# Compaction

When a conversation gets long enough that the next model call would exceed your token budget, marco-agent can summarize the older portion of history into a single synthetic system message and continue with that summary plus the most recent N turns kept verbatim. The model still has the gist of what came before, but you stop paying for thousands of tokens of stale context every turn.

## Default behavior: off

Compaction is **opt-in**. If you don't pass a `compaction` config, no compaction happens — your full history rides through to every turn. This is intentional. The library can't know whether your model can handle 1M tokens, what models your API key supports for the summary call, or what shape of summary your domain needs.

## Enabling it

```typescript
import { MarcoAgent } from 'marco-agent'

const agent = new MarcoAgent({
  compaction: {
    summaryModel: 'claude-haiku-4-5',
    summaryPrompt: 'Summarize the conversation above into a brief paragraph capturing key decisions, facts learned, and unresolved threads. Cite tool results that would matter for continuing the conversation.',
    triggerAtInputTokens: 150_000,  // optional, default 150_000
    keepLastTurns: 4,                // optional, default 4
  },
})
```

`summaryModel` and `summaryPrompt` are **required**. There are no defaults for them — see the design rationale at the bottom.

## How it works

Before each `ask()` / `stream()` call:

1. Look at the **last assistant message** in the incoming history. Read its `usage.inputTokens` — that's the real token count from the previous turn.
2. Add a rough estimate of the new prompt's tokens (`prompt.length / 4`).
3. If that sum exceeds `triggerAtInputTokens` AND there are more than `keepLastTurns` user messages in history → compact.
4. Walk back through history to find the boundary: keep the last `keepLastTurns` turns verbatim, send everything before to the summary model.
5. Build new history: `[summary as system message, ...recent turns]`.
6. Run the agent loop on the compacted history.

The compaction call uses your agent's existing `provider`, just with a different `model` name. It counts toward `result.usage` (so budget guards apply to it too).

## Stream events

```typescript
for await (const ev of agent.stream(prompt, history)) {
  if (ev.type === 'compaction_start') {
    setStatus('Compacting conversation…')
  } else if (ev.type === 'compaction_end') {
    console.log(`Collapsed ${ev.messagesRemoved} messages into a ${ev.summaryTokens}-token summary`)
    showExpandableNote(ev.summaryText)  // optional: show users what was summarized
    setStatus(null)
  }
}
```

`compaction_start` fires before the summary model call begins. `compaction_end` fires after, with `{ messagesRemoved, summaryTokens, summaryText }`. Both events are absent when no compaction was triggered. `summaryText` is the actual model-generated summary so apps can render a "what was summarized?" expandable section without parsing the rewritten history.

## Result shape

```typescript
const result = await agent.ask(prompt, history)
result.compacted   // true if compaction ran this turn; absent otherwise
result.messages    // the conversation state to resume from (compacted form when compaction ran)
result.usage       // includes tokens spent by the summary call
```

After compaction, `result.messages` is the **compacted** form — `[summarySystemMessage, ...recent_kept_turns, ...new_turn_messages]`. The pre-compaction prefix is replaced. If you want to keep the original messages, save them yourself before calling `ask()` (see "Persistence patterns" below).

When compaction did NOT run, `result.messages` is `[...original_history, ...new_turn_messages]` as expected.

## Persistence patterns

Compaction changes what `result.messages` represents, which means your storage strategy matters. Three patterns, pick one based on whether you need an audit log.

### Paradigm A — Compacted-only (the default for CLIs)

Save only `result.messages` after each turn. After compaction, the saved state IS the compacted form. The pre-compaction prefix is gone forever once summarized.

```typescript
const result = await agent.ask(prompt, history)
db.save(conversationId, result.messages)

// next turn
const history = db.load(conversationId)
const result = await agent.ask(newPrompt, history)
```

Simple, efficient, no audit log. Right for CLI tools where users don't expect to scroll through past compactions.

### Paradigm B — Full archive + compacted live (for products with chat history UI)

Save two things: an append-only `archive` of every user/assistant message ever, AND the compacted `live_state` for the next turn.

```typescript
// after every turn
const result = await agent.ask(prompt, history)
const newMessages = result.messages.slice(history.length)  // just this turn's additions
db.appendToArchive(conversationId, [
  { role: 'user', text: prompt },
  ...newMessages,
])
db.replaceLiveState(conversationId, result.messages)

// next turn — load LIVE state, not archive
const history = db.loadLiveState(conversationId)
const result = await agent.ask(newPrompt, history)
```

Storage doubles, but you get a complete audit trail AND fast resume (no re-summarizing the same prefix). Right for multi-user dashboards where users expect to see their full conversation history (Crystallio's chat panel pattern).

### Paradigm C — Full archive only, recompact every turn

Save only the original full history; send it back every turn; let compaction re-run and re-pay the summary call each time. Almost never the right call — the recurring summary cost is wasteful. Listed for completeness.

### Recommendation

- **CLI / marco-agent-cli** → Paradigm A
- **Crystallio (and similar products with chat-history features)** → Paradigm B
- **Don't use C**

The library doesn't enforce either — both A and B are supported by what `result.messages` already returns. The difference is purely how your app's persistence layer behaves.

## When not to use it

- Short conversations that never approach your token budget — compaction adds latency and a model call you don't need.
- Conversations where every word matters (legal, medical reasoning) — summaries lose nuance. Consider chunked retrieval instead.
- Cost-critical paths where any extra LLM call is unacceptable — compaction *prevents* runaway costs in long conversations, but the summary call itself isn't free.

## Tuning notes

- **Pick a cheap `summaryModel`.** Compaction summaries don't need your best model. A small instruction-tuned model (Haiku, GPT-4.1-nano, Llama 3.1 8B via OpenRouter) is usually fine and dramatically cheaper than running compaction with the same model the agent uses.
- **Tune `keepLastTurns` to your task.** Coding agents that reference the last few file paths benefit from `keepLastTurns: 6+`. Pure Q&A agents do fine with 2-3.
- **Make `summaryPrompt` domain-specific.** A coding agent wants "preserve file paths, function names, and TODO threads." A research agent wants "preserve sources cited, hypotheses considered, decisions made." A generic prompt produces a generic-feeling continuation.

## Why no defaults for `summaryModel` and `summaryPrompt`?

Defaulting `summaryModel` would silently break apps using OpenRouter / DeepSeek / any non-Anthropic provider — the default model name wouldn't resolve against their API key. Better to fail fast at construction with a clear missing-required-field error than silently fail at runtime mid-conversation.

Defaulting `summaryPrompt` would produce useless summaries for most domains. The shape of "what to preserve" is the most important design decision in compaction; pushing that onto the user is correct.

`triggerAtInputTokens` defaults to 150_000 because there's a reasonable industry default — most modern context windows are large but cost / latency / attention-degradation start kicking in well before the hard limit. Override per-model or per-tier as needed.
