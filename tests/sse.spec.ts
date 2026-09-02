import { describe, expect, it } from 'vitest'
import { DONE, parseSse } from '../src/sse.ts'

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
  it('yields data payloads in arrival order, the [DONE] sentinel last', async () => {
    const raw = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n'
    expect(await collect(streamOf(raw))).toEqual(['{"a":1}', '{"b":2}', DONE])
  })

  it('reassembles events split across read boundaries, including mid-UTF-8', async () => {
    const raw = 'data: {"delta":"héllo"}\n\ndata: [DONE]\n\n'
    const split = 14
    expect(await collect(streamOf(raw.slice(0, split), raw.slice(split)))).toEqual([
      '{"delta":"héllo"}',
      DONE,
    ])
  })

  it('handles CRLF framing and multi-line data', async () => {
    const raw = 'data: line1\ndata: line2\r\n\r\ndata: [DONE]\n\n'
    expect(await collect(streamOf(raw))).toEqual(['line1\nline2', DONE])
  })

  it('routes comments to the activity callback without yielding them', async () => {
    const comments: string[] = []
    const raw = ': keep-alive\n\ndata: {}\n\ndata: [DONE]\n\n'
    const events = await collect(streamOf(raw), comment => comments.push(comment))
    expect(events).toEqual(['{}', DONE])
    expect(comments).toEqual(['keep-alive'])
  })

  it('throws STREAM_CLOSED when the stream ends without [DONE]', async () => {
    await expect(collect(streamOf('data: {"a":1}\n\n')))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
