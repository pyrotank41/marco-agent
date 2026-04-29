import { describe, it, expect } from 'vitest'
import { MockProvider } from 'marco-harness'
import { MarcoAgent } from '../src/agent.js'

describe('MarcoAgent', () => {
  it('returns the assistant text for a single-turn ask()', async () => {
    const provider = new MockProvider([
      [
        { type: 'text_delta', text: 'Hello back.' },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            text: 'Hello back.',
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        },
      ],
    ])

    const agent = new MarcoAgent({ provider, tools: [] })
    const reply = await agent.ask('hi')
    expect(reply).toBe('Hello back.')
  })

  it('exposes the underlying Harness via .raw', () => {
    const provider = new MockProvider([])
    const agent = new MarcoAgent({ provider, tools: [] })
    expect(agent.raw).toBeDefined()
    expect(typeof agent.raw.run).toBe('function')
  })
})
