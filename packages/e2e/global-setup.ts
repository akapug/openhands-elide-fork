import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'

function repoRoot() {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..')
}

async function waitHttp(url: string, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if ((r as any).ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Timeout waiting for ${url}`)
}

export default async function globalSetup() {
  const root = repoRoot()

  const server = spawn('pnpm', ['-C', 'apps/server-elide', 'dev'], {
    cwd: root,
    shell: true,
    stdio: 'inherit'
  })
  const ui = spawn('pnpm', ['-C', 'apps/ui', 'dev'], {
    cwd: root,
    shell: true,
    stdio: 'inherit'
  })

  // Wait for server health and UI root to load
  await waitHttp('http://127.0.0.1:8080/healthz')
  await waitHttp('http://127.0.0.1:8080/')

  // Persist PIDs for teardown
  const pids = { server: server.pid, ui: ui.pid }
  writeFileSync(join(root, '.e2e-pids.json'), JSON.stringify(pids), 'utf8')
}

