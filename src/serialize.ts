/**
 * Serialize harness messages into Tokener's OpenAI-compatible chat
 * completions. Tool-result blocks become standalone `{role: 'tool'}` wire
 * messages; images resolve to ordered inline `image_url` parts; assistant
 * reasoning rides back as `reasoning_content` (plain text — the OpenAI
 * dialect has no signatures, so replay needs no verification).
 *
 * @module dsh-tokener/serialize
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ReasoningEffort, ResolvedThinking } from './types.ts'
import type { WireMessage, WireRequest, WireTool, WireUserContentPart } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  /** Default thinking effort for calls that name none (default `off`). */
  reasoningEffort?: ReasoningEffort | undefined
}

/** Prepared request images, keyed by durable attachment id. Present only when the request carries images. */
export interface ImageSerializationOptions {
  requestImages: ReadonlyMap<string, RequestImageAttachment>
}

/** Text substituted for tool results that carry no representable content. */
const EMPTY_TOOL_OUTPUT = '(no output)'

/**
 * Resolve the thinking-channel fields for one request.
 * - `off` (or no effort) sends nothing — the gateway model keeps its own default.
 * - `low` / `high` / `max` send `reasoning_effort`, the one thinking-control
 *   field the gateway accepts on the chat-completions dialect.
 * - Session titles run at the smallest effort instead.
 */
export function resolveThinking(
  options: Pick<GenerateOptions, 'reasoningEffort' | 'purpose'>,
  defaults: RequestDefaults,
): ResolvedThinking {
  if (options.purpose === 'session-title') return { reasoning_effort: 'low' }
  const effort = options.reasoningEffort ?? defaults.reasoningEffort
  if (effort === undefined || effort === 'off') return {}
  // The harness's branded wire id shares the plain wire spelling.
  // The harness's branded wire id shares the plain wire spelling.
  return { reasoning_effort: effort as Exclude<ReasoningEffort, 'off'> }
}

/** Join the text blocks of a message. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Base64-encode one prepared request image into an inline image_url part. */
function imagePart(version: RequestImageAttachment): WireUserContentPart {
  return {
    type: 'image_url',
    image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
  }
}

/** Convert text/image blocks (recursing into nested tool results) into wire parts. */
async function contentParts(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions | undefined,
): Promise<WireUserContentPart[]> {
  const parts: WireUserContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = images?.requestImages.get(block.attachment.attachmentId)
        if (version === undefined) {
          throw new LlmError(
            'Tokener image input requires the durable attachment service to prepare request images.',
            'UNSUPPORTED_CONTENT',
          )
        }
        parts.push(imagePart(version))
        break
      }
      case 'tool-result':
        parts.push(...await contentParts(block.content, images))
        break
      default:
        // Reasoning and tool-call blocks are not user-input vocabulary.
        break
    }
  }
  return parts
}

/** Keep text-only user messages on the compact string wire form. */
function userContent(parts: readonly WireUserContentPart[]): string | WireUserContentPart[] {
  const text: string[] = []
  for (const part of parts) {
    if (part.type !== 'text') return [...parts]
    text.push(part.text)
  }
  return text.join('')
}

/** Serialize one assistant turn (text + reasoning passback + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Some upstreams reject null content
    // outright, and since the message sits durably in the session log, a null
    // here bricks every later turn of that session.
    content: text,
    // CoT passback on every reasoning-carrying turn: the OpenAI dialect has no
    // signatures, so replay is plain text, and DeepSeek upstreams expect the
    // passback on tool-call turns.
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` wire messages; a user message contributes its text/images
 * first and its tool results as separate wire messages after. Images inside
 * tool results cannot ride the string-only tool content, so they join a
 * following user message.
 * @param messages - the harness conversation, in order.
 * @param images - prepared request images, when the request carries any.
 * @returns ordered wire messages; order preserved.
 */
export async function serializeMessages(
  messages: readonly Message[],
  images?: ImageSerializationOptions,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  let pendingToolImages: WireUserContentPart[] = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text.length > 0) wire.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message))
      continue
    }

    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
    )
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const parts = await contentParts(regular, images)
    const text = userContent(parts)
    if (text.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      const resultParts = await contentParts(result.content, images)
      const resultImages = resultParts.filter(
        (part): part is Extract<WireUserContentPart, { type: 'image_url' }> => part.type === 'image_url',
      )
      const resultText = resultParts.filter(part => part.type === 'text').map(part => part.text).join('')
      flushToolImages()
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: resultText.length > 0 ? resultText : EMPTY_TOOL_OUTPUT,
      })
      pendingToolImages.push(...resultImages)
    }
  }
  flushToolImages()
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply. `max_tokens` is materialized by the adapter.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults.
 * @param images - prepared request images; required when messages carry image blocks.
 * @returns the ready-to-post `/chat/completions` body.
 */
export async function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  images?: ImageSerializationOptions,
): Promise<WireRequest> {
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const thinking = resolveThinking(options, defaults)
  const messages: WireMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...await serializeMessages(options.messages, images))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...thinking.reasoning_effort === undefined ? {} : { reasoning_effort: thinking.reasoning_effort },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop === undefined ? {} : { stop: options.stop },
  }
}
