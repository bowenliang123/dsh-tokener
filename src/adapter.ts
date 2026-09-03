/**
 * `TokenerAdapter`: fetch + SSE against Tokener's OpenAI-compatible
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 * Structurally a sibling of the harness's own DeepSeek adapter — same wire
 * dialect, same layering — pointed at the Tokener gateway.
 *
 * @module dsh-tokener/adapter
 */

import { attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, CONTEXT_WINDOW_EXCEEDED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  ModelModality,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import { serializeRequest } from './serialize.ts'
import type { ImageSerializationOptions, RequestDefaults } from './serialize.ts'
import type { TokenerCatalogModel } from './catalog.ts'
import type { WireError, WireModelEntry, WireRequest } from './types.ts'

/** Default per-request output cap; explicit request values win. */
export const DEFAULT_MAX_TOKENS = 16_384
/** Default combined request/response context capacity (the gateway's own unrecognized-model default). */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Default maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default aspect-preserving pixel budget for one request image. */
export const DEFAULT_IMAGE_MAX_PIXELS = 1_456_000
/** Default encoded-byte budget for one request image (the protocol accepts well above this). */
export const DEFAULT_IMAGE_MAX_BYTES = 2_000_000
/** Public Tokener API base (models traffic only; the console never proxies LLM calls). */
export const PUBLIC_BASE_URL = 'https://api.tokener.dev/v1'

/** How long the gateway's live listing is reused across picker opens. */
export const LIVE_CATALOG_TTL_MS = 60_000

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const LOW_REASONING_EFFORT = ReasoningEffortId('low')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
const MAX_REASONING_EFFORT = ReasoningEffortId('max')
const TEXT_MODALITIES: readonly ModelModality[] = ['text']

/**
 * Selectable reasoning efforts — the same vocabulary and copy the harness's
 * own DeepSeek adapter declares, mapped on the wire to `reasoning_effort`.
 */
function effortInfoFor(defaults: RequestDefaults): LlmModelReasoningInfo {
  return {
    efforts: [
      {
        id: OFF_REASONING_EFFORT,
        name: 'Off',
        description: 'Use for simple tasks that do not need reasoning.',
      },
      {
        id: LOW_REASONING_EFFORT,
        name: 'Low',
        description: 'Prefer for routine or latency-sensitive tasks.',
      },
      {
        id: HIGH_REASONING_EFFORT,
        name: 'High',
        description: 'The default balance for most tasks.',
      },
      {
        id: MAX_REASONING_EFFORT,
        name: 'Max',
        description: 'Reserve for the hardest quality-first tasks.',
      },
    ],
    defaultEffort: defaults.reasoningEffort === 'low'
      ? LOW_REASONING_EFFORT
      : defaults.reasoningEffort === 'high'
        ? HIGH_REASONING_EFFORT
        : defaults.reasoningEffort === 'max'
          ? MAX_REASONING_EFFORT
          : OFF_REASONING_EFFORT,
  }
}

/** Dependencies the adapter resolves per operation; the plugin owns the policy. */
export interface TokenerAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => TokenerConnectionOptions
  /**
   * Resolve the API key for the connection facts of one request. The snapshot
   * is passed in — never re-read — so the key can only ever come from the
   * same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: TokenerConnectionOptions) => Promise<string>
  /** Resolve the current durable attachment service; absence rejects image input. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/**
 * Validated connection facts for one operation. The plugin's resolve step is
 * the one explicit producer of this shape; the adapter trusts it and re-reads
 * it per operation, which is what makes a configuration change reach the next
 * request without re-registration.
 */
export interface TokenerConnectionOptions {
  /** Endpoint base; `/chat/completions` and `/models` are appended. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call (thinking effort). */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory model catalog merged over live discovery; requests remain unrestricted. */
  models: readonly TokenerCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Aspect-preserving pixel budget for one request image. */
  imageMaxPixels: number
  /** Encoded-byte budget for one request image. */
  imageMaxBytes: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Collect ordered, deduplicated image references across a whole request. */
function collectImageRefs(
  messages: readonly Message[],
): ImageAttachmentRef[] {
  const refs = new Map<string, ImageAttachmentRef>()
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  for (const message of messages) walk(message.content)
  return [...refs.values()]
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/** Headers every Tokener request sends: bearer auth plus harness attribution. */
function requestHeaders(apiKey: string): Record<string, string> {
  return {
    'authorization': `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    ...attributionHeaders(),
  }
}

/**
 * List the model ids one endpoint advertises, mapped from the OpenAI-style
 * listing the gateway documents.
 * @param baseURL - endpoint base; `/models` is appended.
 * @param apiKey - credential for this interrogation.
 * @param signal - caller cancellation.
 * @returns advertised entries (id plus disclosed capacities) in endpoint order.
 */
export async function fetchModelEntries(
  baseURL: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<readonly (WireModelEntry & { id: string })[]> {
  let response: Response
  try {
    response = await fetch(`${baseURL}/models`, {
      method: 'GET',
      headers: requestHeaders(apiKey),
      signal,
    })
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    throw new LlmError(`Tokener model list request to ${baseURL} failed`, 'TRANSPORT', { cause: error })
  }
  if (!response.ok) {
    throw await responseError(response, 'Tokener model list request')
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (error: unknown) {
    throw new LlmError('Tokener model list returned malformed JSON', 'MALFORMED_RESPONSE', { cause: error })
  }
  const entries = Array.isArray((parsed as { data?: unknown }).data)
    ? (parsed as { data: unknown[] }).data
    : []
  const listed: (WireModelEntry & { id: string })[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as WireModelEntry
    if (typeof candidate.id === 'string' && candidate.id.length > 0) listed.push({ ...candidate, id: candidate.id })
  }
  return listed
}

/** Convert one non-2xx response into a typed LlmError with provider facts. */
async function responseError(response: Response, label: string): Promise<LlmError> {
  let message = `${label} error (HTTP ${response.status})`
  let wireError: WireError | undefined
  const rawResponse = await response.text()
  try {
    const parsed = JSON.parse(rawResponse) as { error?: { type?: unknown; message?: unknown } } | null
    if (typeof parsed?.error?.message === 'string' && parsed.error.message.length > 0) {
      message = parsed.error.message
      wireError = parsed as WireError
    }
  } catch {
    // The HTTP status remains authoritative when a gateway returns malformed JSON.
  }
  const delay = providerRetryAfterMs(response.headers.get('retry-after'))
  const id = requestId(response.headers)
  return new LlmError(message, httpErrorCode(response.status, wireError?.error), {
    cause: new Error(rawResponse.length > 0 ? rawResponse : `Tokener HTTP ${response.status}`),
    status: response.status,
    ...delay === undefined ? {} : { providerRetryAfterMs: delay },
    ...id === undefined ? {} : { requestId: id },
  })
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: { type?: string; message?: string }): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status === 404) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The Tokener gateway adapter. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class TokenerAdapter extends LlmAdapter {
  /** Short-lived cache of the gateway's live listing, keyed by endpoint. */
  private liveCatalog?: {
    readonly baseURL: string
    readonly at: number
    readonly entries: readonly (WireModelEntry & { id: string })[]
  }

  constructor(private readonly config: TokenerAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Tokener' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.config.options()
    // A curated profile narrows the picker to exactly its rows (the Models
    // page's contract). With no curated rows — the fresh-install default —
    // the picker advertises every model the key can reach on the gateway,
    // like a pi-ai route without a models list.
    if (connection.models.length > 0) {
      return Promise.resolve(connection.models.map(model => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: model.inputModalities ?? TEXT_MODALITIES,
      })))
    }
    const apiKey = await this.config.resolveApiKey(connection)
    const entries = await this.liveCatalogOf(connection, apiKey)
    return entries.map(entry => ({
      provider,
      id: entry.id,
      name: entry.id,
      inputModalities: TEXT_MODALITIES,
    }))
  }

  /** The gateway's live listing, memoized briefly so picker opens stay cheap. */
  private async liveCatalogOf(
    connection: TokenerConnectionOptions,
    apiKey: string,
  ): Promise<readonly (WireModelEntry & { id: string })[]> {
    const cached = this.liveCatalog
    if (cached !== undefined
      && cached.baseURL === connection.baseURL
      && Date.now() - cached.at < LIVE_CATALOG_TTL_MS) {
      return cached.entries
    }
    const entries = await fetchModelEntries(connection.baseURL, apiKey)
    this.liveCatalog = { baseURL: connection.baseURL, at: Date.now(), entries }
    return entries
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.modelInfoFor(this.config.options(), provider, model))
  }

  private modelInfoFor(
    connection: TokenerConnectionOptions,
    provider: string,
    model: string,
  ): LlmResolvedModelInfo {
    const configured = connection.models.find(entry => entry.id === model)
    return {
      // An uncatalogued model is safely treated as text-only. Declaring an
      // unverified image capability would let the host persist input that the
      // endpoint may reject on every later turn.
      provider,
      id: model,
      name: configured?.name ?? model,
      ...configured?.description === undefined ? {} : { description: configured.description },
      inputModalities: configured?.inputModalities ?? TEXT_MODALITIES,
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: {
        // The registry validates caller efforts against this list and
        // materializes the default when a caller names none, so the
        // configured effort reaches the wire on every ordinary call.
        ...effortInfoFor(connection.defaults),
      },
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    // One connection snapshot binds both the model metadata and the eventual
    // dispatch, so a settings change between preparation and streaming can
    // never pair one generation's capabilities with another's endpoint.
    const connection = this.config.options()
    return Promise.resolve({
      model: this.modelInfoFor(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options())
  }

  private async * streamWithConnection(
    options: GenerateOptions,
    connection: TokenerConnectionOptions,
  ): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    const apiKey = await this.config.resolveApiKey(connection)
    const images = await this.prepareRequestImages(options, connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      images,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Tokener stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Tokener request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Tokener API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Tokener stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  /** Resolve every request image to its base64 request version, or `undefined` for text-only requests. */
  private async prepareRequestImages(
    options: GenerateOptions,
    connection: TokenerConnectionOptions,
  ): Promise<ImageSerializationOptions | undefined> {
    if (!options.messages.some(message => contentHasImage(message.content))) return undefined
    const attachments = this.config.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError(
        'Tokener image conversion requires the durable attachment service.',
        'UNSUPPORTED_CONTENT',
      )
    }
    const refs = collectImageRefs(options.messages)
    const versions = await Promise.all(refs.map(ref => attachments.readImageRequest(ref, {
      maxPixels: connection.imageMaxPixels,
      maxBytes: connection.imageMaxBytes,
    })))
    return {
      requestImages: new Map(refs.map((ref, index) => [ref.attachmentId, versions[index]])),
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: TokenerConnectionOptions,
    apiKey: string,
    images: ImageSerializationOptions | undefined,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const body: WireRequest = await serializeRequest(options, connection.defaults, images)

    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)
    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers: requestHeaders(apiKey),
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `Tokener API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      throw await responseError(response, 'Tokener API')
    }
    if (!response.body) {
      throw new LlmError('Tokener API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onActivity))
  }
}
