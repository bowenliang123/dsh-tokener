/**
 * Serialize harness messages into an Anthropic Messages request for the
 * Tokener gateway. Tool results ride `tool_result` blocks inside user
 * messages; assistant reasoning is deliberately not replayed (gateway models
 * return unsigned thinking blocks, and a multi-vendor gateway cannot verify
 * signatures from a different upstream); images resolve to inline base64.
 *
 * @module dsh-tokener/serialize
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { WireContentBlock, WireMessage, WireRequest, WireThinking, WireTool } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  /** Default thinking effort for calls that name none. */
  reasoningEffort?: ReasoningEffort | undefined
  /** Budget override per non-off effort; missing tiers fall back to {@link DEFAULT_EFFORT_BUDGETS}. */
  effortBudgets?: Partial<Record<Exclude<ReasoningEffort, 'off'>, number>> | undefined
}

/** The selectable thinking-effort vocabulary this adapter exposes. */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

/** Default thinking budget per effort tier (protocol floor is 1,024). */
export const DEFAULT_EFFORT_BUDGETS: Record<Exclude<ReasoningEffort, 'off'>, number> = {
  low: 4_096,
  medium: 12_288,
  high: 24_576,
  max: 49_152,
}

/** Headroom kept for visible output when a budget is clamped under max_tokens. */
const BUDGET_HEADROOM_TOKENS = 1_024

/** Prepared request images, keyed by durable attachment id. Present only when the request carries images. */
export interface ImageSerializationOptions {
  requestImages: ReadonlyMap<string, RequestImageAttachment>
}

/** Minimum thinking budget the Anthropic Messages protocol accepts. */
export const MIN_THINKING_BUDGET_TOKENS = 1024

/** Default thinking budget when the `extended` effort is selected and config supplies none. */
export const DEFAULT_THINKING_BUDGET_TOKENS = 8_192

/** Text substituted for tool results that carry no representable content. */
const EMPTY_TOOL_OUTPUT = '(no output)'

/** Text substituted when an assistant turn has no wire-representable content left. */
const EMPTY_ASSISTANT_TEXT = '(empty response)'

/**
 * Resolve the thinking-channel control for one request.
 *
 * `off` (or no effort) sends no thinking parameter — the gateway model keeps
 * its own default. Every other tier sends `thinking: {type: 'enabled'}` with
 * the tier's budget, clamped under `max_tokens` so the protocol constraint
 * (budget strictly below max_tokens, plus headroom for visible output) holds
 * no matter how large the tier is configured. Tokener's own docs define no
 * effort parameter at all, so tiers are Anthropic-standard expressions of
 * intent: honored natively by Anthropic upstreams, advisory elsewhere.
 */
export function resolveThinking(
  options: Pick<GenerateOptions, 'reasoningEffort' | 'purpose' | 'maxTokens'>,
  defaults: RequestDefaults,
): WireThinking | undefined {
  // Auxiliary short answers never need the thinking channel, even when the
  // model default or the effort selection would enable it.
  if (options.purpose === 'session-title') return undefined
  // The branded wire id and the config union share one spelling.
  const effort = (options.reasoningEffort ?? defaults.reasoningEffort) as ReasoningEffort | undefined
  if (effort === undefined || effort === 'off') return undefined
  const tierBudget = defaults.effortBudgets?.[effort] ?? DEFAULT_EFFORT_BUDGETS[effort]
  if (options.maxTokens === undefined) {
    return { type: 'enabled', budget_tokens: tierBudget }
  }
  const budget = Math.min(tierBudget, options.maxTokens - BUDGET_HEADROOM_TOKENS)
  if (budget < MIN_THINKING_BUDGET_TOKENS) {
    throw new LlmError(
      `thinking effort "${effort}" needs budget_tokens of at least ${MIN_THINKING_BUDGET_TOKENS},`
        + ` but max_tokens ${options.maxTokens} leaves no room for it`,
      'INVALID_REQUEST',
    )
  }
  return { type: 'enabled', budget_tokens: budget }
}

/** Base64-encode one prepared request image into an Anthropic image block. */
function imageBlock(version: RequestImageAttachment): WireContentBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: version.mediaType,
      data: Buffer.from(version.data).toString('base64'),
    },
  }
}

/** Convert text/image blocks (recursing into nested tool results) into wire blocks. */
async function wireBlocks(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions | undefined,
): Promise<WireContentBlock[]> {
  const wire: WireContentBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        // Empty text blocks are rejected by the protocol; drop them.
        if (block.text.length > 0) wire.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = images?.requestImages.get(block.attachment.attachmentId)
        if (version === undefined) {
          throw new LlmError(
            'Tokener image input requires the durable attachment service to prepare request images.',
            'UNSUPPORTED_CONTENT',
          )
        }
        wire.push(imageBlock(version))
        break
      }
      case 'tool-result':
        wire.push(...await wireBlocks(block.content, images))
        break
      default:
        // Reasoning and tool-call blocks are not user-input vocabulary.
        break
    }
  }
  return wire
}

/** Serialize one `tool_result` block, substituting a placeholder for empty output. */
async function wireToolResult(
  block: Extract<ContentBlock, { type: 'tool-result' }>,
  images: ImageSerializationOptions | undefined,
): Promise<WireContentBlock> {
  const content = await wireBlocks(block.content, images)
  return {
    type: 'tool_result',
    tool_use_id: block.toolCallId,
    content: content.length > 0 ? content : [{ type: 'text', text: EMPTY_TOOL_OUTPUT }],
    ...block.isError === true ? { is_error: true } : {},
  }
}

/** Serialize one assistant turn. Reasoning is dropped (see module doc). */
function wireAssistant(blocks: readonly ContentBlock[]): WireContentBlock[] {
  const wire: WireContentBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) wire.push({ type: 'text', text: block.text })
        break
      case 'tool-call': {
        let input: Record<string, unknown>
        try {
          input = JSON.parse(block.arguments) as Record<string, unknown>
        } catch (error) {
          throw new LlmError(
            `tool call "${block.name}" (${block.id}) carries malformed JSON arguments and cannot be replayed`,
            'INVALID_REQUEST',
            { cause: error },
          )
        }
        wire.push({ type: 'tool_use', id: block.id, name: block.name, input })
        break
      }
      default:
        break
    }
  }
  // A thinking-only turn leaves nothing representable; the protocol rejects
  // empty content arrays, so a placeholder keeps the history replayable.
  return wire.length > 0 ? wire : [{ type: 'text', text: EMPTY_ASSISTANT_TEXT }]
}

/**
 * Serialize the conversation into wire messages. User-role tool results come
 * first within their turn, then text/image blocks; system-role messages are
 * hoisted to the top-level system string by the caller.
 * @param messages - the harness conversation, in order.
 * @param images - prepared request images, when the request carries any.
 * @returns ordered wire messages with role user/assistant only.
 */
export async function serializeMessages(
  messages: readonly Message[],
  images?: ImageSerializationOptions,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      wire.push({ role: 'assistant', content: wireAssistant(message.content) })
      continue
    }
    if (message.role === 'system') continue
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
    )
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const content = [
      ...await Promise.all(toolResults.map(result => wireToolResult(result, images))),
      ...await wireBlocks(regular, images),
    ]
    // A harness user turn always carries content; skip only a degenerate
    // hand-built empty one, which the protocol would reject.
    if (content.length > 0) wire.push({ role: 'user', content })
  }
  return wire
}

/** Join the top-level system slot and any system-role messages into one system string. */
function resolveSystem(options: GenerateOptions): string | undefined {
  const parts: string[] = []
  if (options.system !== undefined && options.system.length > 0) parts.push(options.system)
  for (const message of options.messages) {
    if (message.role !== 'system') continue
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text.length > 0) parts.push(text)
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/**
 * Build the full streaming wire request. `max_tokens` is protocol-required
 * and always present (the adapter materializes the configured default);
 * optional fields are omitted rather than sent as null.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults.
 * @param images - prepared request images; required when messages carry image blocks.
 * @returns the ready-to-post `/messages` body.
 */
export async function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  images?: ImageSerializationOptions,
): Promise<WireRequest> {
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
  const thinking = resolveThinking(options, defaults)
  return {
    model: options.model,
    max_tokens: options.maxTokens ?? 0,
    stream: true,
    messages: await serializeMessages(options.messages, images),
    ...resolveSystem(options) === undefined ? {} : { system: resolveSystem(options) },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...thinking === undefined ? {} : { thinking },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
  }
}
