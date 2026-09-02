import { describe, expect, it } from 'vitest'
import { Config, PUBLIC_BASE_URL, resolveAdapterOptions } from '../src/index.ts'
import { DEFAULT_MAX_TOKENS } from '../src/adapter.ts'

describe('Config schema', () => {
  it('resolves an absent config to defaults, leaving unset optionals undefined', () => {
    const parsed = Config(undefined) as Record<string, unknown>
    expect(parsed.apiKeyEnv).toBe('TOKENER_API_KEY')
    expect(parsed.baseURL).toBeUndefined()
    expect(parsed.maxTokens).toBe(DEFAULT_MAX_TOKENS)
    expect(parsed.models).toEqual([])
  })
})

describe('resolveAdapterOptions', () => {
  it('applies every default', () => {
    const resolved = resolveAdapterOptions({})
    expect(resolved.baseURL).toBe(PUBLIC_BASE_URL)
    expect(resolved.apiKeyEnv).toBe('TOKENER_API_KEY')
    expect(resolved.maxTokens).toBe(DEFAULT_MAX_TOKENS)
    expect(resolved.defaultContextWindow).toBe(200_000)
    expect(resolved.streamIdleTimeoutMs).toBe(300_000)
    expect(resolved.imageMaxPixels).toBe(1_456_000)
    expect(resolved.imageMaxBytes).toBe(2_000_000)
    expect(resolved.defaults).toEqual({})
    expect(resolved.models).toEqual([])
    expect(resolved.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 5 })
  })

  it('detaches catalog entries', () => {
    const resolved = resolveAdapterOptions({
      models: [{ id: 'm', name: 'M', contextWindow: 10, maxTokens: 5, inputModalities: ['text', 'image'] }],
    })
    expect(resolved.models).toEqual([{
      id: 'm',
      name: 'M',
      contextWindow: 10,
      maxTokens: 5,
      inputModalities: ['text', 'image'],
    }])
  })

  it.each([
    [{ baseURL: '' }, 'baseURL'],
    [{ maxTokens: 0 }, 'maxTokens'],
    [{ maxTokens: 1.5 }, 'maxTokens'],
    [{ defaultContextWindow: 0 }, 'defaultContextWindow'],
    [{ thinkingBudgetTokens: 1_023 }, 'thinkingBudgetTokens'],
    [{ maxTokens: 2_000, thinkingBudgetTokens: 2_048 }, 'thinkingBudgetTokens'],
    [{ streamIdleTimeoutMs: 0 }, 'streamIdleTimeoutMs'],
    [{ streamIdleTimeoutMs: Number.POSITIVE_INFINITY }, 'streamIdleTimeoutMs'],
    [{ imageMaxPixels: 0 }, 'imageMaxPixels'],
    [{ imageMaxBytes: 0 }, 'imageMaxBytes'],
    [{ models: [{ id: '' }] }, 'catalog model ids'],
    [{ models: [{ id: 'm', name: '' }] }, 'empty name'],
    [{ models: [{ id: 'm', contextWindow: 0 }] }, 'contextWindow'],
    [{ models: [{ id: 'm', maxTokens: -1 }] }, 'maxTokens'],
    [{ models: [{ id: 'm', inputModalities: [] }] }, 'inputModalities must not be empty'],
    [{ models: [{ id: 'm', inputModalities: ['video' as never] }] }, 'only "text" and "image"'],
    [{ models: [{ id: 'm', inputModalities: ['text', 'text'] }] }, 'duplicates'],
    [{ models: [{ id: 'm' }, { id: 'm' }] }, 'duplicate catalog model'],
  ])('rejects %o', (config: Record<string, unknown>, fragment: string) => {
    expect(() => resolveAdapterOptions(config as never)).toThrow(new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})
