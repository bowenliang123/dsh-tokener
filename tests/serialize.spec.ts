import { describe, expect, it } from 'vitest'
import { LlmError, ReasoningEffortId, createAssistantMessage, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { DEFAULT_EFFORT_BUDGETS, resolveThinking, serializeMessages, serializeRequest } from '../src/serialize.ts'
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
  it('maps user text, dropping empty text blocks', async () => {
    const wire = await serializeMessages([
      user('hello'),
      user('', [{ type: 'text', text: '' }]),
    ])
    expect(wire).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])
  })

  it('skips system-role messages (the caller hoists them) and degenerate empty user turns', async () => {
    const wire = await serializeMessages([
      createUserMessage({ content: [], source: { kind: 'user' } }),
    ])
    expect(wire).toEqual([])
  })

  it('skips reasoning and tool-call blocks inside user content', async () => {
    const CALL2 = brandString<ToolCallId>('call_9')
    const wire = await serializeMessages([
      createUserMessage({
        content: [
          { type: 'reasoning', text: 'thoughts' },
          { type: 'tool-call', id: CALL2, name: 'x', arguments: '{}' },
          { type: 'text', text: 'real content' },
        ],
        source: { kind: 'user' },
      }),
    ])
    expect(wire).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'real content' }] },
    ])
  })

  it('serializes assistant text and tool calls with parsed JSON arguments', async () => {
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
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: CALL, name: 'lookup', input: { q: 'hz' } },
        ],
      },
    ])
  })

  it('throws INVALID_REQUEST on malformed tool-call arguments', async () => {
    await expect(serializeMessages([
      assistant([{ type: 'tool-call', id: CALL, name: 'lookup', arguments: '{broken' }]),
    ])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('substitutes a placeholder when an assistant turn has no representable content', async () => {
    const wire = await serializeMessages([
      assistant([{ type: 'reasoning', text: 'only thoughts' }]),
      assistant([{ type: 'text', text: '' }]),
    ])
    expect(wire).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: '(empty response)' }] },
      { role: 'assistant', content: [{ type: 'text', text: '(empty response)' }] },
    ])
  })

  it('keeps an all-empty system vocabulary out of the request', async () => {
    const request = await serializeRequest({
      provider: 'tokener',
      model: 'm',
      messages: [
        createMessage({
          role: 'system',
          content: [{ type: 'text', text: '' }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
    })
    expect(request.system).toBeUndefined()
    expect(request.messages).toEqual([])
  })

  it('expands tool results into tool_result blocks ahead of remaining user content', async () => {
    const wire = await serializeMessages([
      createToolResultMessage({
        callId: CALL,
        content: [{ type: 'text', text: 'sunny 30C' }],
        isError: false,
      }),
      createUserMessage({
        content: [
          { type: 'tool-result', toolCallId: CALL, content: [{ type: 'text', text: 'boom' }], isError: true },
          { type: 'text', text: 'and also' },
        ],
        source: { kind: 'user' },
      }),
    ])
    expect(wire).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: CALL, content: [{ type: 'text', text: 'sunny 30C' }] }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: CALL, content: [{ type: 'text', text: 'boom' }], is_error: true },
          { type: 'text', text: 'and also' },
        ],
      },
    ])
  })

  it('substitutes a placeholder for empty tool output and flattens nested tool-result blocks', async () => {
    const wire = await serializeMessages([
      createToolResultMessage({ callId: CALL, content: [], isError: false }),
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CALL,
          content: [{ type: 'tool-result', toolCallId: CALL, content: [{ type: 'text', text: 'nested' }], isError: false }],
          isError: false,
        }],
        source: { kind: 'user' },
      }),
    ])
    expect(wire).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: CALL, content: [{ type: 'text', text: '(no output)' }] }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: CALL, content: [{ type: 'text', text: 'nested' }] }] },
    ])
  })

  it('emits prepared images as base64 blocks and rejects unprepared ones', async () => {
    const withImage = createUserMessage({
      content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: imageRef }],
      source: { kind: 'user' },
    })
    const prepared = { requestImages: new Map([[imageRef.attachmentId, requestImage()]]) }
    const wire = await serializeMessages([withImage], prepared)
    expect(wire).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') } },
        ],
      },
    ])
    await expect(serializeMessages([withImage])).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})

describe('resolveThinking', () => {
  const base = { purpose: undefined, maxTokens: 16_384 } as const

  it('stays off by default and for session titles', () => {
    expect(resolveThinking({ ...base }, {})).toBeUndefined()
    // tier budget 49,152 clamps under the 16,384 max_tokens with 1,024 headroom
    expect(resolveThinking({ ...base, reasoningEffort: ReasoningEffortId('max') }, { reasoningEffort: 'max' }))
      .toEqual({ type: 'enabled', budget_tokens: 15_360 })
    expect(resolveThinking({
      purpose: 'session-title',
      reasoningEffort: ReasoningEffortId('max'),
      maxTokens: 16_384,
    }, {})).toBeUndefined()
  })

  it('sends the tier budget unclamped when the request names no max_tokens', () => {
    expect(resolveThinking(
      { purpose: undefined, reasoningEffort: ReasoningEffortId('medium') },
      { reasoningEffort: 'medium' },
    )).toEqual({ type: 'enabled', budget_tokens: DEFAULT_EFFORT_BUDGETS.medium })
  })

  it('maps each tier to its budget and clamps under max_tokens with headroom', () => {
    expect(resolveThinking({ ...base }, { reasoningEffort: 'low', effortBudgets: { low: 4_096 } }))
      .toEqual({ type: 'enabled', budget_tokens: 4_096 })
    // tier budget 4,096 clamps to max_tokens 2,048 minus the 1,024 headroom
    expect(resolveThinking(
      { purpose: undefined, reasoningEffort: ReasoningEffortId('low'), maxTokens: 2_048 },
      { reasoningEffort: 'low', effortBudgets: { low: 4_096 } },
    )).toEqual({ type: 'enabled', budget_tokens: 1_024 })
    expect(() => resolveThinking(
      { purpose: undefined, reasoningEffort: ReasoningEffortId('low'), maxTokens: 1_024 },
      { effortBudgets: { low: 4_096 } },
    )).toThrow(LlmError)
  })
})

describe('serializeRequest', () => {
  it('assembles the full streaming request with hoisted system text and tools', async () => {
    const request = await serializeRequest({
      provider: 'tokener',
      model: 'glm-5.2',
      messages: [
        createMessage({
          role: 'system',
          content: [{ type: 'text', text: 'house rules' }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
        user('hi'),
      ],
      system: 'be brief',
      tools: [{ name: 'lookup', description: 'Search', parameters: { type: 'object' } }],
      temperature: 0.5,
      maxTokens: 2_048,
      stop: ['END'],
    })
    expect(request).toEqual({
      model: 'glm-5.2',
      max_tokens: 2_048,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: 'be brief\n\nhouse rules',
      tools: [{ name: 'lookup', description: 'Search', input_schema: { type: 'object' } }],
      temperature: 0.5,
      stop_sequences: ['END'],
    })
  })

  it('sends the thinking control only when the extended effort resolves', async () => {
    const options: GenerateOptions = {
      provider: 'tokener',
      model: 'm',
      messages: [user('hi')],
      maxTokens: 16_384,
    }
    const plain = await serializeRequest(options)
    expect(plain.thinking).toBeUndefined()
    expect(plain.system).toBeUndefined()
    const extended = await serializeRequest(options, { reasoningEffort: 'high', effortBudgets: { high: 2_048 } })
    expect(extended.thinking).toEqual({ type: 'enabled', budget_tokens: 2_048 })
  })

  it('omits empty tools arrays and absent optionals', async () => {
    const request = await serializeRequest({ provider: 'tokener', model: 'm', messages: [], tools: [] })
    expect(request.tools).toBeUndefined()
    expect(request.temperature).toBeUndefined()
    expect(request.stop_sequences).toBeUndefined()
    expect(request.max_tokens).toBe(0)
  })
})

describe('request defaults type', () => {
  it('documents the effort vocabulary', () => {
    const defaults: RequestDefaults = { reasoningEffort: 'off', effortBudgets: { low: 1_024 } }
    expect(defaults.reasoningEffort).toBe('off')
  })
})
