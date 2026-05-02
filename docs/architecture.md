# marco-agent architecture

The design north star for `marco-agent`. Captures the patterns the library is built around and the deliberate boundary between what the library owns and what each consuming application owns. Per-feature deep dives live in their own docs (linked inline).

## The stack

```
┌────────────────────────────────────────────────────────────┐
│  Your app (CLI, Next.js, Edge function, Discord bot, ...)  │  domain code
├────────────────────────────────────────────────────────────┤
│  marco-agent                                               │  reusable runtime + adapters
│    MarcoAgent · streaming · history · usage · MCP bridge   │
├────────────────────────────────────────────────────────────┤
│  marco-harness                                             │  the loop inside a harness
│    Harness · runInnerLoop · ToolRegistry · Hooks · Provider│
├────────────────────────────────────────────────────────────┤
│  @anthropic-ai/sdk                                         │  vendor SDK
└────────────────────────────────────────────────────────────┘
```

Each layer adds opinions the layer below deliberately refuses to take. `marco-harness` stays small and unopinionated — about 1000 lines, readable in an afternoon. `marco-agent` adds the opinions every CLI or web agent project would otherwise re-implement.

## The library/app boundary

> **marco-agent owns the runtime and reusable adapters. The app owns its domain — its data, identity, UI, prompt, persistence.**

Anything app-shaped does not belong in the library, no matter how tempting. Anything you'd otherwise re-implement in every project does belong in the library.

Litmus test for any new code: *"Would another project I haven't built yet want this exact code?"* If yes → library. If no → app. If maybe → wait until the second concrete consumer asks for it.

## Where tools come from

A `MarcoAgent` is just an LLM loop with a list of tools. Those tools come from exactly three places:

| Source | Lives in | Examples |
|---|---|---|
| **Library helpers** | `marco-agent` | `currentTimeTool`, `fromMcpServer()` (a tool *factory*) |
| **App built-ins** | your app code | crystallio's `searchThoughtsTool(userId)`, your `bash` tool, etc. |
| **MCP-provided** | a remote MCP server, loaded via `fromMcpServer()` | crystallio MCP, filesystem MCP, anything that speaks MCP |

Memory is not a special concept — it's tools. If your agent has tools that read and write persistent state, it has memory. The library does not invent a separate "memory" abstraction, because tools already model that perfectly.

## The seam: MCP

```
[ marco-agent ]  ──fromMcpServer()──▶  [ your MCP server ]
   knows: how to                          knows: what search_thoughts
   wire MCP tools                         does, who can call it,
   into the harness                       what user_id means
```

Adding a new tool to your app = add it to your MCP server. Zero changes to marco-agent or any consumer. Building project #2 = new MCP server, same marco-agent. App's job shrinks to: assemble tools, set the system prompt, handle history + auth + UI.

Full API: [`docs/mcp-bridge.md`](mcp-bridge.md).

## Per-call architecture

Each call to `ask()` or `stream()` constructs a fresh `Harness` internally. State (history, tools, system prompt) is composed per-call rather than carried on the agent. This keeps a single `MarcoAgent` instance safe to share across concurrent web requests.

```
agent.ask(prompt, history)
  │
  ├─ buildHarness(history, provider, budgetGuard)
  │     ├─ initialMessages = history
  │     ├─ tools           = options.tools (default: [current_time])
  │     ├─ hooks           = userHooks merged with budget guard
  │     └─ modelConfig     = { model, maxTokens, systemPrompt, ... }
  │
  ├─ harness.run({ kind: 'user_message', text: prompt })
  │     ├─ inner loop: model call → maybe tool calls → tool results → loop
  │     └─ returns final messages
  │
  └─ usage = sum(usage of all assistant messages added this turn)
     return { text, messages, usage: { ...tokens, costUsd } }
```

For `stream()`, the same shape, but the provider is wrapped in a tee that pushes every `ChunkEvent` to a queue. The generator yields events as they arrive, plus a final `done` event with the same `AskResult` shape.

## State lives with the caller

`MarcoAgent` is **stateless across calls**. The conversation history is owned by the caller and passed to each `ask()` / `stream()` call:

```typescript
let history: Message[] = []

const r1 = await agent.ask('My name is Karan.', history)
history = r1.messages

const r2 = await agent.ask('What did I just tell you?', history)
// agent has no memory of r1 except via history
```

Web requests are stateless; one `MarcoAgent` instance can serve thousands of concurrent users. Where history lives, when it's evicted, whether it's compacted — that's an app concern, not a library one. A CLI keeps history in a local variable; a web route loads it from a request-scoped DB lookup.

## Streaming events

`agent.stream()` returns an `AsyncGenerator<StreamEvent>` with these event types:

| Event | When | Use |
|---|---|---|
| `text` | text token from the model | append to live "streaming" string |
| `tool_call_start` | model invokes a tool | show "calling X…" indicator |
| `tool_call_end` | tool finishes | clear the indicator |
| `usage` | after each model call | live spend counter |
| `budget_exceeded` | a budget limit tripped | show user-facing message |
| `done` | turn complete | replace history, persist usage |

Standard web pattern: route handler forwards each event as an SSE `data:` frame; client maintains history in component state and round-trips it with each request. See `examples/nextjs/`.

## Usage tracking

Tokens are the source of truth (model-agnostic, never wrong). Cost is a derived view computed via an injectable `PricingFunction`. Library always reports tokens; cost uses a dated default snapshot for current Anthropic models that apps override for accuracy or negotiated rates.

Budget guards enforce per-turn limits in tokens, model calls, or USD — caller picks. Trips abort the run via the harness's `beforeModelCall` hook and surface as a typed error (`ask`) or a `budget_exceeded` event (`stream`).

Full details: [`docs/usage-tracking.md`](usage-tracking.md). For the complete list of supported model backends and `baseURL` recipes (Anthropic, OpenAI direct, OpenRouter, DeepSeek, Ollama, LM Studio, vLLM, Groq, Together, Fireworks), see [`docs/providers.md`](providers.md).

## Hooks

`marco-harness` exposes five hooks. `marco-agent` uses some internally (the budget guard wires into `beforeModelCall`) but never blocks userland hooks — they run alongside the library's, not instead of them.

| Hook | Fires | Common use |
|---|---|---|
| `onRunStart` | start of a `run()` | logging, request gating |
| `beforeModelCall` | before each model call | injection, budget guard (library) |
| `beforeToolCall` | before each tool execution | permission UX, audit |
| `afterToolResult` | after each tool result | result transformation, logging |
| `onRunEnd` | end of a `run()` | cleanup, telemetry |

Pass via `new MarcoAgent({ hooks: { ... } })`.

## What v0.1.0 ships

The complete library surface. If it's not in this list, it's not in v0.1.0:

| Feature | Status |
|---|---|
| `MarcoAgent` (constructor, defaults, options) | ✅ |
| `ask(prompt, history?)` — single-turn, returns text + messages + usage | ✅ |
| `stream(prompt, history?)` — async generator of typed `StreamEvent`s | ✅ |
| Multi-turn history (caller-owned, passed per call) | ✅ |
| Usage tracking (tokens) and computed cost (default Anthropic pricing, overridable) | ✅ |
| Budget guards (`maxInputTokensPerTurn`, `maxModelCallsPerTurn`, `maxCostUsdPerTurn`) | ✅ |
| `BudgetExceededError` and `budget_exceeded` stream event | ✅ |
| `currentTimeTool` (one bundled generic tool) | ✅ |
| `fromMcpServer()` — MCP-to-Tool bridge with `contextArgs` for multi-tenant scoping | ✅ |
| Anthropic and Mock providers (re-exported from marco-harness) | ✅ |
| `OpenAICompatibleProvider` for OpenRouter/Together/Groq/vLLM/etc. (re-exported) | ✅ |
| Reasoning content surfaced as `reasoning` stream event + `AskResult.reasoning` | ✅ |
| `toolFromZod()` — derive a Tool's JSON Schema + validation from a single zod schema | ✅ |
| Compaction (opt-in) — summarize older history when token use trips a threshold; emits `compaction_start`/`compaction_end` events; `AskResult.compacted` flag | ✅ |
| `marco-agent "<prompt>"` CLI bin (one-shot or `--stream`) | ✅ |

Anything else — compaction, progressive tool disclosure, web search adapters, persistence helpers, plugin systems — is **not decided**. We add features when a real consumer needs them, not before.

## Design decisions worth knowing

### Tokens, not cost, are the primitive
If the library tracked cost as the core measurement, stale price tables would silently miscount and negotiated rates couldn't be modeled. Tokens are truth; cost is a view computed by a caller-controlled function. At worst the *displayed* cost is stale — fixable in one line in the consuming app.

### State lives with the caller, not the agent
A stateful agent (history-on-instance) sounds ergonomic but locks the library out of multi-user web contexts. Stateless `ask`/`stream` with an explicit `history` parameter trivially supports both: a CLI keeps history in a local variable, a web route loads it from a request-scoped store.

### A fresh Harness per call
Constructing a `Harness` is cheap (microseconds — registering tool references and storing options). The alternative — mutating one long-lived harness's `initialMessages` per call — adds a coordination problem under concurrency for no measurable performance gain.

### Default pricing is a dated snapshot
Hard-coding prices means they go stale. Refusing to ship defaults means every project writes the same trivial pricing table. Compromise: ship a snapshot with a date in the source comment, make overriding it a one-liner.

### MCP is the integration story
MCP is the standard tool-exposition protocol across the LLM ecosystem. Building a great MCP-to-Tool bridge once means marco-agent works with any MCP server anyone ships — no per-vendor adapter code. App-side, exposing tools via MCP means the same toolset works in Claude Desktop, ChatGPT, Cursor, and anything else that speaks MCP — not just marco-agent.

### No abstractions before two concrete consumers
We deliberately did NOT ship a `MemoryStore` interface or a `HistoryStore` interface, even though both seemed reasonable. Reason: each had exactly one current consumer, and one impl is a class, not an interface. We add the interface when a second backend actually shows up.

### SDK for Anthropic, raw fetch for OpenAI-compatible — situational, not biased
`AnthropicProvider` uses `@anthropic-ai/sdk` because Anthropic's streaming protocol is genuinely complex (six event types, nested content blocks, prompt caching, extended thinking, computer use — and it changes). The SDK absorbs that churn. `OpenAICompatibleProvider` uses raw `fetch()` because the OpenAI chat-completions format is simple, the role demands working with many endpoints (OpenRouter / Together / Groq / vLLM / LM Studio), and pulling the OpenAI SDK with custom `baseURL` adds 15+ deps we don't need. Rule: **use the SDK when the protocol earns its weight; roll fetch when it doesn't.** Asymmetry is intentional, not accidental.

### Compaction defaults are intentionally minimal
Compaction takes `summaryModel` and `summaryPrompt` as **required** fields with no defaults. Defaulting `summaryModel` would silently break apps using non-Anthropic providers (the default model wouldn't resolve against an OpenRouter or DeepSeek API key). Defaulting `summaryPrompt` would produce useless summaries — what to preserve depends on the agent's domain. Only `triggerAtInputTokens` (default 150_000) and `keepLastTurns` (default 4) have defaults, because both are domain-agnostic and broadly safe.
