import { spawn } from 'node:child_process'

function runSweep(name: string, baseURL: string, out: string, extraEnv: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => {
    const args = [
      'packages/bench/dist/cli.js', 'sweep',
      `--base-url=${baseURL}`,
      `--concurrency=${process.env.TRIO_CONCURRENCY || '8'}`,
      `--total=${process.env.TRIO_TOTAL || '64'}`,
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

async function waitHealthy(name: string, url: string, timeoutMs = 20000) {
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

async function main() {
  if (String(process.env.TRIO_START_SERVERS || '').toLowerCase() === '1' || String(process.env.TRIO_START_SERVERS || '').toLowerCase() === 'true') {
    // Start servers with SYN_* envs propagated
    const baseEnv = { ...process.env }

    const elide = startServer(
      'elide',
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['-C','apps/server-elide','dev'],
      { env: baseEnv }
    )
    const express = startServer(
      'express',
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['-C','apps/baseline-express','dev'],
      { env: baseEnv }
    )
    const fastapi = startServer(
      'fastapi',
      process.platform === 'win32' ? (process.env.PYTHON || 'python') : (process.env.PYTHON || 'python'),
      ['-m','uvicorn','app.main:app','--host', process.platform === 'win32' ? '127.0.0.1' : '0.0.0.0','--port','8082'],
      { env: baseEnv, cwd: process.cwd() + '/apps/baseline-fastapi' }
    )

    try {
      await Promise.all([
        waitHealthy('elide','http://localhost:8080/healthz'),
        waitHealthy('express','http://localhost:8081/healthz'),
        waitHealthy('fastapi','http://localhost:8082/healthz'),
      ])
      await Promise.all([
        runSweep('elide', 'http://localhost:8080', 'bench-elide.html', { LLM_MODEL: 'synthetic', SAMPLING_PID: String(elide.pid || '') }),
        runSweep('express', 'http://localhost:8081', 'bench-express.html', { SAMPLING_PID: String(express.pid || '') }),
        runSweep('fastapi', 'http://localhost:8082', 'bench-fastapi.html', { SAMPLING_PID: String(fastapi.pid || '') }),
      ])
    } finally {
      elide.kill()
      express.kill()
      fastapi.kill()
    }
    return
  }

  // Default: just run against already-running servers
  await Promise.all([
    runSweep('elide', 'http://localhost:8080', 'bench-elide.html', { LLM_MODEL: 'synthetic' }),
    runSweep('express', 'http://localhost:8081', 'bench-express.html'),
    runSweep('fastapi', 'http://localhost:8082', 'bench-fastapi.html'),
  ])
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

