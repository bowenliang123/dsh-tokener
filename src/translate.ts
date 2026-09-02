/**
 * Translate Tokener Anthropic-Messages SSE events into the harness StreamChunk
 * protocol. Blocks open lazily on their first non-empty delta, so gateway
 * quirks — an empty thinking block streamed as start+stop with no delta —
 * never materialize as empty harness blocks. `usage` is deferred to
 * `message_stop` and emitted before the terminal `finish`; nothing follows
 * `finish`. Reaching EOF before `message_stop` is truncation: the model call
 * cannot be trusted, so the stream fails with `STREAM_CLOSED`.
 *
 * @module dsh-tokener/translate
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SseEvent } from './sse.ts'
import type { WireEvent, WireUsage } from './types.ts'

/** One open harness block under assembly, keyed by the wire block index. */
interface OpenBlock {
  /**
   * Harness block index, assigned in first-opened stream order. A lazy
   * block that never receives a delta keeps its placeholder: it never
   * materializes, so it never consumes an index.
   */
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  /** Whether `block-start` has been emitted; lazy for text/reasoning. */
  opened: boolean
  text: string
  /** tool-call only: identity from `content_block_start`. */
  id?: string
  name?: string
}

/**
 * Map the wire `stop_reason` vocabulary to the harness FinishReason.
 * `pause_turn` maps to `stop`: the delivered content is complete from the
 * consumer's perspective, and the harness has no way to re-issue the turn.
 * @param reason - the wire stop reason, when the gateway supplied one.
 * @returns the mapped reason; unrecognized values become `{kind: 'error'}` with the uppercased value as code.
 */
export function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case undefined:
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return { kind: 'stop' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'refusal':
      return { kind: 'error', failure: { message: 'model refused the request', code: 'REFUSAL' } }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage to the harness's disjoint TokenUsage convention. Anthropic
 * `input_tokens` already excludes cache reads and writes, matching the
 * harness convention with no subtraction. Cache fields the gateway omitted
 * read as zero (no caching happened), so the total stays exact.
 * @param usage - the latest wire usage (fields from `message_delta` overwrite `message_start`).
 * @returns harness counts; cache fields appear only when the wire supplied them.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens
  const cacheWrite = usage.cache_creation_input_tokens
  const counts = Number.isSafeInteger(input) && input >= 0
    && Number.isSafeInteger(output) && output >= 0
  return {
    inputTokens: input,
    outputTokens: output,
    ...!counts ? {} : { totalTokens: input + output + (cacheRead ?? 0) + (cacheWrite ?? 0) },
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
  }
}

/** Map one Anthropic error type to a stable harness error code. */
export function wireErrorCode(type: string): string {
  if (type.endsWith('authentication_error') || type.endsWith('permission_error')) return 'AUTH'
  if (type.endsWith('rate_limit_error')) return 'RATE_LIMIT'
  if (type.endsWith('overloaded_error')) return 'SERVER'
  if (type.endsWith('invalid_request_error') || type.endsWith('not_found_error')) return 'INVALID_REQUEST'
  return 'SERVER'
}

/**
 * Map an HTTP status (plus optional parsed error body) to a stable error code.
 * @param status - status of a non-2xx gateway response.
 * @param error - the parsed Anthropic error payload, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireEvent & { type: 'error' }): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  const detail = [error?.error.type, error?.error.message].filter(Boolean).join(' ')
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 400 || status === 404 || status === 413) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: brandString<ToolCallId>(block.id ?? ''),
      name: block.name ?? '',
      // Zero-input calls may stream no input_json_delta at all; arguments stay
      // parseable end to end.
      arguments: block.text.length > 0 ? block.text : '{}',
    }
  }
}

/**
 * Consume SSE events and yield StreamChunks. Malformed JSON payloads abort
 * the stream with `MALFORMED_RESPONSE`; a mid-stream `error` event aborts
 * with the mapped provider code.
 * @param events - SSE events from {@link parseSse}, terminating at EOF.
 * @returns deltas as they arrive; `usage` and `finish` are deferred to `message_stop`.
 */
export async function* translate(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  const blocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingUsage: WireUsage | undefined
  let stopReason: string | undefined

  const open = (kind: OpenBlock['kind'], wireIndex: number): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, opened: true, text: '' }
    blocks.set(wireIndex, block)
    order.push(block)
    return block
  }

  /** Assign a harness index to a lazy block at its first real delta. */
  const openLazy = (block: OpenBlock): number => {
    block.index = nextIndex++
    block.opened = true
    order.push(block)
    return block.index
  }

  for await (const event of events) {
    let wire: WireEvent
    try {
      wire = JSON.parse(event.data) as WireEvent
    } catch {
      throw new LlmError(`malformed SSE payload: ${event.data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    switch (wire.type) {
      case 'message_start': {
        if (wire.message.usage !== undefined) pendingUsage = { ...wire.message.usage }
        break
      }
      case 'content_block_start': {
        const kind = wire.content_block.type === 'tool_use'
          ? 'tool-call' as const
          : wire.content_block.type === 'thinking' ? 'reasoning' as const : 'text' as const
        if (kind === 'tool-call') {
          // Tool calls open eagerly: identity (id/name) is on the block start,
          // and consumers may react before any argument delta arrives.
          const block = open(kind, wire.index)
          block.id = wire.content_block.id
          block.name = wire.content_block.name
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: brandString<ToolCallId>(block.id ?? ''),
            ...block.name === undefined ? {} : { name: block.name },
            argumentsDelta: '',
          }
        } else {
          // Text/reasoning open lazily on their first non-empty delta; the
          // harness index is only assigned if that ever happens.
          blocks.set(wire.index, { index: -1, kind, opened: false, text: '' })
        }
        break
      }
      case 'content_block_delta': {
        const block = blocks.get(wire.index)
        if (block === undefined) break
        if (wire.delta.type === 'text_delta') {
          // A delta aimed at a block of another kind is wire noise, not content.
          if (block.kind !== 'text' || wire.delta.text.length === 0) break
          if (!block.opened) {
            const index = openLazy(block)
            yield { type: 'block-start', index, blockType: 'text' }
          }
          block.text += wire.delta.text
          yield { type: 'text-delta', index: block.index, text: wire.delta.text }
        } else if (wire.delta.type === 'thinking_delta') {
          if (block.kind !== 'reasoning' || wire.delta.thinking.length === 0) break
          if (!block.opened) {
            const index = openLazy(block)
            yield { type: 'block-start', index, blockType: 'reasoning' }
          }
          block.text += wire.delta.thinking
          yield { type: 'reasoning-delta', index: block.index, text: wire.delta.thinking }
        } else if (wire.delta.type === 'input_json_delta') {
          if (block.kind !== 'tool-call') break
          const fragment = wire.delta.partial_json
          block.text += fragment
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: brandString<ToolCallId>(block.id ?? ''),
            ...block.name === undefined ? {} : { name: block.name },
            argumentsDelta: fragment,
          }
        }
        // signature_delta rides thinking blocks; the harness has nowhere to
        // carry a signature, and this adapter does not replay reasoning.
        break
      }
      case 'content_block_stop': {
        const block = blocks.get(wire.index)
        if (block === undefined) break
        blocks.delete(wire.index)
        // A never-opened text/reasoning block was empty end to end; emit
        // nothing rather than an empty harness block.
        if (!block.opened) break
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
        break
      }
      case 'message_delta': {
        if (wire.delta.stop_reason !== undefined) stopReason = wire.delta.stop_reason
        if (wire.usage !== undefined) pendingUsage = { ...pendingUsage, ...wire.usage }
        break
      }
      case 'message_stop': {
        if (pendingUsage !== undefined && (pendingUsage.input_tokens !== undefined || pendingUsage.output_tokens !== undefined)) {
          yield { type: 'usage', usage: mapUsage(pendingUsage) }
        }
        const reason = mapFinishReason(stopReason)
        yield {
          type: 'finish',
          // A completed response with no visible block at all is a degenerate
          // completion; a reasoning-only turn still counts as content (its
          // text lands in the session log) and must not force a retry.
          reason: reason.kind === 'stop' && order.length === 0
            ? {
              kind: 'error',
              failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
            }
            : reason,
        }
        return
      }
      case 'error': {
        throw new LlmError(
          wire.error.message.length > 0 ? wire.error.message : `gateway error: ${wire.error.type}`,
          wireErrorCode(wire.error.type),
        )
      }
      default:
        // ping and unknown event types are transport noise.
        break
    }
  }

  // message_stop returns before reaching here, so EOF at this point is
  // truncation: the response never terminated and the call cannot be trusted.
  throw new LlmError('SSE stream ended without message_stop', 'STREAM_CLOSED')
}
