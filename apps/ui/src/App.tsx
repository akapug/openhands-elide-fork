import React, { useEffect, useMemo, useRef, useState } from 'react'

type Msg = { role: 'system'|'user'|'assistant'; content: string }

type Settings = {
  baseURL: string
  apiKey: string
  model: string
  runtime: 'elide'|'docker'
}

const defaultSettings: Settings = {
  baseURL: import.meta.env.VITE_LLM_BASE_URL || 'http://localhost:1234/v1',
  apiKey: import.meta.env.VITE_LLM_API_KEY || 'lm-studio',
  model: import.meta.env.VITE_LLM_MODEL || 'openai/gpt-oss-120b',
  runtime: 'elide',
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => {
    const raw = localStorage.getItem('settings')
    return raw ? JSON.parse(raw) : defaultSettings
  })
  const [input, setInput] = useState('Explain Elide in 2 sentences.')
  const [messages, setMessages] = useState<Msg[]>([])
  const [streaming, setStreaming] = useState(false)
  const [showReasoning, setShowReasoning] = useState(false)
  const [reasoning, setReasoning] = useState('')
  const taRef = useRef<HTMLTextAreaElement|null>(null)

  useEffect(() => { localStorage.setItem('settings', JSON.stringify(settings)) }, [settings])

  const send = async () => {
    setStreaming(true)
    const body = {
      model: settings.model,
      messages: [...messages, { role: 'user', content: input }],
      stream: true,
      max_tokens: 256,
      temperature: 0.2,
    }
    const res = await fetch(`/api/chat/completions`, {
      method: 'POST',
      headers: { 'content-type':'application/json' },
      body: JSON.stringify({ ...body, runtime: settings.runtime, baseURL: settings.baseURL, apiKey: settings.apiKey }),
    })
    if (!res.ok || !res.body) {
      setStreaming(false)
      setMessages(m => [...m, { role:'assistant', content:`[error ${res.status}]` }])
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let assistant = ''
    setMessages(m => [...m, { role:'user', content: input }])
    setInput('')
    setReasoning('')
    let doneFlag = false
    while (!doneFlag) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Process SSE frames separated by blank lines
      const frames = buffer.split('\n\n')
      buffer = frames.pop() || ''
      for (const frame of frames) {
        // Each frame may contain multiple lines; we only care about lines starting with 'data: '
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') { doneFlag = true; break }
          try {
            const json = JSON.parse(payload)
            const delta = json?.choices?.[0]?.delta || {}
            if (typeof delta.content === 'string' && delta.content.length) {
              assistant += delta.content
              setMessages(m => {
                const ms = m.slice()
                const last = ms[ms.length-1]
                if (!last || last.role !== 'assistant') ms.push({ role:'assistant', content: assistant })
                else last.content = assistant
                return ms
              })
            }
            if (typeof delta.reasoning === 'string' && delta.reasoning.length) {
              setReasoning(r => r + delta.reasoning)
            }
          } catch {}
        }
      }
    }
    setStreaming(false)
  }

  return (
    <div style={{ display:'grid', gridTemplateColumns:'300px 1fr', height:'100vh' }}>
      <aside style={{ padding:12, borderRight:'1px solid #ddd' }}>
        <h3>Settings</h3>
        <label>Runtime
          <select value={settings.runtime} onChange={e=>setSettings(s=>({ ...s, runtime:e.target.value as any }))}>
            <option value="elide">Elide</option>
            <option value="docker">Docker</option>
          </select>
        </label>
        <label>Base URL
          <input value={settings.baseURL} onChange={e=>setSettings(s=>({ ...s, baseURL:e.target.value }))} />
        </label>
        <label>API Key
          <input value={settings.apiKey} onChange={e=>setSettings(s=>({ ...s, apiKey:e.target.value }))} />
        </label>
        <label>Model
          <input value={settings.model} onChange={e=>setSettings(s=>({ ...s, model:e.target.value }))} />
        </label>
        <label>
          <input type="checkbox" checked={showReasoning} onChange={e=>setShowReasoning(e.target.checked)} /> Show reasoning
        </label>
        <button onClick={()=>localStorage.removeItem('settings')}>Reset</button>
      </aside>
      <main style={{ padding:12 }}>
        <h2>OpenHands–Elide</h2>
        <div style={{ marginBottom:12 }}>
          <textarea ref={taRef} rows={4} style={{ width:'100%' }} value={input} onChange={e=>setInput(e.target.value)} />
          <button onClick={send} disabled={streaming}>Send</button>
        </div>
        <div style={{ height:'40vh', overflow:'auto', border:'1px solid #eee', padding:8 }}>
          {messages.map((m,i)=> (
            <div key={i} style={{ whiteSpace:'pre-wrap', margin:'8px 0' }}>
              <b>{m.role}:</b> {m.content}
            </div>
          ))}
        </div>
        {showReasoning && (
          <div style={{ marginTop:8, padding:8, border:'1px dashed #ddd', background:'#fafafa', whiteSpace:'pre-wrap' }}>
            <b>Reasoning:</b> {reasoning}
          </div>
        )}

        <hr style={{ margin:'16px 0' }} />
        <h3>Bench (local :8080)</h3>
        <BenchPanel />
      </main>
    </div>
  )
}

function BenchPanel() {
  const [target, setTarget] = useState('http://localhost:8080')
  const [modesSuite, setModesSuite] = useState<string[]>(['sse','micro-plain','micro-chunked'])
  const [concList, setConcList] = useState<number[]>([8,32,64,128])
  const [customConc, setCustomConc] = useState('8,32,64,128,256,512,1024,2048,4096')
  const cancelRef = useRef(false)
  const [cliPid, setCliPid] = useState<number|null>(null)

  const cliES = useRef<EventSource|null>(null)
  const [cliSamples, setCliSamples] = useState<Array<{t:number,cpu:number,rssMb:number}>>([])
  const [cliLinks, setCliLinks] = useState<{log?:string,index?:string}>({})


  const [mode, setMode] = useState<'sse'|'micro-plain'|'micro-chunked'>('sse')
  const [concurrency, setConcurrency] = useState(64)
  const [total, setTotal] = useState(256)
  const [bytes, setBytes] = useState(64)
  const [frames, setFrames] = useState(200)
  const [delayMs, setDelayMs] = useState(5)
  const [fanout, setFanout] = useState(0)
  const [cpuSpinMs, setCpuSpinMs] = useState(0)
  const [gzip, setGzip] = useState(true)
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<any|null>(null)
  // Apex search settings
  const [apexTtftP95Max, setApexTtftP95Max] = useState(250)
  const [apexStart, setApexStart] = useState(32)
  const [apexMax, setApexMax] = useState(8192)


  const p = (arr:number[], q:number)=>{
    if (!arr.length) return 0; const a=[...arr].sort((a,b)=>a-b); const i=Math.min(a.length-1, Math.max(0, Math.floor(q*(a.length-1)))); return a[i]
  }

  async function runOnce(): Promise<{ttft?:number, dur:number}> {
    const t0 = performance.now()
    if (mode === 'sse') {
      const res = await fetch('/api/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'synthetic', runtime: 'elide',
          frames, delay_ms: delayMs, bytes_per_frame: bytes,
          cpu_spin_ms: cpuSpinMs, fanout, gzip,
        })
      })
      if (!res.ok || !res.body) return { dur: performance.now()-t0 }
      const reader = res.body.getReader(); let ttft: number | undefined
      const readStart = performance.now()
      while (true) {
        const { done, value } = await reader.read();
        if (done) break
        if (ttft === undefined) ttft = performance.now()-readStart
      }
      return { ttft, dur: performance.now()-t0 }
    }
    if (mode === 'micro-plain') {
      const url = new URL('/micro/plain', target)
      url.searchParams.set('bytes', String(bytes))
      if (gzip) url.searchParams.set('gzip', '1')
      const res = await fetch(String(url)); await res.arrayBuffer()
      return { dur: performance.now()-t0 }
    }
    // micro-chunked
    const url = new URL('/micro/chunked', target)
    url.searchParams.set('bytes', String(bytes)); url.searchParams.set('chunks', '4')
    url.searchParams.set('delay_ms', String(delayMs)); if (gzip) url.searchParams.set('gzip', '1')
    const res = await fetch(String(url)); const r0 = performance.now();
    if (!res.body) return { dur: performance.now()-t0 }
    const reader = res.body.getReader(); let ttft: number | undefined
    while (true) { const { done } = await reader.read(); if (ttft===undefined) ttft = performance.now()-r0; if (done) break }
    return { ttft, dur: performance.now()-t0 }
  }

  async function runBench() {
    setRunning(true); setSummary(null)
    const ttfts:number[] = [], durs:number[] = []
    let inflight = 0, done = 0
    async function spawn() {
      while (done < total) {
        if (inflight >= concurrency) { await new Promise(r=>setTimeout(r,1)); continue }
        inflight++
        runOnce().then(({ttft, dur})=>{ if (ttft!==undefined) ttfts.push(ttft); durs.push(dur) }).finally(()=>{ inflight--; done++ })
      }
      while (inflight>0) await new Promise(r=>setTimeout(r,1))
    }
    await spawn()
    const elapsed = durs.length ? Math.max(...durs) : 0
    const rps = elapsed>0 ? (total * 1000) / elapsed : 0

    setSummary({
      count: total, rps: Number(rps.toFixed(2)),
      ttft_p50: ttfts.length?Number(p(ttfts,0.5).toFixed(2)):undefined,
      ttft_p95: ttfts.length?Number(p(ttfts,0.95).toFixed(2)):undefined,
      ttft_p99: ttfts.length?Number(p(ttfts,0.99).toFixed(2)):undefined,
      dur_p50: Number(p(durs,0.5).toFixed(2)), dur_p95: Number(p(durs,0.95).toFixed(2)), dur_p99: Number(p(durs,0.99).toFixed(2)),
    })
    setRunning(false)
  }

  async function benchSummary(c:number, t:number) {
    const ttfts:number[] = [], durs:number[] = []
    let inflight = 0, done = 0
    async function spawn() {
      while (done < t) {
        if (inflight >= c) { await new Promise(r=>setTimeout(r,1)); continue }
        inflight++
        runOnce().then(({ttft, dur})=>{ if (ttft!==undefined) ttfts.push(ttft); durs.push(dur) }).finally(()=>{ inflight--; done++ })
      }
      while (inflight>0) await new Promise(r=>setTimeout(r,1))
    }
    await spawn()
    const elapsed = durs.length ? Math.max(...durs) : 0
    const rps = elapsed>0 ? (t * 1000) / elapsed : 0
    return {
      count: t, rps: Number(rps.toFixed(2)),
      ttft_p50: ttfts.length?Number(p(ttfts,0.5).toFixed(2)):undefined,
      ttft_p95: ttfts.length?Number(p(ttfts,0.95).toFixed(2)):undefined,
      ttft_p99: ttfts.length?Number(p(ttfts,0.99).toFixed(2)):undefined,
      dur_p50: Number(p(durs,0.5).toFixed(2)), dur_p95: Number(p(durs,0.95).toFixed(2)), dur_p99: Number(p(durs,0.99).toFixed(2)),
    }
  }

  async function runFullSuite() {
    setRunning(true); setSummary(null)
    const tiers = (customConc || '8,32,64,128,256,512,1024,2048,4096')
      .split(',')
      .map(s=>Number(s.trim()))
      .filter(n=>Number.isFinite(n) && n>0)
    const runs:any[] = []
    const selModes = modesSuite.length ? modesSuite : [mode]
    for (const m of selModes) {
      for (const c of tiers) {
        const t = c * 4
        // temporarily switch mode to reuse benchSummary()
        setMode(m as any)
        await new Promise(r=>setTimeout(r,0))
        const s = await benchSummary(c, t)
        runs.push({
          mode: m, concurrency: c, total: t, bytes, frames, delay_ms: delayMs, fanout, cpu_spin_ms: cpuSpinMs, gzip, summary: s,
        })
      }
    }
    await fetch('/bench/ui-save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meta: { target, modes: selModes, ts: Date.now() }, runs })
    })
    setRunning(false)
  }

  async function runBinarySearch() {
    setRunning(true); setSummary(null)
    const trials:any[] = []
    const m0 = mode
    const metricOf = (s:any)=> (s?.ttft_p95 ?? s?.dur_p95 ?? Infinity)
    const isOk = (s:any)=> metricOf(s) <= apexTtftP95Max
    // probe function that records
    const probe = async (c:number)=>{
      const t = Math.max(4, c*4)
      const s = await benchSummary(c, t)
      trials.push({ mode, concurrency:c, total:t, bytes, frames, delay_ms:delayMs, fanout, cpu_spin_ms:cpuSpinMs, gzip, summary: s })
      return s
    }
    try{
      // doubling phase
      let lo = Math.max(1, apexStart)
      let hi = lo
      setMode(m0) // ensure unchanged
      await new Promise(r=>setTimeout(r,0))
      let s = await probe(hi)
      if (!isOk(s)){
        // decrease to find any acceptable
        while (lo > 1){
          hi = lo; lo = Math.max(1, Math.floor(lo/2))
          s = await probe(lo)
          if (isOk(s)) break
          if (lo<=1) break
        }
        if (!isOk(s)) {
          await fetch('/bench/ui-save', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ meta:{ target, type:'binary_search', mode:m0, threshold:apexTtftP95Max, ts:Date.now() }, trials }) })
          setRunning(false); return
        }
      } else {
        // grow until we fail or reach apexMax
        while (isOk(s) && hi < apexMax){
          lo = hi
          hi = Math.min(apexMax, hi*2)
          s = await probe(hi)
        }
      }
      // binary search
      while (hi - lo > 1){
        const mid = Math.floor((lo+hi)/2)
        const sm = await probe(mid)

        if (isOk(sm)) lo = mid; else hi = mid
      }
      const best = trials.reduce((a:any,b:any)=> (b.summary?.rps ?? 0) > (a.summary?.rps ?? 0) ? b : a, trials[0])
      await fetch('/bench/ui-save', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ meta:{ target, type:'binary_search', mode:m0, threshold:apexTtftP95Max, ts:Date.now(), best:{concurrency:best?.concurrency, rps:best?.summary?.rps} }, trials }) })
    } finally {
      setMode(m0)
      setRunning(false)
    }
  }


  const [cliStatus, setCliStatus] = useState<string>('')
  const [cliLogs, setCliLogs] = useState<string[]>([])

  function toggleModeInSuite(m:string){
    setModesSuite(prev=> prev.includes(m) ? prev.filter(x=>x!==m) : [...prev, m])
  }


  async function runCliSuite(){
    try{
      setCliStatus('starting CLI run...')
      const tiers = (customConc || '8,32,64,128,256,512,1024,2048,4096')
        .split(',').map(s=>Number(s.trim())).filter(n=>Number.isFinite(n) && n>0)

      const resp = await fetch('/bench/run-cli', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({
        concurrency: tiers,
        totals: tiers.map((c:number)=>c*4),
        frames, delay_ms: delayMs, bytes, cpu_spin_ms: cpuSpinMs,
        fanout, fanout_delay_ms: 0, gzip,
        startServers: true, wslNode: false, wslFastapi: false,
      })})
      const j = await resp.json()
      if (!j.ok){ setCliStatus('CLI run failed to start: '+(j.error||'unknown')); return }
      setCliPid(j.pid)
      setCliStatus('running (pid '+j.pid+')...')
      setCliSamples([]); setCliLinks({}); setCliLogs([])
      if (cliES.current) { try{ cliES.current.close() }catch{}; cliES.current = null }
      const pid = j.pid
      const es = new EventSource('/bench/run-cli/stream?pid='+pid)
      cliES.current = es
      es.addEventListener('status', (ev:any)=>{
        try{ const d = JSON.parse(ev.data); const rel = String(d.log||'').replace(/^packages[\\\/]bench[\\\/]results[\\\/]/,'/results/'); setCliStatus(`status: ${d.status} (log: ${rel})`) }catch{}
      })
      es.addEventListener('sample', (ev:any)=>{
        try{ const d = JSON.parse(ev.data); setCliSamples(prev=>{ const arr = prev.concat({t:d.t,cpu:d.cpu,rssMb:d.rssMb}); return arr.length>240?arr.slice(-240):arr }) }catch{}
      })
      es.addEventListener('log', (ev:any)=>{
        try{ const d = JSON.parse(ev.data); const line = (d?.text ?? String(ev.data)) + '\n'; setCliLogs(prev=>{ const arr = prev.concat(line); return arr.length>200?arr.slice(-200):arr }) }catch{ setCliLogs(prev=>{ const arr = prev.concat(String(ev.data)+'\n'); return arr.length>200?arr.slice(-200):arr }) }
      })
      es.addEventListener('done', (ev:any)=>{
        try{ const d = JSON.parse(ev.data); const log = String(d.log||'').replace(/^packages[\\\/]bench[\\/]results[\\\/]/,'/results/'); setCliLinks({ log, index: String(d.index||'/results/index.html') }); setCliStatus(`done (status: ${d.status})`) }catch{}
        try{ es.close() }catch{}; cliES.current = null
      })
    }catch(e:any){ setCliStatus('error: '+(e?.message||String(e))) }
  }

  async function cancelCli(){
    if (!cliPid) return
    await fetch('/bench/run-cli/cancel?pid='+cliPid, { method:'POST' })
    setCliStatus('cancel requested for pid '+cliPid)
    try{ cliES.current?.close() }catch{}
    cliES.current = null
  }

  return (
    <div style={{ border:'1px solid #eee', padding:8 }}>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
        <label>Target <input value={target} onChange={e=>setTarget(e.target.value)} style={{ width:220 }} /></label>
        <label>Mode
          <select value={mode} onChange={e=>setMode(e.target.value as any)}>
            <option value="sse">SSE synthetic</option>
            <option value="micro-plain">Micro plain</option>
            <option value="micro-chunked">Micro chunked</option>
          </select>
        </label>
        <label>Concurrency <input type="number" value={concurrency} onChange={e=>setConcurrency(Number(e.target.value))} style={{ width:90 }} /></label>
        <label>Total <input type="number" value={total} onChange={e=>setTotal(Number(e.target.value))} style={{ width:90 }} /></label>
        <label>Bytes <input type="number" value={bytes} onChange={e=>setBytes(Number(e.target.value))} style={{ width:90 }} /></label>
        {mode==='sse' && (<>
          <label>Frames <input type="number" value={frames} onChange={e=>setFrames(Number(e.target.value))} style={{ width:90 }} /></label>
          <label>Delay ms <input type="number" value={delayMs} onChange={e=>setDelayMs(Number(e.target.value))} style={{ width:90 }} /></label>
          <label>Fanout <input type="number" value={fanout} onChange={e=>setFanout(Number(e.target.value))} style={{ width:90 }} /></label>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span>Suite modes:</span>
          <label><input type="checkbox" checked={modesSuite.includes('sse')} onChange={()=>toggleModeInSuite('sse')} /> SSE</label>
          <label><input type="checkbox" checked={modesSuite.includes('micro-plain')} onChange={()=>toggleModeInSuite('micro-plain')} /> Micro plain</label>
          <label><input type="checkbox" checked={modesSuite.includes('micro-chunked')} onChange={()=>toggleModeInSuite('micro-chunked')} /> Micro chunked</label>
        </div>


        <div style={{ flexBasis:'100%', height:8 }} />

          <label>CPU spin ms <input type="number" value={cpuSpinMs} onChange={e=>setCpuSpinMs(Number(e.target.value))} style={{ width:110 }} /></label>
        {cliSamples.length>0 && (()=>{ const last = cliSamples[cliSamples.length-1]; const cpu=Number(last.cpu||0).toFixed(1); const rss=Number(last.rssMb||0).toFixed(1); return (<div style={{ fontFamily:'monospace' }}>Live: CPU {cpu}% | RSS {rss} MB | samples {cliSamples.length}</div>) })()}
        {(cliLinks.index || cliLinks.log) && (
          <div style={{ display:'flex', gap:8 }}>
            {cliLinks.index && <a href={cliLinks.index} target="_blank" rel="noreferrer">Open results index</a>}
            {cliLinks.log && <a href={cliLinks.log} target="_blank" rel="noreferrer">Open log</a>}
          </div>
        )}
        {cliLogs.length>0 && (
          <pre style={{ maxHeight:160, overflow:'auto', background:'#111', color:'#0f0', padding:8 }}>
            {cliLogs.slice(-40).join('')}
          </pre>
        )}

        <div style={{ flexBasis:'100%', height:8 }} />

        </>)}
        <label>Concurrency tiers (CSV) <input value={customConc} onChange={e=>setCustomConc(e.target.value)} style={{ width:320 }} placeholder="e.g. 8,32,64,128,256,512,1024,2048,4096" /></label>
        <button onClick={()=>setCustomConc('64,128,256,512,1024,2048,4096')} disabled={running}>Preset: Max (64..4096)</button>
        <div style={{ flexBasis:'100%', height:8 }} />

        <label>Apex p95 max ms <input type="number" value={apexTtftP95Max} onChange={e=>setApexTtftP95Max(Number(e.target.value))} style={{ width:110 }} /></label>
        <label>Start conc <input type="number" value={apexStart} onChange={e=>setApexStart(Number(e.target.value))} style={{ width:90 }} /></label>
        <label>Max conc <input type="number" value={apexMax} onChange={e=>setApexMax(Number(e.target.value))} style={{ width:110 }} /></label>
        <button onClick={runBinarySearch} disabled={running} title="Find maximum sustainable concurrency under ttft p95 threshold">Binary search for apex</button>
        <div style={{ flexBasis:'100%', height:8 }} />



        {mode!=='sse' && (

          <label>Delay ms <input type="number" value={delayMs} onChange={e=>setDelayMs(Number(e.target.value))} style={{ width:90 }} /></label>
        )}
        <label><input type="checkbox" checked={gzip} onChange={e=>setGzip(e.target.checked)} /> gzip</label>
        <button onClick={runBench} disabled={running}>{running?'Running...':'Run'}</button>
        <button onClick={runFullSuite} disabled={running} title="Runs 8x64, 32x128, 64x256, 128x512 and saves to results/index.html via /bench/ui-save">{running?'Running...':'Run full sweep + save'}</button>
        <button onClick={runCliSuite} disabled={false} title="Run bench CLI with selected tiers; auto-updates results/index.html">Run via CLI (trio)</button>
        <button onClick={cancelCli} disabled={!cliPid}>Cancel CLI</button>
        {cliStatus && <span style={{ fontFamily:'monospace' }}> {cliStatus} </span>}

      </div>


      {summary && (
        <div style={{ marginTop:8, fontFamily:'monospace' }}>
          RPS {summary.rps} | ttft p50/p95/p99: {summary.ttft_p50 ?? '-'} / {summary.ttft_p95 ?? '-'} / {summary.ttft_p99 ?? '-'} ms | dur p50/p95/p99: {summary.dur_p50} / {summary.dur_p95} / {summary.dur_p99} ms
        </div>
      )}
    </div>
  )
}


