/**
 * Decode an SSE byte stream into named events. Framing — chunk reassembly,
 * UTF-8/CRLF/BOM handling, comment and non-data field skipping, multi-`data:`
 * joining — is `eventsource-parser`'s. Unlike OpenAI-style streams, Anthropic
 * Messages events carry an event name and have no `[DONE]` sentinel: the
 * translator owns termination (`message_stop`) and truncation detection.
 *
 * @module dsh-tokener/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'

/** One SSE dispatch: the event name (empty for an unnamed event) and its data payload. */
export interface SseEvent {
  event: string
  data: string
}

/**
 * Parse an SSE byte stream into named events, in arrival order, until EOF.
 * Comment lines never enter the yielded stream; they reach the optional
 * transport-activity callback so an idle watchdog can be pulsed.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback.
 * @returns each event's name and data payload in arrival order.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<SseEvent> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const chunk of events) {
    // Per the SSE spec the parser never dispatches an event without data, so
    // every yielded chunk carries a payload.
    yield { event: chunk.event ?? '', data: chunk.data }
  }
}
