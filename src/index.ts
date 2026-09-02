/**
 * Register a {@link TokenerAdapter} for the `tokener` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-tokener` user-settings section (`ctx.settings`) and resolves the API
 * key through the optional credential seam (`ctx.credentials`), so a changed
 * base URL, catalog, or key reaches the very next request without restarting
 * anything, while an in-flight stream keeps the facts it started with. The
 * one registration-captured fact — the retry policy — re-registers the route
 * in place when it changes.
 *
 * ```yaml
 * - id: llm-tokener
 *   name: dsh-tokener
 *   config:
 *     apiKeyEnv: TOKENER_API_KEY
 *     models:
 *       - id: deepseek-v4-flash
 *         contextWindow: 1000000
 *         maxTokens: 393216
 *       - id: gpt-5.6-sol
 *         contextWindow: 922000
 *         inputModalities: [text, image]
 * ```
 *
 * @module dsh-tokener
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_IMAGE_MAX_BYTES, DEFAULT_IMAGE_MAX_PIXELS, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, fetchModelEntries, PUBLIC_BASE_URL, TokenerAdapter } from './adapter.ts'
import type { TokenerConnectionOptions } from './adapter.ts'
import type { ReasoningEffort } from './types.ts'
import { MODEL_MODALITIES } from './catalog.ts'
import type { TokenerCatalogModel } from './catalog.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_PIXELS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  PUBLIC_BASE_URL,
  TokenerAdapter,
  fetchModelEntries,
} from './adapter.ts'
export type { TokenerAdapterOptions, TokenerConnectionOptions } from './adapter.ts'
export type { ReasoningEffort } from './types.ts'
export type { TokenerCatalogModel } from './catalog.ts'

export const name = 'llm-tokener'
export const inject = ['llm']

const NS = 'llm-tokener'
const DEFAULT_API_KEY_ENV = 'TOKENER_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'tokener'
/** The namespace sub-key the provider profile lives under (pi-ai's `providers` analog). */
const PROFILES_KEY = 'profiles'

/**
 * One provider profile: the `profiles.tokener` subtree of the settings
 * section, addressed by the Models page as `['profiles', 'tokener']` so the
 * route is addable, editable, and deletable like any adapter-declared route.
 * Every field is optional: a missing API key resolves through
 * {@link TokenerProfile.apiKeyEnv} at each request (a request without any key
 * fails with `MISSING_CREDENTIAL`, not at plugin load), and model capacities
 * fall back to the route defaults or live discovery.
 */
export interface TokenerProfile {
  /** Credential reference (environment-variable name) resolved per request; defaults to `TOKENER_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; falls back to the public Tokener API. */
  baseURL?: string
  /** Default thinking effort (default `off`); `low`/`high`/`max` enable the thinking channel via `reasoning_effort`. */
  reasoningEffort?: ReasoningEffort
  /** Default per-request output cap (default 16,384); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 200,000). */
  defaultContextWindow?: number
  /** Advisory catalog merged over live discovery; names, capacities, and image modality declarations. */
  models?: TokenerCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Aspect-preserving pixel budget for one request image (default 1,456,000). */
  imageMaxPixels?: number
  /** Encoded-byte budget for one request image (default 2,000,000). */
  imageMaxBytes?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-tokener` settings-section shape. The profile lives under
 * `profiles.tokener` so the web Models page can address, edit, and delete it
 * as one route subtree.
 */
export interface Config {
  profiles?: { tokener?: TokenerProfile }
}

const catalogModel: z<TokenerCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  // The Models page's model rows carry this field as an explicit empty array
  // (its "unspecified" spelling); empty normalizes to text-only below.
  inputModalities: z.array(z.union(MODEL_MODALITIES)),
})

const profileSchema: z<TokenerProfile> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default([]),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  imageMaxPixels: z.number().step(1).min(1).default(DEFAULT_IMAGE_MAX_PIXELS),
  imageMaxBytes: z.number().step(1).min(1).default(DEFAULT_IMAGE_MAX_BYTES),
  retryPolicy: RetryPolicySchema,
})

export const Config: z<Config> = z.object({
  profiles: z.dict(profileSchema, z.string()).default({}),
})

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(profile: TokenerProfile): TokenerConnectionOptions {
  if (profile.baseURL !== undefined && profile.baseURL.length === 0) {
    throw new Error('llm-tokener: baseURL must be a non-empty string')
  }
  if (profile.maxTokens !== undefined
    && (!Number.isSafeInteger(profile.maxTokens) || profile.maxTokens <= 0)) {
    throw new Error('llm-tokener: maxTokens must be a positive safe integer')
  }
  if (profile.defaultContextWindow !== undefined
    && (!Number.isInteger(profile.defaultContextWindow) || profile.defaultContextWindow <= 0)) {
    throw new Error('llm-tokener: defaultContextWindow must be a positive integer')
  }

  const streamIdleTimeoutMs = profile.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-tokener: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const imageMaxPixels = profile.imageMaxPixels ?? DEFAULT_IMAGE_MAX_PIXELS
  if (!Number.isSafeInteger(imageMaxPixels) || imageMaxPixels <= 0) {
    throw new Error('llm-tokener: imageMaxPixels must be a positive safe integer')
  }
  const imageMaxBytes = profile.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES
  if (!Number.isSafeInteger(imageMaxBytes) || imageMaxBytes <= 0) {
    throw new Error('llm-tokener: imageMaxBytes must be a positive safe integer')
  }
  const seen = new Set<string>()
  for (const model of profile.models ?? []) {
    if (model.id.length === 0) throw new Error('llm-tokener: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-tokener: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-tokener: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-tokener: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    const inputModalities = model.inputModalities
    if (inputModalities !== undefined && inputModalities.length > 0) {
      if (inputModalities.some(modality => !MODEL_MODALITIES.includes(modality))) {
        throw new Error(
          `llm-tokener: catalog model "${model.id}" inputModalities must contain only "text" and "image"`,
        )
      }
      if (new Set(inputModalities).size !== inputModalities.length) {
        throw new Error(`llm-tokener: catalog model "${model.id}" inputModalities must not contain duplicates`)
      }
    }
    if (seen.has(model.id)) throw new Error(`llm-tokener: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
  }
  return {
    apiKeyEnv: credentialRef(profile.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: profile.baseURL ?? PUBLIC_BASE_URL,
    defaults: {
      reasoningEffort: profile.reasoningEffort,
    },
    maxTokens: profile.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: profile.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: (profile.models ?? []).map((model) => {
      // An explicit empty modality array (the Models page's "unspecified")
      // detaches as text-only, the same answer an absent field gets.
      const modalities = model.inputModalities
      const usable = modalities !== undefined && modalities.length > 0
      return {
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.description === undefined ? {} : { description: model.description },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        ...!usable ? {} : { inputModalities: [...modalities] },
      }
    }),
    streamIdleTimeoutMs,
    imageMaxPixels,
    imageMaxBytes,
    retryPolicy: resolveRetryPolicy(profile.retryPolicy, 'llm-tokener: retryPolicy'),
  }
}

/** Register the Tokener adapter for the `tokener` provider route. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: TokenerConnectionOptions | undefined
  const options = (): TokenerConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw.profiles?.tokener ?? {})
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-tokener: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: TokenerConnectionOptions): Promise<string> => {
    // Every credential fact comes from the caller's snapshot, so a rejected
    // settings generation cannot leak its key onto the previous endpoint.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-tokener', ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-tokener', ref)
      }
    }
    throw new LlmError(
      `llm-tokener: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new TokenerAdapter({
    options,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Tokener', settingsNs: NS, settingsPath: [PROFILES_KEY, PROVIDER] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two, and an observer that reacted
    // to it would see this provider disappear and come back.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  // Interrogating an endpoint is a configuration-time action over a draft, so
  // the whole namespace shares one discovery offer: the provider a surface is
  // adding does not exist yet, and a draft supplies its endpoint and one-shot
  // key directly.
  ctx.llm.registerModelDiscovery(NS, async (request, signal) => {
    const connection = options()
    const baseURL = request.baseURL ?? connection.baseURL
    const apiKey = request.apiKey ?? await resolveApiKey(connection)
    const entries = await fetchModelEntries(baseURL, apiKey, signal)
    return entries.map((entry): LlmDiscoveredModel => ({
      id: entry.id,
      ...entry.max_input_tokens === undefined ? {} : { contextWindow: entry.max_input_tokens },
      ...entry.max_output_tokens === undefined ? {} : { maxTokens: entry.max_output_tokens },
    }))
  })

  ctx.inject(['settings'], (settingsCtx) => {
    // The host settings service may predate `installSection` (it arrived in
    // 0.1.2-alpha); `register` + the scope handle are the compatible seam on
    // every release: the composition entry rides as the base layer, a stored
    // `llm-tokener:` section layers over it, and the watch pushes committed
    // changes into the per-request resolution without a restart.
    const scope = settingsCtx.settings.register(NS, Config, {
      base: config,
    })
    current = () => scope.get()
    const disposeWatch = scope.watch(() => {
      ensureRegistrationFacts()
    })
    ctx.effect(() => disposeWatch, 'llm-tokener: settings watch')
    // A stored section may already differ from the composition entry.
    ensureRegistrationFacts()
  })
}
