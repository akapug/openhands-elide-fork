import 'dotenv/config'
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client'

const PORT = Number(process.env.PORT || 8080);
const VITE_DEV_URL = process.env.VITE_DEV_URL || "http://localhost:5173";

collectDefaultMetrics()
const chatRequests = new Counter({ name: 'chat_requests_total', help: 'Chat requests', labelNames: ['runtime','model','status'] })
const chatTTFTHist = new Histogram({ name: 'chat_ttft_ms', help: 'TTFT for chat completions (ms)', buckets: [10,20,50,100,200,400,800,1500,3000,6000], labelNames: ['runtime','model'] })
const chatDurHist = new Histogram({ name: 'chat_duration_ms', help: 'Total duration for chat completions (ms)', buckets: [50,100,200,400,800,1500,3000,6000,12000], labelNames: ['runtime','model'] })
const chatTokens = new Counter({ name: 'chat_tokens_total', help: 'Total tokens streamed to clients', labelNames: ['runtime','model'] })
const chatBytes = new Counter({ name: 'chat_bytes_out_total', help: 'Total bytes streamed to clients', labelNames: ['runtime','model'] })

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
    if (!fetchRes.body) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream no body\n");
      statusLabel = String(fetchRes.status || 500)
      return;
    }
    res.writeHead(fetchRes.status, {
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
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`error: ${e.message}`);
    statusLabel = '500'
  } finally {
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

