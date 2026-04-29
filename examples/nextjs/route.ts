// Example: a Next.js App Router route handler that streams MarcoAgent
// responses to the browser as Server-Sent Events.
//
// Drop this file at app/api/chat/route.ts in your Next.js app.
// Then POST { prompt: string, history?: Message[] } and consume the
// EventSource stream on the client.

import { MarcoAgent, type Message } from 'marco-agent'

export const runtime = 'nodejs'

type RequestBody = {
  prompt: string
  history?: Message[]
}

export async function POST(req: Request): Promise<Response> {
  const { prompt, history = [] } = (await req.json()) as RequestBody
  if (!prompt) return new Response('prompt required', { status: 400 })

  const agent = new MarcoAgent({
    // Replace defaults with your own tools, hooks, system prompt, etc.
    // For Crystallio: pass MCP-backed tools scoped to the requesting user_id.
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }
      try {
        for await (const event of agent.stream(prompt, history)) {
          send(event)
        }
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}
