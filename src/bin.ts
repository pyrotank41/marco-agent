#!/usr/bin/env node
import { argv, env, exit, stdout, stderr } from 'node:process'
import { MarcoAgent } from './agent.js'

async function main(): Promise<void> {
  const prompt = argv.slice(2).join(' ').trim()
  if (!prompt) {
    stderr.write('Usage: marco-agent "<your prompt>"\n')
    exit(1)
  }

  if (!env.ANTHROPIC_API_KEY) {
    stderr.write('Missing ANTHROPIC_API_KEY environment variable.\n')
    exit(1)
  }

  const agent = new MarcoAgent()
  const reply = await agent.ask(prompt)
  stdout.write(reply + '\n')
}

main().catch((err) => {
  stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
  exit(1)
})
