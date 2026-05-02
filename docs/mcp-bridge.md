# MCP-to-Tool bridge

`fromMcpServer()` is a single async function that turns any HTTP-based MCP server's tool surface into a `Tool[]` ready to drop into a `MarcoAgent`. No per-endpoint wrapper code, no schema duplication, no auth re-implementation per project.

## Usage

```typescript
import { MarcoAgent, fromMcpServer } from 'marco-agent'

const tools = await fromMcpServer({
  url: 'https://crystallio.app/api/mcp',
  headers: { 'x-crystallio-service-secret': mySecret },
  contextArgs: { target_user_id: requestingUserId },
})

const agent = new MarcoAgent({ tools })
```

That's the whole API. Three pieces of behavior to know about:

### 1. Tool discovery

On call, `fromMcpServer` POSTs `tools/list` (JSON-RPC 2.0) to the URL, receives the server's full tool catalog, and constructs one `Tool` object per entry. Names, descriptions, and JSON Schema input shapes flow straight through from the MCP server.

### 2. `contextArgs` — multi-tenant scoping

Anything you put in `contextArgs` is spread into every tool call's `arguments` **after** the model's args, so the model cannot override them. This is the security boundary that lets a SaaS pass `target_user_id` per request without trusting the model:

```typescript
contextArgs: { target_user_id: 'safe-user-id' }
// model tries to spoof:
//   { query: 'cats', target_user_id: 'evil-user-id' }
// merged args sent to MCP server:
//   { query: 'cats', target_user_id: 'safe-user-id' }   // contextArgs wins
```

### 3. Filtering

`include` and `exclude` accept arrays of tool names. Use when an MCP server exposes more tools than you want the agent to have access to (Phase 1 read-only, etc.):

```typescript
await fromMcpServer({
  url, headers,
  include: ['search_thoughts', 'list_thoughts'],   // read-only Phase 1
})
```

## What it does NOT do

| Concern | Why not |
|---|---|
| Read env vars or `.env` files | Pure function. Pass resolved values. |
| Read config files (`mcp.json` etc.) | That's marco-agent-cli's job; library stays embed-friendly. |
| Resolve `${VAR}` interpolation | Same — config-layer concern. |
| Validate inputs against the JSON Schema client-side | The MCP server is the source of truth and validates server-side. Adding ajv would bloat the dep tree for marginal value. |
| Cache `tools/list` between calls | Caller's choice; some apps want hot reload during dev. |
| Speak the stdio MCP transport | HTTP only for v0.1.0. Stdio bridge can come if there's demand. |

## Errors

All failure modes throw with descriptive messages:

| Failure | Surfaces as |
|---|---|
| HTTP non-2xx response | `Error: MCP HTTP <status>: <body>` |
| JSON-RPC error envelope | `Error: MCP RPC error: <message>` |
| Tool returned `isError: true` | `Error: <text content of error>` (thrown from the tool's handler, not from `fromMcpServer` itself) |
| Empty `result` from server | `Error: MCP RPC: empty result` |
| No `fetch` available in runtime | `Error: fromMcpServer: no fetch implementation available` |

For runtimes without a global `fetch` (very old Node, exotic edge runtimes), pass your own:

```typescript
import { fetch } from 'undici'
await fromMcpServer({ url, fetch })
```

## Result content extraction

MCP tools return a `result` object that may carry `content`, `structuredContent`, or both. The bridge converts to the string that `marco-harness`'s tool handler expects, in this priority order:

1. If `isError: true` → throw with the text content
2. If `structuredContent` present → `JSON.stringify(structuredContent)`
3. If `content` present → join all `text` fields with newlines
4. Else → empty string
