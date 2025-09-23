import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function run(name: string, cmd: string, args: string[], opts: any = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...opts })
  child.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`))
  child.stderr.on('data', d => process.stderr.write(`[${name}][err] ${d}`))
  child.on('exit', code => {
    console.error(`[${name}] exited with code ${code}`)
    process.exit(code ?? 1)
  })
  return child
}

async function main() {
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

  // Elide server (Node)
  run('elide', pnpmCmd, ['-C', 'apps/server-elide', 'dev'])

  // Express baseline (Node) — build then run dist without requiring tsx
  try {
    const build = spawnSync(pnpmCmd, ['-C', 'apps/baseline-express', 'build'], { stdio: 'inherit' })
    if (build.status !== 0) throw new Error(`express build failed with code ${build.status}`)
    run('express', 'node', ['dist/index.js'], { cwd: join(process.cwd(), 'apps', 'baseline-express') })
  } catch (e) {
    console.error('[express] failed to start:', (e as any)?.message || e)
  }

  // FastAPI baseline (Python)
  const venvPy = process.platform === 'win32'
    ? join('apps', 'baseline-fastapi', '.venv', 'Scripts', 'python.exe')
    : join('apps', 'baseline-fastapi', '.venv', 'bin', 'python')
  const python = existsSync(venvPy) ? venvPy : 'python'
  run('fastapi', python, ['-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', '8082'], {
    cwd: join(process.cwd(), 'apps', 'baseline-fastapi')
  })

  // Flask baseline (Python)
  run('flask', pnpmCmd, ['-C', 'apps/baseline-flask', 'dev'])

  // Elide runtime: try environment first, then auto-detect Elide repo with tools/scripts/server.js
  const elideCmdEnv = process.env.BENCH_ELIDE_CMD || process.env.BENCH_ELIDE_RT_CMD || ''
  if (elideCmdEnv) {
    try {
      const child = spawn(elideCmdEnv, { stdio: ['ignore','pipe','pipe'], shell: true, cwd: process.cwd() })
      child.stdout.on('data', d => process.stdout.write(`[elide-rt] ${d}`))
      child.stderr.on('data', d => process.stderr.write(`[elide-rt][err] ${d}`))
      child.on('exit', code => console.error(`[elide-rt] exited with code ${code}`))
      console.log('[elide-rt] started via BENCH_ELIDE_CMD')
    } catch (e:any) {
      console.error('[elide-rt] failed to start (env):', e?.message || e)
    }
  } else {
    // Try native Elide CLI if available
    let started = false
    const elideBin = process.platform === 'win32' ? 'elide.exe' : 'elide'
    try {
      const check = spawnSync(elideBin, ['--help'], { stdio: 'ignore' })
      if (check && check.status === 0) {
        run('elide-rt', elideBin, ['serve', '--port', '8084'])
        console.log('[elide-rt] started via detected Elide CLI ("elide serve --port 8084")')
        started = true
      }
    } catch {}

    // Fallback: auto-detect Elide repo and use sample server.js script
    if (!started) {
      const candidates: string[] = []
      if (process.env.BENCH_ELIDE_REPO) candidates.push(process.env.BENCH_ELIDE_REPO)
      candidates.push(join(process.cwd(), '..', 'elide'))
      candidates.push(join(process.cwd(), 'elide'))

      for (const dir of candidates) {
        const script = join(dir, 'tools', 'scripts', 'server.js')
        if (existsSync(script)) {
          try {
            run('elide-rt', 'node', [script, '--port', '8084'], { cwd: dir })
            console.log(`[elide-rt] started from ${script}`)
            started = true
            break
          } catch (e:any) {
            console.error('[elide-rt] failed to start from script:', script, e?.message || e)
          }
        }
      }
    }

    if (!started) {
      console.log('[elide-rt] No BENCH_ELIDE_CMD set, Elide CLI not found, and no tools/scripts/server.js in BENCH_ELIDE_REPO, ../elide, or ./elide; Elide runtime not started')
    }
  }

  console.log('Started Elide:8080, Express:8081, FastAPI:8082, Flask:8083, Elide-RT:8084 (if available)')
  console.log('Press Ctrl+C to stop all')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

