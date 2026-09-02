import { describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { mapFinishReason, mapUsage, translate } from '../src/translate.ts'
import { httpErrorCode } from '../src/adapter.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** One OpenAI chat-completions chunk fixture, stringified for the wire. */
function chunk(inner: object): string {
  return JSON.stringify(inner)
}

const textDelta = (text: string) => ({ choices: [{ index: 0, delta: { content: text } }] })
const reasoningDelta = (text: string) => ({ choices: [{ index: 0, delta: { reasoning_content: text } }] })
const finishChunk = (reason: string, usage?: object) => ({
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
  ...(usage === undefined ? {} : { usage }),
})
const usageChunk = (usage: object) => JSON.stringify({ choices: [], usage })
const DONE = '[DONE]'

/** Feed fixture payloads straight into the translator. */
async function run(...payloads: string[]): Promise<StreamChunk[]> {
  async function* iterate(): AsyncGenerator<string> {
    yield* payloads
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of translate(iterate())) chunks.push(chunk)
  return chunks
}

describe('translate', () => {
  it('streams a text response as block-start, deltas, block-end, usage, finish', async () => {
    const chunks = await run(
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: null, reasoning_content: '' } }] }),
      chunk(textDelta('he')),
      chunk(textDelta('y')),
      chunk(finishChunk('stop', { prompt_tokens: 9, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } })),
      DONE,
    )
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'he' },
      { type: 'text-delta', index: 0, text: 'y' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hey' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, totalTokens: 14, cacheReadTokens: 2, reasoningTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('maps reasoning_content onto a lazily-opened reasoning block', async () => {
    const chunks = await run(...[
      chunk({ choices: [{ index: 0, delta: { reasoning_content: '', content: '' } }] }),
      chunk(reasoningDelta('let me')),
      chunk(reasoningDelta(' think')),
      chunk(textDelta('done')),
      chunk(finishChunk('stop')),
      DONE,
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'let me' },
      { type: 'reasoning-delta', index: 0, text: ' think' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'done' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'let me think' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('keeps a reasoning-only completion as a successful stop, not an empty response', async () => {
    const chunks = await run(
      chunk(reasoningDelta('hm')),
      chunk(finishChunk('stop')),
      DONE,
    )
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('streams tool calls with identity, argument fragments, and raw JSON arguments', async () => {
    const chunks = await run(
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{' } }] } }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"city":"HZ"}' } }] } }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '' } }] } }] }),
      chunk(finishChunk('tool_calls')),
      DONE,
    )
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '{' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '"city":"HZ"}' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"HZ"}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('adopts tool-call identity lazily and tolerates an identity-less close', async () => {
    // identity fields arrive on a later delta; this close never saw id/name
    const chunks = await run(
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 3 }] } }] }),
      chunk(finishChunk('tool_calls')),
      DONE,
    )
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: '', arguments: '' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('defaults the finish to stop when no chunk names a finish_reason', async () => {
    const chunks = await run(chunk(textDelta('x')), DONE)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('maps a completed response with no visible block to an EMPTY_RESPONSE error finish', async () => {
    const chunks = await run(chunk(finishChunk('stop')), DONE)
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } },
    })
  })

  it('throws a mapped LlmError on malformed JSON payloads', async () => {
    await expect(run('not-json')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('throws STREAM_CLOSED when the payload stream ends without [DONE]', async () => {
    await expect(run(chunk(textDelta('half')))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('accepts a trailing usage-only chunk before [DONE]', async () => {
    const chunks = await run(
      chunk(textDelta('x')),
      chunk(finishChunk('stop')),
      usageChunk({ prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }),
      DONE,
    )
    expect(chunks.filter(chunk => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } },
    ])
  })

  it('keeps the latest usage when both finish-attached and trailing usage arrive', async () => {
    const chunks = await run(
      chunk(textDelta('x')),
      chunk(finishChunk('stop', { prompt_tokens: 1, completion_tokens: 1 })),
      usageChunk({ prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }),
      DONE,
    )
    expect(chunks.filter(chunk => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } },
    ])
  })
})

describe('mapFinishReason', () => {
  it('maps the wire vocabulary', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
    expect(mapFinishReason('content_filter')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: content_filter', code: 'CONTENT_FILTER' },
    })
  })
})

describe('mapUsage', () => {
  it('subtracts cache hits out of aggregate prompt tokens', () => {
    expect(mapUsage({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 6 },
      completion_tokens_details: { reasoning_tokens: 3 },
    })).toEqual({ inputTokens: 4, outputTokens: 4, totalTokens: 14, cacheReadTokens: 6, reasoningTokens: 3 })
  })

  it('degrades to zeros when aggregate counters are missing', () => {
    expect(mapUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('withholds derived fields when counts are unusable', () => {
    expect(mapUsage({ prompt_tokens: -1, completion_tokens: 2 })).toEqual({ inputTokens: -1, outputTokens: 2 })
  })
})

describe('wireErrorCode + httpErrorCode', () => {
  it('maps statuses with the parsed body as a tiebreaker', () => {
    expect(httpErrorCode(401)).toBe('AUTH')
    expect(httpErrorCode(403)).toBe('AUTH')
    expect(httpErrorCode(429)).toBe('RATE_LIMIT')
    expect(httpErrorCode(400, { type: 'invalid_request_error', message: 'context length exceeded for model' })).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(httpErrorCode(400, { type: 'invalid_request_error', message: 'You have insufficient quota remaining' })).toBe(QUOTA_EXCEEDED_CODE)
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
