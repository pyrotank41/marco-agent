import { Harness, AnthropicProvider, type Tool, type Hooks, type ModelProvider, type ModelConfig, type Message } from 'marco-harness'
import { currentTimeTool } from './tools/current-time.js'

export type MarcoAgentOptions = {
  systemPrompt?: string
  model?: string
  maxTokens?: number
  temperature?: number
  tools?: Tool[]
  hooks?: Hooks
  provider?: ModelProvider
  apiKey?: string
  maxIterations?: number
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant built on the marco-harness framework.
Be concise, accurate, and use your tools when they would give a more reliable answer than guessing.`

const DEFAULT_MODEL = 'claude-sonnet-4-6'

export class MarcoAgent {
  private readonly harness: Harness

  constructor(options: MarcoAgentOptions = {}) {
    const provider = options.provider ?? new AnthropicProvider({ apiKey: options.apiKey })
    const modelConfig: ModelConfig = {
      model: options.model ?? DEFAULT_MODEL,
      maxTokens: options.maxTokens ?? 4096,
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
    }

    this.harness = new Harness({
      provider,
      modelConfig,
      tools: options.tools ?? [currentTimeTool],
      hooks: options.hooks,
      maxIterations: options.maxIterations,
    })
  }

  async ask(prompt: string): Promise<string> {
    const result = await this.harness.run({ kind: 'user_message', text: prompt })
    return extractFinalText(result.messages)
  }

  get raw(): Harness {
    return this.harness
  }
}

function extractFinalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.text) {
      return msg.text
    }
  }
  return ''
}
