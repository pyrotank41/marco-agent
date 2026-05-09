import { describe, it, expect, beforeEach } from 'vitest'
import { fromMcpServer } from '../src/mcp.js'

type RpcRequest = { jsonrpc: string; id: number; method: string; params: { name?: string; arguments?: Record<string, unknown> } }

function makeFakeFetch(handler: (req: RpcRequest, init: RequestInit) => unknown): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as RpcRequest
    const result = handler(body, init ?? {})
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

const TOOLS_LIST = {
  tools: [
    { name: 'search_thoughts', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'list_thoughts',   description: 'List',   inputSchema: { type: 'object' } },
    { name: 'capture_thought', description: 'Write',  inputSchema: { type: 'object', properties: { content: { type: 'string' } } } },
  ],
}

describe('fromMcpServer', () => {
  let calls: RpcRequest[] = []
  beforeEach(() => { calls = [] })

  function route(req: RpcRequest): unknown {
    calls.push(req)
    if (req.method === 'tools/list') return TOOLS_LIST
    if (req.method === 'tools/call') {
      return { content: [{ type: 'text', text: `called ${req.params.name} with ${JSON.stringify(req.params.arguments)}` }] }
    }
    throw new Error(`unknown method: ${req.method}`)
  }

  it('fetches tools/list and returns one Tool per MCP tool', async () => {
    const tools = await fromMcpServer({ url: 'http://mcp', fetch: makeFakeFetch(route) })
    expect(tools).toHaveLength(3)
    expect(tools.map((t) => t.name)).toEqual(['search_thoughts', 'list_thoughts', 'capture_thought'])
    expect(tools[0].description).toBe('Search')
    expect(calls[0].method).toBe('tools/list')
  })

  it('include filter restricts which tools are returned', async () => {
    const tools = await fromMcpServer({
      url: 'http://mcp',
      fetch: makeFakeFetch(route),
      include: ['search_thoughts', 'list_thoughts'],
    })
    expect(tools.map((t) => t.name)).toEqual(['search_thoughts', 'list_thoughts'])
  })

  it('exclude filter removes named tools', async () => {
    const tools = await fromMcpServer({
      url: 'http://mcp',
      fetch: makeFakeFetch(route),
      exclude: ['capture_thought'],
    })
    expect(tools.map((t) => t.name)).toEqual(['search_thoughts', 'list_thoughts'])
  })

  it('handler invokes tools/call and surfaces the text content', async () => {
    const tools = await fromMcpServer({ url: 'http://mcp', fetch: makeFakeFetch(route) })
    const result = await tools[0].handler({ query: 'test' }, { runId: 'r1' })
    expect(result).toContain('called search_thoughts')
    expect(result).toContain('"query":"test"')
  })

  it('contextArgs are injected and override model-supplied args', async () => {
    const tools = await fromMcpServer({
      url: 'http://mcp',
      fetch: makeFakeFetch(route),
      contextArgs: { target_user_id: 'safe-user-id' },
    })
    // Model tries to spoof target_user_id — contextArgs must win
    await tools[0].handler({ query: 'test', target_user_id: 'evil-user-id' }, { runId: 'r1' })
    const callArgs = calls.find((c) => c.method === 'tools/call')?.params.arguments
    expect(callArgs).toMatchObject({ query: 'test', target_user_id: 'safe-user-id' })
  })

  it('headers from opts are passed on every request', async () => {
    let seen: Headers | null = null
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), { status: 200 })
    }) as typeof globalThis.fetch
    await fromMcpServer({ url: 'http://mcp', fetch, headers: { 'x-secret': 'shh' } })
    expect(seen!.get('x-secret')).toBe('shh')
    expect(seen!.get('content-type')).toBe('application/json')
  })

  it('JSON-RPC error surfaces as Error', async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }), { status: 200 })) as typeof globalThis.fetch
    await expect(fromMcpServer({ url: 'http://mcp', fetch })).rejects.toThrow(/method not found/)
  })

  it('isError result throws from handler', async () => {
    const fetch = makeFakeFetch((req) => {
      if (req.method === 'tools/list') return TOOLS_LIST
      return { content: [{ type: 'text', text: 'permission denied' }], isError: true }
    })
    const tools = await fromMcpServer({ url: 'http://mcp', fetch })
    await expect(tools[0].handler({}, { runId: 'r1' })).rejects.toThrow(/permission denied/)
  })

  it('HTTP non-2xx surfaces as Error with status', async () => {
    const fetch = (async () => new Response('forbidden', { status: 403 })) as typeof globalThis.fetch
    await expect(fromMcpServer({ url: 'http://mcp', fetch })).rejects.toThrow(/MCP HTTP 403/)
  })

  it('structuredContent is JSON-stringified', async () => {
    const fetch = makeFakeFetch((req) => {
      if (req.method === 'tools/list') return TOOLS_LIST
      return { structuredContent: { foo: 'bar', n: 42 } }
    })
    const tools = await fromMcpServer({ url: 'http://mcp', fetch })
    const result = await tools[0].handler({}, { runId: 'r1' })
    expect(JSON.parse(result)).toEqual({ foo: 'bar', n: 42 })
  })

  it('forwards ctx.abortSignal to the underlying fetch on tools/call', async () => {
    let seenSignal: AbortSignal | undefined
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as RpcRequest
      if (body.method === 'tools/call') seenSignal = init?.signal as AbortSignal | undefined
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: body.method === 'tools/list'
            ? TOOLS_LIST
            : { content: [{ type: 'text', text: 'ok' }] },
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch

    const tools = await fromMcpServer({ url: 'http://mcp', fetch })
    const ctrl = new AbortController()
    await tools[0].handler({}, { runId: 'r1', abortSignal: ctrl.signal })
    expect(seenSignal).toBe(ctrl.signal)
  })

  it('aborts in-flight MCP fetch when signal fires', async () => {
    // Simulate a slow MCP server: the fetch resolves only after a delay,
    // unless the AbortSignal fires first.
    const fetch = ((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const body = JSON.parse((init?.body as string) ?? '{}') as RpcRequest
        if (body.method === 'tools/list') {
          resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: TOOLS_LIST }), { status: 200 }))
          return
        }
        const sig = init?.signal as AbortSignal | undefined
        const timer = setTimeout(() => {
          resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'late' }] } }), { status: 200 }))
        }, 200)
        sig?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }) as typeof globalThis.fetch

    const tools = await fromMcpServer({ url: 'http://mcp', fetch })
    const ctrl = new AbortController()
    const promise = tools[0].handler({}, { runId: 'r1', abortSignal: ctrl.signal })
    setTimeout(() => ctrl.abort('user stop'), 20)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
