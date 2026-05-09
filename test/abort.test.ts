// Cancellation tests — exercises agent.abort(), the per-call signal,
// and the new 'aborted' stream event. The MCP signal forwarding is
// covered separately in test/mcp.test.ts.

import { describe, it, expect } from 'vitest'
import { MockProvider } from 'marco-harness'
import { MarcoAgent, AgentAbortedError, type StreamEvent } from '../src/agent.js'

function singleAssistantTurn(text: string) {
  return [
    { type: 'text_delta' as const, text },
    {
      type: 'message_end' as const,
      message: {
        role: 'assistant' as const,
        text,
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    },
  ]
}

function multiChunkTurn(parts: string[]) {
  return [
    ...parts.map((text) => ({ type: 'text_delta' as const, text })),
    {
      type: 'message_end' as const,
      message: {
        role: 'assistant' as const,
        text: parts.join(''),
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    },
  ]
}

describe('MarcoAgent — abort', () => {
  it('agent.abort() throws AgentAbortedError from ask() with partial result', async () => {
    const provider = new MockProvider([multiChunkTurn(['part1...', 'part2...', 'part3...'])])
    const agent = new MarcoAgent({ provider, tools: [] })

    const promise = agent.ask('hi')
    queueMicrotask(() => agent.abort('user clicked stop'))

    await expect(promise).rejects.toBeInstanceOf(AgentAbortedError)
    try {
      await promise
    } catch (err) {
      expect(err).toBeInstanceOf(AgentAbortedError)
      const aborted = err as AgentAbortedError
      expect(aborted.reason).toContain('user clicked stop')
      expect(aborted.partial).toBeDefined()
      expect(aborted.partial.messages.length).toBeGreaterThan(0)
    }
  })

  it("stream() yields 'aborted' event with partial result on abort()", async () => {
    const provider = new MockProvider([multiChunkTurn(['part1...', 'part2...', 'part3...'])])
    const agent = new MarcoAgent({ provider, tools: [] })
    const events: StreamEvent[] = []

    const iter = agent.stream('hi')
    queueMicrotask(() => agent.abort('user stop'))
    for await (const ev of iter) {
      events.push(ev)
    }

    const last = events.at(-1)
    expect(last?.type).toBe('aborted')
    if (last?.type === 'aborted') {
      expect(last.reason).toContain('user stop')
      expect(last.result.messages.length).toBeGreaterThan(0)
    }
    // No 'done' event on abort — the run terminates with 'aborted' instead.
    expect(events.some((e) => e.type === 'done')).toBe(false)
  })

  it("stream() ends with 'done' (not 'aborted') when nothing aborts", async () => {
    const provider = new MockProvider([singleAssistantTurn('hi back')])
    const agent = new MarcoAgent({ provider, tools: [] })
    const events: StreamEvent[] = []
    for await (const ev of agent.stream('hi')) {
      events.push(ev)
    }
    expect(events.at(-1)?.type).toBe('done')
    expect(events.some((e) => e.type === 'aborted')).toBe(false)
  })

  it('per-call signal aborts the run (without using agent.abort())', async () => {
    const provider = new MockProvider([multiChunkTurn(['a...', 'b...', 'c...'])])
    const agent = new MarcoAgent({ provider, tools: [] })
    const ctrl = new AbortController()

    const promise = agent.ask('hi', [], { signal: ctrl.signal })
    queueMicrotask(() => ctrl.abort('external stop'))

    await expect(promise).rejects.toBeInstanceOf(AgentAbortedError)
  })

  it('constructor-time signal aborts the run', async () => {
    const ctrl = new AbortController()
    const provider = new MockProvider([multiChunkTurn(['a...', 'b...'])])
    const agent = new MarcoAgent({ provider, tools: [], signal: ctrl.signal })

    const promise = agent.ask('hi')
    queueMicrotask(() => ctrl.abort('ctor stop'))

    await expect(promise).rejects.toBeInstanceOf(AgentAbortedError)
  })

  it('agent.abort() while no run is in flight is a no-op', () => {
    const provider = new MockProvider([])
    const agent = new MarcoAgent({ provider, tools: [] })
    expect(() => agent.abort()).not.toThrow()
  })

  it('aborting before ask() runs throws on first await', async () => {
    const ctrl = new AbortController()
    ctrl.abort('pre-flight')
    const provider = new MockProvider([singleAssistantTurn('would be hi')])
    const agent = new MarcoAgent({ provider, tools: [], signal: ctrl.signal })

    await expect(agent.ask('hi')).rejects.toBeInstanceOf(AgentAbortedError)
  })

  it('partial text is delivered via text events even when result.messages lacks the incomplete assistant turn', async () => {
    // Documented limitation: when the model fetch is aborted mid-stream,
    // the assistant message hasn't been pushed to harness.messages yet,
    // so result.text is empty. The streamed text is delivered via 'text'
    // events — consumers that want to persist partial output should
    // accumulate from those.
    const provider = new MockProvider([multiChunkTurn(['hello ', 'world ', '...'])])
    const agent = new MarcoAgent({ provider, tools: [] })

    const events: StreamEvent[] = []
    const iter = agent.stream('hi')
    let aborted = false
    for await (const ev of iter) {
      events.push(ev)
      if (!aborted && ev.type === 'text') {
        aborted = true
        agent.abort('mid-stream')
      }
    }

    const last = events.at(-1)
    expect(last?.type).toBe('aborted')
    // At least one text event was delivered before abort.
    expect(events.some((e) => e.type === 'text')).toBe(true)
  })
})
