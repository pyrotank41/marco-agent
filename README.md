# marco-agent

A simple, extensible AI agent built on [marco-harness](https://github.com/pyrotank41/MARCO).

`MarcoAgent` is a thin wrapper around the harness with sensible defaults — a system prompt, the Claude Sonnet 4.6 model, and one bundled tool (`current_time`). Use it as-is for quick scripts, or extend it with your own tools and hooks for project-specific agents.

## Install

```bash
npm install marco-agent
```

## Quick start

```typescript
import { MarcoAgent } from 'marco-agent'

const agent = new MarcoAgent()
const reply = await agent.ask('What time is it in Tokyo?')
console.log(reply)
```

Set `ANTHROPIC_API_KEY` in your environment before running.

## CLI

```bash
npx marco-agent "summarize the latest TC39 stage-4 proposals"
```

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

For full control over the underlying harness (registering tools dynamically, running with custom triggers), reach into `agent.raw`.

## License

MIT
