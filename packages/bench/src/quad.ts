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
    const outAbs = resolvePath(resultsDir(), out)
    const args = [
      repoRoot() + '/packages/bench/dist/cli.js', 'sweep',
      `--base-url=${baseURL}`,
      `--concurrency=${conc}`,
      `--total=${total}`,
      '--prompt=synthetic', '--html', `--out=${outAbs}`,
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

async function killListenersOnWindows(port: number): Promise<void> {
  if (process.platform !== 'win32') return
  const auto = String(process.env.QUAD_KILL_CONFLICTS || '1').toLowerCase()
  if (!(auto === '1' || auto === 'true')) return
  await new Promise<void>((resolve) => {
    try {
      const p = spawn('netstat', ['-ano'])
      let buf = ''
      p.stdout.on('data', d => { buf += String(d) })
      p.on('close', () => {
        const lines = buf.split(/\r?\n/)
        const pids = new Set<string>()
        for (const line of lines) {
          if (line.includes(`:${port}`) && /LISTENING/i.test(line)) {
            const parts = line.trim().split(/\s+/)
            const pid = parts[parts.length - 1]
            if (pid && /^\d+$/.test(pid) && Number(pid) !== process.pid) pids.add(pid)
          }
        }
        if (!pids.size) return resolve()
        let remaining = pids.size
        for (const pid of pids) {
          const k = spawn('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' })
          const done = () => { remaining--; if (remaining <= 0) resolve() }
          k.on('exit', done)
          k.on('error', done)
        }
      })
      p.on('error', () => resolve())
    } catch { resolve() }
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

function parseTargets(): Set<string> {
  const def = ['elide','express','fastapi','flask']
  const raw = String(process.env.QUAD_TARGETS || '')
  if (!raw.trim()) return new Set(def)
  const arr = raw.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)
  const ok = new Set(def)
  return new Set(arr.filter(x=>ok.has(x)))
}


async function main() {
  const sequential = String(process.env.QUAD_MODE || '').toLowerCase() === 'sequential'
  const tiers = parseTiers()

  const targets = parseTargets()
  const startAll = String(process.env.QUAD_START_SERVERS || '').toLowerCase() === '1' || String(process.env.QUAD_START_SERVERS || '').toLowerCase() === 'true'
  const baseEnv = { ...process.env }
  let elide: any = null, express: any = null, fastapi: any = null, flask: any = null

  // Base URLs (allow override via env; supports docker-compose service names)
  const baseElide   = String(process.env.QUAD_BASE_ELIDE   || 'http://localhost:8080')
  const baseExpress = String(process.env.QUAD_BASE_EXPRESS || 'http://localhost:8081')
  const baseFastapi = String(process.env.QUAD_BASE_FASTAPI || 'http://localhost:8082')
  const baseFlask   = String(process.env.QUAD_BASE_FLASK   || 'http://localhost:8083')

  // Optional: dockerized Flask
  const useDockerFlask = String(process.env.QUAD_DOCKER_FLASK || '').toLowerCase() === '1' || String(process.env.QUAD_DOCKER_FLASK || '').toLowerCase() === 'true'

  // Start only if requested AND not already healthy; health probes run below
  if (startAll && targets.has('elide')) {
    // Build and start Node Elide
    if (process.platform === 'win32' && (String(process.env.QUAD_WSL_NODE||'').toLowerCase()==='1' || String(process.env.QUAD_WSL_NODE||'').toLowerCase()==='true')) {
      const rootWsl = winPathToWsl(repoRoot())
      await new Promise<void>((resolve,reject)=>{
        const p = startServer('wsl-elide-build','wsl.exe',['--cd', `${rootWsl}/apps/server-elide`, 'bash','-lc','pnpm -C . build'],{ env: baseEnv });
        p.on('exit', (c:number)=> c===0?resolve():reject(new Error('elide build failed')))
      })
      elide = startServer('elide','wsl.exe',['--cd', `${rootWsl}/apps/server-elide`, 'bash','-lc','node dist/index.js'],{ env: baseEnv })
    } else {
      await new Promise<void>((resolve,reject)=>{
        const p = startServer('elide-build', process.platform==='win32'?'pnpm.cmd':'pnpm', ['-C','apps/server-elide','build'], { env: baseEnv });
        p.on('exit', (c:number)=> c===0?resolve():reject(new Error('elide build failed')))
      })
      elide = startServer('elide', process.platform==='win32'?'pnpm.cmd':'pnpm', ['-C','apps/server-elide','start'], { env: baseEnv })
    }
  }

  if (startAll && targets.has('express')) {
    // Free port 8081 proactively on Windows to avoid EADDRINUSE during local dev
    try { await killListenersOnWindows(8081) } catch {}
    if (process.platform === 'win32' && (String(process.env.QUAD_WSL_NODE||'').toLowerCase()==='1' || String(process.env.QUAD_WSL_NODE||'').toLowerCase()==='true')) {
      const rootWsl = winPathToWsl(repoRoot())
      await new Promise<void>((resolve,reject)=>{
        const p = startServer('wsl-express-build','wsl.exe',['--cd', `${rootWsl}/apps/baseline-express`, 'bash','-lc','pnpm -C . build'],{ env: baseEnv });
        p.on('exit', (c:number)=> c===0?resolve():reject(new Error('express build failed')))
      })
      express = startServer('express','wsl.exe',['--cd', `${rootWsl}/apps/baseline-express`, 'bash','-lc','node dist/index.js'],{ env: baseEnv })
    } else {
      await new Promise<void>((resolve,reject)=>{
        const p = startServer('express-build', process.platform==='win32'?'pnpm.cmd':'pnpm', ['-C','apps/baseline-express','build'], { env: baseEnv });
        p.on('exit', (c:number)=> c===0?resolve():reject(new Error('express build failed')))
      })
      express = startServer('express', process.platform==='win32'?'pnpm.cmd':'pnpm', ['-C','apps/baseline-express','start'], { env: baseEnv })
    }
  }

  if (startAll && targets.has('fastapi')) {
    if (process.platform === 'win32' && (String(process.env.QUAD_WSL_FASTAPI||'').toLowerCase()==='1' || String(process.env.QUAD_WSL_FASTAPI||'').toLowerCase()==='true')) {
      const rootWsl = winPathToWsl(repoRoot())
      const synKeys = ['SYN_FRAMES','SYN_DELAY_MS','SYN_BYTES','SYN_CPU_SPIN_MS','SYN_FANOUT','SYN_FANOUT_DELAY_MS','SYN_GZIP'] as const
      const kv = synKeys.map(k=> process.env[k] ? `${k}=${process.env[k]}` : '').filter(Boolean).join(' ')
      const cmd = `${kv} python3 -m venv .venv && .venv/bin/python -m pip -q install -U pip && .venv/bin/pip -q install -r requirements.txt && ${kv} .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8082`
      fastapi = startServer('fastapi','wsl.exe',['--cd', `${rootWsl}/apps/baseline-fastapi`, 'bash','-lc', cmd],{ env: baseEnv })
    } else {
      fastapi = startServer('fastapi', process.env.PYTHON || 'python', ['-m','uvicorn','app.main:app','--host', process.platform==='win32'?'127.0.0.1':'0.0.0.0','--port','8082'], { env: baseEnv, cwd: repoRoot() + '/apps/baseline-fastapi' })
    }
  }

  if (startAll && targets.has('flask')) {
    if (useDockerFlask) {
      // Bring up dockerized Flask on 8083 if not already running
      const composeFile = resolvePath(repoRoot(), 'infra/docker-compose.yml')
      try { startServer('docker-flask', process.platform==='win32'?'docker.exe':'docker', ['compose','-f', composeFile, 'up','-d','flask']) } catch {}
    } else {
      const synKeys = ['SYN_FRAMES','SYN_DELAY_MS','SYN_BYTES','SYN_CPU_SPIN_MS','SYN_FANOUT','SYN_FANOUT_DELAY_MS','SYN_GZIP'] as const
      const kv = synKeys.map(k=> process.env[k] ? `${k}=${process.env[k]}` : '').filter(Boolean).join(' ')
      if (process.platform === 'win32') {
        const rootWsl = winPathToWsl(repoRoot())
        const cmd = `${kv} python3 -m venv .venv && .venv/bin/python -m pip -q install -U pip && .venv/bin/pip -q install -r requirements.txt && ${kv} .venv/bin/python -m gunicorn app.main:app -w 1 -b 127.0.0.1:8083`
        flask = startServer('flask','wsl.exe',['--cd', `${rootWsl}/apps/baseline-flask`, 'bash','-lc', cmd], {})
      } else {
        flask = startServer('flask', process.env.PYTHON || 'python3', ['-m','gunicorn','app.main:app','-w','1','-b','0.0.0.0:8083'], { cwd: repoRoot() + '/apps/baseline-flask' })
      }
    }
  }

  try {
    // Probe health per target; do not fail the whole run if one target is down
    const healthy: Record<string, boolean> = { elide:false, express:false, fastapi:false, flask:false }
    const probes: Array<Promise<void>> = []
    const probe = async (name:string, url:string) => {
      try { await waitHealthy(name, url) ; healthy[name] = true } catch (e:any) { process.stderr.write(`[${name}][err] ${e?.message||e}\n`) }
    }
    if (targets.has('elide')) probes.push(probe('elide',`${baseElide.replace(/\/$/, '')}/healthz`))
    if (targets.has('express')) probes.push(probe('express',`${baseExpress.replace(/\/$/, '')}/healthz`))
    if (targets.has('fastapi')) probes.push(probe('fastapi',`${baseFastapi.replace(/\/$/, '')}/healthz`))
    if (targets.has('flask')) probes.push(probe('flask',`${baseFlask.replace(/\/$/, '')}/healthz`))
    await Promise.all(probes)

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
        if (targets.has('elide'))   { if (healthy.elide)   { try { await runSweep('elide',baseElide, outE, envElide) } catch (e) { writeFail(outE,'elide',e) } } else { writeFail(outE,'elide',new Error('not healthy')) } }
        if (targets.has('express')) { if (healthy.express) { try { await runSweep('express',baseExpress, outX, envExpress) } catch (e) { writeFail(outX,'express',e) } } else { writeFail(outX,'express',new Error('not healthy')) } }
        if (targets.has('fastapi')) { if (healthy.fastapi) { try { await runSweep('fastapi',baseFastapi, outF, envFastapi) } catch (e) { writeFail(outF,'fastapi',e) } } else { writeFail(outF,'fastapi',new Error('not healthy')) } }
        if (targets.has('flask'))   { if (healthy.flask)   { try { await runSweep('flask',baseFlask, outFl, envFlask) } catch (e) { writeFail(outFl,'flask',e) } } else { writeFail(outFl,'flask',new Error('not healthy')) } }
      } else {
        const jobs: Array<Promise<any>> = []
        const names: string[] = []
        if (targets.has('elide'))   { if (healthy.elide)   { jobs.push(runSweep('elide',baseElide, outE, envElide)); names.push('elide') } else { writeFail(outE,'elide',new Error('not healthy')) } }
        if (targets.has('express')) { if (healthy.express) { jobs.push(runSweep('express',baseExpress, outX, envExpress)); names.push('express') } else { writeFail(outX,'express',new Error('not healthy')) } }
        if (targets.has('fastapi')) { if (healthy.fastapi) { jobs.push(runSweep('fastapi',baseFastapi, outF, envFastapi)); names.push('fastapi') } else { writeFail(outF,'fastapi',new Error('not healthy')) } }
        if (targets.has('flask'))   { if (healthy.flask)   { jobs.push(runSweep('flask',baseFlask, outFl, envFlask)); names.push('flask') } else { writeFail(outFl,'flask',new Error('not healthy')) } }
        const results = await Promise.allSettled(jobs)
        for (let i=0;i<results.length;i++) {
          const nm = names[i]
          const outMap: any = { elide: outE, express: outX, fastapi: outF, flask: outFl }
          const r = results[i]
          if (r.status==='rejected') writeFail(outMap[nm], nm as any, (r as any).reason)
        }
      }
    }

    mkdirSync(resolvePath(resultsDir(), RUN_REL), { recursive: true })
    for (const tier of tiers) await runForTier(tier)
  } finally {
    await killTree(elide?.pid)
    await killTree(express?.pid)
    await killTree(fastapi?.pid)
    await killTree(flask?.pid)
  }
}

main().catch(err => { console.error(err); process.exit(1) })

