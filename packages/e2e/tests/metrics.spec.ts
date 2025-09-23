import { test, expect } from '@playwright/test'

async function getMetricsText(baseURL: string, request: any) {
  const res = await request.get(`${baseURL}/metrics`)
  expect(res.ok()).toBeTruthy()
  return await res.text()
}

function getCounter(metrics: string, name: string, labels: Record<string,string>) {
  const lines = metrics.split('\n').filter(l => l.startsWith(name))
  for (const l of lines) {
    const m = l.match(/^(\w+)(\{[^}]*\})?\s+(\d+(?:\.\d+)?)/)
    if (!m) continue
    const labelStr = m[2] || ''
    let ok = true
    for (const [k,v] of Object.entries(labels)) {
      if (!labelStr.includes(`${k}="${v}"`)) { ok = false; break }
    }
    if (ok) return Number(m[3])
  }
  return 0
}

function getHistCount(metrics: string, name: string, labels: Record<string,string>) {
  return getCounter(metrics, `${name}_count`, labels)
}

async function waitHealth(url: string, request: any) {
  for (let i=0;i<30;i++) {
    try { const r = await request.get(`${url}/healthz`); if (r.ok()) return }
    catch {}
    await new Promise(r=>setTimeout(r, 500))
  }
  throw new Error('server not healthy')
}

test('chat request increments metrics on error path (no upstream)', async ({ page, request, baseURL }) => {
  const url = baseURL || 'http://127.0.0.1:8080'
  await waitHealth(url, request)
  // baseline metrics
  const before = await getMetricsText(url, request)
  const beforeReq500 = getCounter(before, 'chat_requests_total', { runtime: 'elide', model: 'openai/gpt-oss-120b', status: '500' })
  const beforeDurCount = getHistCount(before, 'chat_duration_ms', { runtime: 'elide', model: 'openai/gpt-oss-120b' })

  // note: error reasons are exposed in chat_errors_total with reason label; we'll assert presence post-call

  // trigger a request that will 500 upstream via direct API call (more robust than UI clicking)
  const chatRes = await request.post(url + '/api/chat/completions', {
    data: {
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      runtime: 'elide',
      baseURL: 'http://localhost:9/v1'
    }
  })
  expect(chatRes.status()).toBe(500)

  // post metrics
  const after = await getMetricsText(url, request)
  const afterReq500 = getCounter(after, 'chat_requests_total', { runtime: 'elide', model: 'openai/gpt-oss-120b', status: '500' })
  const afterDurCount = getHistCount(after, 'chat_duration_ms', { runtime: 'elide', model: 'openai/gpt-oss-120b' })

  expect(after).toContain('chat_errors_total')
  expect(after.includes('reason="upstream_500"') || after.includes('reason="exception"')).toBeTruthy()

  expect(afterReq500).toBeGreaterThan(beforeReq500)
  expect(afterDurCount).toBeGreaterThan(beforeDurCount)
})

