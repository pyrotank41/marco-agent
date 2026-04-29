import { Harness, AnthropicProvider, type Tool, type Hooks, type ModelProvider, type ModelConfig, type Message, type ChunkEvent } from 'marco-harness'
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

export type AskResult = {
  text: string
  messages: Message[]
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'done'; result: AskResult }

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant built on the marco-harness framework.
Be concise, accurate, and use your tools when they would give a more reliable answer than guessing.`

const DEFAULT_MODEL = 'claude-sonnet-4-6'

export class MarcoAgent {
  private readonly options: MarcoAgentOptions
  private readonly provider: ModelProvider

  constructor(options: MarcoAgentOptions = {}) {
    this.provider = options.provider ?? new AnthropicProvider({ apiKey: options.apiKey })
    this.options = options
  }

  async ask(prompt: string, history: Message[] = []): Promise<AskResult> {
    const harness = this.buildHarness(history, this.provider)
    const result = await harness.run({ kind: 'user_message', text: prompt })
    return { text: extractFinalText(result.messages), messages: result.messages }
  }

  async *stream(prompt: string, history: Message[] = []): AsyncGenerator<StreamEvent, void, unknown> {
    const queue: ChunkEvent[] = []
    let resolveWait: (() => void) | null = null
    let done = false

    const wake = (): void => {
      const r = resolveWait
      resolveWait = null
      r?.()
    }

    const innerProvider = this.provider
    const tee: ModelProvider = {
      async *stream(messages, tools, config) {
        for await (const event of innerProvider.stream(messages, tools, config)) {
          queue.push(event)
          wake()
          yield event
        }
      },
    }

    const harness = this.buildHarness(history, tee)
    const runPromise = harness
      .run({ kind: 'user_message', text: prompt })
      .finally(() => { done = true; wake() })

    while (!done || queue.length > 0) {
      while (queue.length > 0) {
        const ev = queue.shift()!
        if (ev.type === 'text_delta') yield { type: 'text', text: ev.text }
        else if (ev.type === 'tool_call_start') yield { type: 'tool_call_start', id: ev.id, name: ev.name }
        else if (ev.type === 'tool_call_end') yield { type: 'tool_call_end', id: ev.id }
      }
      if (!done) await new Promise<void>((resolve) => { resolveWait = resolve })
    }

    const result = await runPromise
    yield { type: 'done', result: { text: extractFinalText(result.messages), messages: result.messages } }
  }

  private buildHarness(initialMessages: Message[], provider: ModelProvider): Harness {
    const modelConfig: ModelConfig = {
      model: this.options.model ?? DEFAULT_MODEL,
      maxTokens: this.options.maxTokens ?? 4096,
      systemPrompt: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      ...(this.options.temperature !== undefined && { temperature: this.options.temperature }),
    }
    return new Harness({
      provider,
      modelConfig,
      tools: this.options.tools ?? [currentTimeTool],
      hooks: this.options.hooks,
      maxIterations: this.options.maxIterations,
      initialMessages,
    })
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
