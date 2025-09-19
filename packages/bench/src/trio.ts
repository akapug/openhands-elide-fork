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

async function main() {
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

