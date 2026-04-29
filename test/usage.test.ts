import { describe, it, expect } from 'vitest'
import { MockProvider } from 'marco-harness'
import { MarcoAgent, BudgetExceededError, defaultAnthropicPricing, withCost } from '../src/index.js'

function turn(text: string, usage = { inputTokens: 100, outputTokens: 50 }) {
  return [
    { type: 'text_delta' as const, text },
    {
      type: 'message_end' as const,
      message: {
        role: 'assistant' as const,
        text,
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage,
      },
    },
  ]
}

describe('usage tracking', () => {
  it('ask() returns aggregated usage and cost for the turn', async () => {
    const provider = new MockProvider([turn('hi', { inputTokens: 200, outputTokens: 100 })])
    const agent = new MarcoAgent({ provider, tools: [], model: 'claude-sonnet-4-6' })
    const result = await agent.ask('say hi')

    expect(result.usage.inputTokens).toBe(200)
    expect(result.usage.outputTokens).toBe(100)
    expect(result.usage.modelCalls).toBe(1)
    // Sonnet 4.6: $3/MT input, $15/MT output → 200*3/1M + 100*15/1M = 0.0006 + 0.0015 = 0.0021
    expect(result.usage.costUsd).toBeCloseTo(0.0021, 6)
  })

  it('only counts tokens from the current turn (excludes carried history)', async () => {
    const provider = new MockProvider([turn('round 2', { inputTokens: 50, outputTokens: 25 })])
    const agent = new MarcoAgent({ provider, tools: [] })
    const history = [
      { role: 'user' as const, text: 'first' },
      {
        role: 'assistant' as const,
        text: 'round 1',
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 9999, outputTokens: 9999 },
      },
    ]
    const result = await agent.ask('next', history)
    expect(result.usage.inputTokens).toBe(50)
    expect(result.usage.outputTokens).toBe(25)
  })

  it('stream() emits a usage event after each model call and a final usage in done', async () => {
    const provider = new MockProvider([turn('hi', { inputTokens: 80, outputTokens: 40 })])
    const agent = new MarcoAgent({ provider, tools: [] })

    const usageEvents: number[] = []
    let finalCost = 0
    for await (const ev of agent.stream('hi')) {
      if (ev.type === 'usage') usageEvents.push(ev.usage.modelCalls)
      if (ev.type === 'done') finalCost = ev.result.usage.costUsd
    }
    expect(usageEvents).toEqual([1])
    expect(finalCost).toBeGreaterThan(0)
  })

  it('budget guard throws BudgetExceededError on ask()', async () => {
    const provider = new MockProvider([turn('hi', { inputTokens: 1000, outputTokens: 1000 })])
    const agent = new MarcoAgent({
      provider,
      tools: [],
      budget: { maxInputTokensPerTurn: 500 },
    })
    await expect(agent.ask('hi')).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it('budget guard emits budget_exceeded in stream() and aborts', async () => {
    const provider = new MockProvider([turn('hi', { inputTokens: 1000, outputTokens: 1000 })])
    const agent = new MarcoAgent({
      provider,
      tools: [],
      budget: { maxCostUsdPerTurn: 0.001, pricing: defaultAnthropicPricing },
    })
    const events: string[] = []
    for await (const ev of agent.stream('hi')) events.push(ev.type)
    expect(events).toContain('budget_exceeded')
  })

  it('defaultAnthropicPricing knows current Anthropic models', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, modelCalls: 1 }
    expect(defaultAnthropicPricing('claude-sonnet-4-6', usage)).toBeCloseTo(3.0, 2)
    expect(defaultAnthropicPricing('claude-haiku-4-5', usage)).toBeCloseTo(0.8, 2)
    expect(defaultAnthropicPricing('claude-opus-4-7', usage)).toBeCloseTo(15.0, 2)
  })

  it('defaultAnthropicPricing strips dated model suffix', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, modelCalls: 1 }
    expect(defaultAnthropicPricing('claude-haiku-4-5-20251001', usage)).toBeCloseTo(0.8, 2)
  })

  it('custom pricing function overrides defaults', () => {
    const usage = { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, modelCalls: 1 }
    const result = withCost(usage, 'whatever', () => 42)
    expect(result.costUsd).toBe(42)
  })
})
