// Compaction — summarize older conversation history when token use grows
// past a threshold, keeping the most recent N turns verbatim.
//
// Layer placement: this is an opinion (when to compact, what to keep, how to
// summarize) and lives in marco-agent, not marco-harness. The harness stays
// agnostic about conversation hygiene.
//
// Trigger: uses the LAST assistant message's actual usage.inputTokens
// (real measurement) plus a rough estimate of the new prompt's tokens.
// More honest than a tokenizer-based pre-count and dependency-free.
//
// Defaults policy: triggerAtInputTokens defaults to 150_000 because even with
// massive context windows, cost / latency / attention-degradation kick in
// well before the model's hard limit. summaryModel and summaryPrompt have NO
// default — the library can't know what model your API key supports, and a
// generic prompt would mismatch most agent domains.

import type { Message, ModelProvider, SystemMessage, Usage } from 'marco-harness'

// Convention shape that marco-agent stamps onto the synthesized summary's
// `meta` field. Harness has no idea about this — it just allows arbitrary
// MessageMeta. Consumers who care about compaction can import this type plus
// the isCompactionSummary type guard below to narrow safely.
export type CompactionSummaryMeta = {
  kind: 'compaction'
  // Number of original messages collapsed into this summary.
  messagesRemoved: number
  // Tokens spent on the summary LLM call. inputTokens covers the prefix
  // that was summarized; outputTokens covers the summary text itself. Both
  // matter for cost attribution — neither is derivable from the other.
  summaryUsage: Usage
}

// Type guard for consumers walking result.messages. Use this to find the
// synthesized summary message and narrow its `meta` to CompactionSummaryMeta:
//
//   const summary = result.messages.find(isCompactionSummary)
//   if (summary) console.log(summary.meta.messagesRemoved)
//
// More robust than `m.role === 'system' && m.meta?.kind === 'compaction'`
// at the call site because it returns a properly narrowed type.
export function isCompactionSummary(
  m: Message,
): m is SystemMessage & { meta: CompactionSummaryMeta } {
  if (m.role !== 'system') return false
  const meta = m.meta as { kind?: unknown } | undefined
  return meta?.kind === 'compaction'
}

export type CompactionConfig = {
  // REQUIRED — model id to use for the summary call. No default.
  summaryModel: string
  // REQUIRED — instructions for the summary model. No default.
  summaryPrompt: string
  // Optional — token threshold to trigger compaction. Default 150_000.
  triggerAtInputTokens?: number
  // Optional — number of recent turns (user messages + everything after) to
  // keep verbatim. Default 4.
  keepLastTurns?: number
}

export type CompactionResult = {
  history: Message[]
  compacted: boolean
  // Tokens spent on the summary call (zero if no compaction happened).
  usage: { inputTokens: number; outputTokens: number }
  // Number of messages collapsed into the summary (zero if no compaction).
  messagesRemoved: number
  // The summary text the model produced (empty if no compaction). Surfaced
  // so apps can render an expandable "what was summarized?" UI hint
  // without fishing through the rewritten history.
  summaryText: string
}

const DEFAULT_TRIGGER = 150_000
const DEFAULT_KEEP_LAST_TURNS = 4

export function shouldCompact(
  history: Message[],
  prompt: string,
  config: CompactionConfig | undefined,
): boolean {
  if (!config) return false
  const trigger = config.triggerAtInputTokens ?? DEFAULT_TRIGGER

  // Use the last assistant turn's actual input tokens as the truth signal.
  // If we never made a model call yet, there's nothing to compact against.
  let lastInputTokens = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === 'assistant') {
      lastInputTokens = m.usage?.inputTokens ?? 0
      break
    }
  }
  if (lastInputTokens === 0) return false

  // Rough char-to-token approximation; deliberately conservative-leaning.
  const estimatedNewPromptTokens = Math.ceil(prompt.length / 4)

  if (lastInputTokens + estimatedNewPromptTokens <= trigger) return false

  // Don't compact if we don't have more turns than we'd keep.
  const keep = config.keepLastTurns ?? DEFAULT_KEEP_LAST_TURNS
  const userCount = history.filter((m) => m.role === 'user').length
  return userCount > keep
}

export async function performCompaction(
  provider: ModelProvider,
  history: Message[],
  config: CompactionConfig,
  options: { signal?: AbortSignal } = {},
): Promise<CompactionResult> {
  const keep = config.keepLastTurns ?? DEFAULT_KEEP_LAST_TURNS

  // Boundary = index of the (keep-th from end) user message. Everything
  // STRICTLY before that index becomes the prefix to summarize; the boundary
  // index and everything after is kept verbatim.
  let userSeen = 0
  let boundary = -1
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      userSeen++
      if (userSeen === keep) {
        boundary = i
        break
      }
    }
  }
  if (boundary <= 0) {
    // Not enough user messages to compact (already validated by shouldCompact,
    // but be defensive).
    return { history, compacted: false, usage: { inputTokens: 0, outputTokens: 0 }, messagesRemoved: 0, summaryText: '' }
  }

  const prefix = history.slice(0, boundary)
  const recent = history.slice(boundary)

  const stringified = messagesToText(prefix)
  const summaryUserMessage: Message = {
    role: 'user',
    text: `${config.summaryPrompt}\n\n--- conversation to summarize ---\n${stringified}`,
  }

  let summaryText = ''
  let inputTokens = 0
  let outputTokens = 0

  for await (const ev of provider.stream(
    [summaryUserMessage],
    [],
    { model: config.summaryModel, maxTokens: 4000 },
    options.signal ? { signal: options.signal } : undefined,
  )) {
    if (ev.type === 'text_delta') summaryText += ev.text
    else if (ev.type === 'message_end') {
      summaryText = ev.message.text ?? summaryText
      inputTokens = ev.message.usage.inputTokens
      outputTokens = ev.message.usage.outputTokens
    }
  }

  const trimmedSummary = summaryText.trim()
  // Mark the synthesized system message with meta so consumers can detect it
  // in result.messages without threading separate stream-event tracking
  // through their persistence layer. Available since marco-harness 0.2.2.
  const summaryMessage: Message = {
    role: 'system',
    text: `Summary of earlier conversation:\n${trimmedSummary}`,
    meta: {
      kind: 'compaction',
      messagesRemoved: prefix.length,
      summaryUsage: { inputTokens, outputTokens },
    },
  }

  return {
    history: [summaryMessage, ...recent],
    compacted: true,
    usage: { inputTokens, outputTokens },
    messagesRemoved: prefix.length,
    summaryText: trimmedSummary,
  }
}

function messagesToText(messages: Message[]): string {
  return messages
    .map((m) => {
      if (m.role === 'system') return `[system] ${m.text}`
      if (m.role === 'user') return `[user] ${m.text}`
      if (m.role === 'assistant') {
        const parts: string[] = []
        if (m.text) parts.push(`[assistant] ${m.text}`)
        for (const tc of m.toolCalls) {
          parts.push(`[assistant tool_call ${tc.name}] ${JSON.stringify(tc.input)}`)
        }
        return parts.join('\n')
      }
      if (m.role === 'tool') return `[tool result${m.isError ? ' ERROR' : ''}] ${m.content}`
      return ''
    })
    .join('\n\n')
}
