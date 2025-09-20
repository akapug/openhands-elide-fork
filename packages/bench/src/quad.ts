import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve as resolvePath, dirname as pathDirname } from 'node:path'

function resultsDir() { return repoRoot() + '/packages/bench/results' }
const RUN_ID = process.env.QUAD_RUN_ID || new Date().toISOString().replace(/[:.]/g,'-')
const RUN_REL = `runs/${RUN_ID}`
function writeFail(out: string, name: string, err: any) {
  try {
    const p = resolvePath(resultsDir(), out)
    mkdirSync(pathDirname(p), { recursive: true })
    const msg = typeof err === 'string' ? err : (err?.stack || err?.message || String(err))
    const html = `<!doctype html><meta charset="utf-8"/><title>FAILED ${name}</title><pre>${escapeHtml(msg)}</pre>`
    writeFileSync(p, html)
    process.stderr.write(`[${name}][err] wrote failure placeholder ${out}\n`)
  } catch {}
}
function escapeHtml(s:string){ return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'} as any)[c]||c) }

function runSweep(name: string, baseURL: string, out: string, extraEnv: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => {
    const conc = extraEnv.QUAD_CONCURRENCY || process.env.QUAD_CONCURRENCY || '8'
    const total = extraEnv.QUAD_TOTAL || process.env.QUAD_TOTAL || '64'
    const args = [
      repoRoot() + '/packages/bench/dist/cli.js', 'sweep',
      `--base-url=${baseURL}`,
      `--concurrency=${conc}`,
      `--total=${total}`,
      '--prompt=synthetic', '--html', `--out=${out}`,
    ]
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`))
    child.stderr.on('data', d => process.stderr.write(`[${name}][err] ${d}`))
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)))
  })
}

async function waitHealthy(name: string, url: string, timeoutMs = Number(process.env.QUAD_HEALTH_TIMEOUT_MS || 60000)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`${name} did not become healthy at ${url} in ${timeoutMs}ms`)
}

function startServer(name: string, cmd: string, args: string[], opts: any = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore','pipe','pipe'], ...opts })
  child.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`))
  child.stderr.on('data', d => process.stderr.write(`[${name}][err] ${d}`))
  return child
}

function winPathToWsl(p: string): string {
  const m = p.match(/^([A-Za-z]):\\(.*)$/)
  if (!m) return p
  const drive = m[1].toLowerCase()
  const rest = m[2].replace(/\\/g, '/')
  return `/mnt/${drive}/${rest}`
}

function killTree(pid?: number): Promise<void> {
  return new Promise((resolve) => {
    if (!pid) return resolve()
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      k.on('exit', () => resolve())
      k.on('error', () => resolve())
    } else {
      try { process.kill(pid, 'SIGKILL') } catch {}
      resolve()
    }
  })
}

function repoRoot(): string {
  const cwd = process.cwd().replace(/\\/g, '/')
  if (cwd.endsWith('/elide-hands/openhands-elide-fork')) return cwd
  if (cwd.includes('/elide-hands/openhands-elide-fork')) return cwd.slice(0, cwd.indexOf('/elide-hands/openhands-elide-fork') + '/elide-hands/openhands-elide-fork'.length)
  return cwd + '/elide-hands/openhands-elide-fork'
}

function parseTiers() {
  const concList = (process.env.QUAD_CONCURRENCY_LIST || '').split(',').map(s=>s.trim()).filter(Boolean).map(Number)
  const totalList = (process.env.QUAD_TOTAL_LIST || '').split(',').map(s=>s.trim()).filter(Boolean).map(Number)
  if (concList.length && totalList.length && concList.length === totalList.length) {
    return concList.map((c,i)=>({ c, t: totalList[i] }))
  }
  const c = Number(process.env.QUAD_CONCURRENCY || '8')
  const t = Number(process.env.QUAD_TOTAL || '64')
  return [{ c, t }]
}

async function main() {
  const sequential = String(process.env.QUAD_MODE || '').toLowerCase() === 'sequential'
  const tiers = parseTiers()

  // Expect servers already running by default, but support starting Flask here if needed
  const startFlask = String(process.env.QUAD_START_FLASK || '').toLowerCase() === '1'
  let flask: any = null
  if (startFlask) {
    const synKeys = ['SYN_FRAMES','SYN_DELAY_MS','SYN_BYTES','SYN_CPU_SPIN_MS','SYN_FANOUT','SYN_FANOUT_DELAY_MS','SYN_GZIP'] as const
    const kv = synKeys.map(k=> process.env[k] ? `${k}=${process.env[k]}` : '').filter(Boolean).join(' ')
    if (process.platform === 'win32') {
      // Run in WSL
      const rootWsl = winPathToWsl(repoRoot())
      const cmd = `${kv} python3 -m venv .venv && .venv/bin/python -m pip -q install -U pip && .venv/bin/pip -q install -r requirements.txt && ${kv} .venv/bin/python -m gunicorn app.main:app -w 1 -b 127.0.0.1:8083`
      flask = startServer(
        'flask',
        'wsl.exe',
        ['--cd', `${rootWsl}/apps/baseline-flask`, 'bash', '-lc', cmd],
        {}
      )
    } else {
      flask = startServer(
        'flask',
        process.env.PYTHON || 'python3',
        ['-m','gunicorn','app.main:app','-w','1','-b','0.0.0.0:8083'],
        { cwd: repoRoot() + '/apps/baseline-flask' }
      )
    }
  }

  try {
    await Promise.all([
      waitHealthy('elide','http://localhost:8080/healthz'),
      waitHealthy('express','http://localhost:8081/healthz'),
      waitHealthy('fastapi','http://localhost:8082/healthz'),
      waitHealthy('flask','http://localhost:8083/healthz'),
    ])

    const runForTier = async (tier: {c:number,t:number}) => {
      const baseEnv = { ...process.env }
      const envElide   = { ...baseEnv, QUAD_CONCURRENCY: String(tier.c), QUAD_TOTAL: String(tier.t), LLM_MODEL: 'synthetic' }
      const envExpress = { ...baseEnv, QUAD_CONCURRENCY: String(tier.c), QUAD_TOTAL: String(tier.t) }
      const envFastapi = { ...baseEnv, QUAD_CONCURRENCY: String(tier.c), QUAD_TOTAL: String(tier.t) }
      const envFlask   = { ...baseEnv, QUAD_CONCURRENCY: String(tier.c), QUAD_TOTAL: String(tier.t) }

      const outE = `${RUN_REL}/bench-elide.${tier.c}x${tier.t}.html`
      const outX = `${RUN_REL}/bench-express.${tier.c}x${tier.t}.html`
      const outF = `${RUN_REL}/bench-fastapi.${tier.c}x${tier.t}.html`
      const outFl = `${RUN_REL}/bench-flask.${tier.c}x${tier.t}.html`

      if (sequential) {
        try { await runSweep('elide','http://localhost:8080', outE, envElide) } catch (e) { writeFail(outE,'elide',e) }
        try { await runSweep('express','http://localhost:8081', outX, envExpress) } catch (e) { writeFail(outX,'express',e) }
        try { await runSweep('fastapi','http://localhost:8082', outF, envFastapi) } catch (e) { writeFail(outF,'fastapi',e) }
        try { await runSweep('flask','http://localhost:8083', outFl, envFlask) } catch (e) { writeFail(outFl,'flask',e) }
      } else {
        const results = await Promise.allSettled([
          runSweep('elide','http://localhost:8080', outE, envElide),
          runSweep('express','http://localhost:8081', outX, envExpress),
          runSweep('fastapi','http://localhost:8082', outF, envFastapi),
          runSweep('flask','http://localhost:8083', outFl, envFlask),
        ])
        if (results[0].status==='rejected') writeFail(outE,'elide',(results[0] as any).reason)
        if (results[1].status==='rejected') writeFail(outX,'express',(results[1] as any).reason)
        if (results[2].status==='rejected') writeFail(outF,'fastapi',(results[2] as any).reason)
        if (results[3].status==='rejected') writeFail(outFl,'flask',(results[3] as any).reason)
      }
    }

    mkdirSync(resolvePath(resultsDir(), RUN_REL), { recursive: true })
    for (const tier of tiers) await runForTier(tier)
  } finally {
    await killTree(flask?.pid)
  }
}

main().catch(err => { console.error(err); process.exit(1) })

