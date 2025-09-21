import 'dotenv/config'
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createGzip } from 'node:zlib'
import { existsSync, createReadStream, createWriteStream, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { register, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client'

const PORT = Number(process.env.PORT || 8080);
const VITE_DEV_URL = process.env.VITE_DEV_URL || "http://localhost:5173";
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const UI_DIST_DIR = process.env.UI_DIST_DIR || resolve(__dirname, '../../ui/dist')
const REPO_ROOT = resolve(__dirname, '../../..')
const RESULTS_DIR = resolve(REPO_ROOT, 'packages/bench/results')
const GENERATE_INDEX = resolve(REPO_ROOT, 'packages/bench/scripts/generate-index.mjs')

const CLI_RUNS = new Map<number, { logPath: string, status: 'running'|'done'|'error' }>()

const CLI_SUBS = new Map<number, Set<any>>()
const CLI_SAMPLERS = new Map<number, { timer: NodeJS.Timeout, last?: { cpuSeconds: number, rssBytes: number }, lastAt?: number }>()


const LOG_SUBS = new Set<any>()
function broadcastLog(level: string, text: string){
  for (const res of LOG_SUBS) sseWrite(res, 'log', { level, text })
}
function fmtArg(a:any){
  if (typeof a === 'string') return a
  if (a && a.stack) return String(a.stack)
  try { return JSON.stringify(a) } catch { return String(a) }
}
const _origError = console.error.bind(console)
console.error = (...args: any[]) => { try{ broadcastLog('err', args.map(fmtArg).join(' ')) }catch{}; _origError(...args) }
process.on('uncaughtException', (e:any)=>{ try{ broadcastLog('err', (e?.stack||String(e))) }catch{} })
process.on('unhandledRejection', (r:any)=>{ try{ broadcastLog('err', (r?.stack||String(r))) }catch{} })

function sseWrite(res:any, type:string, data:any){
  try{
    res.write(`event: ${type}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }catch{}
}
function broadcast(pid:number, type:string, data:any){
  const subs = CLI_SUBS.get(pid)
  if (!subs) return
  for (const res of subs) sseWrite(res, type, data)
}

function sampleProcessOnce(pid: number): { cpuSeconds: number, rssBytes: number } | null {
  try {
    if (process.platform === 'win32') {
      const cmd = `powershell -NoProfile -Command "$p=Get-Process -Id ${pid}; Write-Output (\"$($p.CPU),$($p.WorkingSet)\")"`
      const out = execSync(cmd, { stdio: ['ignore','pipe','ignore'] }).toString().trim()
      const [cpuStr, rssStr] = out.split(',')
      const cpuSeconds = Number(cpuStr)
      const rssBytes = Number(rssStr)
      if (!Number.isFinite(cpuSeconds) || !Number.isFinite(rssBytes)) return null
      return { cpuSeconds, rssBytes }
    } else {
      const out = execSync(`ps -p ${pid} -o cputime=,rss=`, { stdio: ['ignore','pipe','ignore'] }).toString().trim()
      const parts = out.split(/\s+/).filter(Boolean)
      if (parts.length < 2) return null
      const cputime = parts[0]
      const rssKb = Number(parts[1])
      const segs = cputime.split(':').map(Number)
      let cpuSeconds = 0
      if (segs.length === 3) cpuSeconds = segs[0]*3600 + segs[1]*60 + segs[2]
      else if (segs.length === 2) cpuSeconds = segs[0]*60 + segs[1]
      else cpuSeconds = Number(cputime) || 0
      const rssBytes = rssKb * 1024
      return { cpuSeconds, rssBytes }
    }
  } catch {
    return null
  }
}

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


async function tryServeStatic(req: any, res: any): Promise<boolean> {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    let p = url.pathname
    // Serve results under /results/*
    if (p === '/results' || p === '/results/') p = '/results/index.html'
    if (p.startsWith('/results/')) {
      const rel = p.slice('/results/'.length)
      const fsPathR = resolve(RESULTS_DIR, rel)
      if (existsSync(fsPathR) && statSync(fsPathR).isFile()) {
        const ext = fsPathR.split('.').pop()?.toLowerCase()
        const type = ext === 'html' ? 'text/html' : ext === 'js' ? 'text/javascript' : ext === 'css' ? 'text/css' : ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'text/plain'
        res.writeHead(200, { 'content-type': type })
        createReadStream(fsPathR).pipe(res)
        return true
      }
    }
    if (p === '/' || p === '') p = '/index.html'
    const fsPath = resolve(UI_DIST_DIR, '.' + p)
    if (existsSync(fsPath) && statSync(fsPath).isFile()) {
      const ext = fsPath.split('.').pop()?.toLowerCase()
      const type = ext === 'html' ? 'text/html' : ext === 'js' ? 'text/javascript' : ext === 'css' ? 'text/css' : ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'application/octet-stream'
      res.writeHead(200, { 'content-type': type })
      createReadStream(fsPath).pipe(res)
      return true
    }
    // SPA fallback
    const indexPath = resolve(UI_DIST_DIR, 'index.html')
    if (existsSync(indexPath)) {
      res.writeHead(200, { 'content-type': 'text/html' })
      createReadStream(indexPath).pipe(res)
      return true
    }
  } catch {}
  return false
}

const server = createServer(async (req, res) => {
  {
    const u = req.url || '/'
    if (u.startsWith('/logs/stream')) {
      res.writeHead(200, {
        'content-type':'text/event-stream', 'cache-control':'no-cache', 'connection':'keep-alive', 'access-control-allow-origin':'*'
      })
      res.write(': connected\n\n')
      LOG_SUBS.add(res)
      req.on('close', ()=>{ try{ LOG_SUBS.delete(res) }catch{} })
      return
    }
  }

  const url = req.url || "/";
  if (url.startsWith('/bench/run-cli/stream')) {
    const q = new URL(req.url || '/', `http://${req.headers.host}`).searchParams
    const pid = Number(q.get('pid')||'0')
    res.writeHead(200, {
      'content-type':'text/event-stream', 'cache-control':'no-cache', 'connection':'keep-alive', 'access-control-allow-origin':'*'
    })
    res.write(': connected\n\n')
    let set = CLI_SUBS.get(pid)
    if (!set) { set = new Set(); CLI_SUBS.set(pid, set) }
    set.add(res)
    const info = CLI_RUNS.get(pid)
    if (info) sseWrite(res, 'status', { status: info.status, log: `packages/bench/results/${info.logPath.split(/[/\\]/).pop()}` })
    req.on('close', ()=>{ try{ set?.delete(res) }catch{} })
    return
  }

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
  if (url.startsWith('/micro/plain')) {
    try {
      const q = new URL(req.url || '/', `http://${req.headers.host}`).searchParams
      const bytes = Math.max(1, Number(q.get('bytes') || '32'))
      const useGzip = String(q.get('gzip') || '').toLowerCase() === '1' || String(q.get('gzip') || '').toLowerCase() === 'true'

      const buf = Buffer.alloc(bytes, 120) // 'x'
      const headers: Record<string,string> = { 'content-type':'text/plain', 'content-length': String(buf.length) }
      if (useGzip) { delete headers['content-length']; headers['content-encoding'] = 'gzip' }
      res.writeHead(200, headers)
      if (useGzip) { const gz = createGzip(); gz.pipe(res); gz.end(buf) } else res.end(buf)
    } catch (e:any) {
      res.writeHead(500, { 'content-type':'text/plain' }); res.end(String(e?.message||e))
    }
    return
  }
  if (url.startsWith('/micro/chunked')) {
    try {
      const q = new URL(req.url || '/', `http://${req.headers.host}`).searchParams
      const bytesPer = Math.max(1, Number(q.get('bytes') || '32'))
      const chunks = Math.max(1, Number(q.get('chunks') || '1'))
      const delay = Math.max(0, Number(q.get('delay_ms') || '0'))
      const useGzip = String(q.get('gzip') || '').toLowerCase() === '1' || String(q.get('gzip') || '').toLowerCase() === 'true'
      const word = Buffer.alloc(bytesPer, 120)
      const headers: Record<string,string> = { 'content-type':'application/octet-stream', 'transfer-encoding':'chunked', 'cache-control':'no-cache' }
      if (useGzip) headers['content-encoding'] = 'gzip'
      res.writeHead(200, headers)
      const writer: any = useGzip ? createGzip() : res
      if (useGzip) (writer as any).pipe(res)
      const sleep = (ms: number) => new Promise(r=>setTimeout(r, ms))
      for (let i=0;i<chunks;i++) {
        writer.write(word)
        if (delay>0) await sleep(delay)
      }
      if (useGzip) (writer as any).end(); else res.end()
    } catch (e:any) {
      res.writeHead(500, { 'content-type':'text/plain' }); res.end(String(e?.message||e))
    }
    return
  }
  if (url === '/bench/health') {
    try {
      const probe = async (u: string, timeoutMs = 1500) => {
        try {
          const ac = new AbortController()
          const t = setTimeout(() => ac.abort(), timeoutMs)
          const r = await fetch(u, { signal: ac.signal })
          clearTimeout(t)
          return r.ok
        } catch { return false }
      }
      const data = {
        elide: true, // this server
        express: await probe('http://localhost:8081/healthz'),
        fastapi: await probe('http://localhost:8082/healthz'),
        flask: await probe('http://localhost:8083/healthz'),
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, targets: data }))
    } catch (e:any) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok:false, error: e?.message || String(e) }))
    }
    return
  }

  if (url === '/bench/ui-save' && req.method === 'POST') {
    try {
      const chunks: Buffer[] = []
      for await (const ch of req) chunks.push(ch)
      const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      const ts = Date.now()
      mkdirSync(RESULTS_DIR, { recursive: true })
      const file = resolve(RESULTS_DIR, `ui-${ts}.json`)
      writeFileSync(file, JSON.stringify(payload, null, 2))
      await new Promise<void>((resolveDone) => {
        const p = spawn(process.execPath, [GENERATE_INDEX], { cwd: REPO_ROOT, stdio: 'ignore' })
        p.on('close', () => resolveDone())
        p.on('error', () => resolveDone())
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, file: `packages/bench/results/ui-${ts}.json` }))
    } catch (e:any) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok:false, error: e?.message || String(e) }))
    }
    return
  }

  if (url === '/bench/run-cli' && req.method === 'POST') {
    try {
      const chunks: Buffer[] = []
      for await (const ch of req) chunks.push(ch)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      const concList: number[] = Array.isArray(body.concurrency) ? body.concurrency : []
      const totalList: number[] = Array.isArray(body.totals) ? body.totals : concList.map((c:number)=>c*4)
      const frames = Number(body.frames ?? 200)
      const delay_ms = Number(body.delay_ms ?? 5)
      const bytes = Number(body.bytes ?? 256)
      const cpu_spin_ms = Number(body.cpu_spin_ms ?? 0)
      const fanout = Number(body.fanout ?? 0)
      const fanout_delay_ms = Number(body.fanout_delay_ms ?? 0)
      const gzip = !!body.gzip
      const startServers = body.startServers !== false
      const wslNode = !!body.wslNode
      const wslFastapi = !!body.wslFastapi
      const runtime = String(body.runtime || 'elide')
      const ts = Date.now()
      const runId = new Date(ts).toISOString().replace(/[:.]/g,'-')
      const runRel = `runs/${runId}`
      mkdirSync(RESULTS_DIR, { recursive: true })
      const logPath = resolve(RESULTS_DIR, `cli-${ts}.log`)
      const out = createWriteStream(logPath)
      const cliPath = resolve(REPO_ROOT, 'packages/bench/dist/quad.js')
      const targetsArr: string[] = Array.isArray(body.targets) && body.targets.length ? body.targets.map((s:string)=>String(s).toLowerCase()) : ['elide','express','fastapi','flask']
      const env = {
        ...process.env,
        QUAD_RUN_ID: runId,
        QUAD_START_SERVERS: startServers ? '1' : '',
        QUAD_MODE: 'sequential',
        QUAD_CONCURRENCY_LIST: concList.join(','),
        QUAD_TOTAL_LIST: totalList.join(','),
        QUAD_WSL_NODE: wslNode ? '1' : '',
        QUAD_WSL_FASTAPI: wslFastapi ? '1' : '',
        QUAD_TARGETS: targetsArr.join(','),
        QUAD_DOCKER_FLASK: '1',
        SYN_FRAMES: String(frames),
        SYN_DELAY_MS: String(delay_ms),
        SYN_BYTES: String(bytes),
        SYN_CPU_SPIN_MS: String(cpu_spin_ms),
        SYN_FANOUT: String(fanout),
        SYN_FANOUT_DELAY_MS: String(fanout_delay_ms),
        SYN_GZIP: gzip ? '1' : '',
      }
      const p = spawn(process.execPath, [cliPath], { cwd: REPO_ROOT, env })
      const relLog = `packages/bench/results/${logPath.split(/[/\\]/).pop()}`
      p.stdout?.on('data', (d)=> { out.write(d); broadcast(p.pid || 0, 'log', { text: String(d) }) })
      p.stderr?.on('data', (d)=> { out.write(d); broadcast(p.pid || 0, 'log', { text: String(d), level:'err' }) })
      const pid = p.pid || Math.floor(Math.random()*1e9)
      CLI_RUNS.set(pid, { logPath, status: 'running' })
      // start sampler
      const first = sampleProcessOnce(pid)
      if (first) {
        const sampler = { last: first, lastAt: Date.now(), timer: setInterval(() => {
          const cur = sampleProcessOnce(pid)
          if (!cur) return
          const now = Date.now()
          const last = sampler.last!
          const dt = Math.max(0.001, (now - (sampler.lastAt||now)) / 1000)
          const dCpu = Math.max(0, cur.cpuSeconds - last.cpuSeconds)


          const cpu = (dCpu / dt) * 100
          const rssMb = cur.rssBytes / (1024*1024)
          sampler.last = cur; sampler.lastAt = now
          broadcast(pid, 'sample', { t: now, cpu, rssMb })
        }, 500) }
        CLI_SAMPLERS.set(pid, sampler)
      }
      broadcast(pid, 'start', { pid, log: relLog })
      p.on('close', async (code)=>{
        out.end(() => undefined)
        try {
          const g = spawn(process.execPath, [GENERATE_INDEX], { cwd: REPO_ROOT, stdio: 'ignore' })
          g.on('close', ()=>{})
        } catch {}
        const status = code===0 ? 'done' : 'error'
        CLI_RUNS.set(pid, { logPath, status })
        const s = CLI_SAMPLERS.get(pid); if (s) { try{ clearInterval(s.timer) }catch{} CLI_SAMPLERS.delete(pid) }
        broadcast(pid, 'done', { pid, status, log: relLog, index: `/results/${runRel}/index.html` })
        const subs = CLI_SUBS.get(pid)
        if (subs) { for (const r of subs) { try{ r.end() }catch{} } CLI_SUBS.delete(pid) }
      })
      res.writeHead(200, { 'content-type':'application/json' })
      res.end(JSON.stringify({ ok:true, pid, log: relLog }))
    } catch (e:any) {
      res.writeHead(500, { 'content-type':'application/json' })
      res.end(JSON.stringify({ ok:false, error: e?.message || String(e) }))
    }
    return
  }

  if (url.startsWith('/bench/run-cli/status')) {
    const q = new URL(req.url || '/', `http://${req.headers.host}`).searchParams
    const pid = Number(q.get('pid')||'0')
    const info = CLI_RUNS.get(pid)
    res.writeHead(200, { 'content-type':'application/json' })
    res.end(JSON.stringify(info ? { ok:true, pid, ...info } : { ok:false, error: 'not_found' }))
    return
  }

  if (url.startsWith('/bench/run-cli/cancel') && req.method === 'POST') {
    try {
      const q = new URL(req.url || '/', `http://${req.headers.host}`).searchParams
      const pid = Number(q.get('pid')||'0')
      if (pid) {
        try { process.kill(pid) } catch {}
        const info = CLI_RUNS.get(pid)
        if (info) CLI_RUNS.set(pid, { ...info, status: 'error' })
        // stop sampler
        const s = CLI_SAMPLERS.get(pid); if (s) { try{ clearInterval(s.timer) }catch{} CLI_SAMPLERS.delete(pid) }
        const relLog = info ? `packages/bench/results/${info.logPath.split(/[/\\]/).pop()}` : ''
        broadcast(pid, 'done', { pid, status:'error', log: relLog, index:'/results/index.html' })
        const subs = CLI_SUBS.get(pid); if (subs) { for (const r of subs) { try{ r.end() }catch{} } CLI_SUBS.delete(pid) }
      }
      res.writeHead(200, { 'content-type':'application/json' })
      res.end(JSON.stringify({ ok:true }))
    } catch (e:any) {
      res.writeHead(500, { 'content-type':'application/json' })
      res.end(JSON.stringify({ ok:false, error: e?.message || String(e) }))
    }

  if (url.startsWith('/bench/run-cli/stream')) {
    const q = new URL(req.url || '/', `http://${req.headers.host}`).searchParams
    const pid = Number(q.get('pid')||'0')
    res.writeHead(200, {
      'content-type':'text/event-stream', 'cache-control':'no-cache', 'connection':'keep-alive', 'access-control-allow-origin':'*'
    })
    res.write(': connected\n\n')
    let set = CLI_SUBS.get(pid)
    if (!set) { set = new Set(); CLI_SUBS.set(pid, set) }
    set.add(res)
    const info = CLI_RUNS.get(pid)
    if (info) sseWrite(res, 'status', { status: info.status, log: `packages/bench/results/${info.logPath.split(/[/\\]/).pop()}` })
    req.on('close', ()=>{ try{ set?.delete(res) }catch{} })
    return
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
  // Try serving built UI; otherwise proxy to Vite dev
  if (await tryServeStatic(req, res)) return;
  proxyTo(VITE_DEV_URL, req, res);
});

server.listen(PORT, () => {
  console.log(`server-elide listening on :${PORT}`);
});

