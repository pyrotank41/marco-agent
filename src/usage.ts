import type { Message, Usage as HarnessUsage } from 'marco-harness'

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  modelCalls: number
}

export type CostUsage = Usage & {
  costUsd: number
}

export type PricingFunction = (model: string, usage: Usage) => number

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  modelCalls: 0,
})

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    modelCalls: a.modelCalls + b.modelCalls,
  }
}

export function fromHarnessUsage(u: HarnessUsage | undefined): Usage {
  if (!u) return emptyUsage()
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelCalls: 1,
  }
}

// Sums usage across all assistant messages in `messages` after `historyLength`.
// Used to compute the usage attributable to the current turn, ignoring any
// usage that was already carried in from prior conversation history.
export function turnUsage(messages: Message[], historyLength: number): Usage {
  let total = emptyUsage()
  for (let i = historyLength; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'assistant') {
      total = addUsage(total, fromHarnessUsage(m.usage))
    }
  }
  return total
}

// Default pricing for current Anthropic models. Snapshot as of 2026-04-28 — pass
// your own PricingFunction for accuracy or to model negotiated rates.
//
// Rates are in dollars per 1M tokens. Cache rates only apply when the upstream
// SDK starts emitting cache breakdowns; until then those token counts are zero.
const ANTHROPIC_RATES_USD_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheCreate: 18.75 },
  'claude-sonnet-4-6': { input:  3.00, output: 15.00, cacheRead: 0.30, cacheCreate:  3.75 },
  'claude-haiku-4-5':  { input:  0.80, output:  4.00, cacheRead: 0.08, cacheCreate:  1.00 },
}

export const defaultAnthropicPricing: PricingFunction = (model, usage) => {
  const rates = ANTHROPIC_RATES_USD_PER_MTOK[stripModelSuffix(model)]
  if (!rates) return 0
  return (
    usage.inputTokens         * rates.input +
    usage.outputTokens        * rates.output +
    usage.cacheReadTokens     * rates.cacheRead +
    usage.cacheCreationTokens * rates.cacheCreate
  ) / 1_000_000
}

function stripModelSuffix(model: string): string {
  // Match either base name (claude-sonnet-4-6) or dated variant
  // (claude-sonnet-4-6-20251001) by trimming a trailing -YYYYMMDD.
  return model.replace(/-\d{8}$/, '')
}

export function withCost(usage: Usage, model: string, pricing?: PricingFunction): CostUsage {
  const fn = pricing ?? defaultAnthropicPricing
  return { ...usage, costUsd: fn(model, usage) }
}
