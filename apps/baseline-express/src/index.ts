import express from 'express'
import { createGzip } from 'node:zlib'

const app = express()
app.disable('x-powered-by')
app.use(express.json())

const PORT = Number(process.env.PORT || 8081)

app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok\n')
})

// Synthetic SSE endpoint mirroring Elide server's synthetic mode
app.post('/api/chat/completions', async (req, res) => {
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
  for (let i = 0; i < fanout; i++) {
    if (fanoutDelay > 0) await sleep(fanoutDelay)
    if (cpuSpinMs > 0) spin(cpuSpinMs)
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

app.listen(PORT, () => {
  console.log(`baseline-express listening on :${PORT}`)
})

