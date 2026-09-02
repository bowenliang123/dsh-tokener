import { describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { httpErrorCode, mapFinishReason, mapUsage, translate, wireErrorCode } from '../src/translate.ts'
import type { MockEvent } from './mock-server.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const messageStart = { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 0, output_tokens: 0 } } }) }
const endTurnDelta = { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) }
const messageStop = { event: 'message_stop', data: '{"type":"message_stop"}' }

/** Feed fixture events straight into the translator. */
async function run(...events: MockEvent[]): Promise<StreamChunk[]> {
  async function* iterate(): AsyncGenerator<MockEvent> {
    yield* events
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of translate(iterate())) chunks.push(chunk)
  return chunks
}

/** One complete text-response stream with a customizable event body. */
function stream(...middle: MockEvent[]): MockEvent[] {
  return [messageStart, ...middle, endTurnDelta, messageStop]
}

describe('translate', () => {
  it('streams a text response as block-start, deltas, block-end, usage, finish', async () => {
    const chunks = await run(
      { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } }) },
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'y' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
      { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 9, output_tokens: 5 } }) },
      messageStop,
    )
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'he' },
      { type: 'text-delta', index: 0, text: 'y' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hey' } },
      { type: 'usage', usage: { inputTokens: 9, outputTokens: 5, totalTokens: 17, cacheReadTokens: 2, cacheWriteTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('never emits empty text/thinking blocks the gateway streams as start+stop', async () => {
    const chunks = await run(...stream(
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 1 }) },
    ))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 5, totalTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('maps thinking and signature deltas onto a reasoning block, ignoring signatures', async () => {
    const chunks = await run(...stream(
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' think' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 1 }) },
    ))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'let me' },
      { type: 'reasoning-delta', index: 0, text: ' think' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'let me think' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'done' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 5, totalTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('keeps a reasoning-only completion as a successful stop, not an empty response', async () => {
    const chunks = await run(...stream(
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
    ))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('streams tool calls with identity, argument fragments, and parseable arguments', async () => {
    const chunks = await run(
      messageStart,
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ci' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ty":"HZ"}' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
      { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }) },
      messageStop,
    )
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{"ci' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: 'ty":"HZ"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"HZ"}' } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 5, totalTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('closes a zero-input tool call with parseable empty arguments', async () => {
    const chunks = await run(...stream(
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_2', name: 'noop' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
    ))
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_2', name: 'noop', arguments: '{}' },
    })
  })

  it('emits no usage chunk when the gateway reports no input or output count', async () => {
    const chunks = await run(
      { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { usage: { cache_read_input_tokens: 7 } } }) },
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
      { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) },
      messageStop,
    )
    expect(chunks.filter(chunk => chunk.type === 'usage')).toEqual([])
  })

  it('maps a completed response with no visible block to an EMPTY_RESPONSE error finish', async () => {
    const chunks = await run(...stream())
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } },
    })
  })

  it('keeps gateway quirks harmless: empty deltas, nameless tool calls, stray json, no usage', async () => {
    const chunks = await run(
      // message_start without usage
      { event: 'message_start', data: '{"type":"message_start","message":{}}' },
      // a tool-use block the gateway never identifies
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }) },
      // text_delta aimed at a tool block index is wire noise, not content
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'wait' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
      // an empty thinking delta never opens a block; json aimed at a text block is noise
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'thinking' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 1 }) },
      // message_delta without usage
      { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) },
      messageStop,
    )
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{"a":1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: '', arguments: '{"a":1}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('falls back to the error type when an error event carries no message', async () => {
    await expect(run(
      { event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'api_error', message: '' } }) },
    )).rejects.toMatchObject({ code: 'SERVER', message: 'gateway error: api_error' })
  })

  it('accepts a usage-only message_delta ahead of the terminal one', async () => {
    const chunks = await run(...stream(
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
      { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: {}, usage: { output_tokens: 3 } }) },
    ))
    expect(chunks.filter(chunk => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 5, totalTokens: 5 } },
    ])
  })

  it('throws a mapped LlmError on a mid-stream error event', async () => {
    await expect(run(
      { event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'gateway overloaded' } }) },
    )).rejects.toMatchObject({ code: 'SERVER', message: 'gateway overloaded' })
  })

  it('throws MALFORMED_RESPONSE on a non-JSON payload', async () => {
    await expect(run({ event: 'message_start', data: 'not-json' }))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('throws STREAM_CLOSED when the stream ends without message_stop', async () => {
    await expect(run(
      messageStart,
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) },
    )).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('ignores pings, deltas for unknown blocks, and empty delta fragments', async () => {
    const chunks = await run(...stream(
      { event: 'ping', data: '{"type":"ping"}' },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'ghost' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 9 }) },
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
    ))
    expect(chunks.filter(chunk => chunk.type !== 'usage' && chunk.type !== 'finish')).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
    ])
  })
})

describe('mapFinishReason', () => {
  it('maps the wire vocabulary', () => {
    expect(mapFinishReason(undefined)).toEqual({ kind: 'stop' })
    expect(mapFinishReason('end_turn')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('stop_sequence')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('pause_turn')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_use')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('max_tokens')).toEqual({ kind: 'max-tokens' })
    expect(mapFinishReason('refusal')).toEqual({ kind: 'error', failure: { message: 'model refused the request', code: 'REFUSAL' } })
    expect(mapFinishReason('detected_unusual_activity')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: detected_unusual_activity', code: 'DETECTED_UNUSUAL_ACTIVITY' },
    })
  })
})

describe('mapUsage', () => {
  it('totals input, output, and any cache fields', () => {
    expect(mapUsage({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 }))
      .toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 1 })
    expect(mapUsage({ input_tokens: 3 })).toEqual({ inputTokens: 3, outputTokens: 0, totalTokens: 3 })
    expect(mapUsage({})).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })

  it('withholds the total when a count is unusable', () => {
    expect(mapUsage({ input_tokens: -1, output_tokens: 2 })).toEqual({ inputTokens: -1, outputTokens: 2 })
  })
})

describe('wireErrorCode', () => {
  it('maps Anthropic error types to stable codes', () => {
    expect(wireErrorCode('authentication_error')).toBe('AUTH')
    expect(wireErrorCode('permission_error')).toBe('AUTH')
    expect(wireErrorCode('rate_limit_error')).toBe('RATE_LIMIT')
    expect(wireErrorCode('overloaded_error')).toBe('SERVER')
    expect(wireErrorCode('invalid_request_error')).toBe('INVALID_REQUEST')
    expect(wireErrorCode('not_found_error')).toBe('INVALID_REQUEST')
    expect(wireErrorCode('api_error')).toBe('SERVER')
  })
})

describe('httpErrorCode', () => {
  it('maps statuses with the parsed body as a tiebreaker', () => {
    const error = (type: string, message: string) => ({ type: 'error' as const, error: { type, message } })
    expect(httpErrorCode(401)).toBe('AUTH')
    expect(httpErrorCode(403)).toBe('AUTH')
    expect(httpErrorCode(429)).toBe('RATE_LIMIT')
    expect(httpErrorCode(400, error('invalid_request_error', 'context length exceeded for model'))).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(httpErrorCode(400, error('invalid_request_error', 'You have insufficient quota remaining'))).toBe(QUOTA_EXCEEDED_CODE)
    expect(httpErrorCode(400)).toBe('INVALID_REQUEST')
    expect(httpErrorCode(404)).toBe('INVALID_REQUEST')
    expect(httpErrorCode(413)).toBe('INVALID_REQUEST')
    expect(httpErrorCode(500)).toBe('SERVER')
    expect(httpErrorCode(529)).toBe('SERVER')
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })
})

describe('LlmError shape', () => {
  it('keeps provider facts serializable', () => {
    const error = new LlmError('nope', 'AUTH', { status: 401, requestId: ProviderRequestId('req_1') })
    expect(error.failure).toMatchObject({ message: 'nope', code: 'AUTH', status: 401, requestId: 'req_1' })
  })
})
