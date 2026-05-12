// Tests for the multimodal prompt path: ask()/stream() accepting
// `string | UserMessageContentPart[]`, forwarding `content` through
// the harness to the provider, and the text fallback used for
// compaction + transcripts.

import { describe, it, expect } from 'vitest'
import type {
  ChunkEvent,
  Message,
  ModelConfig,
  ModelProvider,
  StreamOptions,
  ToolSpec,
  UserMessageContentPart,
} from 'marco-harness'
import { MarcoAgent, normalizePrompt, type AgentPrompt, type StreamEvent } from '../src/agent.js'

/**
 * Capturing provider — records the `messages` array passed in on
 * the most recent stream() call, then emits a canned single-turn
 * assistant response.
 */
function captureProvider(scriptText = 'ok'): {
  provider: ModelProvider
  getLastMessages: () => Message[] | null
} {
  let lastMessages: Message[] | null = null
  const provider: ModelProvider = {
    async *stream(messages: Message[], _tools: ToolSpec[], _config: ModelConfig, _opts?: StreamOptions): AsyncIterable<ChunkEvent> {
      lastMessages = messages
      const events: ChunkEvent[] = [
        { type: 'text_delta', text: scriptText },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            text: scriptText,
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        },
      ]
      for (const e of events) yield e
    },
  }
  return { provider, getLastMessages: () => lastMessages }
}

async function drainStream(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

// ─────────── normalizePrompt unit tests ───────────

describe('normalizePrompt', () => {
  it('returns string prompt unchanged with no content', () => {
    const out = normalizePrompt('hello world')
    expect(out).toEqual({ text: 'hello world' })
    expect(out.content).toBeUndefined()
  })

  it('synthesizes a text fallback from text parts', () => {
    const out = normalizePrompt([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])
    expect(out.text).toBe('first\nsecond')
    expect(out.content).toHaveLength(2)
  })

  it('mentions images and documents in the text fallback', () => {
    const out = normalizePrompt([
      { type: 'text', text: 'compare these' },
      { type: 'image', source: { kind: 'url', url: 'https://x/y.png' } },
      { type: 'document', source: { kind: 'url', url: 'https://x/d.pdf', filename: 'budget.pdf' } },
    ])
    expect(out.text).toBe('compare these\n[Image]\n[Document: budget.pdf]')
  })

  it('handles document with no filename gracefully', () => {
    const out = normalizePrompt([
      { type: 'document', source: { kind: 'base64', mediaType: 'application/pdf', data: 'AA' } },
    ])
    expect(out.text).toBe('[Document: document]')
  })

  it('forwards the original content array verbatim', () => {
    const parts: UserMessageContentPart[] = [
      { type: 'text', text: 'a' },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AB' } },
    ]
    const out = normalizePrompt(parts)
    expect(out.content).toBe(parts)
  })
})

// ─────────── ask() ───────────

describe('MarcoAgent.ask — AgentPrompt input', () => {
  it('forwards a string prompt as text-only UserMessage', async () => {
    const { provider, getLastMessages } = captureProvider()
    const agent = new MarcoAgent({ provider, tools: [] })
    await agent.ask('hi there')
    const last = getLastMessages()!
    const user = last.find((m) => m.role === 'user')!
    expect(user.role).toBe('user')
    if (user.role === 'user') {
      expect(user.text).toBe('hi there')
      expect(user.content).toBeUndefined()
    }
  })

  it('forwards a content-part prompt onto UserMessage.content', async () => {
    const { provider, getLastMessages } = captureProvider()
    const agent = new MarcoAgent({ provider, tools: [] })
    const parts: UserMessageContentPart[] = [
      { type: 'text', text: "what's in this image" },
      { type: 'image', source: { kind: 'url', url: 'https://x/y.png' } },
    ]
    await agent.ask(parts)
    const last = getLastMessages()!
    const user = last.find((m) => m.role === 'user')!
    expect(user.role).toBe('user')
    if (user.role === 'user') {
      expect(user.content).toEqual(parts)
      expect(user.text).toBe("what's in this image\n[Image]")
    }
  })

  it('treats an empty content array as text-only (no content forwarded)', async () => {
    const { provider, getLastMessages } = captureProvider()
    const agent = new MarcoAgent({ provider, tools: [] })
    await agent.ask([] as AgentPrompt)
    const last = getLastMessages()!
    const user = last.find((m) => m.role === 'user')!
    expect(user.role).toBe('user')
    if (user.role === 'user') {
      expect(user.content).toBeUndefined()
      expect(user.text).toBe('')
    }
  })
})

// ─────────── stream() ───────────

describe('MarcoAgent.stream — AgentPrompt input', () => {
  it('forwards content parts through stream() to the provider', async () => {
    const { provider, getLastMessages } = captureProvider()
    const agent = new MarcoAgent({ provider, tools: [] })
    const parts: UserMessageContentPart[] = [
      { type: 'document', source: { kind: 'url', url: 'https://x/d.pdf', filename: 'd.pdf' } },
    ]
    await drainStream(agent.stream(parts))
    const last = getLastMessages()!
    const user = last.find((m) => m.role === 'user')!
    if (user.role === 'user') {
      expect(user.content).toEqual(parts)
      expect(user.text).toBe('[Document: d.pdf]')
    }
  })

  it('a plain string prompt produces a text-only stream call', async () => {
    const { provider, getLastMessages } = captureProvider()
    const agent = new MarcoAgent({ provider, tools: [] })
    await drainStream(agent.stream('plain text'))
    const last = getLastMessages()!
    const user = last.find((m) => m.role === 'user')!
    if (user.role === 'user') {
      expect(user.text).toBe('plain text')
      expect(user.content).toBeUndefined()
    }
  })
})
