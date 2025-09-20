import { spawn } from 'node:child_process'

function parseWrkOutput(txt: string) {
  // Very simple parser that extracts Requests/sec and latency percentiles if present
  const lines = txt.split(/\r?\n/)
  let rps = NaN
  let latencyAvg = NaN, p50 = NaN, p90 = NaN, p99 = NaN
  for (const l of lines) {
    const mRps = l.match(/Requests\/sec:\s+([0-9.]+)/i)
    if (mRps) rps = Number(mRps[1])
    const mLat = l.match(/Latency\s+([0-9.]+)\s*([a-zμ]+)/i)
    if (mLat) latencyAvg = toMs(Number(mLat[1]), mLat[2])
    const mP50 = l.match(/50%\s+([0-9.]+)\s*([a-zμ]+)/i)
    if (mP50) p50 = toMs(Number(mP50[1]), mP50[2])
    const mP90 = l.match(/90%\s+([0-9.]+)\s*([a-zμ]+)/i)
    if (mP90) p90 = toMs(Number(mP90[1]), mP90[2])
    const mP99 = l.match(/99%\s+([0-9.]+)\s*([a-zμ]+)/i)
    if (mP99) p99 = toMs(Number(mP99[1]), mP99[2])
  }
  return { rps, latencyAvg, p50, p90, p99 }
}

function toMs(v: number, unit: string): number {
  const u = unit.toLowerCase()
  if (u.startsWith('ms')) return v
  if (u.startsWith('s')) return v * 1000
  if (u.includes('us') || u.includes('μs')) return v / 1000
  return v
}

function htmlReport(stats: any) {
  return `<!doctype html><meta charset="utf-8"/><title>wrk2 Report</title>
  <style>body{font:14px system-ui,Segoe UI,Arial} table{border-collapse:collapse} td,th{border:1px solid #ddd;padding:6px}</style>
  <h2>wrk2 Report</h2>
  <table><tbody>
  ${Object.entries(stats).map(([k,v])=>`<tr><th>${k}</th><td>${typeof v==='number'?v.toFixed(2):v}</td></tr>`).join('')}
  </tbody></table>`
}

async function main() {
  const url = String(process.env.WRK_URL || process.argv[2] || 'http://127.0.0.1:8080/micro/plain?bytes=1024')
  const rate = String(process.env.WRK_RATE || '1000')
  const duration = String(process.env.WRK_DURATION || '10s')
  const conns = String(process.env.WRK_CONNECTIONS || '64')
  const threads = String(process.env.WRK_THREADS || '4')
  const bin = String(process.env.WRK_BIN || 'wrk') // or 'wrk2'

  const args = ['-t', threads, '-c', conns, '-d', duration]
  if (bin.includes('wrk2')) args.push('-R', rate); else args.push(url)
  if (bin.includes('wrk2')) args.push(url)

  const child = spawn(bin, args, { stdio: ['ignore','pipe','pipe'] })
  let out = '', err = ''
  child.stdout.on('data', d => out += String(d))
  child.stderr.on('data', d => err += String(d))
  await new Promise<void>((resolve, reject) => child.on('exit', code => code===0?resolve():reject(new Error(`wrk exited ${code}: ${err}`))))

  const stats = parseWrkOutput(out || err)
  const report = { url, rate, duration, connections: conns, threads, ...stats }
  console.log(JSON.stringify(report, null, 2))
  if (process.env.WRK_HTML) {
    const fs = await import('node:fs')
    const outfile = String(process.env.WRK_HTML) || 'wrk2-report.html'
    fs.writeFileSync(outfile, htmlReport(report))
    console.log(`wrote ${outfile}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })

