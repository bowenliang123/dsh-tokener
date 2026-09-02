import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One named SSE event fixture. */
export interface MockEvent {
  event: string
  data: string
}

/** One scripted behavior for the next POST /messages the mock server receives. */
export type Behavior =
  | { kind: 'sse'; events: MockEvent[]; delayMs?: number }
  | { kind: 'http-error'; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { kind: 'close-early'; events: MockEvent[] }

export interface MockModelEntry {
  id?: string
  mode?: string
  max_input_tokens?: number
  max_output_tokens?: number
}

export interface MockServer {
  url: string
  /** Bodies of received POST /messages requests, in order. */
  requests: unknown[]
  /** Header bags of received POST /messages requests, in order (parallel to `requests`). */
  headers: IncomingMessage['headers'][]
  /** Header bags of received GET /models requests, in order. */
  modelHeaders: IncomingMessage['headers'][]
  /** Entries served from GET /models. */
  models: MockModelEntry[]
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** Convenience wrapper for one SSE event fixture. */
export function sse(event: string, data: unknown): MockEvent {
  return { event, data: typeof data === 'string' ? data : JSON.stringify(data) }
}

/** A minimal complete text generation over the OpenAI wire, reused by request-shape assertions. */
export const textEvents: MockEvent[] = [
  sse('data', { choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: '' } }] }),
  sse('data', { choices: [{ index: 0, delta: { content: 'hello' } }] }),
  sse('data', { choices: [{ index: 0, delta: { content: ' world' } }] }),
  sse('data', { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
  sse('data', '[DONE]'),
]

/** Serialize one event into its wire form (named event + data + blank line). */
function frame({ event, data }: MockEvent): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/** Optional canned failure for GET /models. */
export interface ModelsBehavior {
  status: number
  body: string
  contentType?: string
}

/** Local Anthropic Messages stand-in: replays scripted behaviors per request. */
export async function mockServer(
  script: Behavior[],
  models: MockModelEntry[] = [],
  modelsBehavior?: ModelsBehavior,
): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const modelHeaders: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/models' && request.method === 'GET') {
        modelHeaders.push(request.headers)
        if (modelsBehavior !== undefined) {
          response.writeHead(modelsBehavior.status, {
            'content-type': modelsBehavior.contentType ?? 'application/json',
          }).end(modelsBehavior.body)
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: models }))
        return
      }
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      headers.push(request.headers)
      const behavior = script.shift()
      if (!behavior) {
        response.writeHead(500).end('mock script exhausted')
        return
      }
      if (behavior.kind === 'http-error') {
        response.writeHead(behavior.status, {
          'content-type': behavior.contentType ?? 'application/json',
          ...behavior.headers,
        })
        response.end(behavior.body)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const write = (index: number): void => {
        if (index >= behavior.events.length) {
          if (behavior.kind === 'sse') response.end()
          else response.destroy() // close-early: drop the socket mid-stream
          return
        }
        response.write(frame(behavior.events[index]))
        setTimeout(() => { write(index + 1) }, behavior.kind === 'sse' ? behavior.delayMs ?? 0 : 5)
      }
      write(0)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    modelHeaders,
    models,
    script,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}
