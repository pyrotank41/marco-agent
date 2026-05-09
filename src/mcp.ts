// fromMcpServer — MCP-server-to-Tool bridge.
//
// Pure function. Takes resolved values (url, headers, contextArgs) and returns
// a Tool[] ready to plug into MarcoAgent. No env reads, no file reads, no
// secret resolution — those concerns live in marco-agent-cli's config layer
// or in the embedding app's own auth flow.
//
// Transport: HTTP + JSON-RPC 2.0. (stdio transport can come later.)
//
// Multi-tenant pattern: contextArgs are spread INTO every tool call's
// arguments AFTER the model's args, so the model cannot override them. This
// is the security boundary that lets a SaaS pass `target_user_id` per
// request without trusting the model.

import type { Tool } from 'marco-harness'

export type FromMcpServerOptions = {
  url: string
  headers?: Record<string, string>
  contextArgs?: Record<string, unknown>
  include?: string[]
  exclude?: string[]
  // Extra params passed on the tools/list discovery call. Some multi-tenant
  // servers require auth context (e.g. target_user_id) on discovery too,
  // not just on tools/call. JSON-RPC params is server-specific anything
  // beyond the optional `cursor`. Empty by default.
  listParams?: Record<string, unknown>
  // Override fetch for testing or custom transports.
  fetch?: typeof globalThis.fetch
}

type McpToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

type McpToolResult = {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: unknown
  isError?: boolean
}

type JsonRpcResponse<T> = {
  jsonrpc: '2.0'
  id: number | string
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

let nextId = 1

async function jsonRpc<T>(
  url: string,
  method: string,
  params: unknown,
  headers: Record<string, string> | undefined,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    signal,
  })
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as JsonRpcResponse<T>
  if (json.error) throw new Error(`MCP RPC error: ${json.error.message}`)
  if (json.result === undefined) throw new Error('MCP RPC: empty result')
  return json.result
}

function resultToText(r: McpToolResult): string {
  if (r.isError) {
    const msg = r.content?.find((c) => c.type === 'text')?.text ?? 'MCP tool returned error'
    throw new Error(msg)
  }
  if (r.structuredContent !== undefined) return JSON.stringify(r.structuredContent)
  if (r.content) return r.content.map((c) => c.text ?? '').join('\n').trim()
  return ''
}

export async function fromMcpServer(opts: FromMcpServerOptions): Promise<Tool[]> {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  if (!fetchImpl) throw new Error('fromMcpServer: no fetch implementation available')

  const list = await jsonRpc<{ tools: McpToolDescriptor[] }>(
    opts.url, 'tools/list', opts.listParams ?? {}, opts.headers, fetchImpl,
  )

  let tools = list.tools ?? []
  if (opts.include) tools = tools.filter((t) => opts.include!.includes(t.name))
  if (opts.exclude) tools = tools.filter((t) => !opts.exclude!.includes(t.name))

  return tools.map((t): Tool => ({
    name: t.name,
    description: t.description ?? '',
    inputJsonSchema: t.inputSchema ?? { type: 'object', properties: {} },
    // The MCP server is the source of truth for input validation. Pass through.
    validate: (input) => input,
    handler: async (input, ctx) => {
      const modelArgs = (typeof input === 'object' && input !== null) ? input as Record<string, unknown> : {}
      const args = { ...modelArgs, ...(opts.contextArgs ?? {}) }
      // Forward ctx.abortSignal so a stop click cancels the in-flight
      // MCP HTTP call mid-fetch — not just orphans it. Bills stop.
      const result = await jsonRpc<McpToolResult>(
        opts.url, 'tools/call', { name: t.name, arguments: args }, opts.headers, fetchImpl, ctx.abortSignal,
      )
      return resultToText(result)
    },
  }))
}
