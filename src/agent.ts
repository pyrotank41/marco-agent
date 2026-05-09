import { Harness, AnthropicProvider, type Tool, type Hooks, type ModelProvider, type ModelConfig, type Message, type ChunkEvent, type AssistantMessage } from 'marco-harness'
import { currentTimeTool } from './tools/current-time.js'
import { type Usage, type CostUsage, type PricingFunction, emptyUsage, addUsage, fromHarnessUsage, turnUsage, withCost } from './usage.js'
import { type CompactionConfig, shouldCompact, performCompaction } from './compaction.js'

export type BudgetConfig = {
  maxInputTokensPerTurn?: number
  maxOutputTokensPerTurn?: number
  maxModelCallsPerTurn?: number
  maxCostUsdPerTurn?: number
  pricing?: PricingFunction
  onExceeded?: 'abort' | 'warn'
}

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
  pricing?: PricingFunction
  budget?: BudgetConfig
  // Optional. Without it, no compaction happens. summaryModel and
  // summaryPrompt are required when compaction is configured.
  compaction?: CompactionConfig
  /**
   * External AbortSignal that cancels the run. When fired, the in-flight
   * model call is aborted (mid-stream), tool calls are short-circuited,
   * and ask()/stream() either throw AgentAbortedError (ask) or yield
   * an 'aborted' event (stream). For an ergonomic alternative, call
   * agent.abort(reason) — internally mirrors this signal.
   */
  signal?: AbortSignal
}

export type RunOptions = {
  /** Per-call abort signal. Overrides MarcoAgentOptions.signal if both set. */
  signal?: AbortSignal
}

export type AskResult = {
  text: string
  // Chain-of-thought, when the underlying model emitted reasoning tokens
  // (DeepSeek R1/V4-Pro, OpenAI o-series, etc.). Concatenation of all
  // assistant turns' reasoning content for this ask.
  reasoning?: string
  messages: Message[]
  usage: CostUsage
  // True when history was compacted before this turn. Absent otherwise.
  compacted?: boolean
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; usage: CostUsage }
  | { type: 'budget_exceeded'; reason: string; usage: CostUsage }
  | { type: 'compaction_start' }
  | { type: 'compaction_end'; messagesRemoved: number; summaryTokens: number; summaryText: string }
  | { type: 'done'; result: AskResult }
  | { type: 'aborted'; result: AskResult; reason?: string }

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant built on the marco-harness framework.
Be concise, accurate, and use your tools when they would give a more reliable answer than guessing.`

const DEFAULT_MODEL = 'claude-sonnet-4-6'

export class BudgetExceededError extends Error {
  constructor(public readonly reason: string, public readonly usage: CostUsage) {
    super(`Budget exceeded: ${reason}`)
    this.name = 'BudgetExceededError'
  }
}

/**
 * Thrown by ask() when the run is cancelled (via agent.abort() or an
 * AbortSignal). Carries the partial result so callers can persist what
 * was completed before the cancellation.
 */
export class AgentAbortedError extends Error {
  constructor(public readonly reason: string, public readonly partial: AskResult) {
    super(`Agent run aborted: ${reason}`)
    this.name = 'AgentAbortedError'
  }
}

export class MarcoAgent {
  private readonly options: MarcoAgentOptions
  private readonly provider: ModelProvider
  private currentRun: AbortController | null = null

  constructor(options: MarcoAgentOptions = {}) {
    this.provider = options.provider ?? new AnthropicProvider({ apiKey: options.apiKey })
    this.options = options
  }

  /**
   * Abort the in-flight ask()/stream() call, if any. No-op when nothing
   * is running. The run unwinds at the next cancellation point: the
   * model fetch is cancelled mid-stream (tokens stop being billed), any
   * in-flight tool calls are short-circuited, and the run resolves with
   * partial state. ask() then throws AgentAbortedError; stream() yields
   * a final 'aborted' event.
   */
  abort(reason?: string): void {
    this.currentRun?.abort(reason ?? 'manually aborted')
  }

  async ask(prompt: string, history: Message[] = [], options: RunOptions = {}): Promise<AskResult> {
    const ctrl = this.makeRunController(options.signal)
    this.currentRun = ctrl

    let workingHistory = history
    let compacted = false
    let compactionUsage = emptyUsage()

    try {
      if (shouldCompact(history, prompt, this.options.compaction)) {
        const c = await performCompaction(this.provider, history, this.options.compaction!, { signal: ctrl.signal })
        workingHistory = c.history
        compacted = c.compacted
        compactionUsage = { ...emptyUsage(), inputTokens: c.usage.inputTokens, outputTokens: c.usage.outputTokens, modelCalls: 1 }
      }

      const harness = this.buildHarness(workingHistory, this.provider, () => undefined)
      const result = await harness.run({ kind: 'user_message', text: prompt }, { signal: ctrl.signal })
      const turnTokens = turnUsage(result.messages, workingHistory.length)
      const totalTokens = addUsage(compactionUsage, turnTokens)
      const usage = withCost(totalTokens, this.model(), this.options.pricing)

      const out = buildAskResult(result.messages, workingHistory.length, usage)
      const finalResult: AskResult = compacted ? { ...out, compacted: true } : out

      if (result.status === 'aborted') {
        throw new AgentAbortedError(result.abortReason ?? 'aborted', finalResult)
      }

      this.assertWithinBudget(usage)
      return finalResult
    } finally {
      this.currentRun = null
    }
  }

  async *stream(prompt: string, history: Message[] = [], options: RunOptions = {}): AsyncGenerator<StreamEvent, void, unknown> {
    const ctrl = this.makeRunController(options.signal)
    this.currentRun = ctrl

    try {
      yield* this.streamInternal(prompt, history, ctrl.signal)
    } finally {
      this.currentRun = null
    }
  }

  private async *streamInternal(prompt: string, history: Message[], signal: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    let workingHistory = history
    let compacted = false
    let compactionUsage = emptyUsage()

    if (shouldCompact(history, prompt, this.options.compaction)) {
      yield { type: 'compaction_start' }
      const c = await performCompaction(this.provider, history, this.options.compaction!, { signal })
      workingHistory = c.history
      compacted = c.compacted
      compactionUsage = { ...emptyUsage(), inputTokens: c.usage.inputTokens, outputTokens: c.usage.outputTokens, modelCalls: 1 }
      yield { type: 'compaction_end', messagesRemoved: c.messagesRemoved, summaryTokens: c.usage.outputTokens, summaryText: c.summaryText }
    }

    const queue: ChunkEvent[] = []
    let resolveWait: (() => void) | null = null
    let done = false
    let runningUsage = compactionUsage
    let budgetTrip: { reason: string; usage: CostUsage } | null = null

    const wake = (): void => {
      const r = resolveWait
      resolveWait = null
      r?.()
    }

    const innerProvider = this.provider
    const tee: ModelProvider = {
      async *stream(messages, tools, config, opts) {
        for await (const event of innerProvider.stream(messages, tools, config, opts)) {
          queue.push(event)
          wake()
          yield event
        }
      },
    }

    const harness = this.buildHarness(workingHistory, tee, () => budgetTrip?.reason)
    const runPromise = harness
      .run({ kind: 'user_message', text: prompt }, { signal })
      .finally(() => { done = true; wake() })

    while (!done || queue.length > 0) {
      while (queue.length > 0) {
        const ev = queue.shift()!
        if (ev.type === 'text_delta') yield { type: 'text', text: ev.text }
        else if (ev.type === 'reasoning_delta') yield { type: 'reasoning', text: ev.text }
        else if (ev.type === 'tool_call_start') yield { type: 'tool_call_start', id: ev.id, name: ev.name }
        else if (ev.type === 'tool_call_end') yield { type: 'tool_call_end', id: ev.id }
        else if (ev.type === 'message_end') {
          const callUsage = fromHarnessUsage((ev.message as AssistantMessage).usage)
          runningUsage = addUsage(runningUsage, callUsage)
          const costUsage = withCost(runningUsage, this.model(), this.options.pricing)
          yield { type: 'usage', usage: costUsage }
          const trip = this.checkBudget(costUsage)
          if (trip) {
            budgetTrip = { reason: trip, usage: costUsage }
            yield { type: 'budget_exceeded', reason: trip, usage: costUsage }
          }
        }
      }
      if (!done) await new Promise<void>((resolve) => { resolveWait = resolve })
    }

    const result = await runPromise
    const turnTokens = turnUsage(result.messages, workingHistory.length)
    const totalTokens = addUsage(compactionUsage, turnTokens)
    const finalUsage = withCost(totalTokens, this.model(), this.options.pricing)
    const out = buildAskResult(result.messages, workingHistory.length, finalUsage)
    const finalResult: AskResult = compacted ? { ...out, compacted: true } : out
    if (result.status === 'aborted') {
      yield { type: 'aborted', result: finalResult, reason: result.abortReason }
    } else {
      yield { type: 'done', result: finalResult }
    }
  }

  /**
   * Build the per-run AbortController. Mirrors any external signal
   * (per-call options.signal or constructor-time options.signal) into
   * an internal controller, so agent.abort() can fire alongside the
   * external signal.
   */
  private makeRunController(perCallSignal?: AbortSignal): AbortController {
    const ctrl = new AbortController()
    const external = perCallSignal ?? this.options.signal
    if (external) {
      if (external.aborted) {
        ctrl.abort(external.reason)
      } else {
        external.addEventListener('abort', () => ctrl.abort(external.reason), { once: true })
      }
    }
    return ctrl
  }

  private model(): string {
    return this.options.model ?? DEFAULT_MODEL
  }

  private checkBudget(usage: CostUsage): string | null {
    const b = this.options.budget
    if (!b) return null
    if (b.maxInputTokensPerTurn !== undefined && usage.inputTokens > b.maxInputTokensPerTurn) return `inputTokens ${usage.inputTokens} > ${b.maxInputTokensPerTurn}`
    if (b.maxOutputTokensPerTurn !== undefined && usage.outputTokens > b.maxOutputTokensPerTurn) return `outputTokens ${usage.outputTokens} > ${b.maxOutputTokensPerTurn}`
    if (b.maxModelCallsPerTurn !== undefined && usage.modelCalls > b.maxModelCallsPerTurn) return `modelCalls ${usage.modelCalls} > ${b.maxModelCallsPerTurn}`
    if (b.maxCostUsdPerTurn !== undefined && usage.costUsd > b.maxCostUsdPerTurn) return `costUsd ${usage.costUsd.toFixed(4)} > ${b.maxCostUsdPerTurn}`
    return null
  }

  private assertWithinBudget(usage: CostUsage): void {
    const trip = this.checkBudget(usage)
    if (trip && this.options.budget?.onExceeded !== 'warn') throw new BudgetExceededError(trip, usage)
  }

  private buildHarness(initialMessages: Message[], provider: ModelProvider, getBudgetTrip: () => string | undefined): Harness {
    const modelConfig: ModelConfig = {
      model: this.model(),
      maxTokens: this.options.maxTokens ?? 4096,
      systemPrompt: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      ...(this.options.temperature !== undefined && { temperature: this.options.temperature }),
    }

    // Budget guard: runs before each model call. If the previous calls in this
    // turn pushed us past the budget, reject the next call so the harness stops.
    const userHooks = this.options.hooks ?? {}
    const hooks: Hooks = {
      ...userHooks,
      beforeModelCall: async (input) => {
        const trip = getBudgetTrip()
        if (trip && this.options.budget?.onExceeded !== 'warn') {
          return { messages: input.messages, abort: true }
        }
        if (userHooks.beforeModelCall) return await userHooks.beforeModelCall(input)
        return { messages: input.messages }
      },
    }

    return new Harness({
      provider,
      modelConfig,
      tools: this.options.tools ?? [currentTimeTool],
      hooks,
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

// Concatenates reasoning across all assistant messages in the current turn
// (i.e. those after `historyLength`). Returns undefined if no reasoning was
// emitted, so the AskResult.reasoning field is absent rather than empty.
function extractTurnReasoning(messages: Message[], historyLength: number): string | undefined {
  const parts: string[] = []
  for (let i = historyLength; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.reasoning) parts.push(msg.reasoning)
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function buildAskResult(messages: Message[], historyLength: number, usage: CostUsage): AskResult {
  const reasoning = extractTurnReasoning(messages, historyLength)
  return {
    text: extractFinalText(messages),
    ...(reasoning !== undefined && { reasoning }),
    messages,
    usage,
  }
}
