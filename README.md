# marco-agent

A simple, extensible AI agent built on [marco-harness](https://github.com/pyrotank41/MARCO). Works in CLI, server-side Node, and Next.js / Edge runtimes (anywhere `@anthropic-ai/sdk` runs).

`MarcoAgent` is a thin wrapper around the harness with sensible defaults — a system prompt, the Claude Sonnet 4.6 model, and one bundled tool (`current_time`). Use it as-is for quick scripts, or extend it with your own tools, hooks, and conversation history for project-specific agents.

> **Designing an integration?** See [`docs/architecture.md`](docs/architecture.md) for the library/app boundary, tool-category framework, and roadmap. [`docs/usage-tracking.md`](docs/usage-tracking.md) covers token + cost accounting in depth. [`docs/mcp-bridge.md`](docs/mcp-bridge.md) covers `fromMcpServer()` for wiring any MCP server into the agent.

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

Set `ANTHROPIC_API_KEY` in your environment before running.

## CLI

```bash
npx marco-agent "summarize the latest TC39 stage-4 proposals"
npx marco-agent --stream "write a haiku about TypeScript"
```

## Streaming

For chat UIs, server-sent events, etc. — get tokens as they arrive:

```typescript
for await (const event of agent.stream('explain monads')) {
  if (event.type === 'text') process.stdout.write(event.text)
  else if (event.type === 'tool_call_start') console.log(`\n[calling ${event.name}]`)
  else if (event.type === 'done') {
    // event.result.messages is the canonical history — persist it for the next turn
  }
}
```

## Multi-turn conversations

`ask()` and `stream()` both accept a `history` parameter — pass the previous turn's `result.messages` to continue:

```typescript
let history: Message[] = []

const r1 = await agent.ask('My name is Karan.', history)
history = r1.messages

const r2 = await agent.ask('What did I just tell you?', history)
console.log(r2.text) // → "You told me your name is Karan."
```

State lives with the caller, not the agent — so the same `MarcoAgent` instance is safe to share across concurrent web requests.

## Web app integration (Next.js)

A complete streaming chat panel example lives in [`examples/nextjs/`](examples/nextjs/) — server route handler + client React component, plus notes on adapting it for project-specific tools.

## Extending

Pass your own tools, hooks, system prompt, or model:

```typescript
import { MarcoAgent } from 'marco-agent'
import { z } from 'zod'
import type { Tool } from 'marco-harness'

const calculatorTool: Tool = {
  name: 'calculator',
  description: 'Evaluate a basic arithmetic expression.',
  inputJsonSchema: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
  },
  validate: (i) => z.object({ expression: z.string() }).parse(i),
  handler: async (input) => {
    const { expression } = input as { expression: string }
    return String(Function(`"use strict"; return (${expression})`)())
  },
}

const agent = new MarcoAgent({
  systemPrompt: 'You are a math tutor. Show your work.',
  tools: [calculatorTool],
})
```

## License

MIT
