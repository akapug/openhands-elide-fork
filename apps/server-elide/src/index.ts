import 'dotenv/config'
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createGzip } from 'node:zlib'

import { register, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client'

const PORT = Number(process.env.PORT || 8080);
const VITE_DEV_URL = process.env.VITE_DEV_URL || "http://localhost:5173";

collectDefaultMetrics()
const chatRequests = new Counter({ name: 'chat_requests_total', help: 'Chat requests', labelNames: ['runtime','model','status'] })
const chatTTFTHist = new Histogram({ name: 'chat_ttft_ms', help: 'TTFT for chat completions (ms)', buckets: [10,20,50,100,200,400,800,1500,3000,6000], labelNames: ['runtime','model'] })
const chatDurHist = new Histogram({ name: 'chat_duration_ms', help: 'Total duration for chat completions (ms)', buckets: [50,100,200,400,800,1500,3000,6000,12000], labelNames: ['runtime','model'] })
const chatTokens = new Counter({ name: 'chat_tokens_total', help: 'Total tokens streamed to clients', labelNames: ['runtime','model'] })
const chatBytes = new Counter({ name: 'chat_bytes_out_total', help: 'Total bytes streamed to clients', labelNames: ['runtime','model'] })
const chatInFlight = new Gauge({ name: 'chat_in_flight', help: 'In-flight chat requests', labelNames: ['runtime','model'] })
const chatHdrsHist = new Histogram({ name: 'chat_upstream_headers_ms', help: 'Time to receive upstream headers (ms)', buckets: [10,20,50,100,200,400,800,1500,3000,6000], labelNames: ['runtime','model'] })
const chatErrors = new Counter({ name: 'chat_errors_total', help: 'Errors during chat proxying', labelNames: ['runtime','model','reason'] })
const buildInfo = new Gauge({ name: 'build_info', help: 'Build information', labelNames: ['version','node'] })
try { const pkg = await import('../package.json', { assert: { type: 'json' } }) as any; buildInfo.labels(String(pkg.default?.version||'0.0.0'), process.versions.node).set(1) } catch { buildInfo.labels('unknown', process.versions.node).set(1) }

function proxyTo(target: string, req: any, res: any) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const t = new URL(url.pathname + url.search, target);
  const isHttps = t.protocol === "https:";
  const r = (isHttps ? httpsRequest : httpRequest)({
    method: req.method,
    hostname: t.hostname,
    port: t.port || (isHttps ? 443 : 80),
    path: t.pathname + t.search,
    headers: { ...req.headers, host: t.host },
  }, (pr) => {
    res.writeHead(pr.statusCode || 502, pr.headers);
    pr.pipe(res);
  });
  r.on("error", (e) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy error: ${e.message}`);
  });
  req.pipe(r);
}

async function handleChatProxy(req: any, res: any) {
  const started = performance.now()
  let ttftObserved = false
  let labels = { runtime: 'elide', model: 'unknown' } as { runtime: string, model: string }
  let statusLabel = '200'
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const baseURL: string = body.baseURL || process.env.LLM_BASE_URL || "http://localhost:1234/v1";
    const apiKey: string | undefined = body.apiKey || process.env.LLM_API_KEY;
    labels = { runtime: String(body.runtime || 'elide'), model: String(body.model || process.env.LLM_MODEL || 'unknown') }
    chatInFlight.labels(labels.runtime, labels.model).inc()
    // Synthetic SSE mode to isolate serving overhead
    if (String(labels.model).toLowerCase() === 'synthetic' || body.synthetic) {
      try {
        const frames = Number(body.frames ?? process.env.SYN_FRAMES ?? 200);
        const delayMs = Number(body.delay_ms ?? process.env.SYN_DELAY_MS ?? 5);
        const bytesPerFrame = Number(body.bytes_per_frame ?? process.env.SYN_BYTES ?? 64);
        const cpuSpinMs = Number(body.cpu_spin_ms ?? process.env.SYN_CPU_SPIN_MS ?? 0);
        const fanout = Number(body.fanout ?? process.env.SYN_FANOUT ?? 0);
        const fanoutDelay = Number(body.fanout_delay_ms ?? process.env.SYN_FANOUT_DELAY_MS ?? 0);
        const useGzip = String(body.gzip ?? process.env.SYN_GZIP ?? '').toLowerCase() === '1' || String(body.gzip ?? process.env.SYN_GZIP ?? '').toLowerCase() === 'true';

        const word = 'x';
        const wordsPerFrame = Math.max(1, Math.floor(bytesPerFrame / (word.length + 1))); // approximate
        // Minimal upstream header timing (no upstream)
        chatHdrsHist.labels(labels.runtime, labels.model).observe(0);
        const headers: Record<string,string> = {
          'content-type': 'text/event-stream',
          'transfer-encoding': 'chunked',
          'cache-control': 'no-cache',
        };
        if (useGzip) headers['content-encoding'] = 'gzip';
        res.writeHead(200, headers);

        const encoder = new TextEncoder();
        const writer: any = useGzip ? createGzip() : res;
        if (useGzip) { (writer as any).pipe(res); }

        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        const spin = (ms: number) => { if (ms <= 0) return; const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };

        // Pre-stream fanout simulation (tool calls / RAG)
        const fanoutMode = String(body.fanout_mode ?? process.env.SYN_FANOUT_MODE ?? 'inproc').toLowerCase()
        for (let i = 0; i < fanout; i++) {
          if (fanoutDelay > 0) await sleep(fanoutDelay)
          if (fanoutMode === 'http') {
            // Loopback HTTP call exercises full HTTP/JSON overhead
            try {
              await fetch(`http://127.0.0.1:${PORT}/tool`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ cpu_spin_ms: cpuSpinMs })
              })
            } catch {}
          } else {
            if (cpuSpinMs > 0) spin(cpuSpinMs)
          }
        }

        for (let i = 0; i < frames; i++) {
          if (i === 0 && !ttftObserved) {
            ttftObserved = true;
            chatTTFTHist.labels(labels.runtime, labels.model).observe(performance.now() - started);
          }
          if (cpuSpinMs > 0) spin(cpuSpinMs);
          const text = (word + ' ').repeat(wordsPerFrame);
          const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
          const buf = encoder.encode(frame);
          chatBytes.labels(labels.runtime, labels.model).inc(buf.length);
          const t = text.trim().length ? text.trim().split(/\s+/).length : 0;
          if (t) chatTokens.labels(labels.runtime, labels.model).inc(t);
          writer.write(buf);
          if (delayMs > 0) await sleep(delayMs);
        }
        writer.write('data: [DONE]\n\n');
        if (useGzip) (writer as any).end(); else res.end();
        statusLabel = '200';
      } catch (e: any) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`synthetic error: ${e?.message || e}`);
        statusLabel = '500';
        try { chatErrors.labels(labels.runtime, labels.model, 'synthetic_exception').inc() } catch {}
      } finally {
        try { chatInFlight.labels(labels.runtime, labels.model).dec() } catch {}
        chatDurHist.labels(labels.runtime, labels.model).observe(performance.now() - started);
        chatRequests.labels(labels.runtime, labels.model, statusLabel).inc();
      }
      return;
    }


    const hdrStart = performance.now()
    const fetchRes = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: labels.model,
        messages: body.messages || [],
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        stream: true,
      }),
    });
    chatHdrsHist.labels(labels.runtime, labels.model).observe(performance.now() - hdrStart)
    if (!fetchRes.ok) {
      statusLabel = String(fetchRes.status || 500)
      chatErrors.labels(labels.runtime, labels.model, `upstream_${statusLabel}`).inc()
    }
    if (!fetchRes.body) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream no body\n");
      statusLabel = String(fetchRes.status || 500)
      chatErrors.labels(labels.runtime, labels.model, 'no_body').inc()
      return;
    }
    if (!res.headersSent) res.writeHead(fetchRes.status, {
      "content-type": fetchRes.headers.get("content-type") || "text/plain",
      "transfer-encoding": "chunked",
      "cache-control": "no-cache",
    });
    const reader = (fetchRes.body as any).getReader();
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ttftObserved) {
        ttftObserved = true
        chatTTFTHist.labels(labels.runtime, labels.model).observe(performance.now() - started)
      }
      const chunk = Buffer.from(value)
      chatBytes.labels(labels.runtime, labels.model).inc(chunk.length)
      res.write(chunk);
      // Parse SSE frames to count tokens
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() || ''
      for (const frame of frames) for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload)
          const delta = json?.choices?.[0]?.delta || {}
          if (typeof delta.content === 'string') {
            const t = delta.content.split(/\s+/).filter(Boolean).length
            if (t) chatTokens.labels(labels.runtime, labels.model).inc(t)
          }
        } catch {}
      }
    }
    res.end();
    statusLabel = String(fetchRes.status)
  } catch (e: any) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(`error: ${e.message}`);
    statusLabel = '500'
    try { chatErrors.labels(labels.runtime, labels.model, 'exception').inc() } catch {}
  } finally {
    try { chatInFlight.labels(labels.runtime, labels.model).dec() } catch {}
    chatDurHist.labels(labels.runtime, labels.model).observe(performance.now() - started)
    chatRequests.labels(labels.runtime, labels.model, statusLabel).inc()
  }
}

async function handleModels(req: any, res: any) {
  try {
    const baseURL: string = process.env.LLM_BASE_URL || "http://localhost:1234/v1";
    const apiKey: string | undefined = process.env.LLM_API_KEY;
    const upstream = await fetch(`${baseURL}/models`, {
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
    res.end(await upstream.text())
  } catch (e: any) {
    res.writeHead(500, { 'content-type':'application/json' });
    res.end(JSON.stringify({ error: e.message }))
  }
}

const server = createServer(async (req, res) => {
  const url = req.url || "/";
  if (url === "/tool") {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
      const cpuSpinMs = Number(body?.cpu_spin_ms ?? process.env.SYN_CPU_SPIN_MS ?? 0)
      const spin = (ms: number) => { if (ms <= 0) return; const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } }
      if (cpuSpinMs > 0) spin(cpuSpinMs)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (e: any) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: e?.message || String(e) }))
    }
    return
  }

  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
    return;
  }
  if (url === "/metrics") {
    const txt = await register.metrics()
    res.writeHead(200, { 'content-type': register.contentType })
    res.end(txt)
    return
  }
  if (url === "/readiness") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.startsWith("/api/chat/completions") || url.startsWith("/v1/chat/completions")) {
    handleChatProxy(req, res);
    return;
  }
  if (url.startsWith('/v1/models')) {
    handleModels(req, res); return;
  }
  if (url.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not implemented" }));
    return;
  }
  // Proxy any other request to Vite dev server
  proxyTo(VITE_DEV_URL, req, res);
});

server.listen(PORT, () => {
  console.log(`server-elide listening on :${PORT}`);
});

