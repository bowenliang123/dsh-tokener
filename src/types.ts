/**
 * Tokener OpenAI-compatible wire vocabulary. Only the fields this adapter
 * sends or reads are typed; everything else stays untyped pass-through.
 * Modeled on the DeepSeek chat-completions wire (`llm-deepseek`).
 *
 * @module dsh-tokener/types
 */



/** Standard OpenAI-style error payload, on HTTP errors. */
export interface WireError {
  error: {
    message?: string
    code?: unknown
    type?: string
  }
}

/**
 * Token accounting reported by the gateway: aggregate prompt tokens (cache
 * hits INCLUDED, like DeepSeek) plus detail breakdowns when disclosed.
 */
export interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** One streamed tool-call fragment, keyed by its `index`. */
export interface WireToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

/** One streamed choice delta. */
export interface WireDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** One streamed choice. */
export interface WireChoice {
  index?: number
  delta?: WireDelta
  finish_reason?: string | null
}

/** One streamed chat-completions chunk. */
export interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage
}

/** One content part of a user message (text or inline base64 image). */
export type WireUserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** One conversation turn on the wire. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | WireUserContentPart[]
  reasoning_content?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/** One tool schema on the wire. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** The selectable thinking-effort vocabulary this adapter exposes (DSH off/low/high/max). */
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max'

/** Thinking-channel control: the one field the gateway accepts on this dialect. */
export interface ResolvedThinking {
  reasoning_effort?: Exclude<ReasoningEffort, 'off'>
}

/** The full streaming request body this adapter posts to `/chat/completions`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
  reasoning_effort?: Exclude<ReasoningEffort, 'off'>
}

/** One entry advertised by `GET /models` (OpenAI-style listing, per Tokener docs). */
export interface WireModelEntry {
  id?: string
  mode?: string
  max_input_tokens?: number
  max_output_tokens?: number
}

/** The `GET /models` response body. */
export interface WireModelList {
  data?: WireModelEntry[]
}
