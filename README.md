# dsh-tokener

[![CI](https://github.com/bowenliang123/dsh-tokener/actions/workflows/pr-checks.yml/badge.svg)](https://github.com/bowenliang123/dsh-tokener/actions/workflows/pr-checks.yml)
[![npm](https://img.shields.io/npm/v/dsh-tokener)](https://www.npmjs.com/package/dsh-tokener)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that registers [Tokener.ai](https://www.tokener.dev) as an LLM provider — the pre-paid model gateway speaking the **OpenAI-compatible chat-completions protocol** (`POST /v1/chat/completions`) over one uniform endpoint for models such as `deepseek-v4-flash`, `deepseek-v4-pro`, `gpt-5.6-sol`, `glm-5.2`, and `kimi-k3`.

The adapter follows the official `dsh-llm` adapter contract (`LlmAdapter`), so DSH core capabilities all apply to Tokener traffic: streaming chunk assembly, the token meter, the `llm/stream` waterfall, retry policies, hot-reloadable settings, the credential seam, and the web Models page.

## Install

```sh
dsh plugin add dsh-tokener
```

or add the row to your composition by hand:

```yaml
# cordis.patch.yml
- insert:
    - id: llm-tokener
      name: dsh-tokener
      config:
        profiles:
          tokener:
            apiKeyEnv: TOKENER_API_KEY
```

Then export your Tokener key (or store it through the credentials seam — the web Models page writes it there):

```sh
export TOKENER_API_KEY=sk-...
```

Point the default model at the new route and start:

```yaml
- id: agent-default-model
  config:
    provider: tokener
    model: deepseek-v4-flash
```

## What you get

- **OpenAI-compatible streaming** — `choices[].delta` chunks (`content`, `reasoning_content`, `tool_calls`) map onto the harness `StreamChunk` protocol: text deltas, reasoning deltas, tool-call argument deltas, usage, and finish reasons (`stop` → `stop`, `tool_calls` → `tool-calls`, `length` → `max-tokens`). Truncation (EOF before `[DONE]`) fails loud with `STREAM_CLOSED`.
- **Reasoning (thinking) channel** — the same four effort levels the harness's own DeepSeek adapter declares (`off` / `low` / `high` / `max`, default `off`). Non-off efforts send `reasoning_effort` — the one thinking-control field the gateway accepts on this dialect (the DeepSeek-dialect `thinking` field is rejected); `off` sends nothing and leaves the model's own default untouched. Tokener's docs define no effort parameter, so levels are advisory on non-DeepSeek upstreams. Gateway thinking blocks that stream empty never materialize as empty harness blocks.
- **Tool use** — harness `ToolSchema` maps to OpenAI `tools` with JSON-schema `parameters`; tool results replay as `role: 'tool'` messages (with placeholders for empty output; images inside tool results join a following user message); arguments stay raw JSON end to end.
- **Images** — with a vision-capable catalog entry (`inputModalities: [text, image]`), durable attachments resolve to inline base64 `image_url` parts through the attachment service. Text-only models keep the harness's own text projection.
- **Live model discovery** — with no curated rows, the picker advertises the gateway's live `GET /models` listing (memoized for 60s); a curated `models` catalog narrows the picker to exactly its rows, naming models, correcting capacities, and declaring image input. The web Models page can also interrogate draft endpoints through registered model discovery.
- **Per-request connection facts** — `baseURL`, catalog, and credential resolve fresh on every request (in-flight streams keep their snapshot), so a settings change reaches the next call without a restart. The one registration-captured fact — the retry policy — re-registers the route atomically when it changes.
- **Attribution and errors** — every request carries the harness `User-Agent` header; HTTP statuses and OpenAI-style error payloads map to stable harness codes (`AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, …) with `retry-after` and `request-id` preserved as retry facts.

## Configuration

| Field | Default | Description |
|---|---|---|
| `apiKeyEnv` | `TOKENER_API_KEY` | Credential reference (environment variable name), resolved per request. |
| `baseURL` | `https://api.tokener.dev/v1` | Endpoint base; `/chat/completions` and `/models` are appended. |
| `reasoningEffort` | `off` | Default effort: `off` sends nothing; `low`/`high`/`max` send `reasoning_effort` with the thinking channel enabled. |
| `maxTokens` | `16384` | Default per-request output cap; explicit request values win. |
| `defaultContextWindow` | `200000` | Context capacity for models without an exact value. |
| `models` | `[]` | Curated catalog: narrows the picker to exactly its rows. Empty (default) advertises the gateway's live listing. |
| `streamIdleTimeoutMs` | `300000` | Maximum provider idle time during one stream read. |
| `imageMaxPixels` / `imageMaxBytes` | `1456000` / `2000000` | Per-image budgets for request-image preparation. |
| `retryPolicy` | normal, 5 retries | Provider-owned retry policy (`RetryPolicySchema`). |

Catalog entries accept `id`, `name`, `description`, `contextWindow`, `maxTokens`, and `inputModalities`:

```yaml
- id: llm-tokener
  name: dsh-tokener
  config:
    profiles:
      tokener:
        models:
          - id: deepseek-v4-flash
            name: DeepSeek V4 Flash
            contextWindow: 1000000
            maxTokens: 393216
          - id: gpt-5.6-sol
            contextWindow: 922000
            inputModalities: [text, image]
```

Everything above is also a live settings section (`llm-tokener`): change it in `$DSH_HOME/settings.yaml` or the web UI and the next request picks it up.

## Model Experience

None, as this package only transports the harness's own request vocabulary to the gateway and back — it contributes no prompt text, tool schemas, or other model-facing content of its own.

#### KV Cache effect

Independent per call: the adapter serializes each request from the session log, so cache reuse upstream is decided by the gateway's models, not by this package. Configuration changes never invalidate an in-flight prefix; they only shape the next request.

## Known Limitations and Deferred Work

- **Reasoning replay is best-effort** — assistant reasoning rides back as plain `reasoning_content` text. The OpenAI dialect has no signatures, so a multi-vendor gateway accepts it as prose; reasoning still lands in the session log.
- **No prompt caching control** — `cache_control` blocks are not emitted; reported cache reads/writes still flow into usage. Waiting on cross-vendor `cache_control` support behind the gateway.
- **Catalog is advisory by design** — an uncatalogued model id is treated as text-only with the route defaults; exact capacities need a catalog entry.

## Development

```sh
pnpm install
pnpm run verify            # lint + typecheck + unit tests (100% coverage) + build
TOKENER_API_KEY=sk-... pnpm run test:e2e   # live-gateway specs (self-skip without a key)
```

The wire layer follows the harness's own DeepSeek adapter (`llm-deepseek`): same OpenAI dialect, same `[DONE]`/usage/stream_options conventions. The build is the standard DSH two-stage pipeline: `tsc` emits `lib/types` (rewriting the explicit `.ts` relative specifiers), then `tsdown` bundles the entry into the single published artifact `lib/index.js`.

## License

[Apache-2.0](./LICENSE)
