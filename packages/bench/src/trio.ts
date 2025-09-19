import { spawn } from 'node:child_process'

function runSweep(name: string, baseURL: string, out: string, extraEnv: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => {
    const conc = extraEnv.TRIO_CONCURRENCY || process.env.TRIO_CONCURRENCY || '8'
    const total = extraEnv.TRIO_TOTAL || process.env.TRIO_TOTAL || '64'
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

async function waitHealthy(name: string, url: string, timeoutMs = Number(process.env.TRIO_HEALTH_TIMEOUT_MS || 60000)) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
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

function runCmd(name: string, cmd: string, args: string[], opts: any = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore','pipe','pipe'], ...opts })
    child.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`))
    child.stderr.on('data', d => process.stderr.write(`[${name}][err] ${d}`))
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)))
  })
}

function winPathToWsl(p: string): string {
  // Convert like D:\code\foo to /mnt/d/code/foo
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
  // Handle being invoked from repo root or from within the monorepo package
  const cwd = process.cwd().replace(/\\/g, '/')
  if (cwd.endsWith('/elide-hands/openhands-elide-fork')) return cwd
  if (cwd.includes('/elide-hands/openhands-elide-fork')) return cwd.slice(0, cwd.indexOf('/elide-hands/openhands-elide-fork') + '/elide-hands/openhands-elide-fork'.length)
  return cwd + '/elide-hands/openhands-elide-fork'
}

function parseTiers() {
  const concList = (process.env.TRIO_CONCURRENCY_LIST || '').split(',').map(s=>s.trim()).filter(Boolean).map(Number)
  const totalList = (process.env.TRIO_TOTAL_LIST || '').split(',').map(s=>s.trim()).filter(Boolean).map(Number)
  if (concList.length && totalList.length && concList.length === totalList.length) {
    return concList.map((c,i)=>({ c, t: totalList[i] }))
  }
  const c = Number(process.env.TRIO_CONCURRENCY || '8')
  const t = Number(process.env.TRIO_TOTAL || '64')
  return [{ c, t }]
}

async function main() {
  const sequential = String(process.env.TRIO_MODE || '').toLowerCase() === 'sequential'
  const tiers = parseTiers()

  if (String(process.env.TRIO_START_SERVERS || '').toLowerCase() === '1' || String(process.env.TRIO_START_SERVERS || '').toLowerCase() === 'true') {
    // Start servers with SYN_* envs propagated
    const baseEnv = { ...process.env }

    const useWslNode = process.platform === 'win32' && (String(process.env.TRIO_WSL_NODE||'').toLowerCase()==='1' || String(process.env.TRIO_WSL_NODE||'').toLowerCase()==='true')

    if (useWslNode) {
      // Build inside WSL
      const rootWsl = winPathToWsl(repoRoot())
      await runCmd('wsl-elide-build', 'wsl.exe', ['--cd', `${rootWsl}/apps/server-elide`, 'bash', '-lc', 'pnpm -C . build'])
      await runCmd('wsl-express-build', 'wsl.exe', ['--cd', `${rootWsl}/apps/baseline-express`, 'bash', '-lc', 'pnpm -C . build'])
    } else {
      // Build Node servers to avoid dev/watch overhead on host
      await runCmd('elide-build', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['-C','apps/server-elide','build'], { env: baseEnv })
      await runCmd('express-build', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['-C','apps/baseline-express','build'], { env: baseEnv })
    }

    const elide = useWslNode
      ? startServer(
          'elide',
          'wsl.exe',
          ['--cd', `${winPathToWsl(repoRoot() + '/apps/server-elide')}`, 'bash', '-lc', 'node dist/index.js'],
          { env: baseEnv }
        )
      : startServer(
          'elide',
          process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
          ['-C','apps/server-elide','start'],
          { env: baseEnv }
        )

    const express = useWslNode
      ? startServer(
          'express',
          'wsl.exe',
          ['--cd', `${winPathToWsl(repoRoot() + '/apps/baseline-express')}`, 'bash', '-lc', 'node dist/index.js'],
          { env: baseEnv }
        )
      : startServer(
          'express',
          process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
          ['-C','apps/baseline-express','start'],
          { env: baseEnv }
        )
    const fastapi = (process.platform === 'win32' && (String(process.env.TRIO_WSL_FASTAPI||'').toLowerCase()==='1' || String(process.env.TRIO_WSL_FASTAPI||'').toLowerCase()==='true'))
      ? (()=>{
          const synKeys = ['SYN_FRAMES','SYN_DELAY_MS','SYN_BYTES','SYN_CPU_SPIN_MS','SYN_FANOUT','SYN_FANOUT_DELAY_MS','SYN_GZIP'] as const
          const kv = synKeys.map(k=> process.env[k] ? `${k}=${process.env[k]}` : '').filter(Boolean).join(' ')
          const cmd = `${kv} python3 -m venv .venv && .venv/bin/python -m pip -q install -U pip && .venv/bin/pip -q install -r requirements.txt && ${kv} .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8082`
          return startServer(
            'fastapi',
            'wsl.exe',
            ['--cd', winPathToWsl(repoRoot() + '/apps/baseline-fastapi'), 'bash', '-lc', cmd],
            { env: baseEnv }
          )
        })()
      : startServer(
          'fastapi',
          process.platform === 'win32' ? (process.env.PYTHON || 'python') : (process.env.PYTHON || 'python'),
          ['-m','uvicorn','app.main:app','--host', process.platform === 'win32' ? '127.0.0.1' : '0.0.0.0','--port','8082'],
          { env: baseEnv, cwd: repoRoot() + '/apps/baseline-fastapi' }
        )

    try {
      await Promise.all([
        waitHealthy('elide','http://localhost:8080/healthz'),
        waitHealthy('express','http://localhost:8081/healthz'),
        waitHealthy('fastapi','http://localhost:8082/healthz'),
      ])

      const runForTier = async (tier: {c:number,t:number}) => {
        const envElide = { ...baseEnv, TRIO_CONCURRENCY: String(tier.c), TRIO_TOTAL: String(tier.t), LLM_MODEL: 'synthetic', SAMPLING_PID: String(elide.pid || '') }
        const envExpress = { ...baseEnv, TRIO_CONCURRENCY: String(tier.c), TRIO_TOTAL: String(tier.t), SAMPLING_PID: String(express.pid || '') }
        const envFastapi = { ...baseEnv, TRIO_CONCURRENCY: String(tier.c), TRIO_TOTAL: String(tier.t), SAMPLING_PID: String(fastapi.pid || '') }
        const outE = `bench-elide.${tier.c}x${tier.t}.html`
        const outX = `bench-express.${tier.c}x${tier.t}.html`
        const outF = `bench-fastapi.${tier.c}x${tier.t}.html`
        if (sequential) {
          await runSweep('elide','http://localhost:8080', outE, envElide)
          await runSweep('express','http://localhost:8081', outX, envExpress)
          await runSweep('fastapi','http://localhost:8082', outF, envFastapi)
        } else {
          await Promise.all([
            runSweep('elide','http://localhost:8080', outE, envElide),
            runSweep('express','http://localhost:8081', outX, envExpress),
            runSweep('fastapi','http://localhost:8082', outF, envFastapi),
          ])
        }
      }

      for (const tier of tiers) {
        await runForTier(tier)
      }
    } finally {
      await killTree(elide.pid)
      await killTree(express.pid)
      await killTree(fastapi.pid)
    }
    return
  }

  // Default: just run against already-running servers
  const tier = parseTiers()[0]
  await Promise.all([
    runSweep('elide', 'http://localhost:8080', `bench-elide.${tier.c}x${tier.t}.html`, { LLM_MODEL: 'synthetic' }),
    runSweep('express', 'http://localhost:8081', `bench-express.${tier.c}x${tier.t}.html`),
    runSweep('fastapi', 'http://localhost:8082', `bench-fastapi.${tier.c}x${tier.t}.html`),
  ])
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

