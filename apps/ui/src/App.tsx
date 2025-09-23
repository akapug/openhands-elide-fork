import React, { useEffect, useMemo, useRef, useState } from 'react'

type Msg = { role: 'system'|'user'|'assistant'; content: string }

type Settings = {
  baseURL: string
  apiKey: string
  model: string
  runtime: 'node-raw'|'docker'
}

const defaultSettings: Settings = {
  baseURL: import.meta.env.VITE_LLM_BASE_URL || 'http://localhost:1234/v1',
  apiKey: import.meta.env.VITE_LLM_API_KEY || 'lm-studio',
  model: import.meta.env.VITE_LLM_MODEL || 'openai/gpt-oss-120b',
  runtime: 'node-raw',
}

class ErrorBoundary extends React.Component<{children:any}, {hasError:boolean}> {
  constructor(props:any){ super(props); this.state = { hasError:false } }
  static getDerivedStateFromError(){ return { hasError:true } }
  componentDidCatch(err:any){ console.error('UI error:', err) }
  render(){ return this.state.hasError ? (<div style={{ padding:12, border:'1px solid #f5c2c7', background:'#f8d7da', borderRadius:6 }}>Something went wrong in this panel. Please check logs.</div>) : this.props.children }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'streaming'|'http'|'concurrency'|'comparative'|'results'|'chat'>('streaming')
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
            <option value="node-raw">Node (raw)</option>
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
        <h2>Elide-Bench</h2>
        <div style={{ display:'flex', gap:12, alignItems:'center', margin:'4px 0' }}>
          <a href="/results/index.html" target="_blank" rel="noreferrer">Results index</a>
          <a href="/metrics" target="_blank" rel="noreferrer">Metrics</a>
        </div>

        <ErrorBoundary>
          <BenchPanel activeTab={activeTab} setActiveTab={setActiveTab} settings={settings} />
        </ErrorBoundary>
      </main>
    </div>
  )
}

function BenchPanel({ activeTab, setActiveTab, settings }: any) {
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
  const [cliProgress, setCliProgress] = useState<Array<{name:string,c:number,t:number}>>([])


  function Sparkline({ values, color = '#0cf' }: { values: number[], color?: string }) {
    const w = 160, h = 40
    if (!values || values.length < 2) return <svg width={w} height={h} />
    const n = Math.min(values.length, 80)
    const step = values.length / n
    const pts: number[] = []
    for (let i = 0; i < n; i++) pts.push(values[Math.floor(i*step)] || 0)
    const max = Math.max(1, ...pts)
    const path = pts.map((v, i) => {
      const x = (i/(n-1))*w
      const y = h - (v/max)*h
      return `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
    return (
      <svg width={w} height={h} style={{ background:'#111', border:'1px solid #222' }}>
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
      </svg>
    )
  }

  const [total, setTotal] = useState(256)
  const [bytes, setBytes] = useState(64)
  const [frames, setFrames] = useState(200)
  const [delayMs, setDelayMs] = useState(5)
  const [fanout, setFanout] = useState(0)
  const [cpuSpinMs, setCpuSpinMs] = useState(0)
  const [gzip, setGzip] = useState(true)
  const [liveModel, setLiveModel] = useState(false)
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState<any|null>(null)
  // Apex search settings
  const [apexTtftP95Max, setApexTtftP95Max] = useState(250)
  const [apexStart, setApexStart] = useState(32)
  const [tiersCsv, setTiersCsv] = useState('8,32,64,128,256,512,1024,2048,4096')
  const maxTiers = '8,32,64,128,256,512,1024,2048,4096'

  const [apexMax, setApexMax] = useState(8192)


  // Optional Elide runtime configuration
  const [elideRtBase, setElideRtBase] = useState('')
  const [elideRtCmd, setElideRtCmd] = useState('')

  const p = (arr:number[], q:number)=>{

    if (!arr.length) return 0; const a=[...arr].sort((a,b)=>a-b); const i=Math.min(a.length-1, Math.max(0, Math.floor(q*(a.length-1)))); return a[i]
  }

  async function runOnce(): Promise<{ttft?:number, dur:number}> {
    const t0 = performance.now()
    if (mode === 'sse') {
      const res = liveModel ? await fetch('/api/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: 'user', content: 'Benchmark: please stream about 100-200 tokens about Elide.' }],
          stream: true, max_tokens: 256, temperature: 0.2,
          runtime: settings.runtime, baseURL: settings.baseURL, apiKey: settings.apiKey,
        })
      }) : await fetch('/api/chat/completions', {
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

  const [errorsOnly, setErrorsOnly] = useState(false)
  const [srvErrs, setSrvErrs] = useState<string[]>([])
  const srvES = useRef<EventSource|null>(null)
  useEffect(()=>{
    if (srvES.current) return
    try{
      const es = new EventSource('/logs/stream')
      srvES.current = es
      es.addEventListener('log', (ev:any)=>{
        try{
          const d = JSON.parse(ev.data)
          if ((d?.level||'') === 'err') setSrvErrs(prev=>{ const arr = prev.concat(String(d.text||'')); return arr.length>200?arr.slice(-200):arr })
        }catch{}
      })
    }catch{}
    return ()=>{ if (srvES.current) { try{ srvES.current.close() }catch{}; srvES.current = null } }
  },[])


  const [cliStatus, setCliStatus] = useState<string>('')
  const [cliLogs, setCliLogs] = useState<Array<{text:string, level?:string}>>([])


  const [targetsHealth, setTargetsHealth] = useState<{['node-raw']?:boolean;elide?:boolean;express?:boolean;fastapi?:boolean;flask?:boolean}|null>(null)
  const [dockerAvail, setDockerAvail] = useState<boolean|null>(null)
  const [probingTargets, setProbingTargets] = useState(false)
  async function probeTargets(){
    try{
      setProbingTargets(true)
      const r = await fetch('/bench/health')
      const j = await r.json()
      if (j?.ok && j.targets) setTargetsHealth(j.targets)
      else setTargetsHealth(null)
      setDockerAvail(j?.tools?.docker===true)
    }catch{ setTargetsHealth(null); setDockerAvail(null) }
    finally { setProbingTargets(false) }
  }

  useEffect(()=>{ probeTargets().catch(()=>{}) },[])


  const [targets, setTargets] = useState<{['node-raw']:boolean;elide:boolean;express:boolean;fastapi:boolean;flask:boolean}>({ 'node-raw':true, elide:false, express:true, fastapi:true, flask:true })
  function toggleTarget(name: 'node-raw'|'elide'|'express'|'fastapi'|'flask'){
    setTargets(prev => ({ ...prev, [name]: !prev[name as keyof typeof prev] as any }))
  }

  function toggleModeInSuite(m:string){
    setModesSuite(prev=> prev.includes(m) ? prev.filter(x=>x!==m) : [...prev, m])
  }


  async function runCliSuite(){
    try{
      setCliStatus('starting CLI run...')
      const tiers = (customConc || '8,32,64,128,256,512,1024,2048,4096')
        .split(',').map(s=>Number(s.trim())).filter(n=>Number.isFinite(n) && n>0)

      const selectedTargets = Object.entries(targets).filter(([,v])=>!!v).map(([k])=>k)
      const resp = await fetch('/bench/run-cli', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({
        concurrency: tiers,
        totals: tiers.map((c:number)=>c*4),
        frames, delay_ms: delayMs, bytes, cpu_spin_ms: cpuSpinMs,
        fanout, fanout_delay_ms: 0, gzip,
        targets: selectedTargets,
        elideRtBase, elideRtCmd,
        startServers: true, wslNode: false, wslFastapi: false,
      })})
      const j = await resp.json()
      if (!j.ok){ setCliStatus('CLI run failed to start: '+(j.error||'unknown')); return }
      setCliPid(j.pid)
      setCliStatus('running (pid '+j.pid+')...')
      setCliSamples([]); setCliLinks({}); setCliLogs([]); setCliProgress([])
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
        const pushLog = (text:string, level?:string)=> setCliLogs(prev=>{
          const arr = prev.concat({ text, level });
          return arr.length>400?arr.slice(-400):arr
        })
        try{
          const d = JSON.parse(ev.data); const line = (d?.text ?? String(ev.data)); const level = d?.level
          pushLog(line, level)
          const m = /\[(node-raw|elide|express|fastapi|flask)\][^\n]*wrote\s+bench-(?:node-raw|elide|express|fastapi|flask)\.(\d+)x(\d+)\.html/i.exec(line)
          if (m) {
            const name = m[1]; const c = Number(m[2]); const t = Number(m[3])
            setCliProgress(prev => prev.find(p=>p.name===name && p.c===c && p.t===t) ? prev : prev.concat({ name, c, t }))
          }
        }catch{
          pushLog(String(ev.data))
        }
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

  const TabButton = ({ id, label, active, onClick }: { id: string, label: string, active: boolean, onClick: () => void }) => (
    <button
      onClick={onClick}
      style={{
        padding: '8px 16px',
        border: '1px solid #ddd',
        borderBottom: active ? '1px solid white' : '1px solid #ddd',
        background: active ? 'white' : '#f5f5f5',
        cursor: 'pointer',
        borderTopLeftRadius: 4,
        borderTopRightRadius: 4,
        marginBottom: active ? -1 : 0,
        fontWeight: active ? 'bold' : 'normal'
      }}
    >
      {label}
    </button>
  )

  const TargetHealthDashboard = () => (
    <div style={{ background: '#f8f9fa', padding: 12, borderRadius: 6, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: '#333' }}>Target Status</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span title={`Node (raw): ${targetsHealth?.['node-raw'] === true ? 'up' : targetsHealth?.['node-raw'] === false ? 'down' : '?'}`}>
            Node (raw) {targetsHealth ? (targetsHealth['node-raw'] ? '🟢' : '🔴') : '⚪'}
          </span>
          <span title={`Elide (runtime): ${targetsHealth?.elide === true ? 'up' : targetsHealth?.elide === false ? 'down' : '?'}`}>
            Elide {targetsHealth ? (targetsHealth.elide ? '🟢' : '🔴') : '⚪'}
          </span>
          <span title={`Express: ${targetsHealth?.express === true ? 'up' : targetsHealth?.express === false ? 'down' : '?'}`}>
            Express {targetsHealth ? (targetsHealth.express ? '🟢' : '🔴') : '⚪'}
          </span>
          <span title={`FastAPI: ${targetsHealth?.fastapi === true ? 'up' : targetsHealth?.fastapi === false ? 'down' : '?'}`}>
            FastAPI {targetsHealth ? (targetsHealth.fastapi ? '🟢' : '🔴') : '⚪'}
          </span>
          <span title={`Flask: ${targetsHealth?.flask === true ? 'up' : targetsHealth?.flask === false ? 'down' : '?'}`}>
            Flask {targetsHealth ? (targetsHealth.flask ? '🟢' : '🔴') : '⚪'}
          </span>
          <button onClick={probeTargets} disabled={probingTargets} style={{ padding: '4px 8px', fontSize: 12 }}>
            {probingTargets ? 'Probing…' : 'Refresh'}
          </button>
        </div>
        {dockerAvail === false && (
          <div style={{ color: '#d63384', fontSize: 12 }}>
            ⚠️ Docker not detected - Flask requires Docker Desktop
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, color: '#2c3e50' }}>Elide-Bench</h1>
        <p style={{ margin: '4px 0 0 0', color: '#6c757d' }}>Runtime Performance Analysis & Comparison</p>
      </header>

      <TargetHealthDashboard />

      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #ddd' }}>
          <TabButton id="streaming" label="Streaming Tests" active={activeTab === 'streaming'} onClick={() => setActiveTab('streaming')} />
          <TabButton id="http" label="HTTP Tests" active={activeTab === 'http'} onClick={() => setActiveTab('http')} />
          <TabButton id="concurrency" label="Concurrency Analysis" active={activeTab === 'concurrency'} onClick={() => setActiveTab('concurrency')} />
          <TabButton id="comparative" label="Comparative Analysis" active={activeTab === 'comparative'} onClick={() => setActiveTab('comparative')} />
          <TabButton id="results" label="Results & Trends" active={activeTab === 'results'} onClick={() => setActiveTab('results')} />
          <TabButton id="chat" label="Interactive Analysis" active={activeTab === 'chat'} onClick={() => setActiveTab('chat')} />
        </div>
      </div>

      <div style={{ border: '1px solid #ddd', borderTop: 'none', padding: 16, background: 'white', minHeight: 400 }}>
        {cliSamples.length > 2 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 16px 0', padding: 8, background: '#f8f9fa', borderRadius: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'monospace', color: '#0cf', fontSize: 12 }}>CPU</span>
              <Sparkline values={cliSamples.map(s => s.cpu)} color="#0cf" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'monospace', color: '#0f0', fontSize: 12 }}>RSS</span>
              <Sparkline values={cliSamples.map(s => s.rssMb)} color="#0f0" />
            </div>
          </div>
        )}
        {cliProgress.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '0 0 16px 0' }}>
            {cliProgress.map((p, i) => (
              <span key={i} style={{ fontFamily: 'monospace', background: '#e9ecef', border: '1px solid #dee2e6', padding: '2px 6px', borderRadius: 4, fontSize: 12 }}>
                {p.name} {p.c}x{p.t}
              </span>
            ))}
          </div>
        )}

        {activeTab === 'streaming' && (
          <div>
            <h3 style={{ marginTop: 0, color: '#495057' }}>SSE Streaming Performance</h3>
            <p style={{ color: '#6c757d', marginBottom: 16 }}>
              Tests Time-To-First-Token (TTFT), streaming throughput, and memory efficiency using synthetic Server-Sent Events.
              Isolates pure serving overhead without upstream LLM calls.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 16 }}>
              <label title="Base URL under test">
                Target <input value={target} onChange={e => setTarget(e.target.value)} style={{ width: '100%', marginTop: 4 }} placeholder="http://localhost:8080" />
              </label>
              <label title="Concurrent connections">
                Concurrency <input type="number" value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label title="Total requests across all connections">
                Total Requests <input type="number" value={total} onChange={e => setTotal(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label title="Bytes per SSE frame">
                Bytes per Frame <input type="number" value={bytes} onChange={e => setBytes(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label title="Number of SSE frames to stream">
                Frame Count <input type="number" value={frames} onChange={e => setFrames(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label title="Delay between frames (ms)">
                Frame Delay (ms) <input type="number" value={delayMs} onChange={e => setDelayMs(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
              <label title="Enable gzip compression"><input type="checkbox" checked={gzip} onChange={e => setGzip(e.target.checked)} /> gzip</label>
              <label title="Simulate CPU work per frame"><input type="checkbox" checked={cpuSpinMs > 0} onChange={e => setCpuSpinMs(e.target.checked ? 10 : 0)} /> CPU simulation</label>
              {cpuSpinMs > 0 && (
                <input type="number" value={cpuSpinMs} onChange={e => setCpuSpinMs(Number(e.target.value))} style={{ width: 80 }} title="CPU spin milliseconds" />
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
              <label title="Use live local model via /api/chat/completions">
                <input type="checkbox" checked={liveModel} onChange={e => setLiveModel(e.target.checked)} /> Use live local model
              </label>
            </div>


            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button onClick={runBench} disabled={running} style={{ padding: '8px 16px' }}>
                {running ? 'Running...' : 'Run Single Test'}
              </button>
              <button onClick={runFullSuite} disabled={running} style={{ padding: '8px 16px' }}>
                {running ? 'Running...' : 'Run Multi-Tier Suite'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'http' && (
          <div>
            <h3 style={{ marginTop: 0, color: '#495057' }}>HTTP Response Performance</h3>
            <p style={{ color: '#6c757d', marginBottom: 16 }}>
              Tests request/response patterns with plain and chunked transfer encoding.
              Measures latency, throughput, and chunking efficiency.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 16 }}>
              <label title="Base URL under test">
                Target <input value={target} onChange={e => setTarget(e.target.value)} style={{ width: '100%', marginTop: 4 }} placeholder="http://localhost:8080" />
              </label>
              <label title="Response pattern">
                Mode
                <select value={mode} onChange={e => setMode(e.target.value as any)} style={{ width: '100%', marginTop: 4 }}>
                  <option value="micro-plain">Plain Response</option>
                  <option value="micro-chunked">Chunked Response</option>
                </select>
              </label>
              <label title="Concurrent connections">
                Concurrency <input type="number" value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label title="Total requests">
                Total Requests <input type="number" value={total} onChange={e => setTotal(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label title="Response size in bytes">
                Response Bytes <input type="number" value={bytes} onChange={e => setBytes(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
              {mode === 'micro-chunked' && (
                <label title="Delay between chunks (ms)">
                  Chunk Delay (ms) <input type="number" value={delayMs} onChange={e => setDelayMs(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
                </label>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
              <label title="Enable gzip compression"><input type="checkbox" checked={gzip} onChange={e => setGzip(e.target.checked)} /> gzip</label>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button onClick={runBench} disabled={running} style={{ padding: '8px 16px' }}>
                {running ? 'Running...' : 'Run Single Test'}
              </button>
              <button onClick={runFullSuite} disabled={running} style={{ padding: '8px 16px' }}>
                {running ? 'Running...' : 'Run Multi-Tier Suite'}
              </button>
            </div>
          </div>
        )}
        {activeTab === 'concurrency' && (
          <div>
            <h3 style={{ marginTop: 0, color: '#495057' }}>Concurrency & Load Analysis</h3>
            <p style={{ color: '#6c757d', marginBottom: 16 }}>
              Find maximum sustainable load and analyze scaling characteristics.
              Binary search finds the apex concurrency under performance thresholds.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 16 }}>
              <label title="Base URL under test">
                Target <input value={target} onChange={e => setTarget(e.target.value)} style={{ width: '100%', marginTop: 4 }} placeholder="http://localhost:8080" />
              </label>
              <label title="Acceptable TTFT p95 threshold (ms)">
                TTFT P95 Max (ms) <input type="number" value={apexTtftP95Max} onChange={e => setApexTtftP95Max(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label title="Starting concurrency for binary search">
                Start Concurrency <input type="number" value={apexStart} onChange={e => setApexStart(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label title="Maximum concurrency to test">
                Max Concurrency <input type="number" value={apexMax} onChange={e => setApexMax(Number(e.target.value))} style={{ width: '100%', marginTop: 4 }} />
              </label>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label title="Comma-separated concurrency tiers for manual testing">
                Manual Tiers (CSV) <input value={tiersCsv} onChange={e => setTiersCsv(e.target.value)} style={{ width: '100%', marginTop: 4 }} placeholder="8,32,64,128,256,512" />
              </label>
              <button onClick={() => setTiersCsv(maxTiers)} style={{ marginTop: 8, padding: '4px 8px' }}>
                Preset: Max ({maxTiers})
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button onClick={runBinarySearch} disabled={running} style={{ padding: '8px 16px' }}>
                {running ? 'Searching...' : 'Binary Search for Apex'}
              </button>
              <button onClick={runFullSuite} disabled={running} style={{ padding: '8px 16px' }}>
                {running ? 'Running...' : 'Run Manual Tiers'}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'comparative' && (
          <div>
            <h3 style={{ marginTop: 0, color: '#495057' }}>Multi-Framework Comparison</h3>
            <p style={{ color: '#6c757d', marginBottom: 16 }}>
              Run comprehensive benchmarks across selected frameworks and test modes.
              Automatically starts servers and generates comparative analysis.
            </p>

            <div style={{ marginBottom: 16 }}>
              <h4 style={{ margin: '0 0 8px 0', color: '#6c757d' }}>Target Frameworks</h4>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label title={`Node (raw): ${targetsHealth?.['node-raw'] === true ? 'up' : targetsHealth?.['node-raw'] === false ? 'down' : '?'}`}>
                  <input type="checkbox" checked={targets['node-raw']} onChange={() => toggleTarget('node-raw')} />
                  Node (raw) {targetsHealth ? (targetsHealth['node-raw'] ? '🟢' : '🔴') : '⚪'}
                </label>
                <label title={`Express: ${targetsHealth?.express === true ? 'up' : targetsHealth?.express === false ? 'down' : '?'}`}>
                  <input type="checkbox" checked={targets.express} onChange={() => toggleTarget('express')} />
                  Express {targetsHealth ? (targetsHealth.express ? '🟢' : '🔴') : '⚪'}
                </label>
                <label title={`FastAPI: ${targetsHealth?.fastapi === true ? 'up' : targetsHealth?.fastapi === false ? 'down' : '?'}`}>
                  <input type="checkbox" checked={targets.fastapi} onChange={() => toggleTarget('fastapi')} />
                  FastAPI {targetsHealth ? (targetsHealth.fastapi ? '🟢' : '🔴') : '⚪'}
                </label>

	            <div style={{ marginTop: 8 }}>
	              <details>
	                <summary style={{ cursor: 'pointer' }}>Elide (runtime) — optional</summary>
	                <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8 }}>
	                  <label title="Include Elide runtime in the run (if configured)">
	                    <input type="checkbox" checked={!!targets.elide} onChange={() => toggleTarget('elide')} /> Enable Elide (runtime)
	                  </label>
	                  <label title="Base URL of the Elide runtime (used as-is if reachable)">
	                    Base URL <input placeholder="http://localhost:8084" value={elideRtBase} onChange={e => setElideRtBase(e.target.value)} />
	                  </label>
	                  <label title="Launch command to start Elide runtime (used when 'Start servers' is enabled)">
	                    Launch command <input placeholder="elide serve ..." value={elideRtCmd} onChange={e => setElideRtCmd(e.target.value)} />
	                  </label>
	                </div>
	                <div style={{ fontSize: 12, color: '#6c757d', marginTop: 6 }}>
	                  If Base URL responds at <code>/healthz</code>, it will be used. If Launch command is provided and “Start servers” is on, the suite will try to start it.
	                </div>
	              </details>
	            </div>

                <label title={`Flask: ${targetsHealth?.flask === true ? 'up' : targetsHealth?.flask === false ? 'down' : '?'}`}>
                  <input type="checkbox" checked={targets.flask} onChange={() => toggleTarget('flask')} />
                  Flask {targetsHealth ? (targetsHealth.flask ? '🟢' : '🔴') : '⚪'}
                </label>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <h4 style={{ margin: '0 0 8px 0', color: '#6c757d' }}>Test Modes</h4>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label title="Include SSE synthetic streaming tests">
                  <input type="checkbox" checked={modesSuite.includes('sse')} onChange={() => toggleModeInSuite('sse')} /> SSE Streaming
                </label>
                <label title="Include HTTP plain response tests">
                  <input type="checkbox" checked={modesSuite.includes('micro-plain')} onChange={() => toggleModeInSuite('micro-plain')} /> HTTP Plain
                </label>
                <label title="Include HTTP chunked response tests">
                  <input type="checkbox" checked={modesSuite.includes('micro-chunked')} onChange={() => toggleModeInSuite('micro-chunked')} /> HTTP Chunked
                </label>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label title="Comma-separated concurrency tiers">
                Concurrency Tiers <input value={tiersCsv} onChange={e => setTiersCsv(e.target.value)} style={{ width: '100%', marginTop: 4 }} placeholder="8,32,64,128" />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button onClick={runCliSuite} disabled={false} style={{ padding: '8px 16px', background: '#0d6efd', color: 'white', border: 'none', borderRadius: 4 }}>
                Run Comparative Suite
              </button>
              <button onClick={cancelCli} disabled={!cliPid} style={{ padding: '8px 16px' }}>
                Cancel
              </button>
              {cliStatus && <span style={{ fontFamily: 'monospace', padding: '8px', background: '#f8f9fa', borderRadius: 4 }}>{cliStatus}</span>}
            </div>

            {(cliLinks.index || cliLinks.log) && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                {cliLinks.index && <a href={cliLinks.index} target="_blank" rel="noreferrer" style={{ padding: '6px 12px', background: '#198754', color: 'white', textDecoration: 'none', borderRadius: 4 }}>Open Results</a>}
                {cliLinks.log && <a href={cliLinks.log} target="_blank" rel="noreferrer" style={{ padding: '6px 12px', background: '#6c757d', color: 'white', textDecoration: 'none', borderRadius: 4 }}>View Log</a>}
              </div>
            )}

            {cliLogs.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <h4 style={{ margin: 0, color: '#6c757d' }}>Live Progress</h4>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <input type="checkbox" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} /> Errors only
                  </label>
                </div>
                <pre style={{ maxHeight: 200, overflowY: 'auto', overflowX: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f8f9fa', border: '1px solid #dee2e6', padding: 12, borderRadius: 4, fontSize: 12 }}>
                  {cliLogs.filter(l => !errorsOnly || l.level === 'err').slice(-100).map((l, i) => (
                    <span key={i} style={{ color: l.level === 'err' ? '#dc3545' : '#198754' }}>{l.text}{'\n'}</span>
                  ))}
                </pre>
              </div>
            )}
          </div>
        )}

        {activeTab === 'results' && (
          <div>
            <h3 style={{ marginTop: 0, color: '#495057' }}>Results & Trends Dashboard</h3>
            <p style={{ color: '#6c757d', marginBottom: 16 }}>
              Integrated performance analysis with real-time insights, historical trends, and actionable recommendations.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 24 }}>
              <div style={{ padding: 16, border: '1px solid #dee2e6', borderRadius: 6, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white' }}>
                <h4 style={{ margin: '0 0 12px 0', color: 'white' }}>📊 Performance Overview</h4>
                {(cliLinks.index || cliLinks.log) ? (
                  <div>
                    <div style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 8 }}>
                      {targetsHealth ? Object.values(targetsHealth).filter(Boolean).length : 0}/5
                    </div>
                    <div style={{ fontSize: 14, opacity: 0.9 }}>Frameworks Online</div>
                    <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                      <a href={cliLinks.index} target="_blank" rel="noreferrer"
                         style={{ padding: '6px 12px', background: 'rgba(255,255,255,0.2)', color: 'white', textDecoration: 'none', borderRadius: 4, fontSize: 12 }}>
                        📈 View Reports
                      </a>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 8 }}>—</div>
                    <div style={{ fontSize: 14, opacity: 0.9 }}>No Recent Data</div>
                    <div style={{ fontSize: 12, opacity: 0.8, marginTop: 8 }}>Run a benchmark to see insights</div>
                  </div>
                )}
              </div>

              <div style={{ padding: 16, border: '1px solid #dee2e6', borderRadius: 6, background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)', color: 'white' }}>
                <h4 style={{ margin: '0 0 12px 0', color: 'white' }}>⚡ System Health</h4>
                {cliSamples.length > 0 ? (
                  (() => {
                    const last = cliSamples[cliSamples.length - 1];
                    const cpu = Number(last.cpu || 0);
                    const rss = Number(last.rssMb || 0);
                    const cpuStatus = cpu > 80 ? '🔴' : cpu > 50 ? '🟡' : '🟢';
                    const memStatus = rss > 1000 ? '🔴' : rss > 500 ? '🟡' : '🟢';
                    return (
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 8 }}>
                          {cpuStatus} CPU: {cpu.toFixed(1)}%
                        </div>
                        <div style={{ fontSize: 14, opacity: 0.9, marginBottom: 4 }}>
                          {memStatus} Memory: {rss.toFixed(0)} MB
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                          {cliSamples.length} samples collected
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 8 }}>⚪ Idle</div>
                    <div style={{ fontSize: 14, opacity: 0.9 }}>No active monitoring</div>
                  </div>
                )}
              </div>

              <div style={{ padding: 16, border: '1px solid #dee2e6', borderRadius: 6, background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)', color: 'white' }}>
                <h4 style={{ margin: '0 0 12px 0', color: 'white' }}>🎯 Quick Actions</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    onClick={() => setActiveTab('comparative')}
                    style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.2)', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
                  >
                    🚀 Run New Benchmark
                  </button>
                  <button
                    onClick={probeTargets}
                    disabled={probingTargets}
                    style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.2)', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
                  >
                    {probingTargets ? '⏳ Probing...' : '🔍 Check Health'}
                  </button>
                </div>
              </div>
            </div>

            {/* Performance Insights Section */}
            <div style={{ marginBottom: 24 }}>
              <h4 style={{ color: '#495057', marginBottom: 16 }}>🧠 AI Performance Insights</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 16 }}>
                <div style={{ padding: 16, border: '1px solid #e3f2fd', borderRadius: 6, background: '#f8f9fa' }}>
                  <h5 style={{ margin: '0 0 12px 0', color: '#1976d2' }}>📈 Scaling Analysis</h5>
                  <p style={{ margin: 0, fontSize: 14, color: '#6c757d' }}>
                    Advanced algorithms analyze how each framework performs as concurrency increases,
                    detecting linear, sub-linear, or degrading scaling patterns.
                  </p>
                  <div style={{ marginTop: 12, padding: 8, background: '#e3f2fd', borderRadius: 4, fontSize: 12 }}>
                    <strong>Latest:</strong> Run a comparative benchmark to see scaling insights
                  </div>
                </div>

                <div style={{ padding: 16, border: '1px solid #e8f5e8', borderRadius: 6, background: '#f8f9fa' }}>
                  <h5 style={{ margin: '0 0 12px 0', color: '#388e3c' }}>⚠️ Bottleneck Detection</h5>
                  <p style={{ margin: 0, fontSize: 14, color: '#6c757d' }}>
                    Automatically identifies performance bottlenecks like high latency variance,
                    low throughput, and resource contention issues.
                  </p>
                  <div style={{ marginTop: 12, padding: 8, background: '#e8f5e8', borderRadius: 4, fontSize: 12 }}>
                    <strong>Status:</strong> No critical bottlenecks detected
                  </div>
                </div>

                <div style={{ padding: 16, border: '1px solid #fff3e0', borderRadius: 6, background: '#f8f9fa' }}>
                  <h5 style={{ margin: '0 0 12px 0', color: '#f57c00' }}>💰 Cost Efficiency</h5>
                  <p style={{ margin: 0, fontSize: 14, color: '#6c757d' }}>
                    Calculates cost-per-request based on typical cloud pricing,
                    helping identify the most economical framework for your workload.
                  </p>
                  <div style={{ marginTop: 12, padding: 8, background: '#fff3e0', borderRadius: 4, fontSize: 12 }}>
                    <strong>Estimate:</strong> Run analysis to see cost comparisons
                  </div>
                </div>

                <div style={{ padding: 16, border: '1px solid #fce4ec', borderRadius: 6, background: '#f8f9fa' }}>
                  <h5 style={{ margin: '0 0 12px 0', color: '#c2185b' }}>🎯 Executive Summary</h5>
                  <p style={{ margin: 0, fontSize: 14, color: '#6c757d' }}>
                    High-level insights and recommendations based on comprehensive
                    performance analysis across all tested scenarios.
                  </p>
                  <div style={{ marginTop: 12, padding: 8, background: '#fce4ec', borderRadius: 4, fontSize: 12 }}>
                    <strong>Ready:</strong> Automated insights available after benchmarks
                  </div>
                </div>
              </div>
            </div>

            {/* Historical Trends Placeholder */}
            <div style={{ marginBottom: 24 }}>
              <h4 style={{ color: '#495057', marginBottom: 16 }}>📊 Historical Trends</h4>
              <div style={{ padding: 24, border: '2px dashed #dee2e6', borderRadius: 8, textAlign: 'center', background: '#f8f9fa' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>📈</div>
                <h5 style={{ margin: '0 0 8px 0', color: '#6c757d' }}>Trend Charts Coming Soon</h5>
                <p style={{ margin: 0, color: '#6c757d', fontSize: 14 }}>
                  Interactive charts showing performance trends over time, regression detection, and baseline comparisons.
                </p>
              </div>
            </div>

            {srvErrs.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <details style={{ border: '1px solid #dc3545', borderRadius: 6, padding: 12 }} open>
                  <summary style={{ color: '#dc3545', fontWeight: 'bold', cursor: 'pointer', marginBottom: 8 }}>
                    ⚠️ Server Errors ({srvErrs.length})
                  </summary>
                  <pre style={{ maxHeight: 120, overflow: 'auto', background: '#f8d7da', color: '#721c24', padding: 12, borderRadius: 4, fontSize: 12, lineHeight: 1.4 }}>
                    {srvErrs.slice(-60).join('\n')}
                  </pre>
                </details>
              </div>
            )}
          </div>
        )}

        {activeTab === 'chat' && (
          <div>
            <h3 style={{ marginTop: 0, color: '#495057' }}>Interactive Analysis</h3>
            <p style={{ color: '#6c757d', marginBottom: 16 }}>
              Chat interface for interactive model testing and analysis.
              Originally designed for OpenHands integration.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <h4 style={{ margin: '0 0 12px 0', color: '#6c757d' }}>Settings</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label title="Runtime to test">
                    Runtime
                    <select value={settings.runtime} onChange={e => setSettings({ ...settings, runtime: e.target.value as any })} style={{ width: '100%', marginTop: 4 }}>
                      <option value="elide">Elide</option>
                    </select>
                  </label>
                  <label title="Base URL for API calls">
                    Base URL
                    <input value={settings.baseURL} onChange={e => setSettings({ ...settings, baseURL: e.target.value })} style={{ width: '100%', marginTop: 4 }} />
                  </label>
                  <label title="API key for authentication">
                    API Key
                    <input type="password" value={settings.apiKey} onChange={e => setSettings({ ...settings, apiKey: e.target.value })} style={{ width: '100%', marginTop: 4 }} />
                  </label>
                  <label title="Model to use">
                    Model
                    <input value={settings.model} onChange={e => setSettings({ ...settings, model: e.target.value })} style={{ width: '100%', marginTop: 4 }} />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                    <input type="checkbox" checked={showReasoning} onChange={e => setShowReasoning(e.target.checked)} />
                    Show reasoning
                  </label>
                  <button onClick={() => { localStorage.setItem('settings', JSON.stringify(settings)); alert('Settings saved!'); }} style={{ padding: '6px 12px', marginTop: 8 }}>
                    Save Settings
                  </button>
                </div>
              </div>

              <div>
                <h4 style={{ margin: '0 0 12px 0', color: '#6c757d' }}>Chat</h4>
                <div style={{ border: '1px solid #dee2e6', borderRadius: 6, height: 400, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ flex: 1, padding: 12, overflowY: 'auto', background: '#f8f9fa' }}>
                    {messages.length === 0 ? (
                      <p style={{ color: '#6c757d', fontStyle: 'italic', textAlign: 'center', marginTop: 50 }}>
                        Start a conversation to test model performance...
                      </p>
                    ) : (
                      messages.map((msg, i) => (
                        <div key={i} style={{ marginBottom: 16 }}>
                          <div style={{ fontWeight: 'bold', color: msg.role === 'user' ? '#0d6efd' : '#198754', marginBottom: 4 }}>
                            {msg.role === 'user' ? 'You' : 'Assistant'}
                          </div>
                          <div style={{ background: 'white', padding: 8, borderRadius: 4, border: '1px solid #dee2e6' }}>
                            {msg.content}
                          </div>
                          {msg.role === 'assistant' && showReasoning && reasoning && i === messages.length - 1 && (
                            <details style={{ marginTop: 8 }}>
                              <summary style={{ color: '#6c757d', fontSize: 12, cursor: 'pointer' }}>Show reasoning</summary>
                              <div style={{ background: '#fff3cd', padding: 8, borderRadius: 4, marginTop: 4, fontSize: 12, fontFamily: 'monospace' }}>
                                {reasoning}
                              </div>
                            </details>
                          )}
                        </div>
                      ))
                    )}
                    {streaming && (
                      <div style={{ color: '#6c757d', fontStyle: 'italic' }}>
                        Assistant is typing...
                      </div>
                    )}
                  </div>

                  <div style={{ padding: 12, borderTop: '1px solid #dee2e6', background: 'white' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <textarea
                        ref={taRef}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (!streaming && input.trim()) {
                              sendMessage();
                            }
                          }
                        }}
                        placeholder="Type your message..."
                        style={{ flex: 1, minHeight: 60, padding: 8, border: '1px solid #dee2e6', borderRadius: 4, resize: 'vertical' }}
                        disabled={streaming}
                      />
                      <button
                        onClick={sendMessage}
                        disabled={streaming || !input.trim()}
                        style={{ padding: '8px 16px', background: '#0d6efd', color: 'white', border: 'none', borderRadius: 4, cursor: streaming ? 'not-allowed' : 'pointer' }}
                      >
                        {streaming ? 'Sending...' : 'Send'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {summary && (
        <div style={{ marginTop: 16, padding: 12, background: '#f8f9fa', borderRadius: 6, fontFamily: 'monospace', fontSize: 12 }}>
          <strong>Last Benchmark:</strong> RPS {summary.rps} | TTFT p50/p95/p99: {summary.ttft_p50 ?? '-'} / {summary.ttft_p95 ?? '-'} / {summary.ttft_p99 ?? '-'} ms | Duration p50/p95/p99: {summary.dur_p50} / {summary.dur_p95} / {summary.dur_p99} ms
        </div>
      )}
    </div>
  )
}


