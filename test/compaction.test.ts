import { describe, it, expect } from 'vitest'
import { MockProvider } from 'marco-harness'
import type { Message, ChunkEvent } from 'marco-harness'
import { MarcoAgent, type StreamEvent } from '../src/agent.js'
import { shouldCompact, performCompaction } from '../src/compaction.js'

function assistantTurn(text: string, inputTokens = 1000, outputTokens = 50): ChunkEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        text,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens, outputTokens },
      },
    },
  ]
}

function makeHistory(numTurns: number, lastInputTokens: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < numTurns; i++) {
    out.push({ role: 'user', text: `user message ${i}` })
    out.push({
      role: 'assistant',
      text: `assistant response ${i}`,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: i === numTurns - 1 ? lastInputTokens : 100, outputTokens: 50 },
    })
  }
  return out
}

describe('shouldCompact', () => {
  it('returns false when no config is provided', () => {
    expect(shouldCompact(makeHistory(10, 200_000), 'hi', undefined)).toBe(false)
  })

  it('returns false when no prior assistant turn exists', () => {
    expect(shouldCompact([], 'hi', { summaryModel: 'm', summaryPrompt: 'p' })).toBe(false)
    expect(shouldCompact(
      [{ role: 'user', text: 'first' }],
      'hi',
      { summaryModel: 'm', summaryPrompt: 'p' },
    )).toBe(false)
  })

  it('returns false when last input tokens + new prompt below threshold', () => {
    expect(shouldCompact(
      makeHistory(10, 1000),
      'short',
      { summaryModel: 'm', summaryPrompt: 'p', triggerAtInputTokens: 100_000 },
    )).toBe(false)
  })

  it('returns true when threshold exceeded and enough turns to compact', () => {
    expect(shouldCompact(
      makeHistory(10, 200_000),
      'hi',
      { summaryModel: 'm', summaryPrompt: 'p', triggerAtInputTokens: 150_000, keepLastTurns: 4 },
    )).toBe(true)
  })

  it('returns false when threshold exceeded but not enough turns to compact', () => {
    expect(shouldCompact(
      makeHistory(3, 200_000),
      'hi',
      { summaryModel: 'm', summaryPrompt: 'p', triggerAtInputTokens: 150_000, keepLastTurns: 4 },
    )).toBe(false)
  })

  it('uses default 150_000 threshold when not specified', () => {
    expect(shouldCompact(
      makeHistory(10, 149_000),
      'hi',
      { summaryModel: 'm', summaryPrompt: 'p' },
    )).toBe(false)
    expect(shouldCompact(
      makeHistory(10, 151_000),
      'hi',
      { summaryModel: 'm', summaryPrompt: 'p' },
    )).toBe(true)
  })
})

describe('performCompaction', () => {
  it('summarizes prefix and keeps last N turns', async () => {
    const history = makeHistory(10, 200_000)  // 20 messages (10 user + 10 assistant)
    // Mock summary model returns a fixed summary
    const provider = new MockProvider([assistantTurn('SUMMARY OF EARLIER TURNS', 5000, 100)])
    const result = await performCompaction(provider, history, {
      summaryModel: 'haiku',
      summaryPrompt: 'Summarize the conversation.',
      keepLastTurns: 3,
    })

    expect(result.compacted).toBe(true)
    // After compaction: 1 system summary + last 3 turns × 2 messages each = 7 messages
    expect(result.history.length).toBe(7)
    expect(result.history[0].role).toBe('system')
    if (result.history[0].role === 'system') {
      expect(result.history[0].text).toContain('SUMMARY OF EARLIER TURNS')
      // The synthesized summary must carry meta so consumers can identify it
      // in result.messages without separate stream-event tracking.
      expect(result.history[0].meta).toEqual({
        kind: 'compaction',
        messagesRemoved: 14,
        summaryUsage: { inputTokens: 5000, outputTokens: 100 },
      })
    }
    // Last messages are the most recent 3 user/assistant pairs from the original
    expect(result.history[1]).toEqual({ role: 'user', text: 'user message 7' })
    // Usage tracked from the summary call
    expect(result.usage).toEqual({ inputTokens: 5000, outputTokens: 100 })
    // 14 messages collapsed (everything before the 8th user message)
    expect(result.messagesRemoved).toBe(14)
  })

  it('omits meta on user-provided system messages so they stay distinguishable', async () => {
    // performCompaction only runs against history; user-provided system
    // prompts come in via MarcoAgent.systemPrompt, never through history.
    // But we should verify that the meta field is never populated on
    // anything BUT the synthesized summary — i.e. plain SystemMessage stays
    // shaped { role, text } without meta.
    const history = makeHistory(10, 200_000)
    const provider = new MockProvider([assistantTurn('SUM', 1000, 50)])
    const result = await performCompaction(provider, history, {
      summaryModel: 'm',
      summaryPrompt: 'p',
      keepLastTurns: 3,
    })

    // Only one system message in result.history, and it's the synthesized one.
    const systemMessages = result.history.filter((m) => m.role === 'system')
    expect(systemMessages).toHaveLength(1)
    if (systemMessages[0].role === 'system') {
      expect(systemMessages[0].meta).toBeDefined()
      expect(systemMessages[0].meta?.kind).toBe('compaction')
    }
  })
})

describe('MarcoAgent compaction integration', () => {
  it('does not compact when compaction config is absent', async () => {
    const provider = new MockProvider([assistantTurn('answer')])
    const agent = new MarcoAgent({ provider, tools: [] })
    const result = await agent.ask('hi', makeHistory(20, 999_999))
    expect(result.compacted).toBeUndefined()
  })

  it('compacts before the next turn when threshold tripped, surfacing compacted: true', async () => {
    // Two scripted provider responses: first the summary call, then the actual ask
    const provider = new MockProvider([
      assistantTurn('SUMMARY', 3000, 80),
      assistantTurn('actual answer'),
    ])
    const agent = new MarcoAgent({
      provider,
      tools: [],
      compaction: { summaryModel: 'haiku', summaryPrompt: 'Summarize.', triggerAtInputTokens: 100_000, keepLastTurns: 3 },
    })
    const result = await agent.ask('next prompt', makeHistory(10, 200_000))
    expect(result.compacted).toBe(true)
    expect(result.text).toBe('actual answer')
    // Usage should include both the summary call AND the actual turn
    expect(result.usage.modelCalls).toBe(2)
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(3000 + 1000)
  })

  it('emits compaction_start and compaction_end events in stream()', async () => {
    const provider = new MockProvider([
      assistantTurn('SUMMARY', 2000, 60),
      assistantTurn('streaming answer'),
    ])
    const agent = new MarcoAgent({
      provider,
      tools: [],
      compaction: { summaryModel: 'haiku', summaryPrompt: 'Summarize.', triggerAtInputTokens: 100_000, keepLastTurns: 3 },
    })

    const events: StreamEvent[] = []
    for await (const e of agent.stream('next prompt', makeHistory(10, 200_000))) events.push(e)

    const types = events.map((e) => e.type)
    const startIdx = types.indexOf('compaction_start')
    const endIdx = types.indexOf('compaction_end')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThan(startIdx)

    const endEvent = events[endIdx] as { type: 'compaction_end'; messagesRemoved: number; summaryTokens: number }
    expect(endEvent.messagesRemoved).toBeGreaterThan(0)
    expect(endEvent.summaryTokens).toBe(60)

    const done = events.find((e) => e.type === 'done')!
    if (done.type !== 'done') throw new Error('expected done')
    expect(done.result.compacted).toBe(true)
  })

  it('synthesized summary in result.messages carries meta.kind compaction with summaryUsage', async () => {
    // The whole point of meta: consumers can detect compaction in
    // result.messages without threading separate stream-event tracking
    // through their persistence layer (e.g. crystallio's archive).
    const provider = new MockProvider([
      assistantTurn('SUMMARY', 4321, 87),  // distinctive token counts
      assistantTurn('next answer'),
    ])
    const agent = new MarcoAgent({
      provider,
      tools: [],
      compaction: { summaryModel: 'haiku', summaryPrompt: 'Summarize.', triggerAtInputTokens: 100_000, keepLastTurns: 3 },
    })
    const result = await agent.ask('next prompt', makeHistory(10, 200_000))
    expect(result.compacted).toBe(true)

    const summaryMsg = result.messages.find(
      (m) => m.role === 'system' && m.meta?.kind === 'compaction',
    )
    expect(summaryMsg).toBeDefined()
    if (summaryMsg && summaryMsg.role === 'system') {
      expect(summaryMsg.text).toContain('SUMMARY')
      expect(summaryMsg.meta).toEqual({
        kind: 'compaction',
        messagesRemoved: 14,
        // Both input + output tokens of the summary LLM call — needed for
        // cost attribution; output alone is insufficient.
        summaryUsage: { inputTokens: 4321, outputTokens: 87 },
      })
    }
  })

  it('does not emit compaction events or set compacted when not triggered', async () => {
    const provider = new MockProvider([assistantTurn('plain')])
    const agent = new MarcoAgent({
      provider,
      tools: [],
      compaction: { summaryModel: 'haiku', summaryPrompt: 'Summarize.', triggerAtInputTokens: 100_000, keepLastTurns: 3 },
    })

    const events: StreamEvent[] = []
    for await (const e of agent.stream('hi', makeHistory(2, 1000))) events.push(e)

    expect(events.find((e) => e.type === 'compaction_start')).toBeUndefined()
    expect(events.find((e) => e.type === 'compaction_end')).toBeUndefined()
    const done = events.find((e) => e.type === 'done')!
    if (done.type !== 'done') throw new Error('expected done')
    expect(done.result.compacted).toBeUndefined()
  })
})
