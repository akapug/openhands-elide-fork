import express from 'express'
import { createGzip } from 'node:zlib'

const app = express()
app.disable('x-powered-by')
app.use(express.json())

const PORT = Number(process.env.PORT || 8081)

app.get('/healthz', (_req: any, res: any) => {
  res.status(200).type('text/plain').send('ok\n')
})

// Local tool endpoint to simulate HTTP fanout overhead
app.post('/tool', async (req: any, res: any) => {
  const cpuSpinMs = Number(req.body?.cpu_spin_ms ?? process.env.SYN_CPU_SPIN_MS ?? 0)
  const spin = (ms: number) => { if (ms <= 0) return; const end = Date.now() + ms; while (Date.now() < end) {} }
  if (cpuSpinMs > 0) spin(cpuSpinMs)
  res.json({ ok: true })
})

// Synthetic SSE endpoint mirroring Elide server's synthetic mode
app.post('/api/chat/completions', async (req: any, res: any) => {
  const frames = Number(req.body?.frames ?? process.env.SYN_FRAMES ?? 200)
  const delayMs = Number(req.body?.delay_ms ?? process.env.SYN_DELAY_MS ?? 5)
  const bytesPerFrame = Number(req.body?.bytes_per_frame ?? process.env.SYN_BYTES ?? 64)
  const cpuSpinMs = Number(req.body?.cpu_spin_ms ?? process.env.SYN_CPU_SPIN_MS ?? 0)
  const fanout = Number(req.body?.fanout ?? process.env.SYN_FANOUT ?? 0)
  const fanoutDelay = Number(req.body?.fanout_delay_ms ?? process.env.SYN_FANOUT_DELAY_MS ?? 0)
  const useGzip = String(req.body?.gzip ?? process.env.SYN_GZIP ?? '').toLowerCase() === '1' || String(req.body?.gzip ?? process.env.SYN_GZIP ?? '').toLowerCase() === 'true'

  const word = 'x'
  const wordsPerFrame = Math.max(1, Math.floor(bytesPerFrame / (word.length + 1)))

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  if (useGzip) res.setHeader('Content-Encoding', 'gzip')

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const spin = (ms: number) => { if (ms <= 0) return; const end = Date.now() + ms; while (Date.now() < end) {} }

  // Pre-stream fanout simulation
  const fanoutHttp = String(process.env.SYN_FANOUT_HTTP || '').toLowerCase() === '1' || String(process.env.SYN_FANOUT_HTTP || '').toLowerCase() === 'true'
  for (let i = 0; i < fanout; i++) {
    if (fanoutDelay > 0) await sleep(fanoutDelay)
    if (fanoutHttp) {
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

  const writer: any = useGzip ? createGzip() : res
  if (useGzip) writer.pipe(res)

  try {
    for (let i = 0; i < frames; i++) {
      if (cpuSpinMs > 0) spin(cpuSpinMs)
      const text = (word + ' ').repeat(wordsPerFrame)
      const payload = JSON.stringify({ choices: [{ delta: { content: text } }] })
      writer.write(`data: ${payload}\n\n`)
      if (delayMs > 0) await sleep(delayMs)
    }
    writer.write('data: [DONE]\n\n')
    if (useGzip) writer.end(); else res.end()
  } catch (e: any) {
    if (!res.headersSent) res.status(500)
    res.end(`error: ${e?.message || e}`)
  }
})

// Non-streaming micro endpoints for wrk2 and microbenchmarks
app.get('/micro/plain', (req: any, res: any) => {
  try {
    const bytes = Math.max(1, Number(req.query?.bytes ?? '32'))
    const buf = Buffer.alloc(bytes, 120)
    res.status(200)
    res.setHeader('Content-Type', 'text/plain')
    res.setHeader('Content-Length', String(buf.length))
    res.end(buf)
  } catch (e: any) {
    res.status(500).type('text/plain').end(String(e?.message || e))
  }
})

app.get('/micro/chunked', async (req: any, res: any) => {
  try {
    const bytesPer = Math.max(1, Number(req.query?.bytes ?? '32'))
    const chunks = Math.max(1, Number(req.query?.chunks ?? '1'))
    const delay = Math.max(0, Number(req.query?.delay_ms ?? '0'))
    const useGzip = String(req.query?.gzip ?? '').toLowerCase() === '1' || String(req.query?.gzip ?? '').toLowerCase() === 'true'
    const word = Buffer.alloc(bytesPer, 120)
    res.status(200)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Transfer-Encoding', 'chunked')
    if (useGzip) res.setHeader('Content-Encoding', 'gzip')

    const writer: any = useGzip ? createGzip() : res
    if (useGzip) writer.pipe(res)
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    for (let i=0;i<chunks;i++) {
      writer.write(word)
      if (delay > 0) await sleep(delay)
    }
    if (useGzip) writer.end(); else res.end()
  } catch (e: any) {
    if (!res.headersSent) res.status(500).type('text/plain')
    res.end(String(e?.message || e))
  }
})


app.listen(PORT, () => {
  console.log(`baseline-express listening on :${PORT}`)
})

