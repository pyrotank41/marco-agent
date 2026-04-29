# Next.js example: streaming chat panel

Two files showing how to drop `marco-agent` into a Next.js App Router app as a server-streamed chat:

- `route.ts` — server route handler. Goes at `app/api/chat/route.ts`. Accepts `{ prompt, history }`, streams `MarcoAgent.stream()` events as SSE.
- `client.tsx` — minimal React panel. Maintains the conversation history in component state and sends it with each request, so the server stays stateless.

## How it works

1. Client POSTs `{ prompt, history }` to `/api/chat`.
2. Route creates a `MarcoAgent`, calls `agent.stream(prompt, history)`, forwards each event as an SSE `data:` frame.
3. Client reads the stream, appends `text` events to a live "streaming" string, and on the `done` event replaces its `history` with the canonical message trail returned by the agent.

## Wiring it into Crystallio

For the planned `/thoughts` chat agent in Crystallio, the only changes are:

1. **Per-request tools.** Build the `MarcoAgent` with tools that proxy to the crystallio MCP server (`search_thoughts`, `list_thoughts`, `suggest_topics`, etc.), each tool's handler scoped to the requesting `user_id` from the session.
2. **System prompt.** Inject Crystallio-specific context (the user's name, how their thoughts are organized, how to cite a thought ID in responses).
3. **Persistence.** Replace the client-side `history` round-trip with a per-user conversation table; load it server-side from the `user_id` and persist new messages on the `done` event.
4. **Auth.** Drop the route behind your existing Crystallio auth. Reject if no `user_id`.

The agent itself doesn't change — only the tools, prompt, and where history lives.
