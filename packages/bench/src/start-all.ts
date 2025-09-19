import { spawn } from 'node:child_process'
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
  // Elide server (Node)
  run('elide', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['-C', 'apps/server-elide', 'dev'])

  // Express baseline (Node)
  run('express', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['-C', 'apps/baseline-express', 'dev'])

  // FastAPI baseline (Python)
  const venvPy = process.platform === 'win32'
    ? join('apps', 'baseline-fastapi', '.venv', 'Scripts', 'python.exe')
    : join('apps', 'baseline-fastapi', '.venv', 'bin', 'python')
  const python = existsSync(venvPy) ? venvPy : 'python'
  run('fastapi', python, ['-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', '8082'], {
    cwd: join(process.cwd(), 'apps', 'baseline-fastapi')
  })

  console.log('Started Elide:8080, Express:8081, FastAPI:8082')
  console.log('Press Ctrl+C to stop all')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

