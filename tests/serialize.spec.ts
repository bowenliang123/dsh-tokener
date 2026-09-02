import { describe, expect, it } from 'vitest'
import { ReasoningEffortId, createAssistantMessage, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { resolveThinking, serializeMessages, serializeRequest } from '../src/serialize.ts'
import type { RequestDefaults } from '../src/serialize.ts'

const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

function requestImage(ref = imageRef): RequestImageAttachment {
  return {
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    attachment: ref,
    data: Uint8Array.of(1, 2, 3),
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: true,
  }
}

function user(text: string, blocks: ContentBlock[] = [{ type: 'text', text }]) {
  return createUserMessage({ content: blocks, source: { kind: 'user' } })
}

function assistant(blocks: ContentBlock[]) {
  return createAssistantMessage({ content: blocks, source: { provider: 'tokener', model: 'glm-5.2' } })
}

const CALL = brandString<ToolCallId>('call_1')

describe('serializeMessages', () => {
  it('maps user text, drops empty text blocks, and keeps turn alignment on empty turns', async () => {
    const wire = await serializeMessages([
      user('hello'),
      user('', [{ type: 'text', text: '' }]),
    ])
    expect(wire).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: '' },
    ])
  })

  it('keeps system-role messages as wire system messages and skips empty ones', async () => {
    const wire = await serializeMessages([
      createMessage({ role: 'system', content: [{ type: 'text', text: '' }], source: { kind: 'plugin', plugin: 'test' } }),
      createAssistantMessage({
        content: [{ type: 'text', text: 'answer' }],
        source: { provider: 'tokener', model: 'glm-5.2' },
      }),
      createMessage({ role: 'system', content: [{ type: 'text', text: 'rules' }], source: { kind: 'plugin', plugin: 'test' } }),
    ])
    expect(wire).toEqual([
      { role: 'assistant', content: 'answer' },
      { role: 'system', content: 'rules' },
    ])
  })

  it('serializes assistant text, reasoning passback, and parsed tool calls', async () => {
    const wire = await serializeMessages([
      assistant([
        { type: 'text', text: 'checking' },
        { type: 'reasoning', text: 'secret thoughts' },
        { type: 'tool-call', id: CALL, name: 'lookup', arguments: '{"q":"hz"}' },
      ]),
    ])
    expect(wire).toEqual([
      {
        role: 'assistant',
        content: 'checking',
        reasoning_content: 'secret thoughts',
        tool_calls: [{ id: CALL, type: 'function', function: { name: 'lookup', arguments: '{"q":"hz"}' } }],
      },
    ])
  })

  it('passes tool-call arguments through as raw JSON strings (the dialect needs no parsing)', async () => {
    const wire = await serializeMessages([
      assistant([{ type: 'tool-call', id: CALL, name: 'lookup', arguments: '{broken' }]),
    ])
    expect(wire[0]?.tool_calls?.[0]?.function?.arguments).toBe('{broken')
  })

  it('expands tool results into role:tool messages with placeholders for empty output', async () => {
    const wire = await serializeMessages([
      createToolResultMessage({ callId: CALL, content: [{ type: 'text', text: 'sunny 30C' }], isError: false }),
      createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CALL, content: [], isError: true }],
        source: { kind: 'user' },
      }),
    ])
    expect(wire).toEqual([
      { role: 'tool', tool_call_id: CALL, content: 'sunny 30C' },
      { role: 'tool', tool_call_id: CALL, content: '(no output)' },
    ])
  })

  it('recurses into nested tool-result blocks and skips non-input vocabulary', async () => {
    const wire = await serializeMessages([
      createUserMessage({
        content: [
          { type: 'tool-result', toolCallId: CALL, content: [{ type: 'tool-result', toolCallId: CALL, content: [{ type: 'text', text: 'nested' }], isError: false }], isError: false },
          { type: 'reasoning', text: 'thoughts' },
          { type: 'text', text: 'visible' },
        ],
        source: { kind: 'user' },
      }),
    ])
    expect(wire).toEqual([
      { role: 'user', content: 'visible' },
      { role: 'tool', tool_call_id: CALL, content: 'nested' },
    ])
  })

  it('emits prepared images as inline base64 parts and rejects unprepared ones', async () => {
    const withImage = user('look', [
      { type: 'text', text: 'look' },
      { type: 'image', attachment: imageRef },
    ])
    const prepared = { requestImages: new Map([[imageRef.attachmentId, requestImage()]]) }
    const wire = await serializeMessages([withImage], prepared)
    expect(wire).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` } },
        ],
      },
    ])
    await expect(serializeMessages([withImage])).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('keeps mixed user turns on parts and routes tool-result images to a following user message', async () => {
    const wire = await serializeMessages([
      createUserMessage({
        content: [
          { type: 'tool-result', toolCallId: CALL, content: [{ type: 'image', attachment: imageRef }], isError: false },
          { type: 'text', text: 'and this?' },
        ],
        source: { kind: 'user' },
      }),
    ], { requestImages: new Map([[imageRef.attachmentId, requestImage()]]) })
    expect(wire).toEqual([
      { role: 'user', content: 'and this?' },
      { role: 'tool', tool_call_id: CALL, content: '(no output)' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Attached image(s) from tool result:' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` } },
        ],
      },
    ])
  })
})

describe('resolveThinking', () => {
  const base = { purpose: undefined } as const

  it('sends nothing by default, for session titles it sends an explicit disabled', () => {
    expect(resolveThinking({ ...base }, {})).toEqual({})
    expect(resolveThinking({ ...base, reasoningEffort: ReasoningEffortId('high') }, { reasoningEffort: 'high' }))
      .toEqual({ reasoning_effort: 'high' })
    expect(resolveThinking({ purpose: 'session-title', reasoningEffort: ReasoningEffortId('high') }, {}))
      .toEqual({ reasoning_effort: 'low' })
  })

  it('maps low/high/max onto reasoning_effort', () => {
    expect(resolveThinking({ ...base, reasoningEffort: ReasoningEffortId('low') }, {}))
      .toEqual({ reasoning_effort: 'low' })
    expect(resolveThinking({ ...base, reasoningEffort: ReasoningEffortId('max') }, {}))
      .toEqual({ reasoning_effort: 'max' })
  })
})

describe('serializeRequest', () => {
  it('assembles the full streaming request with hoisted system text and tools', async () => {
    const request = await serializeRequest({
      provider: 'tokener',
      model: 'glm-5.2',
      messages: [
        { ...createUserMessage({ content: [{ type: 'text', text: 'house rules' }], source: { kind: 'plugin', plugin: 'test' } }), role: 'system' } as never,
        user('hi'),
      ],
      system: 'be brief',
      tools: [{ name: 'lookup', description: 'Search', parameters: { type: 'object' } }],
      temperature: 0.5,
      maxTokens: 2_048,
      stop: ['END'],
    })
    expect(request).toMatchObject({
      model: 'glm-5.2',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'system', content: 'house rules' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Search', parameters: { type: 'object' } } }],
      temperature: 0.5,
      max_tokens: 2_048,
      stop: ['END'],
    })
  })

  it('sends reasoning_effort plus thinking only when an effort resolves', async () => {
    const options: GenerateOptions = {
      provider: 'tokener',
      model: 'm',
      messages: [user('hi')],
      maxTokens: 16_384,
    }
    const plain = await serializeRequest(options)
    expect(plain.reasoning_effort).toBeUndefined()
    const high = await serializeRequest(options, { reasoningEffort: 'high' })
    expect(high.reasoning_effort).toBe('high')
    const off = await serializeRequest({ ...options, reasoningEffort: ReasoningEffortId('off') })
    expect(off.reasoning_effort).toBeUndefined()
  })

  it('omits empty tools arrays and absent optionals', async () => {
    const request = await serializeRequest({ provider: 'tokener', model: 'm', messages: [], tools: [] })
    expect(request.tools).toBeUndefined()
    expect(request.temperature).toBeUndefined()
    expect(request.stop).toBeUndefined()
    expect(request.max_tokens).toBeUndefined()
  })
})

describe('request defaults type', () => {
  it('documents the effort vocabulary', () => {
    const defaults: RequestDefaults = { reasoningEffort: 'off' }
    expect(defaults.reasoningEffort).toBe('off')
  })
})
