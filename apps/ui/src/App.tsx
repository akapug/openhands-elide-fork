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
        <div style={{ height:'70vh', overflow:'auto', border:'1px solid #eee', padding:8 }}>
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
      </main>
    </div>
  )
}

