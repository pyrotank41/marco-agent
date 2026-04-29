# marco-agent architecture

This document is the design north star for `marco-agent`. It captures the patterns the library is built around and the deliberate boundary between what the library owns and what each consuming application owns. Per-feature deep dives live in their own docs (linked inline).

## The stack

```
┌────────────────────────────────────────────────────────────┐
│  Your app (CLI, Next.js, Edge function, Discord bot, ...)  │  domain code
├────────────────────────────────────────────────────────────┤
│  marco-agent                                               │  reusable runtime + adapters
│    MarcoAgent · streaming · history · usage · budget · ... │
├────────────────────────────────────────────────────────────┤
│  marco-harness                                             │  the loop inside a harness
│    Harness · runInnerLoop · ToolRegistry · Hooks · Provider│
├────────────────────────────────────────────────────────────┤
│  @anthropic-ai/sdk                                         │  vendor SDK
└────────────────────────────────────────────────────────────┘
```

Each layer adds opinions the layer below deliberately refuses to take. `marco-harness` stays small and unopinionated — about 1000 lines, readable in an afternoon. `marco-agent` adds the opinions every web/CLI agent project would otherwise re-implement: a default agent shape, streaming for UIs, multi-turn history, usage tracking, budgets, eventually compaction and progressive tool disclosure.

## The library/app boundary

The single principle:

> **marco-agent owns the runtime and reusable adapters. The app owns its domain — its data, identity, UI, prompt, persistence.**

Anything app-shaped does not belong in the library, no matter how tempting. Anything you'd otherwise re-implement in every project does belong in the library.

### What lives where

| Concern | marco-agent | Your app |
|---|---|---|
| Agent loop / harness | ✅ via marco-harness | — |
| Streaming machinery (`agent.stream()`) | ✅ shipped | — |
| Multi-turn history shape (`Message[]`) | ✅ shipped | DB table + load/save |
| Usage tracking (tokens) | ✅ shipped | persist per user / conversation |
| Cost computation | ✅ default pricing fn | override for accuracy / negotiated rates |
| Budget guards | ✅ shipped | per-user / per-tier policy |
| Generic tools (`current_time`, calculator, web search) | ✅ shipped / planned | — |
| Domain tools (`search_thoughts`, `update_thought`, …) | — | yours |
| MCP-server-to-Tool bridge | ✅ planned | the MCP server itself |
| System prompt | default neutral prompt only | your project-specific prompt |
| Auth / user scoping | ✅ pattern (per-request tools closing over user_id) | resolve identity, build per-request tools |
| Permission/confirmation hook | ✅ generic helper that takes a callback | provide the actual UI |
| UI command emission convention | ✅ standard event types | client-side interpreter |
| SSE / Web stream helper | ✅ planned (`toSSEResponse`) | drop into your route |
| Conversation persistence | ✅ planned (`HistoryStore` interface) | concrete impl against your DB |
| The chat panel UI | — | all of it |

The litmus test for any new code: *"Would another project I haven't built yet want this exact code?"* If yes → library. If no → app.

## The seam: MCP

Model Context Protocol is the cleanest interface boundary marco-agent has. Treat MCP as the line between *"library knows how to call tools"* and *"app knows what tools mean"*.

```
[ marco-agent ]  ──MCP client adapter──▶  [ your MCP server ]
   knows: how to                              knows: what search_thoughts
   wire MCP tools                             does, who can call it,
   into the harness                           what user_id means
```

Done right:

- Adding a new tool to your app = add it to your MCP server. Zero changes to marco-agent or any consumer.
- Building project #2 = new MCP server, same marco-agent.
- App's job shrinks to: assemble tools, set the system prompt, handle history + auth + UI.

The MCP-to-Tool bridge is the single highest-leverage feature on the marco-agent roadmap because it eliminates wrapper code apps would otherwise hand-write per endpoint.

## Tool categories for web app agents

When designing the tool surface for an agent, think in six categories. Most projects need a slice of each — not necessarily all six.

| Category | Examples | Owner |
|---|---|---|
| **Read your own data** | `search_*`, `list_*`, `get_user_profile` | app |
| **Write your own data** | `create_*`, `update_*`, `delete_*`, `tag_*` | app, often behind confirmation hooks |
| **Drive the client UI** | `navigate(url)`, `open_modal`, `scroll_to(id)`, `highlight(id)` | app emits, marco-agent forwards via SSE convention |
| **Retrieval / RAG** | `semantic_search`, hybrid search, `find_related(id)` | app (vector store) |
| **External integrations** | web search (Tavily/Brave/Exa), `http_fetch`, calendar/Gmail/Slack | marco-agent ships generic adapters; app supplies credentials |
| **Computation / utility** | `current_time`, `calculator`, sandboxed code, scoped read-only SQL | marco-agent ships generic; app adds domain-specific |

Two often-forgotten meta-categories worth designing in from the start:

- **Agent meta-tools** — `schedule_followup`, `handoff_to_human`, `create_task`. Let the agent defer or escalate cleanly.
- **UI tools** — most teams skip these and the chat becomes a wall of text. Even one `navigate(url)` or `highlight(id)` tool transforms the UX.

## Per-call architecture (what happens inside `ask` / `stream`)

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

For `stream()`, the same shape, but the provider is wrapped in a tee that pushes every `ChunkEvent` to a queue. The generator yields `text` / `tool_call_*` / `usage` / `budget_exceeded` events as they arrive, plus a final `done` event with the same `AskResult` shape.

## State lives with the caller

`MarcoAgent` is **stateless across calls**. The conversation history is owned by the caller and passed to each `ask()` / `stream()` call:

```typescript
let history: Message[] = []

const r1 = await agent.ask('My name is Karan.', history)
history = r1.messages

const r2 = await agent.ask('What did I just tell you?', history)
// agent has no memory of r1 except via history
```

This is intentional. Web requests are stateless; one `MarcoAgent` instance can serve thousands of concurrent users. State management — where history lives, when it's evicted, whether it's compacted — is an app concern, not a library one.

A future `HistoryStore` interface will let apps plug a persistence backend in without changing the `ask()` / `stream()` API.

## Streaming for web UIs

`agent.stream()` returns an `AsyncGenerator<StreamEvent>` with five event types:

| Event | When | Use |
|---|---|---|
| `text` | text token from the model | append to live "streaming" string |
| `tool_call_start` | model invokes a tool | show "calling X…" indicator |
| `tool_call_end` | tool finishes | clear the indicator |
| `usage` | after each model call | live spend counter |
| `budget_exceeded` | a budget limit tripped | show user-facing message |
| `done` | turn complete | replace history, persist usage |

The standard web pattern: route handler forwards each event as an SSE `data:` frame; client maintains history in component state and round-trips it with each request. See `examples/nextjs/` for a complete working example.

## Usage tracking

Tokens are the source of truth (model-agnostic, never wrong). Cost is a derived view computed via an injectable `PricingFunction`. The library always reports tokens; cost is best-effort with a default snapshot of current Anthropic prices that apps can override for accuracy or negotiated rates.

Budget guards enforce per-turn limits in tokens, model calls, or USD — your choice. Trips abort the run cleanly via the harness's `beforeModelCall` hook and surface as a typed error (`ask`) or a `budget_exceeded` event (`stream`).

Full details: [`docs/usage-tracking.md`](usage-tracking.md).

## Hooks and extension points

`marco-harness` exposes five hooks that fire at fixed points in the loop. `marco-agent` uses some of them internally (the budget guard wires into `beforeModelCall`) but never blocks user hooks — a userland hook composes with the library's by running second.

| Hook | Fires | Common use |
|---|---|---|
| `onRunStart` | start of a `run()` | logging, request gating |
| `beforeModelCall` | before each model call | injection, **budget guard (library)**, compaction (planned) |
| `beforeToolCall` | before each tool execution | permission UX, audit |
| `afterToolResult` | after each tool result | result transformation, logging |
| `onRunEnd` | end of a `run()` | cleanup, telemetry |

Apps pass hooks via `new MarcoAgent({ hooks: { ... } })`. They run alongside the library's internal hooks, not instead of them.

## Roadmap (in priority order)

What's shipped, what's next, and why each one is library-shaped rather than app-shaped:

| Feature | Status | Why library, not app |
|---|---|---|
| Streaming + multi-turn history | ✅ shipped | every web agent project would re-implement the SSE plumbing |
| Usage tracking + budget guard | ✅ shipped | every project that bills LLM use needs this; one good impl beats N hand-rolled ones |
| **MCP-server-to-Tool bridge** | next | eliminates per-endpoint wrapper code across all consumer apps |
| `toSSEResponse(stream)` helper | next | one-liner that ends the `ReadableStream` boilerplate in route handlers |
| `HistoryStore` interface + in-memory default | next | gives apps a clear plug point for persistence; library default makes "just works" path trivial |
| Confirmation hook helper | next | callback-based pattern; library shape, app provides UI |
| **Compaction** | planned | summarize older history when context fills; library decides when, app optionally tunes |
| Generic tool adapters: `web_search`, `http_fetch` | planned | gated behind separate exports so deps don't bloat install |
| **Progressive tool disclosure** | maybe | only matters at 50+ tools; build when first user hits the ceiling |

### Compaction (planned)

When conversation history grows past a token threshold, summarize the older portion into a single synthetic system message and keep the last N turns verbatim. Implementation:

- Triggered by a `beforeModelCall` hook that checks accumulated input tokens
- Summarization is itself a model call (use a cheaper model like Haiku via `summaryModel`)
- App configures threshold + recency window; library handles the rest

```typescript
new MarcoAgent({
  compaction: {
    triggerAtInputTokens: 80_000,
    keepLastTurns: 4,
    summaryModel: 'claude-haiku-4-5',
  },
})
```

Library-shaped because the trigger logic, the message rewriting, and the safe handoff back into the loop are non-trivial and identical across apps.

### Progressive tool disclosure (maybe)

For agents with 50+ tools, inlining all schemas into every prompt becomes wasteful. The pattern:

- Initial tool list shown to model: `[name, one_line_description]` only
- Auto-injected meta-tools: `list_tools(category?)`, `describe_tool(name)`, `call_tool(name, args)`
- Model discovers what it needs, schemas only enter the conversation when actually relevant

Optional, **default off**. For typical web app agents (5–20 tools), inlining everything is cheaper and lower-latency once prompt caching is enabled — progressive disclosure earns its keep only when the upfront tool prompt becomes a real bottleneck.

## Design decisions worth knowing

### Why tokens, not cost, are the primitive

If the library tracked cost as the core measurement, stale price tables would silently miscount, negotiated rates couldn't be modeled, and Anthropic shipping a new pricing tier would break every consumer until the library shipped a patch. Keeping tokens as truth and cost as a view computed by a function the caller controls means the library can never get accounting wrong — at worst the *displayed* cost is stale, fixable in one line in the consuming app.

### Why state lives with the caller, not the agent

A stateful agent (history-on-instance) sounds ergonomic but locks the library out of multi-user web contexts where one process serves many concurrent conversations. Stateless `ask`/`stream` with an explicit `history` parameter trivially supports both: a CLI keeps history in a local variable, a web route keeps it in the request-scoped DB load.

### Why a fresh Harness per call

Constructing a `Harness` is cheap (microseconds — it's just registering tools and storing references). The alternative — mutating one long-lived harness's `initialMessages` per call — adds a coordination problem under concurrency for no measurable performance gain.

### Why default pricing is a snapshot, labeled as such

Hard-coding prices means they go stale. Refusing to ship defaults means every project writes the same trivial pricing table. Compromise: ship a snapshot with a date in the source comment, and make overriding it a one-liner. Apps that need accuracy override; apps that just want a rough cost figure for telemetry get one for free.

### Why MCP is the integration story, not custom adapters

MCP is becoming the standard tool-exposition protocol across the LLM ecosystem. Building a great MCP-to-Tool bridge once means marco-agent works with any MCP server anyone ships — no per-vendor adapter code, ever. App-side, exposing tools via MCP also means the same toolset is usable from Claude Desktop, ChatGPT, Cursor, and any future MCP consumer — not just from marco-agent.
