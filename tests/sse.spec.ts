import { describe, expect, it } from 'vitest'
import { parseSse } from '../src/sse.ts'

/** Build a readable byte stream from string chunks. */
function streamOf(...chunks: string[]): ReadableStream<BufferSource> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index]))
      index += 1
    },
  })
}

async function collect(stream: ReadableStream<BufferSource>, onComment?: (comment: string) => void) {
  const events = []
  for await (const event of parseSse(stream, onComment)) events.push(event)
  return events
}

describe('parseSse', () => {
  it('yields named events in arrival order', async () => {
    const raw = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: ping\ndata: {}\n\n'
    expect(await collect(streamOf(raw))).toEqual([
      { event: 'message_start', data: '{"type":"message_start"}' },
      { event: 'ping', data: '{}' },
    ])
  })

  it('reassembles events split across read boundaries, including mid-UTF-8', async () => {
    const raw = 'event: content_block_delta\ndata: {"delta":"héllo"}\n\n'
    const split = 30
    expect(await collect(streamOf(raw.slice(0, split), raw.slice(split)))).toEqual([
      { event: 'content_block_delta', data: '{"delta":"héllo"}' },
    ])
  })

  it('handles CRLF framing and multi-line data', async () => {
    const raw = 'event: a\r\ndata: line1\ndata: line2\r\n\r\n'
    expect(await collect(streamOf(raw))).toEqual([
      { event: 'a', data: 'line1\nline2' },
    ])
  })

  it('routes comments to the activity callback without yielding them', async () => {
    const comments: string[] = []
    const raw = ': keep-alive\n\nevent: ping\ndata: {}\n\n'
    const events = await collect(streamOf(raw), comment => comments.push(comment))
    expect(events).toEqual([{ event: 'ping', data: '{}' }])
    expect(comments).toEqual(['keep-alive'])
  })

  it('reports unnamed events with an empty event name and skips empty data', async () => {
    const raw = 'event: silent\n\ndata: {"type":"message_stop"}\n\n'
    expect(await collect(streamOf(raw))).toEqual([
      { event: '', data: '{"type":"message_stop"}' },
    ])
  })

  it('simply ends iteration at EOF (termination is the translator\'s contract)', async () => {
    expect(await collect(streamOf('event: message_stop\ndata: {}\n\n'))).toEqual([
      { event: 'message_stop', data: '{}' },
    ])
  })
})
