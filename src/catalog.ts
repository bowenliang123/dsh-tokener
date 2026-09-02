/**
 * Advisory model catalog vocabulary shared by the adapter and the plugin
 * config. Catalog entries merge over live `GET /models` discovery: they can
 * name models, label them, correct capacities, and declare image input.
 *
 * @module dsh-tokener/catalog
 */

import type { ModelModality } from '@deepseek-ai/dsh-llm'

/** One advisory catalog entry for the Tokener provider route. */
export interface TokenerCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted falls back to the route default. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the route's maxTokens. */
  maxTokens?: number
  /** Accepted request modalities; omission is text-only. */
  inputModalities?: ModelModality[]
}

export const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]
