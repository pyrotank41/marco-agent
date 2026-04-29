#!/usr/bin/env node
import { argv, env, exit, stdout, stderr } from 'node:process'
import { MarcoAgent } from './agent.js'

async function main(): Promise<void> {
  const args = argv.slice(2)
  const streamMode = args[0] === '--stream' || args[0] === '-s'
  const prompt = (streamMode ? args.slice(1) : args).join(' ').trim()

  if (!prompt) {
    stderr.write('Usage: marco-agent [--stream] "<your prompt>"\n')
    exit(1)
  }
  if (!env.ANTHROPIC_API_KEY) {
    stderr.write('Missing ANTHROPIC_API_KEY environment variable.\n')
    exit(1)
  }

  const agent = new MarcoAgent()

  if (streamMode) {
    for await (const event of agent.stream(prompt)) {
      if (event.type === 'text') stdout.write(event.text)
      else if (event.type === 'done') stdout.write('\n')
    }
  } else {
    const result = await agent.ask(prompt)
    stdout.write(result.text + '\n')
  }
}

main().catch((err) => {
  stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
  exit(1)
})
