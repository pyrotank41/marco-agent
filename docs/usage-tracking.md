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

```typescript
import { MarcoAgent, type PricingFunction } from 'marco-agent'

const myPricing: PricingFunction = (model, usage) => {
  // your own table, your negotiated rates, your cache weighting...
  if (model === 'claude-sonnet-4-6') {
    return (usage.inputTokens * 2.50 + usage.outputTokens * 12.00) / 1_000_000
  }
  return 0
}

const agent = new MarcoAgent({ pricing: myPricing })
```

The library also strips dated suffixes (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`) so the default table works with both naming conventions.

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
