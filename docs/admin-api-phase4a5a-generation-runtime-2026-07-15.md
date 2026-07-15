# Admin API Phase 4A.5a — Generation Runtime Configuration + Status API (2026-07-15)

Status: implemented, tested, live-verified against real Ollama (`gemma3:4b`).
Not committed (per task instruction). Started only after Phase 4A's own
changes were committed and the working tree was clean (precondition met —
verified via `git status --short` before any edit in this task).

## Scope

Runtime/configuration foundation for the future Settings UI, cloud
generation providers, and Phase 4B Ask UI. No cloud providers, no Settings
UI, no session provider switching — all explicitly out of scope per the
task.

## What was built

### 1. Explicit admin bootstrap — `src/admin/bootstrap.js` (new)

The real `npm run admin` entry point now (`package.json`'s `"admin"` script
changed from `node src/admin/server.js` to `node src/admin/bootstrap.js`).
Exports four small, independently-testable pieces plus an `isMainModule`
self-start block (same `pathToFileURL` guard pattern `server.js` used to
use):

- **`snapshotOsEnv(env = process.env)`** — returns a plain-object copy.
  Called as the very first statement of the real entry point, before any
  import that could transitively run `import 'dotenv/config'` and mutate
  `process.env`.
- **`loadDotenvValues(envPath)`** — reads `.env` via `dotenv.parse()` (a
  pure string→object parse with zero `process.env` side effects — not
  `dotenv.config()`/`'dotenv/config'`), so `.env`'s own contents are known
  independently of whatever the OS environment already set. Returns `{}` if
  the file doesn't exist.
- **`applyDotenvValues(dotenvValues, env)`** — thin wrapper over `dotenv`'s
  own `populate()`, which fills gaps only (never overrides an
  already-present key) — this is the exact default (non-`override`)
  behavior `dotenv/config` itself uses, so once the bootstrap has populated
  `process.env`, every later `import 'dotenv/config'` anywhere else in the
  import graph (unchanged, per the task's explicit "do not refactor
  indexer/MCP bootstraps" instruction) becomes a safe no-op.
- **`bootstrapEnv({ envPath, env })`** — runs all three in sequence, returns
  `{ osEnv, dotenvValues }` for the caller to pass into a generation
  runtime.

The `isMainModule` block: `bootstrapEnv()` → dynamic `import('./server.js')`
and `import('../core/generation/runtime.js')` → construct one
`generationRuntime` from the two snapshots → `createApp({
generationRuntime })` → `server.listen(...)`. `server.js` is imported
dynamically (`await import(...)`), not statically, so nothing in its module
graph can run before the bootstrap has already captured `osEnv`.

**`src/admin/server.js`** lost its own top-level `import 'dotenv/config'`
and its `isMainModule`/self-start block entirely — it is now purely the
`createApp()` factory. Its header comment (corrected after a code-review
finding — see below) states precisely what this guarantees: importing it
never starts a server and never loads a generation/embedding model. It is
**not** claimed to be free of all transitive import-time side effects —
`createStorageAdapter()` (imported by `server.js`) pulls in
`core/qdrant/client.js`, which still has its own `import 'dotenv/config'`
(intentionally untouched, per this phase's scope). This is why
`bootstrap.js`'s `isMainModule` block imports `server.js` dynamically
(`await import('./server.js')`) only *after* `bootstrapEnv()` has already
snapshotted the OS environment — the snapshot happens before that
transitive `dotenv/config` import can run, so functional correctness holds
regardless of `server.js`'s own transitive graph. This directly satisfies
"keep `src/admin/server.js` importable without starting a server or
loading models" (the task's literal wording, which is narrower than "zero
side effects") — confirmed by the full existing `tests/unit/admin/*.test.js`
suite (which has always imported `server.js` directly) continuing to pass
unmodified.

**Code review correction (2026-07-15, second pass)**: an earlier version of
this report, `server.js`'s own header comment, and
`docs/design/admin-ui-and-storage-adapter.md`'s module-map entry for
`server.js` all overclaimed "zero side effects on import." That was
inaccurate the moment `createStorageAdapter()` is imported — fixed in all
three places to state the narrower, actually-true guarantee (no
self-start, no model loading) instead.

**Not touched, per the task's explicit instruction**: every other
`import 'dotenv/config'` site (`src/core/ollama.js`, `src/core/config.js`,
`src/indexer/index.js`, `src/mcp/server.js`, `src/sync.js`,
`src/doctor.js`, etc.) — none of those files were refactored.

### 2. Pure generation config resolver — `src/core/generation/config.js` (new)

`resolveGenerationRuntimeConfig({ osEnv, dotenvValues, defaults })` — no
`process.env` reads, no I/O, fully deterministic. Resolves:

| Field | Env var(s) | Default |
|---|---|---|
| `backend` | `SEMIDEX_GENERATION_BACKEND` | `ollama` |
| `model` | `ASK_MODEL`, falling back to `CONTEXT_MODEL` | `gemma3:4b` |
| `baseUrl` | `OLLAMA_URL` | `http://localhost:11434` |
| `numCtx` | `ASK_NUM_CTX` | `8192` |
| `devicePolicy` | `GENERATION_DEVICE` | `auto` |

Every field resolves to `{ value, source }`, `source ∈ {'os_env', 'dotenv',
'default'}`. **Precedence is layer-first, not key-first**: for `model`,
`ASK_MODEL` is preferred over `CONTEXT_MODEL` only *within* a layer — an
OS-env `CONTEXT_MODEL` still beats a `.env`-only `ASK_MODEL`, so the
documented "OS env > .env > default" precedence is never silently violated
just because a particular key happens to live in `.env`. This distinction
is deliberate and covered by a dedicated test
(`resolveGenerationRuntimeConfig — ASK_MODEL / CONTEXT_MODEL fallback` →
"layer precedence... governs across all candidate keys").

Validation, via `GenerationConfigError` (carries `field` and the raw
`value` that failed, so callers never need to re-parse the message):
- `backend` must be in `SUPPORTED_BACKENDS` (`['ollama']` today) —
  unknown backend throws.
- `numCtx` must be a positive integer in `[256, 1_000_000]` — non-numeric,
  non-integer, or out-of-bounds throws.
- `devicePolicy` must be in `SUPPORTED_DEVICE_POLICIES` (`['auto']`
  today) — anything else throws.

**Never silently falls back on an explicitly-supplied invalid value** —
per the task's explicit constraint. An invalid value from either `osEnv` or
`dotenvValues` throws `GenerationConfigError`; only a genuinely *absent*
key falls through to the default.

### 3. Generation runtime service — `src/core/generation/runtime.js` (new)

`createGenerationRuntime({ osEnv, dotenvValues, defaults,
createGenerationProviderFn })` — the one backend-neutral object above
`GenerationProvider`. Implements the `GenerationProvider` contract itself
(`name()`, `capabilities()`, `ready()`, `generate()`), so
**`AskCoordinator` required zero code changes** — `createApp()` now passes
a `generationRuntime` instance wherever it used to pass a raw
`generationProvider`, and the coordinator's own `generationProvider:
generation` parameter name is unchanged (it just receives an object that
happens to be a runtime rather than a bare provider — behaviorally
identical from the coordinator's point of view).

At construction: calls `resolveGenerationRuntimeConfig()`, and on success
constructs the concrete provider via `createGenerationProvider({ backend,
options: { model, baseUrl, askNumCtx } })`. On a `GenerationConfigError` (or
an "unknown backend" `Error` from the registry), the runtime does **not**
throw — it captures the error and represents itself as permanently
not-ready: `ready()` resolves `{ ok: false, reason: <message> }`,
`generate()` rejects clearly ("Generation runtime is not configured
correctly: ..."), and `getStatus()` reports `ready: false` with
`configuration: null`. Any *other*, unexpected error from the provider
factory (a real bug, not a config problem) is re-thrown, not swallowed —
tested explicitly.

`getStatus()` — the one method beyond the `GenerationProvider` contract,
used only by the status route:

```js
{
  backend, model, ready, reason, numCtx,
  capabilities,
  devicePolicy: { value, supported },
  configuration: {
    backend: { source }, model: { source },
    baseUrl: { source, display }, numCtx: { source }, devicePolicy: { source },
  } | null, // null exactly when configuration itself was invalid
}
```

### 4. Registry construction fixed — `src/core/generation/registry.js`,
`src/core/generation/ollama-provider.js` (both modified)

`createGenerationProvider({ backend, options })` now passes `options`
straight through to the selected backend's factory (`make(options)`) —
previously it only selected a backend and constructed it with no arguments
at all, so there was no clean path for resolved config (model/baseUrl/
numCtx) to reach the provider. **No `process.env` reads anywhere in
`registry.js`** (source-level test, matching a `/process\.env\./` regex,
not just prose mentioning the constraint) — a future cloud provider's
registration never needs to know any env var names.

`createOllamaProvider()` lost its own `process.env.CONTEXT_MODEL`/
`process.env.OLLAMA_URL` default reads (the exact scattered-env-fallback
pattern this task exists to eliminate) — it now takes `model`, `baseUrl`,
and a new `askNumCtx` option (renamed from the old internal
`DEFAULT_ASK_NUM_CTX` constant, which is now a `FALLBACK_ASK_NUM_CTX` used
only when the option is omitted — e.g. in isolated tests). Real production
construction always goes through the runtime, which always supplies all
three explicitly from resolved config.

### 5. Status endpoint — `GET /api/generation/status`, `src/admin/api/generation.js` (new)

Delegates entirely to `generationRuntime.getStatus()`. Always returns
**HTTP 200** — `ready: false` (for an unavailable provider or invalid
configuration) is reported in the body, never a 5xx. This is the documented
split from `POST /api/ask`, which keeps its existing pre-stream 503 for the
identical underlying condition (verified by a dedicated test asserting both
routes observe the same `readiness` outcome from one shared runtime
instance, via a call-count assertion proving object identity, not
coincidental agreement).

`reason` is passed through `sanitiseErrorMessage()` (the same helper
`api/ask.js` already uses) before the response is sent — a readiness
reason can embed a raw configured `baseUrl` (e.g. "Ollama is not reachable
at http://host:port"), and this route is never routed through the router's
uncaught-exception catch-all (it never throws), so it must redact
explicitly, matching `api/ask.js`'s own established pattern exactly.
`configuration.baseUrl.display` is redacted separately, one layer down in
`runtime.js`'s own `getStatus()` (via `redactUrl()`, not
`sanitiseErrorMessage()`) — see "Security boundary" below for why that
redaction had to live in the runtime rather than this route.

**Deliberately not touched**: `GET /api/system/ollama-status` keeps its
existing scope (the indexing-form's "is Ollama available for LLM
summaries" pre-check) — nothing in Ask or the new status endpoint reads
from it, and nothing in it was changed.

### 6. `createApp()` — one clean DI contract

`generationProvider` was **replaced** with `generationRuntime` in
`createApp()`'s destructured parameters (not added alongside it) — per the
task's explicit "update tests rather than retaining parallel permanent
paths" instruction. The same `generation` local variable (constructed once,
defaulted to `generationRuntime ?? createGenerationRuntime({ osEnv:
process.env, dotenvValues: {} })` when no DI override is given) is passed
to both `registerGenerationRoutes()` and `createAskCoordinator()` — this is
what guarantees the status endpoint and Ask observe identical readiness for
a given server process, since they share one runtime object, not two
independently-constructed ones.

The `createApp()`-level default (`osEnv: process.env, dotenvValues: {}`)
is a safe fallback for callers that never call `bootstrap.js` (test code,
ad-hoc scripts) — it reads `process.env` directly but touches no file and
no network, so `createApp()` itself stays construction-safe. It does lose
provenance nuance (an OS-env-set var and a `.env`-set var both look like
`process.env` to this fallback), which is expected and documented: real
provenance is only meaningful when the bootstrap's own `osEnv`/
`dotenvValues` snapshots are threaded through, which is exactly what `npm
run admin` now does.

## Bugs found and fixed

None new in this phase — no live-verification surprises this round (unlike
Phase 4A's two round-1 bugs and the three round-2/round-3 code-review
findings). The one real design bug caught was in my own first test draft,
not the implementation: an `ASK_MODEL`/`CONTEXT_MODEL` precedence test
initially asserted the wrong outcome (that a `.env`-only `ASK_MODEL` should
beat an OS-env `CONTEXT_MODEL`) — re-reading the task's own two precedence
rules together (name-preference within a layer vs. `OS env > .env >
default` across layers) showed the implementation's actual behavior was
correct and the test's expectation was wrong; the test was corrected, not
the code.

## Tests

New/changed test files, all offline (no Qdrant/Ollama/ONNX initialization
in any test — explicitly verified, see below):

- `tests/unit/core/generation/config.test.js` (27 tests) — OS-env-over-
  `.env`, `.env`-over-default, provenance when both layers share a key,
  empty-string-treated-as-unset, `ASK_MODEL`/`CONTEXT_MODEL` fallback (both
  precedence rules, tested separately), `ASK_NUM_CTX` validation (numeric,
  integer, bounds, both layers), device-policy validation (both layers),
  unknown-backend rejection (both layers, error message content), purity
  (determinism, no input mutation).
- `tests/unit/core/generation/runtime.test.js` (15 tests) — conforms to
  `GenerationProvider`; delegates `ready()`/`generate()`/`name()`/
  `capabilities()`; passes resolved config into the provider factory;
  invalid config never crashes construction (unknown backend, bad
  `ASK_NUM_CTX`, unsupported device policy, each independently); `generate()`
  rejects clearly on invalid config; a misconfigured runtime never calls the
  provider factory at all; a genuinely unexpected factory error is not
  swallowed; `getStatus()` happy path with full provenance, unready-provider
  path, invalid-config path, and a check that no extra unsafe fields exist
  beyond the documented shape; no eager `ready()`/`generate()` call merely
  from construction.
- `tests/unit/core/generation/registry.test.js` (+2 tests: options
  passthrough to the factory, verified via `ready()`'s reason string
  surfacing the passed-through `baseUrl`; source-level `process.env.`
  absence check).
- `tests/unit/admin/bootstrap.test.js` (10 tests) — `snapshotOsEnv`'s
  copy-not-reference semantics; `loadDotenvValues`'s parse-without-mutating-
  process.env, missing-file, quoted-value handling; `applyDotenvValues`'s
  gap-fill-only (never-override) semantics; `bootstrapEnv`'s full sequence
  proving OS-env-wins without diffing an already-mutated `process.env`
  (the exact anti-pattern the task explicitly forbids); import safety (the
  `isMainModule` guard holds under the test runner — importing the module
  never starts a server).
- `tests/unit/admin/generation.test.js` (9 tests) — happy-path full
  response shape; unavailable-provider and invalid-configuration paths
  (always 200, never 5xx, including the explicit "unknown backend keeps
  admin alive" case); redaction of a credentialed/queried URL and of
  `QDRANT_KEY`, plus an exact-keys check ruling out any extra field; no
  eager Ollama/ONNX/network initialization (a dedicated regression test —
  see below); the status endpoint and `POST /api/ask` sharing exactly one
  runtime instance (proven via a `ready()` call-count closure variable, not
  just matching output).
- `tests/unit/admin/server.test.js`, `tests/unit/admin/ask.test.js` — run
  unmodified against the renamed DI param; both pass without any test
  changes, confirming Phase 4A Ask behavior is unaffected by this phase's
  refactor.

**Regression caught mid-implementation, worth calling out**: the first
draft of `generation.test.js`'s "shares the same runtime as Ask" test
didn't stub `embedQuery`/`countTokens` on its `withServer()` helper, so a
real `POST /api/ask` call inside the test silently loaded the real ~2.3GB
ONNX BGE-M3 tokenizer via `defaultCountTokens`'s and `embedForSearch`'s
production fallbacks — 5+ seconds in what should be a fast offline unit
test. Fixed by stubbing both, and a dedicated "no eager initialization"
test was added specifically to catch this class of regression again.

Targeted run: 157 tests across all Phase-4A.5a-relevant files (config,
registry, ollama-provider, runtime, provider, bootstrap, generation route,
ask route, server/layering), all passing, serially
(`NODE_OPTIONS='--max-old-space-size=768' node --test --test-concurrency=1`).
Full suite: `npm test` → 1326 passed, 0 failed (up from 1263 before this
phase). `npm run smoke` → 1293 passed, 0 failed. `npm run admin:build` →
succeeds (224 modules, unchanged — no UI code touched). `git diff --check`
→ clean (line-ending warnings only, pre-existing repo convention, exit 0).

## Live verification

1. **`npm run admin` (no Ollama running)**: `GET /api/health` → Qdrant
   reachable; `GET /api/generation/status` → `ready: false`, reason names
   the configured `baseUrl` (`http://localhost:11434`, from `.env`),
   `model: "gemma3:4b"` sourced from `.env`'s `CONTEXT_MODEL` (no
   `ASK_MODEL` set) — confirms the fallback chain live.
2. **OS-env override, live**: `ASK_MODEL=os-env-override-model npm run
   admin` → status endpoint reports `model: "os-env-override-model"`,
   `configuration.model.source: "os_env"` — confirms OS env actually wins
   over `.env`'s `CONTEXT_MODEL=gemma3:4b` in a real process, not just in
   unit tests with synthetic snapshots.
3. **Real Ollama running**: status endpoint reports `ready: true, numCtx:
   8192` (real, from `getModelContextLength()` capped at the runtime's
   resolved `askNumCtx`); a full `POST /api/ask` request against the
   bootstrap-started server streamed a real grounded answer with a valid
   citation and `evidenceCount: 2` — confirms Phase 4A Ask behavior is
   fully intact through the new bootstrap/runtime seam, not just
   independently passing in isolation.

All background processes (`ollama serve`, `node`/`npm run admin`) were
stopped after each verification pass; no scratch files or background
processes were left running.

## Changed files

```
M  .env.example
M  docs/design/admin-ui-ux-and-ask-plan.md
M  docs/design/ask-chat.md
M  package.json
M  src/admin/server.js
M  src/core/generation/ollama-provider.js
M  src/core/generation/registry.js
M  tests/unit/core/generation/registry.test.js
?? docs/admin-api-phase4a5a-generation-runtime-2026-07-15.md   (this report)
?? src/admin/api/generation.js
?? src/admin/bootstrap.js
?? src/core/generation/config.js
?? src/core/generation/runtime.js
?? tests/unit/admin/bootstrap.test.js
?? tests/unit/admin/generation.test.js
?? tests/unit/core/generation/config.test.js
?? tests/unit/core/generation/runtime.test.js
```

Nothing committed, per the task's explicit instruction.

## Security boundary

- `GET /api/generation/status` never returns a raw environment object or
  any field beyond the documented shape (asserted by an exact-keys test).
- **`configuration.baseUrl.display` is redacted, not echoed raw.**
  `runtime.js`'s `getStatus()` passes `config.baseUrl.value` through
  `redactUrl()` (`src/core/doctor-checks.js` — protocol + host + port only;
  strips username, password, path, query, hash) before it is ever placed
  in the response, so an operator-configured `OLLAMA_URL` containing
  embedded credentials, a path, or a `?token=...` query string never
  reaches the client. This was **not** the original implementation: a
  first version returned `config.baseUrl.value` verbatim, which a code
  review confirmed live leaked credentials/path/query straight into the
  JSON body. Fixed in `runtime.js` itself (not the HTTP route), so any
  caller of `getStatus()` — not only the HTTP route — gets the safe value.
  Covered by a unit test on `runtime.getStatus()` directly and an
  HTTP-level test asserting the full raw response text (not just one
  field) contains no leaked credentials/path/query when `OLLAMA_URL` has
  all three.
- `reason` is separately passed through `sanitiseErrorMessage()`
  (`api/generation.js`, the same helper `api/ask.js` already uses) — a
  readiness reason string can embed arbitrary provider error text (e.g.
  "Ollama is not reachable at http://host:port"), which is a different
  shape of leak than the structured `baseUrl` field and needed its own
  redaction pass.
- `QDRANT_KEY` (an unrelated secret already present in this codebase's
  `sanitiseErrorMessage` calls) is redacted from the `reason` field the
  same way `api/ask.js` already redacts it — tested explicitly by
  temporarily setting a real-shaped `QDRANT_KEY` and asserting it never
  appears in the response body.
- Nothing else in the resolved config fields (`backend`, `model`, `numCtx`,
  `devicePolicy`) is URL- or secret-shaped, so `baseUrl` was the only
  structured field that needed redaction beyond the free-text `reason`.

## Limitations / documented follow-ups

- **`GENERATION_DEVICE` has exactly one supported value (`auto`)** — by
  design, since Ollama itself only supports automatic device selection
  today. The validation path for a *future* backend with real device
  choices (cpu/gpu) is already wired (an unsupported value produces a clear
  `GenerationConfigError`), but no backend currently exercises anything
  other than `auto`.
- **`createApp()`'s no-DI default loses provenance nuance** — when no
  `generationRuntime` is injected, the fallback treats `process.env` as
  "OS env" with empty `dotenvValues`, so a value that was actually set via
  `.env` (through some other code path's `dotenv/config` call) would be
  misreported as `os_env` provenance in that fallback path specifically.
  This only affects callers that skip `bootstrap.js` entirely; the real
  `npm run admin` entry point always supplies proper snapshots. Documented
  in `server.js`'s own comment at the default's definition.
- **No Settings UI, no cloud providers, no API-key persistence, no session
  provider switching, no local config-file writes** — all explicitly out of
  scope per the task, and confirmed untouched (`registry.js`'s `BACKENDS`
  map still lists only `ollama`; no new UI files were created or modified).
