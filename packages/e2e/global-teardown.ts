import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execSync } from 'node:child_process'

function repoRoot() {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..')
}

function killTree(pid?: number | null) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {}
}

export default async function globalTeardown() {
  const root = repoRoot()
  try {
    const p = JSON.parse(readFileSync(join(root, '.e2e-pids.json'), 'utf8'))
    killTree(p.server)
    killTree(p.ui)
  } catch {}
}

