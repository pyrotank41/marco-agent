# Usage tracking

`marco-agent` measures every model call and exposes the result in two layers: **tokens** (the underlying truth, model-agnostic) and **cost in USD** (a derived view, requires a pricing function).

The split exists because token counts never lie, but model prices change and may be project-specific (negotiated rates, internal cross-charging, weighted cache pricing). The library always reports tokens; cost is computed via an injectable pricing function with sensible defaults for current Anthropic models.

## What you get

### From `ask()`

```typescript
const { text, messages, usage } = await agent.ask('hi')
console.log(usage)
// {
//   inputTokens: 200,
//   outputTokens: 100,
//   cacheReadTokens: 0,
//   cacheCreationTokens: 0,
//   modelCalls: 1,
//   costUsd: 0.0021
// }
```

`usage` is the sum across **all model calls in this turn** (a single `ask()` may make several model calls if the agent uses tools and loops). It does **not** include any usage from prior conversation history passed in via the `history` argument — only this turn's spend.

### From `stream()`

Every model call emits a `usage` event with the running total for the turn. The final `done` event carries the same totals on `result.usage`:

```typescript
for await (const ev of agent.stream(prompt, history)) {
  if (ev.type === 'usage') {
    // Running total for this turn after each model call
    console.log('so far:', ev.usage.inputTokens, ev.usage.outputTokens, ev.usage.costUsd)
  }
  if (ev.type === 'done') {
    // Same shape, final
    persistUsage(ev.result.usage)
  }
}
```

## Pricing

The default pricing function knows current Anthropic models:

| Model | Input ($/MTok) | Output ($/MTok) | Cache read | Cache creation |
|---|---|---|---|---|
| `claude-opus-4-7` | 15.00 | 75.00 | 1.50 | 18.75 |
| `claude-sonnet-4-6` | 3.00 | 15.00 | 0.30 | 3.75 |
| `claude-haiku-4-5` | 0.80 | 4.00 | 0.08 | 1.00 |

These are a **snapshot** baked into the library. They will drift. If accuracy matters, supply your own pricing function:

The library strips dated model suffixes (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`) so the default table works with both naming conventions.

## Writing your own pricing function

The `PricingFunction` signature is:

```typescript
type PricingFunction = (model: string, usage: Usage) => number   // returns dollars
```

`model` is the string you passed as `model` to `MarcoAgent` (e.g. `'deepseek/deepseek-v4-flash'`). `usage` is the marco-agent `Usage` shape (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `modelCalls`).

Your function returns the dollar cost for that one call. The library calls it after every model call and accumulates.

### Minimal example — one OpenRouter model

```typescript
import { MarcoAgent, type PricingFunction } from 'marco-agent'

const pricing: PricingFunction = (model, usage) => {
  if (model === 'deepseek/deepseek-v4-flash') {
    // OpenRouter pricing as of writing (check https://openrouter.ai/models for current rates)
    return (usage.inputTokens * 0.14 + usage.outputTokens * 0.28) / 1_000_000
  }
  return 0
}

const agent = new MarcoAgent({ pricing })
```

### Realistic example — multi-provider with Anthropic defaults preserved

For apps using both Anthropic models AND non-Anthropic models, compose with the built-in `defaultAnthropicPricing` so you don't re-author its table:

```typescript
import { MarcoAgent, defaultAnthropicPricing, type PricingFunction } from 'marco-agent'

// Per-1M-token rates. Snapshot — verify against your provider's pricing page.
const OPENROUTER_RATES: Record<string, { input: number; output: number }> = {
  'deepseek/deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'deepseek/deepseek-v4-pro':   { input: 1.25, output: 5.00 },
  'openai/gpt-4.1-mini':        { input: 0.40, output: 1.60 },
  'meta-llama/llama-3.3-70b-instruct': { input: 0.20, output: 0.20 },
}

const pricing: PricingFunction = (model, usage) => {
  // Delegate Claude models to the built-in table.
  if (model.startsWith('claude-')) {
    return defaultAnthropicPricing(model, usage)
  }
  // OpenRouter / direct providers: look up our table.
  const rates = OPENROUTER_RATES[model]
  if (!rates) return 0  // unknown model — return 0 rather than throw, telemetry not blocking
  return (usage.inputTokens * rates.input + usage.outputTokens * rates.output) / 1_000_000
}

const agent = new MarcoAgent({
  pricing,
  budget: { maxCostUsdPerTurn: 0.10, onExceeded: 'abort' },  // budget is enforced against pricing's output
})
```

Returning `0` for unknown models is deliberate: you'd rather have a cost-tracking gap (silent zero in telemetry) than a thrown error mid-conversation. Log the missing entry from your own monitoring instead.

### Where to find rates

| Provider | Pricing page |
|---|---|
| Anthropic | https://www.anthropic.com/pricing |
| OpenAI | https://platform.openai.com/docs/pricing |
| OpenRouter | https://openrouter.ai/models (per-model page) |
| DeepSeek | https://api-docs.deepseek.com/quick_start/pricing |
| Together | https://www.together.ai/pricing |
| Groq | https://groq.com/pricing |

These change. Build a habit of refreshing the table when you add a new model to your registry. For long-lived apps, consider pulling rates from your provider's pricing API (OpenRouter exposes one) and caching client-side rather than baking them in.

### Where the cost lands

Once `pricing` is set, every `result.usage.costUsd` is computed from it. Same for stream `usage` events. The budget guard's `maxCostUsdPerTurn` checks against this same number, so consistent pricing means consistent enforcement.

## Budget guards

For protecting against runaway turns — long tool loops, accidental infinite retries, abusive prompts on a free app — set a `budget`:

```typescript
const agent = new MarcoAgent({
  budget: {
    maxInputTokensPerTurn: 100_000,
    maxOutputTokensPerTurn: 8_000,
    maxModelCallsPerTurn: 20,
    maxCostUsdPerTurn: 0.50,
    onExceeded: 'abort',  // default — throws BudgetExceededError on ask(), aborts harness on stream()
  },
})
```

When a budget is exceeded:

- **`ask()`** throws `BudgetExceededError` with `reason` and `usage` properties. Catch it; you'll know exactly which limit tripped.
- **`stream()`** emits a `budget_exceeded` event with the same fields, then aborts the harness on the next model-call boundary. The final `done` event still fires so callers can persist what they have.

`onExceeded: 'warn'` lets the run continue and only surfaces the trip in events — useful for telemetry-only mode without enforcement.

## Where each concern lives

`marco-agent` owns:

- Aggregating tokens across all calls in a turn
- A reasonable default pricing table
- Computing `costUsd`
- Enforcing budgets (throwing / aborting)
- Emitting per-call usage in the stream

Your app owns:

- Persisting usage per user / per conversation in your DB
- Setting per-user / per-tier budgets based on your business rules
- Converting `costUsd` into your billing or quota system
- Updating the pricing function when Anthropic ships new prices

## Why tokens, not cost, are the source of truth

If the library tracked cost as the primitive:

- Stale price tables would silently miscount
- Negotiated rates couldn't be modeled
- Anthropic adding a new pricing tier (e.g., batch, prompt cache changes) would break the library until upstream patches landed

By keeping tokens as the reported truth and treating cost as a view computed by a function the caller controls, the library can't get the accounting wrong — at worst the *displayed* cost is stale, and you fix that with a one-line pricing function in your own code.
