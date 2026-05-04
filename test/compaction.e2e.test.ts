// E2E smoke test for compaction meta against a real model.
//
// Skipped unless OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) is set, so CI can
// pass without secrets and the regular `pnpm test` run stays fast and
// hermetic. Run explicitly with:
//   OPENROUTER_API_KEY=... pnpm test compaction.e2e
//
// What this verifies that MockProvider can't:
// - The full request → real-LLM round-trip flows through agent.stream()
//   without losing the meta field (no provider transformation strips it)
// - The summary call's actual usage values (not mocked) populate
//   meta.summaryUsage with sensible non-zero numbers
// - result.messages still contains the synthesized summary as the first
//   system entry after a real compaction

import { describe, it, expect } from 'vitest'
import { OpenAICompatibleProvider } from 'marco-harness'
import type { Message } from 'marco-harness'
import { MarcoAgent } from '../src/agent.js'
import { isCompactionSummary } from '../src/compaction.js'

const HAS_OPENROUTER = !!process.env.OPENROUTER_API_KEY

// Build a synthetic history big enough to trip compaction with a low
// triggerAtInputTokens, without spending real tokens on the conversation
// itself. The summary call still happens (real model), but it operates on
// these short fake turns, not a hundred-thousand-token transcript.
function syntheticHistory(numTurns: number, lastInputTokens: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < numTurns; i++) {
    out.push({ role: 'user', text: `user message ${i}: testing compaction round-trip` })
    out.push({
      role: 'assistant',
      text: `assistant response ${i}: acknowledging the test message`,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: i === numTurns - 1 ? lastInputTokens : 100, outputTokens: 50 },
    })
  }
  return out
}

describe.skipIf(!HAS_OPENROUTER)('e2e: compaction meta survives real LLM round-trip', () => {
  it('synthesizes summary with meta.kind=compaction and non-zero summaryUsage', async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: process.env.OPENROUTER_API_KEY!,
      baseURL: 'https://openrouter.ai/api/v1',
      headers: {
        'HTTP-Referer': 'https://github.com/pyrotank41/marco-agent',
        'X-Title': 'marco-agent compaction e2e',
      },
    })

    const agent = new MarcoAgent({
      provider,
      // Cheap, fast, OpenAI-compatible via OpenRouter.
      model: 'deepseek/deepseek-chat',
      tools: [],
      compaction: {
        summaryModel: 'deepseek/deepseek-chat',
        summaryPrompt: 'Summarize the conversation in one short paragraph.',
        triggerAtInputTokens: 1000, // force trigger
        keepLastTurns: 2,
      },
    })

    const history = syntheticHistory(8, 5000) // last assistant has 5000 input tokens, trips trigger

    const result = await agent.ask('Reply with just the word "ok".', history)

    // Assert the run actually compacted (not just bypassed for some reason).
    expect(result.compacted).toBe(true)

    // The synthesized summary must be present in result.messages.
    // isCompactionSummary narrows .meta to CompactionSummaryMeta — no casts.
    const summaryMsg = result.messages.find(isCompactionSummary)
    expect(summaryMsg).toBeDefined()
    if (summaryMsg) {
      // Real model produced non-empty summary text.
      expect(summaryMsg.text.length).toBeGreaterThan(20)

      // messagesRemoved is the count of original messages folded in.
      // History had 16 messages (8 user + 8 assistant). keepLastTurns=2
      // means we keep the last 2 user msgs + everything from there forward
      // (4 messages), so 12 are removed.
      expect(summaryMsg.meta.messagesRemoved).toBe(12)

      // Real summary call burned real tokens on both sides.
      expect(summaryMsg.meta.summaryUsage.inputTokens).toBeGreaterThan(0)
      expect(summaryMsg.meta.summaryUsage.outputTokens).toBeGreaterThan(0)
    }

    // Sanity: the main turn's answer is present too, after the summary.
    const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant')
    expect(lastAssistant).toBeDefined()
  }, 60_000) // 60s timeout — two real LLM calls
})
