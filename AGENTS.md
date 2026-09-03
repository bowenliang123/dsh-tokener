# AGENTS.md

Engineering conventions for `dsh-tokener`, aligned with the DeepSeek Harness
monorepo's internal plugin rules (see deepseek-harness `docs/cookbook/adding-a-package.md`
and `docs/cookbook/adding-an-llm-adapter.md`).

## What this package is

One single-purpose plugin: a Tokener.ai gateway LLM adapter for the
`@deepseek-ai/dsh-llm` seam, speaking the OpenAI-compatible
chat-completions dialect the gateway serves at `/v1/chat/completions`. Plugin name `llm-tokener`, provider route
`tokener`, npm package `dsh-tokener`.

## Layout

```
src/
  types.ts      # OpenAI-compatible wire vocabulary (only what this adapter sends/reads)
  sse.ts        # SSE byte stream -> data payloads, [DONE]-terminated (eventsource-parser)
  translate.ts  # chat-completions chunks -> harness StreamChunks (usage deferred to [DONE])
  serialize.ts  # harness messages -> OpenAI chat-completions request
  adapter.ts    # TokenerAdapter: fetch + SSE + idle watchdog + error mapping
  catalog.ts    # advisory catalog model type
  index.ts      # plugin entry: name/inject/Config/apply, credentials, settings, discovery
tests/          # vitest specs + mock chat-completions SSE server + live e2e (self-skipping)
```

## Rules

- **Source imports use explicit `.ts` specifiers** (`./types.ts`); `tsc` rewrites
  them to `.js` in emitted code (`rewriteRelativeImportExtensions`).
- **Two-stage build**: `tsc -p tsconfig.json` emits `lib/types/*.js + *.d.ts`,
  then `tsdown` bundles `lib/types/index.js` into the single published runtime
  artifact `lib/index.js`. Dependencies stay external. `files` ships exactly
  `lib/index.js`, `lib/types/**/*.d.ts`, `cordis.patch.yml`, `README.md`, `LICENSE`.
- **Adapter contract obligations** (`dsh-llm`): every provider request carries
  `attributionHeaders()`; `usage` is emitted before `finish` and nothing after;
  tool arguments remain raw JSON end to end; block indexes follow first-opened
  order; EOF without `[DONE]` is `STREAM_CLOSED`; unsupported options fail
  loud with a stable `LlmError` code instead of being dropped silently.
- **Connection facts resolve per request** from one snapshot; a credential is
  only ever paired with the endpoint of the same resolution. The retry policy is
  the one registration-captured fact and re-registers via `handle.replace()`.
- **Config** (`@deepseek-ai/schemastery`, Standard Schema) doubles as the
  settings-section schema; `resolveAdapterOptions` re-validates every bound for
  programmatic construction and keeps the last good facts on a bad live snapshot.
- **Lint** is oxlint with type-aware rules (`.oxlintrc.json`); keep it at zero
  errors. Tests target **100% per-file coverage** (statements, branches,
  functions, lines), matching the monorepo bar; mock only the network boundary
  (`tests/mock-server.ts`), and keep live-gateway evidence in `tests/*.e2e.ts`
  which self-skip without `TOKENER_API_KEY`.

## Verify before publishing

```sh
pnpm run verify      # lint + typecheck + covered unit tests + build
npm pack --dry-run   # files whitelist matches the list above
```
