// Example: a tiny client-side chat panel that consumes the SSE stream
// from app/api/chat/route.ts. Pairs with route.ts in this directory.
//
// State model: keep the full message[] history in component state. Send it
// with every request so the agent can resume the conversation server-side
// without you needing per-user persistence in MVP.

'use client'

import { useState } from 'react'
import type { Message } from 'marco-agent'

export function ChatPanel(): JSX.Element {
  const [history, setHistory] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)

  async function send(): Promise<void> {
    if (!input.trim() || busy) return
    setBusy(true)
    setStreaming('')
    const prompt = input
    setInput('')

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, history }),
    })
    if (!res.body) {
      setBusy(false)
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const block of events) {
        const line = block.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        const event = JSON.parse(line.slice(6))
        if (event.type === 'text') setStreaming((s) => s + event.text)
        else if (event.type === 'done') setHistory(event.result.messages)
      }
    }
    setStreaming('')
    setBusy(false)
  }

  return (
    <div>
      {history.map((m, i) => {
        if (m.role === 'user') return <p key={i}><b>You:</b> {m.text}</p>
        if (m.role === 'assistant' && m.text) return <p key={i}><b>Agent:</b> {m.text}</p>
        return null
      })}
      {streaming && <p><b>Agent:</b> {streaming}<span aria-live="polite">▊</span></p>}
      <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} disabled={busy} />
      <button onClick={send} disabled={busy}>Send</button>
    </div>
  )
}
