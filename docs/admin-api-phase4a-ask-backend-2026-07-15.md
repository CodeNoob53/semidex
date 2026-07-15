# Admin API Phase 4A — Grounded Ask Backend with Ollama Streaming (2026-07-15)

Status: implemented, tested, live-verified against real Qdrant Cloud + real
Ollama (`gemma3:4b`). Not committed (per task instruction).

## Scope

Backend foundation for `question → hybrid retrieval → bounded evidence
assembly → grounded prompt → Ollama streaming generation → validated
citations/refusal → SSE response`. No Ask UI, no cloud providers, no chat
history, no settings UI — all explicitly out of scope per the task.

## What was built

### 1. Shared retrieval service — `src/core/retrieval/search.js` (new)

Extracted the hybrid-search orchestration (mode resolution, collection-exists
check, query embedding, the always-on `excludeNav` filter, `searchHybrid`
call) out of `src/admin/api/search.js` into a provider-neutral core module.
`resolveSearchMode()` and `runHybridSearch({ adapter, embedQuery, collection,
query, top, filters })` return typed `{ error, message }` results (no
`HttpError`, no req/res — this module has no HTTP concerns) so both an HTTP
adapter and the Ask evidence pipeline can render failures however they need.

`src/admin/api/search.js` is now a thin wrapper: body validation, calling
`runHybridSearch`, mapping its typed errors to the existing 501/404/500
`HttpError`s, then window expansion (`expandWindows`/`toWindowChunk`, which
stayed admin-route-local since Ask doesn't need windowed results — it uses
`getAnchoredContent()` instead). `/api/search`'s response shape and ranking
are unchanged — verified by the pre-existing `search.test.js` suite passing
unmodified against the refactored route. MCP search
(`src/mcp/tools/search.js`) was not touched, per the task's explicit
instruction.

### 2. Generation provider boundary — `src/core/generation/` (new)

- **`provider.js`** — the `GenerationProvider` contract (`name()`,
  `capabilities()`, `ready()`, `generate({ prompt, model, options, signal,
  onToken })`) plus `validateGenerationProvider()`, a shallow shape
  validator mirroring `storage/adapter.js`'s `validateStorageAdapter()`.
- **`ollama-provider.js`** — `createOllamaProvider({ baseUrl, model })`
  implements the contract over `src/core/ollama.js`. `ready()` checks
  reachability + required-model presence (reusing `isOllamaReachable`,
  `listOllamaModels`, `validateOllamaModels` — no duplicated fetch/error
  logic); `generate()` delegates to a new `generateStream()` in
  `ollama.js` (see below). Never calls `ollama serve`. Model defaults to
  `process.env.CONTEXT_MODEL || 'gemma3:4b'` — the existing
  project-wide convention (used identically in `jobs.js`, `system.js`,
  `doctor-checks.js`, the indexer's context/tag phases), not a new
  `ASK_MODEL` variable, per the task's explicit instruction to inspect
  existing conventions first.
- **`registry.js`** — `createGenerationProvider({ backend })`, keyed by
  backend name, mirroring `storage/factory.js`'s exact pattern. One
  registered backend (`ollama`) today; a cloud provider (Phase 4A.5) adds
  an entry to the same `BACKENDS` map without reworking callers.

**`src/core/ollama.js`** gained `generateStream(model, prompt, { format,
options, signal, onToken })` — streams `POST /api/generate` with
`stream: true`, parsing Ollama's newline-delimited JSON response frames,
calling `onToken` per fragment, and resolving `{ text, tokensIn, tokensOut,
aborted }` (`tokensIn`/`tokensOut` from Ollama's `prompt_eval_count`/
`eval_count` on the final frame). Reuses `OLLAMA_URL` and the same
request/error-text shape as the existing non-streaming `generate()` — no
duplicated URL resolution or error handling.

### 3. Evidence pipeline — `src/core/ask/` (new)

- **`evidence.js`** — `buildEvidence({ adapter, embedQuery, countTokens,
  collection, question, sourceFile, top, perSourceTokenBudget })` runs
  `runHybridSearch` (default `top=5`), preserves rank order, and for each
  hit:
  - **Skeleton hit (has `nodeId`)**: expands to section scope via the
    Phase 3X primitive `getAnchoredContent()` (bounded per-source budget,
    default 700 tokens, `separatorText: '\n\n'` — the current
    serialize-and-count-once shape, not the older per-boundary token
    count). Hits whose section-scope key (`parentId`, i.e. the section's
    own `nodeId`) collides are deduplicated to one evidence block.
  - **Legacy hit (no node identity)**: falls back to the hit's own chunk
    text, char-ratio-trimmed to the same per-source budget with a
    `truncated` flag — no assembly service involved, an intentionally
    approximate trim (documented as such in the code) since legacy text is
    prose, not structural content.

  Each source: `{ n, sourceFile, chunkIndex, section, snippet, nodeId,
  nodePath, nodeType, truncated }`, numbered sequentially from 1
  regardless of dedup gaps. Zero hits → `{ sources: [] }`, never an error.
- **`prompt.js`** — `buildPrompt(sources, question)`, pure. Implements the
  design doc's template with one change: the "say so plainly" refusal
  instruction is replaced by an exact, language-independent sentinel,
  `REFUSAL_SENTINEL = '[[INSUFFICIENT_EVIDENCE]]'`, which the model is told
  to emit verbatim and nothing else when evidence doesn't answer the
  question. The node-marker (`[node: <path>]`) rule is included only when
  at least one source is a structural node (`table`, `code_block`, or
  `checklist`) with a `nodePath`. Whole-prompt budgeting is active:
  `fitEvidenceToContextBudget()` reserves
  `RESERVED_HEADROOM_TOKENS = 1024`, drops the lowest-ranked sources until
  the reconstructed prompt fits the provider's effective `numCtx`, and the
  coordinator passes that same value as `options.num_ctx` to generation.
- **`citations.js`** — `validateCitations(rawText, sources)`, pure.
  Detects the refusal sentinel via exact trimmed-string match (not
  substring — embedding the sentinel inside longer text does not count as
  refusal); extracts `[n]` citations, splitting `citations` (valid,
  1..N) from `invalidCitations` (out of range), both deduped and ordered;
  validates `[node: path]` markers against `sources`' `nodePath`s, keeping
  valid ones in `text` and stripping+reporting invalid ones in
  `strippedMarkers`. Never reads a `score` field — grounding is judged
  only by whether cited numbers/paths exist in the evidence, matching this
  project's standing "no absolute RRF-score confidence" doctrine.
- **`coordinator.js`** — `createAskCoordinator({ adapter, embedQuery,
  countTokens, generationProvider })` returns `{ ask, isBusy }`.
  `ask({ collection, question, sourceFile, top, signal, onSources,
  onToken })` runs: `generationProvider.ready()` check → `buildEvidence` →
  `onSources(...)` → (if zero evidence: return `refused` without ever
  calling `generate()`) → `buildPrompt` → `generationProvider.generate()`
  → `validateCitations`. Owns a single in-process `busy` boolean lock:
  a concurrent `ask()` call returns `{ status: 'busy' }` immediately,
  never touching the adapter/provider; the lock is released in a
  `finally` block covering every exit path (done, refused, aborted,
  error, provider-unavailable).

### 4. `POST /api/ask` — `src/admin/api/ask.js` (new), SSE — `src/admin/sse.js` (new)

`registerAskRoutes(router, adapter, { askCoordinator })`. Request body:
`{ collection, question, sourceFile?, top? }` (`top` 1..10, default 5).
Validation and unknown-collection checks happen before any stream (plain
JSON 400/404). The coordinator's `provider_unavailable` and pre-stream
retrieval-error results (`not_implemented`/`collection_not_found`/
`embedding_failed`) also map to plain JSON responses (503/501/404/500)
before any `res.writeHead` for SSE — verified by tests that the response
`content-type` is `application/json` in these cases, never
`text/event-stream`.

Once evidence retrieval succeeds, `sources` is written (exactly once,
first), then 0..N `token` events as `onToken` fires, then exactly one
terminal event:
- `done` on success or refusal (refusal carries `refused: true,
  refusalReason: 'no_evidence'` and omits provider/model/token-count
  fields, since the provider was never called),
- `error` (`code: 'generation_failed'`) if `generate()` throws after
  streaming started,
- `error` (`code: 'stream_aborted'`) if the client disconnected.

`src/admin/sse.js` provides `startSse`, `writeSseEvent`, `waitForDrain` —
plain `node:http` framing consistent with `http.js`'s existing style, no
framework. `http.js` gained `tooManyRequests()` (429, `busy`) alongside the
existing `badRequest`/`notFound`/`conflict`/`dependencyUnavailable`.

**Client disconnect → abort wiring**: `res.on('close', ...)` (not
`req.on('close', ...)`) triggers the `AbortController` forwarded into
`generationProvider.generate()`'s `signal`. This was a deliberate fix
during implementation — see Bugs Found and Fixed below.

### 5. DI wiring — `src/admin/server.js`

`createApp()` gained `generationProvider`, `askCoordinator`, `countTokens`
as optional DI params, following the file's existing `param ?? default()`
convention exactly. Default `countTokens` lazily resolves the real BGE-M3
tokenizer via `getTokenCounter({ mode: 'bge-m3' })` on first Ask request —
never at import/startup time (mirrors `getContent.js`'s own lazy-resolution
pattern for the same tokenizer). `generationProvider` defaults to
`createGenerationProvider()` (constructing an `ollama-provider` — pure
object construction, no network call until `.ready()`/`.generate()` are
invoked, so this is safe to default-construct even in tests that never
override it). `askCoordinator` defaults to a coordinator built from the
same adapter/embedQuery/countTokens/generationProvider — one shared
instance per server process, so the busy-lock is meaningful.

### 6. Layering test extended

`tests/unit/admin/server.test.js`'s existing "no Qdrant SDK" layering test
now also forbids `from '.../core/ollama.js'` imports anywhere under
`src/admin/`, per the design doc's explicit instruction. One narrow,
documented exemption: `src/admin/system/ollama.js`, a pre-existing
readiness-check wrapper used only for indexer job-preflight (injected via
`checkOllamaFn` DI), unrelated to generation — the comment in the test
explains why it's exempt rather than silently allow-listing it.

## Bugs found and fixed

**`generateStream()`'s NDJSON parser silently produced empty output against
a real `fetch()` response.** Caught only by the mandated live Ollama check
(unit tests all stub `generateStreamFn` wholesale, so nothing exercised the
real byte-parsing loop). Root cause: `fetch()`'s `Response.body` yields
`Uint8Array` chunks, not Node `Buffer`s; the original code did
`Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk`, and for a plain
`Uint8Array` fell into string-concatenating the array's default
`toString()` — a comma-separated byte-value list, not UTF-8 text — so every
JSON line failed to parse and no tokens were ever emitted. Fixed by always
decoding via `TextDecoder` (`stream: true` across chunks, correctly
handling a multi-byte UTF-8 character split across a chunk boundary).
Regression-tested in `tests/unit/core/ollama.test.js` with a fake
`Uint8Array`-yielding async-iterable body reproducing the exact shape:
happy path, a UTF-8 character split across two chunks, a JSON line split
across two chunks, and an aborted-mid-stream case.

**`req.on('close', ...)` never fired for client-disconnect detection.**
`readJsonBody(req)` fully consumes the request's readable stream before the
handler proceeds; by the time `await readJsonBody(req)` resolves, `req` has
already reported `closed: true` as a normal consequence of the body being
fully read — unrelated to whether the client is still connected for the
(long-lived) SSE response that follows. Attaching `req.on('close', ...)`
after that point either fires immediately (falsely triggering an abort) or,
as observed, never fires again (the event already happened). Fixed by
listening on `res.on('close', ...)` instead — the response socket, which
stays open for the life of the SSE stream and only closes when the
underlying connection is actually torn down (client abort, or normal
`res.end()` after the terminal event, by which point nothing is listening
on the signal anymore). Verified live and by a dedicated HTTP-level test
(`tests/unit/admin/ask.test.js`, "client abort" describe block) asserting
the provider's `AbortSignal` fires and the coordinator's lock releases.

Both were caught before commit; neither shipped in an untested state.

## Code review fixes (round 2, 2026-07-15)

A structured code review found 8 findings (7 P1, 1 P2) against the delivered
Phase 4A implementation. All were confirmed against the code before fixing,
fixed, regression-tested, and live-verified where applicable.

**[P1] Refusal sentinel streamed to the client before stripping.** The
original coordinator forwarded every `onToken` fragment to the SSE layer
immediately; `validateCitations()` only stripped `REFUSAL_SENTINEL` from
`genResult.text` *after* generation completed — but by then the raw sentinel
had already streamed to the client character-by-character (confirmed live
in the original report: 9 streamed fragments spelling out
`[[INSUFFICIENT_EVIDENCE]]`). Fixed by adding a `createSentinelGuard()` in
`coordinator.js` that holds back streamed tokens while the accumulated text
remains a possible prefix of `REFUSAL_SENTINEL`, flushing everything held
once the text provably diverges (a real answer), or discarding it entirely
if the full response turns out to be an exact sentinel match (a refusal) —
`finalize()` handles the case where the model's answer is shorter than the
sentinel and never diverges mid-stream. Live-reverified: a refusal now
produces zero `token` events (previously 9), while `completionTokens: 10`
confirms the model still generated the sentinel internally — it just never
reaches the client.

**[P1] Backpressure not actually enforced (potential memory growth under a
slow client).** `ollama.js`'s NDJSON-parsing loop called `onToken?.(...)`
without awaiting it, and `ask.js`'s `onToken` fired-and-forgot
`waitForDrain(res)` instead of returning it. Fixed both ends: `ollama.js`
now `await`s `onToken`, and `ask.js`'s `onToken` returns the drain-wait
promise (or `undefined` when no backpressure). The coordinator's
`sentinelGuard.push()`/`finalize()` also propagate whatever `onToken`
returns, so the awaited chain is unbroken from the NDJSON parse loop through
to the SSE write. Regression-tested with a slow `onToken` in both
`ollama.test.js` (asserting per-frame processing order) and
`coordinator.test.js` (asserting `generate()` doesn't resolve until a slow
`onToken` finishes).

**[P1] Structural node references were non-functional end to end.** Three
compounding bugs: (a) `evidence.js` overwrote a source's `nodePath` with the
*section's* nodePath (from `getAnchoredContent()`'s return value) instead of
keeping the originally-retrieved entity's own path — a table's citation
would point at its containing section, not the table; (b) `prompt.js` never
included the node path anywhere in the evidence text shown to the model, so
even a correct path couldn't be cited: the model was told "you may cite
`[node: <node_path>]`" without ever seeing what that path was; (c)
`hasStructuralNodes`/marker validation treated *any* `nodePath` (including a
plain paragraph's) as eligible for a `[node: ...]` reference. Fixed: (a)
`evidence.js` now keeps the anchor hit's own `nodeId`/`nodePath`/`nodeType`
as `const`, never overwritten by section expansion; (b) `prompt.js`'s
`formatSourceHeader()` now renders `[node: <path>]` directly in each
structural source's evidence header, so the model can see and copy the
exact path; (c) both `prompt.js` and `citations.js` gate structural
eligibility on `nodeType ∈ {table, code_block, checklist}` (mirroring
`STRUCTURAL_CONTENT_TYPES` in `src/indexer/phases/node-policy.js`), not on
`nodePath` presence alone. Live-verified end to end: a real table hit's
`nodePath` now correctly includes its own node suffix (not the section's),
and an HTTP-level test confirms the prompt actually contains the exact
`[node: <path>]` string and the model's citation of it round-trips through
to `done.entityRefs`.

**[P1] Legacy evidence truncation could overshoot the requested budget.**
The single-shot ratio-based character trim (`maxTokens / count`) was never
re-verified against the real tokenizer, and token density is not uniform
across text — the reviewer's repro: `perSourceTokenBudget=5` produced a
21-token result. Fixed by replacing the ratio guess with a binary search on
character offset (mirroring `token-count.js`'s own `takeLastTokens()`,
which does the same search from the opposite end), guaranteeing the
returned prefix's real token count is `<= maxTokens`. The existing test's
wrong assertion (`<= 50` instead of `<= 5`) was corrected, and a new test
sweeps multiple budgets (1, 2, 3, 7, 15, 40) asserting the real count never
exceeds the requested budget at any of them.

**[P1] Overall prompt was never bounded against the model's real context
window.** `RESERVED_HEADROOM_TOKENS` was declared in `prompt.js` but never
read anywhere — per-source budgets (700 tokens each) bounded individual
evidence blocks, but nothing bounded the *whole* reconstructed prompt
(system rules + all evidence + question) against `num_ctx`, so `top=5` could
in principle assemble ~3.5k+ evidence tokens into a prompt for a
smaller-context model with no check. Fixed: `ollama-provider.js`'s
`ready()` now also resolves and reports `numCtx` (via
`getModelContextLength()`, which already has a safe 4096 fallback and never
throws); `evidence.js` gained `fitEvidenceToContextBudget(sources, question,
numCtx, countTokens)`, which drops the lowest-ranked (highest `n`) sources
one at a time — never re-truncating a kept source's already-bounded text —
until the real, reconstructed prompt's token count fits `numCtx -
RESERVED_HEADROOM_TOKENS`, then renumbers sequentially. The coordinator
calls this between `buildEvidence()` and `onSources()`, so the client only
ever sees the sources that actually made it into the prompt. When trimming
would drop every source, the turn correctly becomes a `no_evidence` refusal
rather than exceeding the budget. This is enforced now, not deferred to a
follow-up.

**[P1] `ollama-provider.js`'s `baseUrl` was silently ignored during
generation.** `ready()` correctly used the configured `baseUrl` for
reachability/model checks, but `generate()` called `generateStreamFn(model,
prompt, { options, signal, onToken })` — omitting `baseUrl` entirely — and
`ollama.js`'s `generateStream()` always built its request URL from the
module-level `OLLAMA_URL` constant, ignoring any `baseUrl` option
altogether. Reviewer's repro confirmed live: a provider constructed with
`baseUrl=http://example.invalid:9999` actually generated against
`localhost:11434`. Fixed both ends: `generateStream()` now accepts and uses
a `baseUrl` option (defaulting to `OLLAMA_URL`, trailing slash stripped,
same normalization `isOllamaReachable`/`listOllamaModels` already use), and
`ollama-provider.js`'s `generate()` now passes its own `baseUrl` through.
Regression-tested in both files.

**[P1] Raw provider/generation error text could leak through the API
without redaction.** The router's catch-all only redacts *uncaught*
exceptions (`sanitiseErrorMessage`, in `router.js`'s `catch` block) — a
deliberately-thrown `HttpError` bypasses it entirely, and so does an SSE
event payload (which is never routed through the catch-all at all, since
`res.end()` has already started). Two leak points: `ask.js` passed
`result.reason` (from `ollama-provider.js`'s `ready()`, which embeds the
raw configured `baseUrl`) straight into `dependencyUnavailable()`, and
`result.message` (potentially containing a raw Ollama response body via
`ollama.js`'s thrown errors) straight into the SSE `error` event. Fixed by
importing `sanitiseErrorMessage` from `core/doctor-checks.js` (a pure
module with no `core/ollama.js` dependency, so this doesn't reintroduce a
layering violation) and wrapping both leak points, plus the pre-stream
retrieval-error path, through a local `safeMessage()` helper. Regression-
tested with a URL containing an embedded query-string secret and a raw
error body containing a leaked key, both asserted absent from the client-
visible response.

**[P2] `searchMode` was derived from post-hoc source count instead of the
actual retrieval result.** The coordinator computed `searchMode:
sources.length > 0 ? 'hybrid' : null` — so a hybrid search that legitimately
ran but found zero hits wrongly reported `searchMode: null`, as if no
search mode had been used at all. Fixed by threading the real `searchMode`
value through from `runHybridSearch()`'s result (via `buildEvidence()`'s
return value) instead of re-deriving it from array length — a completed
hybrid search now always reports `searchMode: 'hybrid'`, hit count
notwithstanding. This also had to be computed from evidence *before*
context-budget trimming (the P1 fix above), since a source count of 0 after
trimming is not the same as retrieval finding nothing.

All 8 fixes are covered by new or corrected tests (21 new tests across
`coordinator.test.js`, `evidence.test.js`, `prompt.test.js`,
`citations.test.js`, `ollama.test.js`, `ollama-provider.test.js`, and
`ask.test.js`), the full suite (1240 tests, up from 1219), smoke (1293),
build, and `git diff --check` all re-verified green, and the refusal-leak
and structural-node-reference fixes were specifically re-checked live
against real Qdrant Cloud + real Ollama (`gemma3:4b`) after fixing.

## Code review fixes (round 3, 2026-07-15)

A third review pass found 3 more P1 findings, all against the round-2
fixes themselves — confirmed, fixed, tested, and live-reverified.

**[P1] `numCtx` was not a real, enforced runtime context — and `/api/show`
still ignored `baseUrl`.** Two compounding issues: (a)
`getModelContextLength()` reports the model's *architectural maximum*
(`model_info.*.context_length` from `/api/show`) — per Ollama's own docs
(Show model details vs. Context length are documented as two different
things), this is NOT the context Ollama will actually allocate for a
request; an unset `num_ctx` runs at a much smaller undocumented runtime
default regardless of the model's ceiling. `ready()` reported this maximum
as `numCtx`, but `generate()` never passed any `num_ctx` to the actual
request at all — so the coordinator's context-budget trimming
(`fitEvidenceToContextBudget`) bounded the prompt against a number Ollama
was never told to honor. (b) `showModel()` (backing both
`getModelContextLength()` and `isThinkingModel()`) still hardcoded the
module-level `OLLAMA_URL`, ignoring any `baseUrl` argument — the same class
of bug fixed for `generateStream()` in round 2, missed here. Confirmed live:
a custom-`baseUrl` provider's `/api/show` call still hit
`http://localhost:11434`. Fixed: `showModel()`/`getModelContextLength()`/
`isThinkingModel()` now accept and use `baseUrl`, with the internal
`/api/show` response cache keyed by `` `${baseUrl}|${model}` `` (not model
alone, so two providers targeting different Ollama instances never share a
cache entry). `ollama-provider.js` now computes an *effective* Ask context —
`numCtx = min(DEFAULT_ASK_NUM_CTX=8192, modelMax)` — reports it from
`ready()`, and the coordinator passes that exact same value as
`options.num_ctx` on the `generate()` call, so the number the budget was
computed against and the number Ollama is actually asked to allocate are
guaranteed identical. `generate()` also defaults `options.num_ctx` to
`DEFAULT_ASK_NUM_CTX` when no options are given at all, so a caller that
skips `ready()` still gets a bounded request rather than Ollama's smaller
undocumented default.

**[P1] A client disconnect during backpressure left the coordinator
permanently `busy`.** `waitForDrain()` only listened for `'drain'` — a
socket that closes while the internal write buffer is still full never
fires `'drain'` (nothing drains a dead connection), so the promise the
NDJSON-parsing loop's `await onToken(...)` was waiting on never resolved.
That meant `generateStream()` never returned, `generate()` never resolved,
and the coordinator's `finally { busy = false }` never ran — every
subsequent Ask request would see `busy` forever, until the process
restarted. Confirmed at runtime (`drain_after_close` stayed pending). Fixed
`waitForDrain()` to also resolve on `'close'` and `'error'`, remove all
three listeners once any one fires (no leak across repeated calls on the
same long-lived `res`), and resolve immediately without attaching any
listener at all if `res.destroyed`/`res.writableEnded` is already true by
the time it's called. Also fixed `ask.js`'s `onSources` to return the same
drain-wait promise `onToken` already did (the sources payload can itself be
large), and the coordinator now `await`s `onSources(...)`, matching how it
already awaits `onToken`'s return value.

**[P1] The sentinel guard compared raw (untrimmed) held text against the
sentinel, leaking whitespace-wrapped refusals.** `validateCitations()`
correctly compares `text.trim()` against `REFUSAL_SENTINEL`, but the
streaming guard added in round 2 compared raw `held` text — a response of
`"\n[[INSUFFICIENT_EVIDENCE]]\n"` has a leading `"\n"` that is not a prefix
of `"[["`, so the guard set `diverged = true` on the very first character
and streamed the ENTIRE sentinel that followed as if it were a normal
answer. Confirmed at runtime for exactly that input. Fixed by comparing
`held.trim()` against the sentinel instead of raw `held`: all-whitespace
accumulated text is held indefinitely (never counted as "diverged"), and a
trimmed match against the sentinel (exact or still-a-prefix) continues to
hold regardless of untrimmed leading/trailing whitespace. `finalize()`'s
own comparison (`fullText.trim() !== REFUSAL_SENTINEL`) was already
correct and needed no change.

All 3 fixes are covered by new tests: `getModelContextLength`'s `baseUrl`/
cache-key behavior and `ollama-provider.js`'s `numCtx` capping/`baseUrl`
plumbing/`generate()` `num_ctx` defaulting (round 3: +11 tests across
`ollama.test.js` and `ollama-provider.test.js`); a dedicated new
`tests/unit/admin/sse.test.js` for `waitForDrain()`'s close/error/already-
destroyed/listener-cleanup behavior (7 tests) plus a coordinator-level
disconnect-during-backpressure regression test; three new whitespace-
wrapped-sentinel tests in `coordinator.test.js` and one HTTP-level
equivalent in `ask.test.js`, plus two coordinator tests asserting
`readiness.numCtx` round-trips into `generate()`'s `options.num_ctx`. Full
suite: 1263 tests (up from 1240), smoke (1293), build, and
`git diff --check` all re-verified green. Live-reverified: `ready()` now
reports a real, capped `numCtx: 8192` for `gemma3:4b`, a `generate()` call
with that `num_ctx` succeeds normally, and the refusal path still produces
zero leaked token events end to end.

## Tests

New/changed test files, all offline (stub adapters/providers, no Qdrant/
Ollama/ONNX initialization). Per-file counts below are as of the initial
(round-1) implementation; the round-2 and round-3 sections above list what
was added on top. Current totals: 199 targeted tests, 1263 full-suite tests,
1293 smoke tests, all passing.

- `tests/unit/core/retrieval/search.test.js` (8 tests) — mode resolution,
  typed error results, `excludeNav` always set, filter merging, hit
  passthrough.
- `tests/unit/core/generation/provider.test.js` (4), `ollama-provider.test.js`
  (7), `registry.test.js` (2) — shape validation, readiness matrix
  (unreachable / model missing / ok), `generate()` delegation and model
  override, unknown-backend error.
- `tests/unit/core/ask/prompt.test.js` (5), `citations.test.js` (9),
  `evidence.test.js` (9), `coordinator.test.js` (9) — prompt structure and
  conditional node-marker rule; sentinel/citation/marker validation
  including dedup and out-of-range handling; retrieval-error passthrough,
  legacy fallback, section-scope expansion and dedup, sequential
  numbering, truncation flagging; the full readiness → evidence → sources
  → generate → citations flow, refusal, generation failure, abort, busy,
  and lock-release-on-every-exit-path.
- `tests/unit/admin/ask.test.js` (12) — full SSE contract over a real
  `node:http` server: validation 400s, unknown-collection 404, provider
  503 (never calls `generate`), happy-path event ordering and `done`
  metadata, zero-evidence refusal (never calls `generate`), generation
  failure → `error` not `done`, concurrent request 429 (never starts a
  second stream), client abort (provider signal fires, lock releases),
  pre-stream retrieval error → JSON 500.
- `tests/unit/core/ollama.test.js` — added `generateStream` describe block
  (4 tests, see Bugs Found above).
- `tests/unit/admin/server.test.js` — layering test extended for
  `core/ollama.js`, with the `system/ollama.js` exemption documented.

Targeted run (initial): 139 new/changed-suite tests, all passing, serially
(`NODE_OPTIONS='--max-old-space-size=768' node --test --test-concurrency=1`).
After the round-2 code review fixes: 176 targeted tests (+37: 21 genuinely
new plus corrected/expanded existing ones), all passing. Full suite:
`npm test` → 1240 passed, 0 failed (up from 1219). `npm run smoke` → 1293
passed, 0 failed. `npm run admin:build` → succeeds (224 modules,
~258 kB JS bundle, unchanged — no UI code was touched). `git diff --check` →
clean (line-ending warnings only, pre-existing repo convention, exit 0).

## Live verification

Ran the real admin server (`node src/admin/server.js`) against the real
Qdrant Cloud instance and real `ollama serve` with `gemma3:4b`, against the
`nodejs-basics` collection (Ukrainian-language course material) — once
before the round-2 code review, and again after applying all 8 fixes:

**Initial pass:**
1. **Happy path**: a real question streamed 35 real `token` events, ended
   with `done` containing a valid `citations: [2]`, real
   `promptTokens`/`completionTokens` from Ollama, `elapsedMs`.
2. **Refusal**: an out-of-scope question ("capital of France... quantum
   computing") caused `gemma3:4b` to emit the literal
   `[[INSUFFICIENT_EVIDENCE]]` sentinel across 9 token fragments — which, at
   the time, streamed to the client raw (the sentinel-leak bug the round-2
   review caught).
3. Confirmed evidence expansion via `getAnchoredContent()` worked against
   real skeleton-chunked data (`truncated: true` correctly flagged when a
   section exceeded the 700-token per-source budget).

**Re-verification after the round-2 fixes** (same collection, same model):
1. **Refusal, re-checked**: the same out-of-scope question now produces
   `done { refused: true }` with **zero** `token` events reaching the
   client — `completionTokens: 10` in the response confirms the model still
   generated the sentinel internally, it simply never streams out. This is
   the direct live confirmation of the sentinel-guard fix.
2. **Happy path, re-checked**: normal streaming is unaffected — 34 real
   `token` events, a valid `citations: [1]`, `searchMode: "hybrid"`.
3. **Structural node references, re-checked**: a retrieved `code_block`
   hit's `nodePath` in the `sources` event now correctly carries the
   entity's own node suffix (e.g. `...#основні-вбудовані-модулі/code_block-12`)
   instead of the section's path, confirming the evidence.js overwrite fix
   live against real skeleton data.

Both background processes (`ollama serve`, `node src/admin/server.js`)
were stopped after each verification pass; no scratch files or background
processes were left running.

## Changed files

```
M  docs/design/admin-ui-ux-and-ask-plan.md
M  docs/design/ask-chat.md
M  src/admin/api/search.js
M  src/admin/http.js
M  src/admin/server.js
M  src/core/ollama.js
M  tests/unit/admin/server.test.js
M  tests/unit/core/ollama.test.js
?? docs/admin-api-phase4a-ask-backend-2026-07-15.md   (this report)
?? src/admin/api/ask.js
?? src/admin/sse.js
?? src/core/ask/evidence.js
?? src/core/ask/prompt.js
?? src/core/ask/citations.js
?? src/core/ask/coordinator.js
?? src/core/generation/provider.js
?? src/core/generation/registry.js
?? src/core/generation/ollama-provider.js
?? src/core/retrieval/search.js
?? tests/unit/admin/ask.test.js
?? tests/unit/core/ask/prompt.test.js
?? tests/unit/core/ask/citations.test.js
?? tests/unit/core/ask/evidence.test.js
?? tests/unit/core/ask/coordinator.test.js
?? tests/unit/core/generation/provider.test.js
?? tests/unit/core/generation/registry.test.js
?? tests/unit/core/generation/ollama-provider.test.js
?? tests/unit/core/retrieval/search.test.js
```

Nothing committed, per the task's explicit instruction.

## Limitations / documented follow-ups

- **Context-budget trimming drops whole sources, not partial content.**
  `fitEvidenceToContextBudget()` (added in the round-2 fixes) enforces
  `numCtx − RESERVED_HEADROOM_TOKENS` as a real bound on the whole prompt,
  but its only lever is dropping the lowest-ranked source entirely — it
  never further truncates a source that's already within its own
  per-source budget. For a very small `numCtx` this can mean fewer, not
  smaller, evidence blocks. This is a deliberate simplicity tradeoff (never
  re-truncating already-bounded text silently) rather than a gap, but a
  follow-up could explore proportionally shrinking per-source budgets
  before dropping sources outright.
- **Token-count honesty boundary** (by design, not a gap): evidence token
  budgets use the real BGE-M3 tokenizer, exact for the text it measures but
  only a proxy for the generation model's own tokenizer. This is
  documented in `evidence.js`'s and `prompt.js`'s header comments and in
  `docs/design/ask-chat.md`'s updated §5.3 — no code path claims exact
  Gemma context accounting.
- **Settings/knobs are not user-configurable yet** (`top`, per-source
  budget, model) — all are either request parameters (`top`) or
  environment/code defaults (`CONTEXT_MODEL`, `DEFAULT_PER_SOURCE_TOKEN_BUDGET`).
  Phase 4A.5 (explicitly out of scope here) is where these become Settings
  UI-configurable.
- No Ask UI, no cloud providers, no chat history/multi-turn, no MCP Ask
  tool — all confirmed untouched, per the task's non-scope list.
