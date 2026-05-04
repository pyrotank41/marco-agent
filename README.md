# marco-agent

[![npm version](https://img.shields.io/npm/v/marco-agent?color=cb3837&label=marco-agent&logo=npm)](https://www.npmjs.com/package/marco-agent)
[![npm downloads](https://img.shields.io/npm/dm/marco-agent?color=cb3837&logo=npm)](https://www.npmjs.com/package/marco-agent)
[![license](https://img.shields.io/npm/l/marco-agent)](./LICENSE)

A simple, extensible AI agent built on [marco-harness](https://github.com/pyrotank41/MARCO). Works in CLI, server-side Node, Next.js, and Edge runtimes — with Anthropic, OpenAI, OpenRouter, DeepSeek, Together, Groq, vLLM, LM Studio, or any OpenAI-compatible endpoint.

`MarcoAgent` is a thin, composable wrapper around the harness. Sensible defaults out of the box, every knob exposed when you need it: streaming, multi-turn history, usage + cost tracking, per-turn budget guards, MCP-server-to-Tool bridge, opt-in compaction, and reasoning-content surfacing for chain-of-thought models.

> **Designing an integration?** See [`docs/architecture.md`](docs/architecture.md) for the library/app boundary, tool-source framework, and the design decisions worth knowing. Per-feature deep dives: [`docs/providers.md`](docs/providers.md), [`docs/usage-tracking.md`](docs/usage-tracking.md), [`docs/mcp-bridge.md`](docs/mcp-bridge.md), [`docs/compaction.md`](docs/compaction.md).

## Install

```bash
npm install marco-agent
```

## Quick start

```typescript
import { MarcoAgent } from 'marco-agent'

const agent = new MarcoAgent()
const { text } = await agent.ask('What time is it in Tokyo?')
console.log(text)
```

Set `ANTHROPIC_API_KEY` in your environment before running. Default model is `claude-sonnet-4-6`; default tool surface includes `current_time`.

## CLI

```bash
npx marco-agent "summarize the latest TC39 stage-4 proposals"
npx marco-agent --stream "write a haiku about TypeScript"
```

## Streaming

For chat UIs, server-sent events, etc. — `agent.stream()` returns an `AsyncGenerator<StreamEvent>` with these event types:

| Event | When |
|---|---|
| `text` | text token from the model |
| `reasoning` | chain-of-thought token (DeepSeek R1/V4-Pro, OpenAI o-series, etc.) |
| `tool_call_start` | model invokes a tool |
| `tool_call_end` | tool finishes |
| `usage` | running token + cost total after each model call |
| `budget_exceeded` | a budget guard tripped |
| `compaction_start` / `compaction_end` | history compaction summary call begins / finishes |
| `done` | turn complete; `event.result` carries text, messages, usage |

```typescript
for await (const event of agent.stream('explain monads')) {
  if (event.type === 'text') process.stdout.write(event.text)
  else if (event.type === 'reasoning') process.stderr.write(event.text)  // route to a separate panel
  else if (event.type === 'tool_call_start') console.log(`\n[calling ${event.name}]`)
  else if (event.type === 'usage') updateLiveSpendCounter(event.usage.costUsd)
  else if (event.type === 'done') persist(event.result.messages)
}
```

## Multi-turn conversations

`ask()` and `stream()` both accept a `history` parameter — pass the previous turn's `result.messages` to continue:

```typescript
import type { Message } from 'marco-agent'

let history: Message[] = []

const r1 = await agent.ask('My name is Karan.', history)
history = r1.messages

const r2 = await agent.ask('What did I just tell you?', history)
console.log(r2.text) // → "You told me your name is Karan."
```

State lives with the caller, not the agent — so a single `MarcoAgent` instance is safe to share across concurrent web requests.

## Choosing a provider

Two providers cover everything. `AnthropicProvider` for Claude. `OpenAICompatibleProvider` for the rest — swap one URL, talk to anything that speaks `/v1/chat/completions`:

| Backend | Provider | `baseURL` |
|---|---|---|
| Claude (Anthropic) | `AnthropicProvider` | — |
| OpenAI direct | `OpenAICompatibleProvider` | `https://api.openai.com/v1` (default) |
| OpenRouter | `OpenAICompatibleProvider` | `https://openrouter.ai/api/v1` |
| DeepSeek direct | `OpenAICompatibleProvider` | `https://api.deepseek.com/v1` |
| Ollama (local Llama, Qwen, etc.) | `OpenAICompatibleProvider` | `http://localhost:11434/v1` |
| LM Studio (local) | `OpenAICompatibleProvider` | `http://localhost:1234/v1` |
| Groq, Together, Fireworks, vLLM, … | `OpenAICompatibleProvider` | their `/v1` |

Quick example — OpenRouter:

```typescript
import { MarcoAgent, OpenAICompatibleProvider } from 'marco-agent'

const agent = new MarcoAgent({
  provider: new OpenAICompatibleProvider({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    headers: { 'HTTP-Referer': 'https://yourapp.com', 'X-Title': 'Your App' },
  }),
  model: 'deepseek/deepseek-v4-flash',
})
```

Full recipes for each backend (including local Ollama, direct OpenAI, vLLM, etc.) are in [`docs/providers.md`](docs/providers.md).

## Tools — define once with zod

`toolFromZod()` derives the JSON Schema and runtime validation from a single zod schema, instead of authoring both by hand:

```typescript
import { MarcoAgent, toolFromZod, z } from 'marco-agent'

const calculatorTool = toolFromZod({
  name: 'calculator',
  description: 'Evaluate a basic arithmetic expression.',
  schema: z.object({ expression: z.string() }),
  handler: async ({ expression }) =>
    String(Function(`"use strict"; return (${expression})`)()),
})

const agent = new MarcoAgent({
  systemPrompt: 'You are a math tutor. Show your work.',
  tools: [calculatorTool],
})
```

`z` is re-exported from marco-agent so you don't have to manage zod's v4 import path. (Internally uses `zod/v4` for native JSON Schema export.)

## MCP server tools — `fromMcpServer()`

Connect to any MCP server and turn its tool surface into agent tools with one call:

```typescript
import { MarcoAgent, fromMcpServer, currentTimeTool } from 'marco-agent'

const tools = await fromMcpServer({
  url: 'https://your-app.com/api/mcp',
  headers: { 'authorization': `Bearer ${serverSecret}` },
  // Spread into every tool call's arguments AFTER the model's args, so the
  // model can't override — multi-tenant security boundary.
  contextArgs: { target_user_id: requestingUserId },
  // Optional filter for which tools to expose.
  include: ['search_records', 'list_records'],
})

const agent = new MarcoAgent({ tools: [currentTimeTool, ...tools] })
```

Full API: [`docs/mcp-bridge.md`](docs/mcp-bridge.md).

## Usage tracking & budgets

Tokens are the source of truth, cost is a derived view via injectable pricing function. Defaults ship for current Anthropic models; override for accuracy or non-Anthropic models:

```typescript
const agent = new MarcoAgent({
  budget: {
    maxInputTokensPerTurn: 100_000,
    maxModelCallsPerTurn: 20,
    maxCostUsdPerTurn: 0.50,
    onExceeded: 'abort',  // throws BudgetExceededError on ask(), emits budget_exceeded on stream()
  },
  // Optional — pass your own pricing for OpenRouter/DeepSeek/negotiated rates.
  pricing: (model, usage) => /* your $-per-token table */ 0,
})

const { text, usage } = await agent.ask('hello')
console.log(usage)
// { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, modelCalls, costUsd }
```

Full API: [`docs/usage-tracking.md`](docs/usage-tracking.md).

## Compaction (opt-in)

When conversations get long, summarize older history into a synthetic system message and keep the last N turns verbatim:

```typescript
const agent = new MarcoAgent({
  compaction: {
    summaryModel: 'claude-haiku-4-5',  // REQUIRED — pick a cheap model
    summaryPrompt: 'Summarize the conversation, preserving facts learned and unresolved threads.',  // REQUIRED
    triggerAtInputTokens: 150_000,  // optional, default 150_000
    keepLastTurns: 4,                // optional, default 4
  },
})
```

Without `compaction` config, no compaction happens. `summaryModel` and `summaryPrompt` are required — the library can't know what models your API key supports or what shape of summary your domain needs.

Full API: [`docs/compaction.md`](docs/compaction.md).

## Reasoning models

Models that emit chain-of-thought (DeepSeek R1/V4-Pro, OpenAI o-series via OpenRouter) surface their reasoning separately from the final text:

```typescript
const { text, reasoning } = await agent.ask('Hard logic problem.')
console.log(text)       // the visible answer
console.log(reasoning)  // the model's hidden thinking, if any
```

Heads up: reasoning models burn output tokens on hidden CoT. Bump `maxTokens` to ~4-8k for them so the visible answer isn't starved.

## Web app integration (Next.js)

A complete streaming chat panel example lives in [`examples/nextjs/`](examples/nextjs/) — server route handler + client React component, plus notes on adapting it for project-specific tools.

## License

MIT
