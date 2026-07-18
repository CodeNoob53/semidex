# Stage B1 — Gemini GenerationProvider vertical slice

Gemini is implemented as the second production Ask answer-generation
backend, extending the existing provider architecture
(`src/core/generation/{provider,registry,runtime,config}.js`). This covers
answer generation only — indexing-time context summaries and tags still
run through Ollama exclusively.

## Required research findings (before implementation)

Read against the official docs (`ai.google.dev/api`,
`ai.google.dev/gemini-api/docs/get-started`, `ai.google.dev/api/models`,
`ai.google.dev/gemini-api/docs/api-versions`) and cross-verified against
the actually-installed `@google/genai@2.12.0` package's own `.d.ts` files
(the strongest available ground truth — not just docs prose).

1. **API used**: `ai.models.generateContentStream()`, not the Interactions
   API. The docs describe a GA "Interactions API"
   (`ai.interactions.create()`) positioned as the newer, agent-oriented
   primitive — confirmed to exist in the installed package
   (`typeof client.interactions === 'object'`). It was not chosen because
   its cancellation/streaming-iteration contract could not be confirmed
   from official sources at implementation time, while
   `generateContentStream()`'s contract is fully documented and verified
   directly against the SDK's type declarations.
2. **API version**: the SDK defaults to `v1beta`; `v1` is the stable
   version. No explicit `apiVersion` override was set — `httpOptions` was
   left at the SDK default for this vertical slice, since pinning a
   specific version was not a stated requirement and the default is what
   every code example in the docs uses.
3. **Streaming and cancellation**: `generateContentStream()` returns an
   async-iterable stream; iterate with `for await (const chunk of stream)`
   and read `chunk.text` for each delta. Cancellation is via
   `config.abortSignal` — confirmed directly against the installed
   package's `GenerateContentConfig` type, which documents this field as
   **client-only**: *"Using it to cancel an operation will not cancel the
   request in the service. You will still be charged usage for any
   applicable operations."* `gemini-provider.js` passes the caller's
   signal through as `config.abortSignal` and also checks `signal.aborted`
   explicitly inside the consuming loop as a second layer. `aborted: true`
   in this provider's return value means "we stopped consuming the
   stream," never "upstream generation halted" — the same honesty
   constraint the task required, now backed by the SDK's own documented
   caveat rather than an absence-of-evidence inference.
4. **Model discovery**: `client.models.list({ config: { pageSize, ... } })`
   returns `Promise<Pager<Model>>` — an `AsyncIterable`, iterated with
   `for await` to walk every page, not just the first (confirmed:
   `Pager<T> implements AsyncIterable<T>`). `ListModelsConfig` supports
   `pageSize`/`pageToken`/`filter`/`queryBase`.
5. **Input-token limit**: yes — `Model.inputTokenLimit` (and
   `outputTokenLimit`) are real, documented fields on the model object
   returned by both `models.get()` and `models.list()`. This is used by
   `gemini-provider.js`'s `ready()` to cap the reported `numCtx`, mirroring
   how `ollama-provider.js` caps it against `getModelContextLength()`.

No unsupported API behavior was guessed. Where official docs were
ambiguous (cancellation semantics), the installed package's own type
declarations were read directly as the authoritative source before
writing any provider code.

## 1. Gemini provider — `src/core/generation/gemini-provider.js`

Implements the existing `GenerationProvider` contract
(`name`/`capabilities`/`ready`/`generate`) with the same construction
pattern as `ollama-provider.js`:

- No `process.env` reads — `apiKey`/`model`/`askNumCtx` arrive via
  constructor arguments only (verified by a source-grep test).
- `createClientFn` DI hook: production constructs the real
  `new GoogleGenAI({ apiKey })` lazily (only on first `ready()`/`generate()`
  call, never at construction — a missing key never crashes
  `createGeminiProvider()` itself); tests always inject a stub, so no
  automated test calls the real Gemini API.
- `ready()`: `ok:false` for a missing key or model (never throws);
  `models.get()` checks the model exists and supports `generateContent`
  via the real `supportedActions` field (fails open — never guesses
  unsupported from an absent field); caps `numCtx` by the real
  `inputTokenLimit` when available.
- `generate()`: streams via `generateContentStream()`, calls `onToken()`
  only for chunks with a non-empty `text` field, accumulates the full
  text, returns `tokensIn`/`tokensOut` from `usageMetadata` when present.
  Passes only Gemini-relevant `options` fields (`temperature`,
  `maxOutputTokens`) — never forwards an Ollama-shaped `num_ctx` (there is
  no Gemini equivalent to send it as; Gemini has no request-level
  context-window parameter, only the read-only `inputTokenLimit` model
  metadata).
- Every error path redacts the API key from thrown/returned messages
  before they leave this file (`redactApiKeyFromMessage`) — verified by
  dedicated tests using a fake key that must never appear in the output.
- Never places the API key in a URL (the SDK's own constructor takes it as
  a header-carried credential, not a query parameter — confirmed by
  reading the client construction path).

## 2. Provider-aware runtime configuration — `src/core/generation/config.js`

- `SUPPORTED_BACKENDS` extended to `['ollama', 'gemini']`.
- `SEMIDEX_GENERATION_BACKEND` is resolved with the same OS env > `.env` >
  default precedence as every other field.
- Model resolution is now backend-aware:
  - `CONTEXT_MODEL` fallback is gated to the `ollama` backend only — an
    Ollama model name can never silently become the effective Gemini
    model.
  - The default model is looked up per-backend
    (`DEFAULT_MODEL_BY_BACKEND`), not a single flat default — switching to
    `gemini` with no explicit `ASK_MODEL` resolves to `gemini-2.5-flash`,
    never `gemma3:4b`.
  - `ASK_MODEL` itself is backend-neutral and always honored.
- `GEMINI_API_KEY` resolves with the identical OS env > `.env` > default
  chain as every other field, but is **excluded** from
  `runtime.js`'s `GENERATION_SETTINGS_KEYS` map — it can never be promoted
  to the `config_json` (settings.json) tier, so it is structurally
  impossible for it to be persisted through the settings-service path.
- `GENERATION_DEVICE` validation is now conditional on the `ollama`
  backend — Gemini has no local-device concept, so an arbitrary
  `GENERATION_DEVICE` value under `gemini` is accepted (reported, not
  acted on) rather than rejected as "unsupported."
- `runtime.js`'s `buildProviderOptions()` builds a backend-specific options
  object — `ollama` gets `{ model, baseUrl, askNumCtx }`, `gemini` gets
  `{ apiKey, model, askNumCtx }`. Neither backend's factory ever sees the
  other's fields (verified by regression tests).
- `getStatus()`'s `configuration` block is backend-conditional:
  `baseUrl`/`devicePolicy` only appear for `ollama`; `geminiApiKey:
  { configured: boolean, source }` only appears for `gemini` — the actual
  key value never appears anywhere in the status response (verified: a
  fake key is asserted absent from the full JSON-stringified response).

## 3. Registry — `src/core/generation/registry.js`

`gemini: createGeminiProvider` added to `BACKENDS`. `ollama` remains the
default (`backend = 'ollama'` unchanged). Existing Ollama behavior is
untouched — regression tests confirm `createGenerationProvider()`'s
default path, options passthrough, and no-`process.env`-reads guarantee
all still hold.

## 4. Provider-aware model discovery

- **`src/core/gemini-models.js`** (new): `discoverGeminiModels({ apiKey,
  createClientFn, forceRefresh })` — mirrors `ollama-models.js`'s
  `{ available, reason, models }` shape. Reports the real
  `supportedActions` API field, never capabilities guessed from a name;
  capability filtering is performed by the shared Settings UI. Paginates through
  every page the `Pager` yields (not just the first). A short (60s)
  in-process cache, keyed by API key, avoids repeating a full
  `models.list()` walk on every Settings UI render; `forceRefresh` bypasses
  it. The API key never appears in a successful or failed response
  (redacted, tested).
- **`src/admin/api/generation-models.js`** (new):
  `GET /api/generation/models?backend=ollama|gemini` — the provider-neutral
  endpoint the task asked for. Delegates to `discoverOllamaModelsFn`/
  `discoverGeminiModelsFn` (both DI'd, defaulting to the real
  implementations) and tags the response with `backend`. Always 200,
  status-in-body — matches the existing `/api/ollama-models` /
  `/api/generation/status` convention. `?refresh=1` maps to `forceRefresh`
  for either backend. An unknown/missing `backend` query param is a 400.
- `GET /api/ollama-models` is **kept unmodified** for existing callers
  (`TAG_MODEL`/`CONTEXT_MODEL`/`EMBED_MODEL` are Ollama-only fields with no
  cross-backend concept and still use it directly). Only `ASK_MODEL`'s
  `dynamicOptions.source` was changed, from `'ollama_models'` to the new
  `'generation_models'`.

## 5. Settings UI

`src/core/settings/definitions.js`:

- `SEMIDEX_GENERATION_BACKEND` is now **writable** (`options: [ollama,
  gemini]`) — it was previously `writable: false` with a "only one backend
  implemented" reason, which is no longer true.
- `ASK_MODEL.dynamicOptions.source` changed to `'generation_models'`.
- `OLLAMA_URL`/`GENERATION_DEVICE` gained
  `visibleWhen: { key: 'SEMIDEX_GENERATION_BACKEND', equals: 'ollama' }` —
  hidden entirely for Gemini.
- New `GEMINI_API_KEY` definition: `type: 'secret'`, `writable: false`,
  `visibleWhen: { ..., equals: 'gemini' }` — same "Configured"/"Not
  configured" badge rendering every other secret field already gets, no
  new UI code needed for that part.

`src/admin/ui-src/global-settings-view.js`:

- `dynamicOptionsControl()` generalized to take a `{ discovery, backend,
  unavailableLabel, unavailableReason }` parameter instead of hardcoding
  `lastOllamaModels` — used for both the existing `'ollama_models'` source
  and the new `'generation_models'` source.
- New `lastGenerationModels`/`lastGenerationModelsBackend` module state,
  `refreshGenerationModels()` (fetches
  `/api/generation/models?backend=<currently STAGED backend>`), and
  `categoryNeedsGenerationModels()` — mirrors the existing Ollama discovery
  plumbing exactly.
- `currentGenerationBackend()`: reads the **staged** (not just
  last-fetched) `SEMIDEX_GENERATION_BACKEND` value, so switching it in an
  unsaved edit immediately determines which model list `ASK_MODEL` should
  query.
- Switching `SEMIDEX_GENERATION_BACKEND` (staged) now **unconditionally**
  triggers a full category rebuild and a `refreshGenerationModels()` call
  for the new backend — not conditioned on whether `OLLAMA_URL`/
  `GENERATION_DEVICE` happened to also change visibility in that specific
  payload, closing a fragility gap found during test-writing (initial
  implementation coincidentally worked only because a full payload always
  has fields whose `visibleWhen` also flips).
- Switching `SEMIDEX_GENERATION_BACKEND` also **immediately marks
  `ASK_MODEL` invalid** (Save disabled) rather than waiting for the async
  model-list refetch to discover a mismatch — the task's explicit "require
  a valid model selection instead of silently saving stale data"
  requirement. The stale model name is preserved as a selected,
  `"(not installed)"`-labeled option (never silently replaced), and
  choosing a real model from the new list clears the invalid flag.
- The `ai` category's static placeholder ("Ollama · Cloud providers are
  planned") was **removed** — it became false the moment Gemini shipped as
  a real, selectable backend option. The category now renders only real,
  functional controls.

## 6. Ask behavior — no changes

`src/core/ask/` was not modified. Verified directly (source grep: no
`ollama`/`gemini`/provider-name branch anywhere in `coordinator.js`) and
empirically: `tests/unit/admin/ask-gemini-provider.test.js` wires the
**real** `createGeminiProvider()` (only its `@google/genai` client is
DI-stubbed) into the real `createAskCoordinator()` + the real
`POST /api/ask` SSE route, and the full retrieval → bounded evidence →
grounded prompt → SSE event sequence → citation validation → refusal →
client-abort-handling pipeline works identically to the existing
Ollama-backed tests, proving the Ask coordinator absorbed the new backend
with zero code changes of its own.

## 7. Documentation

- `.env.example`: `SEMIDEX_GENERATION_BACKEND`/`ASK_MODEL`/`GENERATION_DEVICE`
  comments updated to describe both backends; new `GEMINI_API_KEY` entry.
- `docs/en/configuration.md`: new "Ask Generation Backend" section (this
  runtime configuration was previously undocumented there entirely, even
  for the Ollama-only case) — documents both backends' variables,
  precedence, discovery endpoint, and failure behavior.
- `docs/design/ask-application-runtime.md`: Stage B's "Gemini
  `GenerationProvider`" bullet marked shipped (Stage B1), with an explicit
  note on what remains not-started in the rest of Stage B (Qdrant Cloud
  path, versioned schema, reference client, deployment guide, public-demo
  auth/rate-limiting). No mention of grants, funding, applications, or
  partnerships anywhere.
- This report.

## 8. Tests

62 new tests across 5 new files, plus fixes to 2 pre-existing assertions
that encoded the old (single-backend) behavior:

| File | Tests | Covers |
|---|---|---|
| `tests/unit/core/generation/gemini-provider.test.js` | 22 | Provider contract, ready()/generate() happy+error paths, streaming/accumulation, usage metadata, missing key, invalid/unavailable model, redaction, cancellation (incl. `config.abortSignal` passthrough) |
| `tests/unit/core/gemini-models.test.js` | 11 | Discovery, real-capability reporting, pagination across pages, redacted errors, caching + forceRefresh + per-key isolation |
| `tests/unit/admin/api/generation-models.test.js` | 9 | Provider-neutral route wiring for both backends, refresh passthrough, 400 on bad backend, redaction (Gemini key + QDRANT_KEY) |
| `tests/unit/admin/ui-global-settings-gemini.test.js` | 15 | Backend selectability, field visibility switching (staged), model-list swapping, stale-model invalidation blocking Save, refresh button, GEMINI_API_KEY display contract |
| `tests/unit/admin/ask-gemini-provider.test.js` | 6 | Full Ask SSE flow through the real Gemini provider: streaming, citations, missing-key 503, mid-stream failure, client abort, no-Ollama-path proof |

Plus additions to existing files: `config.test.js` (+8, backend/model/key
resolution and isolation), `runtime.test.js` (+5, backend-aware
options/status), `registry.test.js` (+1, Gemini selection + updated
error-message assertion). Two pre-existing assertions were corrected to
match the now-real behavior change (not weakened — they encoded the
*old*, since-superseded design): `definitions.test.js`'s
"single-implementation enums are read-only" no longer includes
`SEMIDEX_GENERATION_BACKEND` (split into its own test asserting it's
writable with both options); `service.test.js`'s `buildEntry()`
fixture-shape test updated for `ASK_MODEL`'s new `dynamicOptions.source`.
The `ui-global-settings-editing.test.js` "future provider placeholders"
test for the `ai` category was rewritten to assert no placeholder renders
(the old assertion checked for text that is no longer true).

All automated tests use dependency injection (`createClientFn`) for the
`@google/genai` SDK — **no test calls the real Gemini API**.

## 9. Verification

```
node --max-old-space-size=512 --test --test-concurrency=1 "tests/**/*.test.js"
npm run smoke
npm run admin:build
git diff --check
```

| Check | Result |
|---|---|
| Full suite | **1629/1629 pass** (was 1552 before this task; +77 net) |
| Smoke | **1293/1293 pass**, unchanged |
| `admin:build` | success, 225 modules, JS bundle 274.92kB → 276.40kB |
| `git diff --check` | only pre-existing LF/CRLF warnings, no conflict markers |

Both consecutive concerns from the prior test-infrastructure work
(bounded concurrency, no orphaned processes) were re-verified for this
run — process count unchanged before/after.

## 10. Live-check instructions (optional, not run in this session)

To manually verify against the real Gemini API:

```bash
SEMIDEX_GENERATION_BACKEND=gemini GEMINI_API_KEY=<your key> npm run admin
```

Then in the Settings UI (`#/settings/ai`): confirm the Ask answer model
selector lists real models available to the key, confirm
`OLLAMA_URL`/generation device disappear, confirm the Gemini API key row
shows "Configured." Ask a question through the running admin UI and
confirm a real streamed answer with citations arrives via SSE.

## 11. Limitations / explicitly out of scope (per task)

- Indexing-time context summaries and tags do not route through Gemini —
  Ollama only, unchanged.
- No Qdrant Cloud server-side inference, no public SDK/widget, no Telegram
  integration, no auth/multi-tenancy layer — all deferred to later Stage B
  work or Stage C/D per the roadmap doc.
- The Interactions API was not implemented (see §1 above for the
  reasoning); `generateContentStream()` was chosen as the better-verified,
  more conservative option for this vertical slice.
- Gemini's `config.abortSignal` is explicitly client-only per the SDK's
  own documentation — a client abort during generation stops semidex from
  consuming further output but does not stop Google from billing for the
  full generation. This is inherent to the current SDK/API contract, not
  a semidex-side gap.

## 12. Code review addendum (post-implementation)

An independent review of this implementation found four real issues, all
reproduced live before fixing:

- **P1 — Settings API and runtime disagreed on ASK_MODEL's default under
  Gemini.** `definitions.js`'s `ASK_MODEL` had a flat, backend-unaware
  `stringField` default (`gemma3:4b`), while `config.js`'s
  `resolveGenerationRuntimeConfig()` correctly picked
  `DEFAULT_MODEL_BY_BACKEND.gemini`. Reproduced live:
  `settingsService.get('ASK_MODEL').configuredValue` returned `gemma3:4b`
  while `runtime.getConfig().model.value` returned `gemini-2.5-flash` for
  identical input. Fixed at the root: `resolveFromTiers()`
  (`core/settings/service.js`) now resolves `ASK_MODEL`'s default via the
  same exported `DEFAULT_MODEL_BY_BACKEND` map `config.js` uses, keyed by
  the currently-resolved `SEMIDEX_GENERATION_BACKEND` — one provider-aware
  resolver, not two. `getActiveValue()`/`get()`/`getAll()` all agree
  automatically since the fix lives in the shared tier-resolution
  function, not a post-hoc annotation layer. 6 new tests added
  (`service.test.js`), including the exact cross-check against
  `resolveGenerationRuntimeConfig()`'s own output for the same input.
- **P1 — declared Node 18 support was incompatible with the new SDK.**
  `@google/genai@2.12.0` requires Node `>=20.0.0`; the already-present
  transitive dependency `pdfjs-dist@5.4.296` (via `pdf-parse`) requires
  `>=20.16.0 || >=22.3.0`, the stricter floor. `package.json`'s `engines`
  raised from `>=18.17.0` to `>=20.16.0`; `docs/en/testing.md` updated to
  match and explain why.
- **P1 — Gemini model IDs from discovery were unnormalized resource
  names.** `models.list()` genuinely returns `"models/gemini-2.5-flash"`
  (`Model.name`'s own doc comment: "Resource name of the model."), but
  `DEFAULT_MODEL_BY_BACKEND.gemini`, `ASK_MODEL`'s stored value, and every
  UI comparison use the bare form — confirmed both forms are accepted by
  `generateContentStream()`/`models.get()` (both error identically on an
  invalid key regardless of form). Without normalization, the real default
  model would render as "(not installed)" in the Settings UI. Fixed with a
  `normalizeModelName()` helper at the `gemini-models.js` adapter
  boundary — the one place resource names enter this codebase — stripping
  the `models/` prefix before results are cached/returned. New test
  reproduces the exact API response shape and confirms the default model
  no longer mismatches.
- **P2 — unverified-capability Gemini/Ollama models were silently
  selectable.** `dynamicOptionsControl()` rendered a `capabilities: null`
  model as a fully-selectable `<option>`, identical weight to a
  capability-confirmed one — inconsistent with `gemini-provider.js`'s own
  fail-open `ready()` rule being informational-only, not a green light to
  pick that model for the first time. Fixed: an unverified model's
  `<option>` is now `disabled` unless it is *already* the configured
  value (which stays selectable so an unrelated Save is never blocked by
  a pre-existing configuration this control had no part in choosing).
  Applies to both `ollama_models` and `generation_models` sources — this
  pattern predates the Gemini work but the review's argument applies
  equally to both. 2 new tests added.
- **P2 — `capabilities().cancellation` overclaimed Gemini's real
  guarantee.** A single boolean, `true` for both backends, hid that
  Ollama's abort genuinely tears down the upstream HTTP request while
  Gemini's `config.abortSignal` is SDK-documented as client-only (stops
  local consumption; does not stop Google's servers from generating or
  billing). Split into `clientAbort`/`upstreamCancellation` across the
  `GenerationProvider` contract (`provider.js`), both providers,
  `runtime.js`'s fallback shapes, and `docs/design/ask-chat.md`'s
  documented contract. New cross-backend test in `registry.test.js`
  asserts Ollama reports `upstreamCancellation: true` and Gemini reports
  `false`, both `clientAbort: true`.

All four fixes verified: full suite **1639/1639 pass** (was 1629),
`npm run smoke` **1293/1293 pass** (unchanged), `admin:build` succeeds,
`git diff --check` clean (only pre-existing LF/CRLF warnings).
