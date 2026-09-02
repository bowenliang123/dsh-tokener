/**
 * Live-gateway specs against https://api.tokener.dev. They self-skip unless
 * TOKENER_API_KEY is set, so CI without a credential stays green:
 *
 *   TOKENER_API_KEY=sk-... pnpm run test:e2e
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmTokener from '../src/index.ts'
import { PUBLIC_BASE_URL, resolveAdapterOptions } from '../src/index.ts'
import { PROVIDER, assemble } from './assemble.ts'

const key = process.env.TOKENER_API_KEY
const model = process.env.TOKENER_E2E_MODEL ?? 'glm-5.2'

describe.skipIf(key === undefined || key.length === 0)('live tokener gateway', () => {
  it('exposes the documented public endpoint', () => {
    expect(PUBLIC_BASE_URL).toBe('https://api.tokener.dev/v1')
  })

  it('streams a text answer end to end with usage', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmTokener, {})
    expect(ctx.llm.listProviders()).toEqual([{ id: PROVIDER, name: 'Tokener' }])

    const result = await assemble(ctx, {
      model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Reply with exactly TOKENER_OK and nothing else.' }],
        source: { kind: 'user' },
      })],
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'text' && block.text.includes('TOKENER_OK'))).toBe(true)
    expect(result.usage).toBeDefined()
    if (result.usage !== undefined) {
      expect(result.usage.outputTokens).toBeGreaterThan(0)
      expect(result.usage.totalTokens).toBeGreaterThan(0)
    }
  }, 120_000)

  it('round-trips a tool call with structured arguments', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmTokener, {})

    const result = await assemble(ctx, {
      model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'What is the weather in Hangzhou? Use the get_weather tool.' }],
        source: { kind: 'user' },
      })],
      tools: [{
        name: 'get_weather',
        description: 'Get the current weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      }],
    })
    expect(result.finish).toEqual({ kind: 'tool-calls' })
    const call = result.message.content.find(block => block.type === 'tool-call')
    expect(call).toMatchObject({ type: 'tool-call', name: 'get_weather' })
    if (call?.type === 'tool-call') {
      expect(() => JSON.parse(call.arguments) as unknown).not.toThrow()
      expect(JSON.parse(call.arguments)).toMatchObject({ city: expect.any(String) })
    }
  }, 120_000)

  it('lists the live model catalog and resolves metadata', async () => {
    const adapter = new LlmTokener.TokenerAdapter({
      options: () => resolveAdapterOptions({}),
      resolveApiKey: () => Promise.resolve(key as string),
    })
    const models = await adapter.listModels(PROVIDER)
    expect(models.length).toBeGreaterThan(0)
    for (const entry of models) {
      expect(entry.provider).toBe(PROVIDER)
      expect(entry.id.length).toBeGreaterThan(0)
      expect(entry.inputModalities).toEqual(['text'])
    }

    await expect(adapter.resolveModel(PROVIDER, model)).resolves.toMatchObject({
      provider: PROVIDER,
      id: model,
      context: { contextWindow: 200_000 },
      reasoning: { efforts: [{ id: 'off' }, { id: 'extended' }] },
    })
  }, 60_000)
})
