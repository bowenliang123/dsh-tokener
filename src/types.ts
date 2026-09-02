/**
 * Tokener Anthropic-Messages wire vocabulary. Only the fields this adapter
 * sends or reads are typed; everything else stays untyped pass-through.
 *
 * @module dsh-tokener/types
 */

/** Standard Anthropic error payload, on HTTP errors and mid-stream `error` events. */
export interface WireError {
  type: 'error'
  error: {
    type: string
    message: string
  }
}

/** Token accounting reported by the gateway (Anthropic semantics: disjoint counts). */
export interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** One input content block the adapter may send. */
export type WireContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: WireContentBlock[]; is_error?: boolean }

/** One conversation turn on the wire. */
export interface WireMessage {
  role: 'user' | 'assistant'
  content: WireContentBlock[]
}

/** One tool schema on the wire. */
export interface WireTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** Thinking-channel control: either omitted (provider default) or a budget. */
export type WireThinking = { type: 'enabled'; budget_tokens: number }

/** The full streaming request body this adapter posts to `/messages`. */
export interface WireRequest {
  model: string
  max_tokens: number
  stream: true
  messages: WireMessage[]
  system?: string
  tools?: WireTool[]
  thinking?: WireThinking
  temperature?: number
  stop_sequences?: string[]
}

/** SSE event as parsed off the byte stream: an event name plus its JSON `data` payload. */
export type WireEvent =
  | { type: 'message_start'; message: { id?: string; model?: string; usage?: WireUsage } }
  | { type: 'content_block_start'; index: number; content_block: { type: string; id?: string; name?: string } }
  | {
    type: 'content_block_delta'
    index: number
    delta:
      | { type: 'text_delta'; text: string }
      | { type: 'thinking_delta'; thinking: string }
      | { type: 'signature_delta'; signature: string }
      | { type: 'input_json_delta'; partial_json: string }
  }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string; stop_sequence?: string | null }; usage?: WireUsage }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | WireError

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
