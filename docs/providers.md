# Providers — recipes for every backend

`marco-agent` ships exactly two providers and they cover almost everything:

- **`AnthropicProvider`** — for Claude (Sonnet / Haiku / Opus). Uses Anthropic's official SDK because the Anthropic protocol has real complexity worth absorbing (multiple event types, content blocks, prompt caching, extended thinking).
- **`OpenAICompatibleProvider`** — for everything else. Speaks the OpenAI Chat Completions format, which is the de facto standard. Point its `baseURL` at any endpoint that ships `/v1/chat/completions` and it works.

The whole trick is **swap one URL**:

```typescript
import { OpenAICompatibleProvider } from 'marco-agent'

const provider = new OpenAICompatibleProvider({
  apiKey: process.env.SOMETHING,
  baseURL: 'https://api.example.com/v1',  // ← this is the only thing that changes
})
```

`baseURL` defaults to `https://api.openai.com/v1` (OpenAI direct). Override it and you're talking to OpenRouter, Ollama on your laptop, vLLM in your homelab, Groq, Together — anything compatible.

---

## Recipes

### Claude (Anthropic direct)

```typescript
import { MarcoAgent, AnthropicProvider } from 'marco-agent'

const agent = new MarcoAgent({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  model: 'claude-sonnet-4-6',  // or claude-haiku-4-5, claude-opus-4-7
})
```

If you don't pass a `provider` at all, this is what you get by default. The `apiKey` falls back to `process.env.ANTHROPIC_API_KEY` automatically.

### OpenAI direct (GPT-4, GPT-4.1, GPT-5, o-series)

```typescript
import { MarcoAgent, OpenAICompatibleProvider } from 'marco-agent'

const agent = new MarcoAgent({
  provider: new OpenAICompatibleProvider({
    apiKey: process.env.OPENAI_API_KEY,
    // baseURL defaults to https://api.openai.com/v1 — no need to set it
  }),
  model: 'gpt-4.1-mini',
})
```

`apiKey` falls back to `process.env.OPENAI_API_KEY` automatically.

### OpenRouter (gateway to ~200 models)

```typescript
const agent = new MarcoAgent({
  provider: new OpenAICompatibleProvider({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    // OpenRouter uses these for app rankings on their leaderboard.
    headers: { 'HTTP-Referer': 'https://yourapp.com', 'X-Title': 'Your App' },
  }),
  model: 'deepseek/deepseek-v4-flash',  // or anthropic/claude-sonnet-4-6, openai/gpt-4.1, etc.
})
```

Model names on OpenRouter are namespaced (`provider/model`). Browse the catalog at https://openrouter.ai/models.

### DeepSeek (direct, not via OpenRouter)

```typescript
const agent = new MarcoAgent({
  provider: new OpenAICompatibleProvider({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1',
  }),
  model: 'deepseek-chat',  // or deepseek-reasoner
})
```

### Local — Ollama (Llama, Qwen, Mistral, etc. on your machine)

```typescript
const agent = new MarcoAgent({
  provider: new OpenAICompatibleProvider({
    apiKey: 'ollama',  // any non-empty string; Ollama doesn't actually check
    baseURL: 'http://localhost:11434/v1',
  }),
  model: 'llama3.1',  // whatever you've `ollama pull`'d
})
```

Make sure Ollama is running (`ollama serve` if not already). Model name is whatever you'd pass to `ollama run`.

### Local — LM Studio

```typescript
const agent = new MarcoAgent({
  provider: new OpenAICompatibleProvider({
    apiKey: 'lm-studio',  // placeholder, not validated
    baseURL: 'http://localhost:1234/v1',
  }),
  model: 'whatever-model-you-loaded',  // shows in LM Studio's UI
})
```

LM Studio defaults to port `1234`. Start the local server from LM Studio's "Local Server" tab.

### Self-hosted — vLLM

```typescript
const agent = new MarcoAgent({
  provider: new OpenAICompatibleProvider({
    apiKey: process.env.VLLM_API_KEY,  // if your vLLM is configured with auth
    baseURL: 'http://your-vllm-host:8000/v1',
  }),
  model: 'meta-llama/Llama-3.1-70B-Instruct',
})
```

### Groq

```typescript
const agent = new MarcoAgent({
  provider: new OpenAICompatibleProvider({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  }),
  model: 'llama-3.3-70b-versatile',
})
```

### Together AI

```typescript
const agent = new MarcoAgent({
  provider: new OpenAICompatibleProvider({
    apiKey: process.env.TOGETHER_API_KEY,
    baseURL: 'https://api.together.xyz/v1',
  }),
  model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
})
```

### Fireworks

```typescript
const agent = new MarcoAgent({
  provider: new OpenAICompatibleProvider({
    apiKey: process.env.FIREWORKS_API_KEY,
    baseURL: 'https://api.fireworks.ai/inference/v1',
  }),
  model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
})
```

---

## Things to know

### Pricing defaults are Anthropic-only

`defaultAnthropicPricing` (used for `result.usage.costUsd` when you don't pass your own) only knows Sonnet / Haiku / Opus rates. For OpenRouter / OpenAI / DeepSeek / local models, supply a `pricing` function or treat `costUsd` as zero. The "Writing your own pricing function" section of [`docs/usage-tracking.md`](usage-tracking.md#writing-your-own-pricing-function) walks through a multi-provider example that composes with `defaultAnthropicPricing` so you don't re-author Anthropic's rates.

### Reasoning model token budgets

Reasoning models (DeepSeek R1/V4-Pro, OpenAI o-series via OpenRouter) burn output tokens on hidden chain-of-thought before producing visible text. Bump `maxTokens` to 4-8k for them or the visible answer gets starved. Reasoning text is surfaced separately as `result.reasoning` and `reasoning` stream events.

### Tool-call support varies

`MarcoAgent` will pass tools to any provider, but not every model supports tool calling. If you point at a small local Llama variant or a non-tool-tuned model, the agent will run without tools (model just won't invoke them). Test before relying on it.

### API key resolution

- `AnthropicProvider`: `opts.apiKey` falls back to `process.env.ANTHROPIC_API_KEY`
- `OpenAICompatibleProvider`: `opts.apiKey` falls back to `process.env.OPENAI_API_KEY`

For non-OpenAI backends (OpenRouter, Together, etc.), pass your provider's key explicitly via `apiKey:` — don't rely on the env fallback unless you actually want to reuse `OPENAI_API_KEY` across endpoints.

### When does each provider make sense?

- **Use `AnthropicProvider` for Claude.** Direct integration is more reliable than going through OpenRouter for Claude specifically — Anthropic's protocol features (extended thinking, prompt caching, computer use) are native.
- **Use `OpenAICompatibleProvider` for everything else.** Even OpenAI itself — it's the simpler protocol and the same code path your other models use, fewer surprises when swapping.
- **OpenRouter when you're shopping models.** One API key, every model worth using.
- **Local (Ollama, LM Studio, vLLM) when you need air-gapped, latency-sensitive, or zero-marginal-cost runs.**
