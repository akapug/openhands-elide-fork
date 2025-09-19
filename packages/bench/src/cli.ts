#!/usr/bin/env node
import { performance } from 'node:perf_hooks'
import { execSync } from 'node:child_process'

function parseArgs(argv: string[]) {
  const args: Record<string,string|number|boolean> = {}
  for (let i=2;i<argv.length;i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k,v] = a.slice(2).split('=')
      args[k] = v ?? true
    } else if (!args._) args._ = a
  }
  return args
}

async function smoke(baseURL: string) {
  const t0 = performance.now()
  const r = await fetch(`${baseURL}/healthz`)
  const ok = r.ok
  const ttms = performance.now()-t0
  return { ok, ttms }
}

const DEFAULT_PATH = process.env.BENCH_PATH || '/api/chat/completions'
async function run(baseURL: string, prompt = 'Hello', path = DEFAULT_PATH) {
  const sendAt = performance.now()
  const res = await fetch(`${baseURL}${path}`, {
    method: 'POST', headers: { 'content-type':'application/json' },
    body: JSON.stringify({ model: process.env.LLM_MODEL || 'openai/gpt-oss-120b', messages: [{ role:'user', content: prompt }], stream: true })
  })
  let ttft = NaN, tokens = 0
  if (res.body) {
    const reader = (res.body as any).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let ttftSeen = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!ttftSeen) { ttftSeen = true; ttft = performance.now()-sendAt }
      buffer += decoder.decode(value, { stream:true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() || ''
      for (const frame of frames) for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') { break }
        try {
          const json = JSON.parse(payload)
          const delta = json?.choices?.[0]?.delta || {}
          if (typeof delta.content === 'string') tokens += delta.content.split(/\s+/).filter(Boolean).length
        } catch {}
      }
    }
  }
  const duration = performance.now()-sendAt
  const tps = tokens / (duration/1000)
  return { ttft, tokens, duration, tps }
}

function percentile(vals: number[], p: number) {
  if (!vals.length) return NaN
  const a = vals.slice().sort((a,b)=>a-b)
  const idx = Math.floor((p/100) * (a.length-1))
  return a[idx]
}

function mean(vals: number[]) { return vals.length ? (vals.reduce((s,v)=>s+v,0) / vals.length) : NaN }

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
      const cputime = parts[0] // like HH:MM:SS or MM:SS
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

async function sweep(baseURL: string, prompt: string, concurrency = 4, total = 16, path = DEFAULT_PATH) {
  const started = performance.now()
  const results: Awaited<ReturnType<typeof run>>[] = new Array(total)
  let next = 0

  // Optional CPU/RSS sampling for a single target PID across the whole sweep
  const sampPid = process.env.SAMPLING_PID ? Number(process.env.SAMPLING_PID) : 0
  const cpuPercents: number[] = []
  const rssMBs: number[] = []
  let lastSample = sampPid ? sampleProcessOnce(sampPid) : null
  let lastAt = performance.now()
  let timer: any
  if (sampPid && lastSample) {
    timer = setInterval(() => {
      const now = performance.now()
      const cur = sampleProcessOnce(sampPid)
      if (cur && lastSample) {
        const dt = (now - lastAt) / 1000
        const dCpu = cur.cpuSeconds - lastSample.cpuSeconds
        if (dt > 0 && dCpu >= 0) cpuPercents.push((dCpu / dt) * 100)
        rssMBs.push(cur.rssBytes / (1024*1024))
        lastSample = cur
        lastAt = now
      }
    }, 250)
  }

  async function worker() {
    while (true) {
      const idx = next++
      if (idx >= total) break
      results[idx] = await run(baseURL, prompt, path)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (timer) clearInterval(timer)

  const wall = performance.now() - started
  const ttfts = results.map(r=>r.ttft)
  const durs = results.map(r=>r.duration)
  const tokens = results.reduce((s,r)=>s+r.tokens,0)
  const rps = (total / (wall/1000))
  const tps = tokens / (wall/1000)
  const stats: any = {
    total, concurrency, wall, rps, tps,
    ttft_p50: percentile(ttfts,50), ttft_p95: percentile(ttfts,95), ttft_p99: percentile(ttfts,99),
    dur_p50: percentile(durs,50), dur_p95: percentile(durs,95), dur_p99: percentile(durs,99),
  }
  if (cpuPercents.length) {
    stats.cpu_avg = mean(cpuPercents)
    stats.cpu_p95 = percentile(cpuPercents, 95)
  }
  if (rssMBs.length) {
    stats.rss_mb_avg = mean(rssMBs)
    stats.rss_mb_p95 = percentile(rssMBs, 95)
  }
  return stats
}

function htmlReport(stats: any) {
  return `<!doctype html><meta charset="utf-8"/><title>Bench Report</title>
  <style>body{font:14px system-ui,Segoe UI,Arial} table{border-collapse:collapse} td,th{border:1px solid #ddd;padding:6px}</style>
  <h2>Bench Report</h2>
  <table><tbody>
  ${Object.entries(stats).map(([k,v])=>`<tr><th>${k}</th><td>${typeof v==='number'?v.toFixed(2):v}</td></tr>`).join('')}
  </tbody></table>`
}

async function main() {
  const args = parseArgs(process.argv)
  const mode = (args._ as string) || 'smoke'
  const baseURL = (args['base-url'] as string) || 'http://localhost:8080'
  if (mode === 'smoke') {
    const r = await smoke(baseURL)
    console.log(JSON.stringify({ mode, baseURL, ...r }, null, 2))
    return
  }
  if (mode === 'sweep') {
    const conc = Number(args.concurrency || 4)
    const total = Number(args.total || 16)
    const prompt = String(args.prompt || 'Hello')
    const path = String(args.path || DEFAULT_PATH)
    const stats = await sweep(baseURL, prompt, conc, total, path)
    const out = { mode, baseURL, path, ...stats }
    console.log(JSON.stringify(out, null, 2))
    if (args.html) {
      const fs = await import('node:fs')
      const outfile = String(args.out || 'bench-report.html')
      fs.writeFileSync(outfile, htmlReport(out))
      console.log(`wrote ${outfile}`)
    }
    return
  }
  const path = String(args.path || DEFAULT_PATH)
  const r = await run(baseURL, String(args.prompt || 'Hello'), path)
  console.log(JSON.stringify({ mode, baseURL, path, ...r }, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })

