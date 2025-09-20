import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

function repoRoot() {
  const here = dirname(fileURLToPath(import.meta.url))
  // packages/e2e/tests -> repo root is ../../..
  return join(here, '..', '..', '..')
}

async function waitHealth(url: string) {
  for (let i=0;i<30;i++) {
    try { const r = await fetch(url + '/healthz'); if (r.ok) return } catch {}
    await new Promise(r=>setTimeout(r, 500))
  }
  throw new Error('server not healthy')
}

test('bench sweep runs and writes HTML report', async () => {
  const root = repoRoot()
  await waitHealth('http://127.0.0.1:8080')
  const cmd = 'node'
  const args = ['packages/bench/dist/cli.js', 'sweep', '--base-url=http://127.0.0.1:8080', '--concurrency=1', '--total=2', '--prompt=Hi from E2E', '--html']
  const out = execFileSync(cmd, args, { cwd: root, stdio: 'pipe' }).toString('utf8')
  // Should print JSON and write bench-report.html
  const htmlPath = join(root, 'bench-report.html')
  expect(existsSync(htmlPath)).toBeTruthy()
  const html = readFileSync(htmlPath, 'utf8')
  expect(html).toContain('<title>Bench Report</title>')
  // Sanity: JSON output should include mode: sweep
  expect(out).toContain('"mode": "sweep"')
})

