import { describe, it, expect } from 'vitest'
import { MockProvider } from 'marco-harness'
import { MarcoAgent, type StreamEvent } from '../src/agent.js'

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

describe('MarcoAgent', () => {
  it('ask() returns text and the full message trail', async () => {
    const provider = new MockProvider([singleAssistantTurn('Hello back.')])
    const agent = new MarcoAgent({ provider, tools: [] })
    const result = await agent.ask('hi')

    expect(result.text).toBe('Hello back.')
    expect(result.messages.at(-1)?.role).toBe('assistant')
  })

  it('ask() threads conversation history into the next turn', async () => {
    const provider = new MockProvider([singleAssistantTurn('Round 2.')])
    const agent = new MarcoAgent({ provider, tools: [] })
    const history = [
      { role: 'user' as const, text: 'first' },
      {
        role: 'assistant' as const,
        text: 'Round 1.',
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]
    const result = await agent.ask('second', history)

    expect(result.text).toBe('Round 2.')
    expect(result.messages.length).toBeGreaterThanOrEqual(4)
    expect(result.messages[0]).toEqual(history[0])
  })

  it('stream() yields text events and a final done event', async () => {
    const provider = new MockProvider([singleAssistantTurn('Streamed.')])
    const agent = new MarcoAgent({ provider, tools: [] })

    const events: StreamEvent[] = []
    for await (const ev of agent.stream('hi')) events.push(ev)

    const textEvents = events.filter((e) => e.type === 'text')
    const doneEvent = events.find((e) => e.type === 'done')

    expect(textEvents.map((e) => (e as { text: string }).text).join('')).toBe('Streamed.')
    expect(doneEvent).toBeDefined()
    expect((doneEvent as { result: { text: string } }).result.text).toBe('Streamed.')
  })
})
