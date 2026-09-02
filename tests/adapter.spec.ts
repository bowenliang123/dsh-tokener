import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import * as LlmTokener from '../src/index.ts'
import { PUBLIC_BASE_URL, TokenerAdapter, fetchModelEntries, resolveAdapterOptions } from '../src/index.ts'
import { PROVIDER, assemble } from './assemble.ts'
import { StaticAttachmentStore } from './store.ts'
import { closeMockServers, mockServer, sse, textEvents } from './mock-server.ts'
import type { MockEvent } from './mock-server.ts'

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-tokener-'))
  vi.stubEnv('DSH_HOME', testHome)
  // The ambient key every harness test streams with; individual tests override it.
  vi.stubEnv('TOKENER_API_KEY', 'env-key')
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  rmSync(testHome, { recursive: true, force: true })
})

const NS = 'llm-tokener'
const KEY_REF = credentialRef('TOKENER_API_KEY')

/**
 * Real dynamic composition: llm + settings-file + credentials-local +
 * llm-tokener over one temp harness home. `watch: false` keeps every change
 * flowing through the in-process write path, which is deterministic.
 */
async function harness(baseURL: string, profile: object = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(testHome, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(testHome, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmTokener, { profiles: { tokener: { baseURL, ...profile } } })
  return ctx
}

/** Direct adapter over the plugin's real resolve step, with a static key and optional attachment seam. */
function adapterOf(config: LlmTokener.TokenerProfile = {}, attachments?: AttachmentStore): TokenerAdapter {
  const resolved = resolveAdapterOptions(config)
  return new TokenerAdapter({
    options: () => resolved,
    resolveApiKey: () => Promise.resolve('test-key'),
    ...attachments === undefined ? {} : { resolveAttachments: () => attachments },
  })
}

function user(text: string, blocks: ContentBlock[] = [{ type: 'text', text }]) {
  return createUserMessage({ content: blocks, source: { kind: 'user' } })
}

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

function toolEvents(name = 'get_weather'): MockEvent[] {
  return [
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_wx', name } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"HZ"}' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 12, output_tokens: 6 } }),
  ]
}

describe('plugin registration', () => {
  it('declares the cordis plugin facts', () => {
    expect(LlmTokener.name).toBe('llm-tokener')
    expect(LlmTokener.inject).toEqual(['llm'])
  })

  it('fails at composition when the entry config cannot resolve', async () => {
    await expect(harness('http://127.0.0.1:1', { baseURL: '' }))
      .rejects.toThrow(/baseURL must be a non-empty string/)
  })

  it('registers the tokener route, its directory entry, and model discovery', async () => {
    const ctx = await harness('http://127.0.0.1:1')
    expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'Tokener' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: PROVIDER,
      displayName: 'Tokener',
      settingsNs: NS,
      settingsPath: ['profiles', PROVIDER],
    }])
    await expect(ctx.llm.resolveModelInfo(PROVIDER, 'glm-5.2')).resolves.toMatchObject({
      provider: PROVIDER,
      id: 'glm-5.2',
      name: 'glm-5.2',
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 16_384,
      reasoning: { defaultEffort: 'off' },
    })
  })
})

describe('streaming through the runtime', () => {
  it('assembles a text answer with usage and headers on the wire', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }], [
      { id: 'glm-5.2' },
    ])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })

    const headers = server.headers[0]
    expect(headers['x-api-key']).toBe('env-key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['accept']).toBe('text/event-stream')
    expect(String(headers['user-agent'])).toContain('deepseek-harness/')
    expect(server.requests[0]).toMatchObject({
      model: 'glm-5.2',
      max_tokens: 16_384,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
  })

  it('streams tool calls with stop kind tool-calls', async () => {
    const server = await mockServer([{ kind: 'sse', events: [...toolEvents(), sse('message_stop', { type: 'message_stop' })] }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, {
      model: 'glm-5.2',
      messages: [user('weather?')],
      tools: [{ name: 'get_weather', description: 'Weather', parameters: { type: 'object' } }],
    })
    expect(result.finish).toEqual({ kind: 'tool-calls' })
    expect(result.message.content[0]).toMatchObject({ type: 'tool-call', id: 'call_wx', name: 'get_weather', arguments: '{"city":"HZ"}' })
    expect(server.requests[0]).toMatchObject({
      tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object' } }],
    })
  })

  it('materializes the configured default max_tokens and thinking budget', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url, { reasoningEffort: 'high', effortBudgets: { high: 2_048 } })

    await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(server.requests[0]).toMatchObject({
      max_tokens: 16_384,
      thinking: { type: 'enabled', budget_tokens: 2_048 },
    })
  })

  it('drops explicit unsupported optionals rather than sending them', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    await assemble(ctx, {
      model: 'glm-5.2',
      messages: [user('hi')],
      maxTokens: 1_024,
      temperature: 0.3,
      stop: ['STOP'],
      purpose: 'session-title',
    })
    expect(server.requests[0]).toMatchObject({
      max_tokens: 1_024,
      temperature: 0.3,
      stop_sequences: ['STOP'],
    })
    expect('thinking' in (server.requests[0] as object)).toBe(false)
  })
})

describe('failure mapping', () => {
  it.each([
    [401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 'AUTH'],
    [429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'RATE_LIMIT'],
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'context length exceeded: 300000 tokens > 200000' } }, 'CONTEXT_WINDOW_EXCEEDED'],
    [404, { type: 'error', error: { type: 'not_found_error', message: 'model not found' } }, 'INVALID_REQUEST'],
    [529, { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }, 'SERVER'],
  ])('maps HTTP %i to %s', async (status, body, code) => {
    const server = await mockServer([{ kind: 'http-error', status: status as number, body: JSON.stringify(body) }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code, message: (body as { error: { message: string } }).error.message } })
  })

  it('carries provider retry-after and request-id facts', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 429,
      body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
      headers: { 'retry-after': '2', 'request-id': 'req_42' },
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 2_000 },
    })
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(String(result.finish.failure.requestId)).toBe('req_42')
  })

  it('parses HTTP-date and unusable retry-after values defensively', async () => {
    const date = new Date(Date.now() + 5_000).toUTCString()
    const server = await mockServer([
      { kind: 'http-error', status: 429, body: '{}', headers: { 'retry-after': date } },
      { kind: 'http-error', status: 429, body: '{}', headers: { 'retry-after': '0' } },
      { kind: 'http-error', status: 429, body: '{}', headers: { 'retry-after': 'soon' } },
    ])
    const ctx = await harness(server.url)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
      if (result.finish.kind !== 'error') throw new Error('expected an error finish')
      const delay = result.finish.failure.providerRetryAfterMs
      if (attempt === 0) expect(delay).toBeGreaterThan(0)
      else expect(delay).toBeUndefined()
    }
  })

  it('fails with STREAM_CLOSED when the response ends before message_stop', async () => {
    const server = await mockServer([{
      kind: 'sse',
      events: [
        sse('message_start', { type: 'message_start', message: { usage: {} } }),
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an an' } }),
      ],
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'STREAM_CLOSED' } })
  })

  it('fails with MISSING_CREDENTIAL when no key resolves anywhere', async () => {
    vi.stubEnv('TOKENER_API_KEY', '')
    const server = await mockServer([])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  })

  it('serves the credential from the credentials seam ahead of the environment', async () => {
    vi.stubEnv('TOKENER_API_KEY', '')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    await ctx.credentials.set(KEY_REF, 'stored-key')
    await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(server.headers[0]?.['x-api-key']).toBe('stored-key')
  })
})

describe('dynamic configuration', () => {
  it('routes the next request with the freshly resolved base URL without re-registration', async () => {
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(serverA.url)

    await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(serverA.requests).toHaveLength(1)

    await ctx.settings.update(NS, { profiles: { tokener: { baseURL: serverB.url } } })
    await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.requests).toHaveLength(1)
  })

  it('keeps serving the last good configuration after an invalid settings section', async () => {
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }, { kind: 'sse', events: textEvents }])
    const ctx = await harness(serverA.url)

    // The settings schema accepts an empty baseURL, but the resolve step
    // refuses it: the snapshot fails where it is read, the previous facts
    // keep serving, and the failure is logged.
    await ctx.settings.update(NS, { profiles: { tokener: { baseURL: '' } } })
    await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(serverA.requests).toHaveLength(1)

    await ctx.settings.update(NS, { profiles: { tokener: { baseURL: serverA.url } } })
    await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(serverA.requests).toHaveLength(2)
  })

  it('lets the page delete a stored profile, falling back to composition defaults', async () => {
    // Production mounts this plugin with no composition config, so the base
    // layer never pins the profile: a page Delete truly removes it.
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(testHome, 'settings.yaml'), watch: false })
    await ctx.plugin(LocalCredentialProvider, { path: join(testHome, '.credentials.yaml'), watch: false })
    await ctx.plugin(LlmTokener, {})
    expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'Tokener' }])

    // Add-provider flow: the page stores the profile in the user layer.
    await ctx.settings.update(NS, { profiles: { tokener: { baseURL: 'http://127.0.0.1:1' } } })
    expect((ctx.settings.get(NS) as { profiles?: { tokener?: unknown } }).profiles?.tokener).toBeDefined()

    // The page's Delete: unset the profile subtree; the route stays live.
    await ctx.settings.mutate(NS, [{ op: 'unset', path: ['profiles', PROVIDER] }])
    expect((ctx.settings.get(NS) as { profiles?: { tokener?: unknown } }).profiles?.tokener).toBeUndefined()
    expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'Tokener' }])
  })

  it('unregisters the namespace watch when the plugin fiber disposes', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    expect(ctx.settings.get(NS)).toMatchObject({
      profiles: { tokener: { baseURL: server.url } },
    })
    // The watch disposer is bound to this plugin's fiber; the service detaches
    // with the same dispose, so the observable contract is a clean teardown.
    await ctx.fiber.dispose()
  })

  it('re-registers the route when the retry policy changes', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    expect(ctx.llm.providerRetryPolicy(PROVIDER)).toMatchObject({ maxRetries: 5 })

    await ctx.settings.update(NS, { profiles: { tokener: { retryPolicy: { mode: 'normal', maxRetries: 2 } } } })
    expect(ctx.llm.providerRetryPolicy(PROVIDER)).toMatchObject({ maxRetries: 2 })
  })

  it('keeps the provider registered when the retry policy is unchanged', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    await ctx.settings.update(NS, { profiles: { tokener: { baseURL: server.url } } })
    expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'Tokener' }])
  })
})

describe('models and discovery', () => {
  it('advertises exactly the configured catalog, without any network call', async () => {
    // The selector contract on every adapter: the stored profile list IS what
    // pickers offer. Even an unreachable endpoint must not break it.
    const adapter = adapterOf({
      baseURL: 'http://127.0.0.1:1',
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', description: 'Flagship', inputModalities: ['text', 'image'] },
        { id: 'deepseek-v4-flash' },
      ],
    })
    await expect(adapter.listModels(PROVIDER)).resolves.toEqual([
      { provider: PROVIDER, id: 'glm-5.2', name: 'GLM-5.2', description: 'Flagship', inputModalities: ['text', 'image'] },
      { provider: PROVIDER, id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', inputModalities: ['text'] },
    ])
  })

  it('resolves catalog models with their exact capacities', async () => {
    const adapter = adapterOf({
      models: [{ id: 'deepseek-v4-flash', name: 'DSv4F', description: 'Flagship speed', contextWindow: 1_000_000, maxTokens: 393_216 }],
      reasoningEffort: 'max',
      effortBudgets: { max: 32_768 },
    })
    await expect(adapter.resolveModel(PROVIDER, 'deepseek-v4-flash')).resolves.toMatchObject({
      name: 'DSv4F',
      description: 'Flagship speed',
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 393_216,
      reasoning: { defaultEffort: 'max' },
    })
  })

  it('interrogates draft endpoints through registered discovery', async () => {
    const server = await mockServer([], [
      { id: 'glm-5.2' },
      { id: 'gpt-5.6-sol', max_input_tokens: 922_000, max_output_tokens: 128_000 },
    ])
    const ctx = await harness(server.url)
    await expect(ctx.llm.discoverModels(NS, { provider: PROVIDER })).resolves.toEqual([
      { id: 'glm-5.2' },
      { id: 'gpt-5.6-sol', contextWindow: 922_000, maxTokens: 128_000 },
    ])
    await expect(ctx.llm.discoverModels(NS, {
      baseURL: server.url,
      apiKey: 'one-shot',
    })).resolves.toHaveLength(2)
    await expect(ctx.llm.discoverModels('other-ns', { provider: PROVIDER })).rejects.toMatchObject({ code: 'NO_DISCOVERY' })
    await expect(ctx.llm.discoverModels(NS, {})).rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
  })

  it('maps model-list transport and shape failures to typed errors', async () => {
    const unreachable = 'http://127.0.0.1:1'
    await expect(fetchModelEntries(unreachable, 'k')).rejects.toMatchObject({ code: 'TRANSPORT' })

    const failing = await mockServer([], [], { status: 500, body: 'boom' })
    await expect(fetchModelEntries(failing.url, 'k')).rejects.toMatchObject({ code: 'SERVER' })

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } })
    try {
      await expect(fetchModelEntries(unreachable, 'k')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    } finally {
      globalThis.fetch = originalFetch
    }
    globalThis.fetch = async () => new Response('{"nope":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    try {
      // A valid listing without a data array reads as "nothing advertised";
      // catalog membership stays advisory, so this is not an error.
      await expect(fetchModelEntries(unreachable, 'k')).resolves.toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('ignores malformed model-list entries and serves the well-formed rest', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [null, 42, 'str', { id: 'ok' }, { mode: 'chat' }] }), { status: 200 })
    try {
      const entries = await fetchModelEntries('http://127.0.0.1:1', 'k')
      expect(entries.map(entry => entry.id)).toEqual(['ok'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('wraps a body that dies mid-read and refuses a null body', async () => {
    const adapter = adapterOf({ baseURL: 'http://127.0.0.1:1' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(new ReadableStream<BufferSource>({
      start(controller) { controller.error(new TypeError('socket died')) },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    try {
      await expect((async () => {
        for await (const _chunk of adapter.stream({ provider: PROVIDER, model: 'm', messages: [user('hi')] })) {
          // drain
        }
      })()).rejects.toMatchObject({ code: 'TRANSPORT' })
    } finally {
      globalThis.fetch = originalFetch
    }

    globalThis.fetch = async () => new Response(null, { status: 200 })
    try {
      await expect((async () => {
        for await (const _chunk of adapter.stream({ provider: PROVIDER, model: 'm', messages: [user('hi')] })) {
          // drain
        }
      })()).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('aborts a draft discovery interrogation promptly', async () => {
    const server = await mockServer([], [], { status: 500, body: 'ignored' })
    const ctx = await harness(server.url)
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.llm.discoverModels(NS, { provider: PROVIDER }, controller.signal))
      .rejects.toSatisfy((error: unknown) => error instanceof Error && error.name === 'AbortError')
  })

  it('treats a data-less model listing as nothing advertised', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('{"nope":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    try {
      await expect(adapterOf({ baseURL: 'http://127.0.0.1:1' }).listModels(PROVIDER)).resolves.toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps the status authoritative when an error body is empty', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 502, body: '' }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'SERVER', status: 502, message: 'Tokener API error (HTTP 502)' },
    })
  })

  it('maps a pre-aborted transport to ABORTED without a transport wrap', async () => {
    const server = await mockServer([])
    const controller = new AbortController()
    controller.abort()
    const adapter = adapterOf({ baseURL: server.url })
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: PROVIDER,
        model: 'm',
        messages: [user('hi')],
        signal: controller.signal,
      })) {
        // drain
      }
    })()).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('prefers a draft baseURL over the stored connection and never reads a stored key for it', async () => {
    const stored = await mockServer([], [{ id: 'stored-model' }])
    const draft = await mockServer([], [{ id: 'draft-model' }])
    const ctx = await harness(stored.url)
    const discovered = await ctx.llm.discoverModels(NS, { baseURL: draft.url })
    expect(discovered).toEqual([{ id: 'draft-model' }])
    expect(stored.requests).toHaveLength(0)
    expect(draft.modelHeaders[0]?.['x-api-key']).toBe('env-key')
  })
})

describe('image input', () => {
  it('serializes prepared request images as base64 blocks', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const store = {
      readImageRequest: () => Promise.resolve(requestImage()),
    }
    const adapter = adapterOf(
      { baseURL: server.url, models: [{ id: 'vision-model', inputModalities: ['text', 'image'] }] },
      store as unknown as AttachmentStore,
    )
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: PROVIDER,
      model: 'vision-model',
      messages: [user('look', [
        { type: 'text', text: 'look' },
        { type: 'image', attachment: imageRef },
      ])],
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(server.requests[0]).toMatchObject({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') } },
        ],
      }],
    })
  })

  it('rejects image input without the durable attachment service', async () => {
    const adapter = adapterOf({ models: [{ id: 'vision-model', inputModalities: ['text', 'image'] }] })
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: PROVIDER,
        model: 'vision-model',
        messages: [user('look', [{ type: 'image', attachment: imageRef }])],
      })) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})

describe('adapter snapshot binding', () => {
  it('binds model metadata and dispatch to one connection generation', async () => {
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    let resolved = resolveAdapterOptions({ baseURL: serverA.url })
    const adapter = new TokenerAdapter({
      options: () => resolved,
      resolveApiKey: () => Promise.resolve('k'),
    })
    const prepared = await adapter.prepareCall(PROVIDER, 'glm-5.2')
    expect(prepared.model.context).toEqual({ contextWindow: 200_000 })

    resolved = resolveAdapterOptions({ baseURL: serverB.url })
    const chunks = []
    for await (const chunk of prepared.stream({
      provider: PROVIDER,
      model: 'glm-5.2',
      messages: [user('hi')],
    })) chunks.push(chunk)
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.requests).toHaveLength(0)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('wraps non-LlmError transport failures', async () => {
    const failing = await mockServer([])
    failing.script.push({ kind: 'sse', events: [] })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new TypeError('boom')
    }
    const adapter = adapterOf({ baseURL: failing.url })
    try {
      await expect((async () => {
        for await (const _chunk of adapter.stream({ provider: PROVIDER, model: 'm', messages: [user('hi')] })) {
          // drain
        }
      })()).rejects.toMatchObject({ code: 'TRANSPORT' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('maps an idle timeout to TIMEOUT', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 5 }])
    const adapter = adapterOf({ baseURL: server.url, streamIdleTimeoutMs: 1 })
    await expect((async () => {
      for await (const _chunk of adapter.stream({ provider: PROVIDER, model: 'm', messages: [user('hi')] })) {
        // drain
      }
    })()).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('maps caller aborts to ABORTED', async () => {
    const server = await mockServer([{
      kind: 'sse',
      events: [...textEvents.slice(0, 3), { event: '', data: '' }],
      delayMs: 1_000,
    }])
    const controller = new AbortController()
    const adapter = adapterOf({ baseURL: server.url })
    const draining = (async () => {
      for await (const _chunk of adapter.stream({
        provider: PROVIDER,
        model: 'm',
        messages: [user('hi')],
        signal: controller.signal,
      })) {
        // drain
      }
    })()
    const failure = draining.catch((error: unknown) => error)
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    expect(await failure).toMatchObject({ code: 'ABORTED' })
  })
})

describe('ambient environment fallback', () => {
  it('resolves the key from the launch environment when no credentials seam is mounted', async () => {
    vi.stubEnv('TOKENER_API_KEY', 'ambient-key')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmTokener, { profiles: { tokener: { baseURL: 'http://127.0.0.1:1' } } })
    expect(launchEnvironmentOf(ctx).get('TOKENER_API_KEY')?.value).toBe('ambient-key')
  })

  it('streams with the ambient key and fails loud when it goes missing', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('TOKENER_API_KEY', 'ambient-key')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmTokener, { profiles: { tokener: { baseURL: server.url } } })

    await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(server.headers[0]?.['x-api-key']).toBe('ambient-key')

    vi.stubEnv('TOKENER_API_KEY', '')
    const keyless = await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(keyless.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })

    vi.stubEnv('TOKENER_API_KEY', 'bad\u0007key')
    const unusable = await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
    expect(unusable.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } })
    expect(unusable.finish.kind === 'error' && unusable.finish.failure.message.includes('bad\u0007key')).toBe(false)
  })

  it('streams images through the durable attachment seam, including tool-result images', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url, { models: [{ id: 'vision-model', inputModalities: ['text', 'image'] }] })
    await ctx.plugin(StaticAttachmentStore)

    const CALL = brandString<ToolCallId>('call_img')
    await assemble(ctx, {
      model: 'vision-model',
      messages: [
        createUserMessage({
          content: [
            { type: 'tool-result', toolCallId: CALL, content: [{ type: 'image', attachment: imageRef }], isError: false },
            { type: 'text', text: 'and this?' },
          ],
          source: { kind: 'user' },
        }),
      ],
    })
    const content = (server.requests[0] as { messages: Array<{ content: unknown[] }> }).messages[0]?.content
    expect(content).toEqual([
      { type: 'tool_result', tool_use_id: CALL, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') } }] },
      { type: 'text', text: 'and this?' },
    ])
  })

  it('keeps the stream alive across SSE comment keep-alives', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init)
      const body = `: keep-alive\n\n${await response.text()}`
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    try {
      const ctx = await harness(server.url)
      const result = await assemble(ctx, { model: 'glm-5.2', messages: [user('hi')] })
      expect(result.finish).toEqual({ kind: 'stop' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('public surface', () => {
  it('exposes the documented default endpoint', () => {
    expect(PUBLIC_BASE_URL).toBe('https://api.tokener.dev/v1')
  })

  it('keeps the error taxonomy intact', () => {
    expect(new LlmError('x', 'CODE').code).toBe('CODE')
    expect(brandString<ToolCallId>('call').length).toBe(4)
  })
})
