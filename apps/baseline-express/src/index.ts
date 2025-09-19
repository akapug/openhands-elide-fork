import express from 'express'

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
  const word = 'x'
  const wordsPerFrame = Math.max(1, Math.floor(bytesPerFrame / (word.length + 1)))

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  try {
    for (let i = 0; i < frames; i++) {
      const text = (word + ' ').repeat(wordsPerFrame)
      const payload = JSON.stringify({ choices: [{ delta: { content: text } }] })
      res.write(`data: ${payload}\n\n`)
      if (delayMs > 0) await sleep(delayMs)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (e: any) {
    if (!res.headersSent) res.status(500)
    res.end(`error: ${e?.message || e}`)
  }
})

app.listen(PORT, () => {
  console.log(`baseline-express listening on :${PORT}`)
})

