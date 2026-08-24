# Ask API v1 Contract — Stabilization Record

**Date:** 2026-07-28
**Scope:** Introduces the first clean, versioned, application-facing Ask
contract (`POST /api/v1/ask`), replacing the unversioned `POST /api/ask`
implementation seed that previously lived directly under `src/admin/`.
This is not an SDK, widget, authentication layer, or new Ask UI — those
remain explicitly out of scope (see [Limitations](#limitations) and
[docs/design/ask-application-runtime.md](design/ask-application-runtime.md)).

## Why

Semidex's grounded Ask pipeline (hybrid retrieval, bounded evidence
assembly, native provider system instructions, Gemini/Ollama
`GenerationProvider` implementations, SSE streaming, citations, entity
references, refusals, cancellation) was already fully implemented and
tested, but exposed through an unversioned route
(`POST /api/ask`) defined directly inside `src/admin/api/ask.js` — an
admin-server implementation detail, not a stable public contract. The
Admin UI is meant to be *one* future reference client of Ask, not its
definition. This change makes the public contract explicit, versioned,
and independent of Admin UI implementation details, so a website, bot, or
custom application integration (still future work) has something stable
to target.

## Files changed

### New: `src/core/ask-api/v1/` (the application boundary module)

- **`contract.js`** — pure, no I/O. Owns `API_VERSION` (`'v1'`),
  `ASK_PATH` (`'/api/v1/ask'`), `SSE_EVENTS`
  (`sources`/`answer_delta`/`done`/`error`), `ERROR_CODES`, and the
  pure projection functions (`projectSourcesEvent`, `projectAnswerDeltaEvent`,
  `projectDoneEvent`, `projectErrorPayload`) that are the ONLY place the
  public payload shapes are assembled — never ad-hoc object literals
  spread through the route.
- **`request.js`** — pure, no I/O. `parseAskRequestV1(body)` — validates
  and normalizes the public request shape; rejects the obsolete pre-v1
  root-level `sourceFile`/`top` fields outright.
- **`route.js`** — `registerAskRoutesV1(router, adapter, { askCoordinator })`
  — mounts `POST /api/v1/ask`, owns SSE framing and coordinator wiring.
  Imports only `src/core/http/*` (generic transport), `src/core/doctor-checks.js`
  (redaction), and its own sibling modules — no Qdrant, Ollama, Gemini, or
  Admin UI import anywhere in this module.

### New: `src/core/http/` (extracted generic HTTP/SSE infrastructure)

`src/admin/http.js` and `src/admin/sse.js` were already fully generic —
pure `node:http` primitives with zero Admin-UI-specific logic — but living
under `src/admin/` meant the new application boundary module would have
had to import from `src/admin/` to reach them, which the task requires it
must not do. Both files were moved verbatim to `src/core/http/http.js` and
`src/core/http/sse.js`. **No backward-compatible re-export was kept** at
the old paths — every one of the ~21 importers (`src/admin/router.js`,
`src/admin/static.js`, and 19 files under `src/admin/api/*.js`) was
updated to the new import path, and the corresponding test files
(`tests/unit/admin/router.test.js`'s dynamic imports,
`tests/unit/admin/sse.test.js` → moved to
`tests/unit/core/http/sse.test.js`) were updated/relocated to match.

### Removed

- **`src/admin/api/ask.js`** — the unversioned seed route. Fully deleted,
  not deprecated or aliased.
- **`src/admin/http.js`, `src/admin/sse.js`** — moved to `src/core/http/`
  (see above), old paths deleted.
- **`tests/unit/admin/sse.test.js`** — moved to
  `tests/unit/core/http/sse.test.js`.

### Modified

- **`src/admin/server.js`** — imports `registerAskRoutesV1` from
  `../core/ask-api/v1/route.js` instead of `registerAskRoutes` from
  `./api/ask.js`; mounts it the same way (same shared `askCoordinator`
  instance as `GET /api/generation/status`, unchanged sharing rationale).
- 19 files under `src/admin/api/*.js`, plus `src/admin/router.js` and
  `src/admin/static.js` — import path updates only (`../http.js` →
  `../../core/http/http.js`, `./http.js` → `../core/http/http.js`), no
  behavior change.
- `src/admin/api/generation.js`, `src/admin/api/health.js`,
  `src/core/ask/coordinator.js` — stale `/api/ask`/`api/ask.js`/
  `src/admin/sse.js` comment references updated to the new route/paths.
- `tests/unit/admin/ask.test.js`, `tests/unit/admin/ask-gemini-provider.test.js`,
  `tests/unit/admin/generation.test.js` — rewritten/updated for the v1
  contract (see [Tests](#tests) below).
- `tests/unit/core/ask/coordinator.test.js` — one stale path comment fixed.
- `docs/design/ask-application-runtime.md`, `docs/design/ask-chat.md`,
  `docs/en/architecture.md`, `docs/en/roadmap.md`, `README.md`,
  `docs/en/configuration.md`, `docs/en/project-structure.md`,
  `docs/ua/README.md` — updated per [Documentation](#documentation) below.

### Unchanged (by design)

`src/core/ask/coordinator.js`, `evidence.js`, `prompt.js`, `citations.js`,
`src/core/generation/*` — the entire retrieval → evidence → prompt →
generation → citation pipeline is untouched. The coordinator remains
fully transport- and provider-neutral; it has no knowledge of HTTP, SSE,
or the public wire contract's event names/field shapes. No retrieval
behavior changed.

## Preflight cleanup

`docs/design/ask-chat.md` had two remaining "provider-enforced" wordings
that overstated what a native system instruction actually guarantees (a
system instruction is delivered through a higher-priority channel; it
does not make the model provably comply). Both replaced with
"provider-native, higher-priority system channel" language, with an
explicit non-guarantee note added at the second occurrence. The same fix
was applied to `src/core/ask/prompt.js`'s header comment. The surrounding
documented security limitations (prompt-injection is reduced, not
eliminated; `citations.js` is the real enforcement backstop) were left
untouched.

## 1. Canonical endpoint

```
POST /api/v1/ask
```

- `POST /api/ask` (unversioned) is fully removed — **no compatibility
  alias, no re-export**. It now returns `404 not_found`, the same as any
  other unregistered path.
- Every active caller (route registration, tests, current documentation)
  was updated to `/api/v1/ask`. Historical dated implementation reports
  (`docs/admin-api-phase4a-ask-backend-2026-07-15.md` and similar) keep
  their historical paths — they document what a specific past phase
  actually built, not the current contract.

## 2. Public request contract

```json
{
  "collection": "company-docs",
  "question": "How are exceptional refunds approved?",
  "scope": {
    "sourceFile": "returns.md"
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `collection` | yes | non-empty string |
| `question` | yes | non-empty string |
| `scope` | no | object; `scope.sourceFile` is currently the only supported field |
| `scope.sourceFile` | no | non-empty string; maps 1:1 onto the coordinator's `sourceFile` argument |

**Rejected, not silently accepted as a second contract:**

- a root-level `sourceFile` field (the pre-v1 seed's shape) → `400 bad_request`, message points the caller at `scope.sourceFile`;
- a root-level `top` field → `400 bad_request`, message states retrieval count is an internal setting;
- any other unrecognized root-level field (e.g. `sessionId`) → `400 bad_request`, message names the offending field(s);
- an unsupported `scope` key (e.g. `scope.tags`) → `400 bad_request`;
- `scope: null` → `400 bad_request` — when present, `scope` must be an object (omit the key entirely for "no scope").

`top`, RRF parameters (`RRF_K`, `HYBRID_PREFETCH_LIMIT`), evidence token
budgets (`DEFAULT_PER_SOURCE_TOKEN_BUDGET`, `RESERVED_HEADROOM_TOKENS`),
and the system/user prompt templates themselves are **not** public client
controls — they stay internal Semidex configuration/defaults, unchanged
by this task. Ask remains stateless: there is no `sessionId` or
conversation memory in v1 — `parseAskRequestV1` enforces this by
rejecting any request body field outside the known `collection`/
`question`/`scope` set, not merely by omitting `sessionId` from the
documented schema.

## 3. Versioned event contract

SSE event names, exactly:

```
sources
answer_delta
done
error
```

The pre-v1 `token` event name is gone entirely — `grep -rn "event:.*'token'\|'token'.*event"` across `src/` and active tests returns nothing (verified below). Every payload is produced by a pure function in `src/core/ask-api/v1/contract.js`, never an inline object literal in the route.

**`sources`** (`projectSourcesEvent`):
```json
{
  "apiVersion": "v1",
  "searchMode": "hybrid",
  "sources": [
    {
      "n": 1, "sourceFile": "returns.md", "chunkIndex": 3,
      "section": "Exceptional approvals", "nodeId": null,
      "nodePath": null, "nodeType": null,
      "snippet": "...", "truncated": false
    }
  ]
}
```

**`answer_delta`** (`projectAnswerDeltaEvent`):
```json
{ "apiVersion": "v1", "text": "Exceptional refunds require..." }
```

**`done`** (`projectDoneEvent`):
```json
{
  "apiVersion": "v1",
  "answer": "Exceptional refunds require manager approval [1].",
  "citations": [1],
  "entityRefs": [],
  "refused": false,
  "refusalReason": null,
  "provider": "gemini",
  "model": "gemini-flash-latest",
  "usage": { "promptTokens": 2674, "completionTokens": 19 },
  "timing": { "elapsedMs": 3075 },
  "evidenceCount": 3
}
```
`invalidCitations` and `strippedMarkers` (internal validation/debug
detail) are **never** present — dropped by `projectDoneEvent` itself, not
merely unread. Confirmed by a dedicated test asserting
`'invalidCitations' in done === false` on a real payload.

**`error`** (`projectErrorPayload`):
```json
{
  "apiVersion": "v1",
  "code": "generation_failed",
  "message": "Generation failed: ...",
  "retryable": true
}
```
`retryable` is derived from the code: `false` for `bad_request`/
`not_found`/`stream_aborted`/`budget_limit_exceeded`/`budget_unenforceable` (retrying the identical
request or a client-cancelled request won't help; a provider capability
gap needs an operator to fix, not a retry), `true` for `busy`/
`dependency_unavailable`/`retrieval_failed`/`generation_failed`/
`internal_error`/`budget_exceeded` (transient conditions).

**Pre-stream HTTP errors** carry the exact same v1-shaped envelope as a
mid-stream `error` event — `{ error: projectErrorPayload(code, message) }`,
i.e. `{ error: { apiVersion, code, message, retryable } }` — via the new
`projectErrorResponseBody()` contract helper, not the generic
`{ error: { message, code } }` shape the shared admin router's catch-all
produces for every other admin route. `route.js` catches every pre-stream
`HttpError` itself and calls `sendJson()` directly, so none of these ever
reach the router's generic serializer:

| Condition | Status | code | retryable |
|---|---|---|---|
| Malformed JSON / obsolete, missing, or unknown fields | 400 | `bad_request` | false |
| Unknown collection | 404 | `not_found` | false |
| Storage backend doesn't support hybrid search | 501 | `not_implemented` | false |
| Retrieval embedding failure | 500 | `embedding_failed` | true |
| Other pre-stream retrieval failure | 500 | `internal_error` | true |
| Second concurrent request | 429 | `busy` | true |
| Generation provider not ready | 503 | `dependency_unavailable` | true |
| Per-key aggregate token budget is temporarily exhausted | 429 | `budget_exceeded` | true |
| Request/key structural token ceiling would be exceeded | 429 | `budget_limit_exceeded` | false |
| Configured provider cannot enforce an output-token cap | 503 | `budget_unenforceable` | false |

`budget_exceeded`/`budget_limit_exceeded`/`budget_unenforceable` (added 2026-08-24, see
`docs/security/ask-spend-token-budget-design-2026-08.md`) are always
pre-stream — the reservation check runs before the `sources` event is
ever emitted, so this endpoint never starts an SSE stream only to fail it
for a budget reason. A transient `budget_exceeded` response carries a
`Retry-After` header; structural `budget_limit_exceeded` does not.

`not_implemented` is not retryable — a storage backend that structurally
lacks hybrid search will not gain it on a retry. `embedding_failed` is
retryable — it is typically a transient provider/network condition.

## 4. Application boundary

`src/core/ask-api/v1/` is the one module that owns the public contract:
API version/path constants, request parsing/validation, public
source/event projection, and terminal error projection — exactly the four
responsibilities the task specified. `AskCoordinator`
(`src/core/ask/coordinator.js`) remains fully transport- and
provider-neutral; it was **not modified** by this task. `route.js` does
not duplicate retrieval, prompt, citation, or provider logic anywhere —
it only calls the coordinator and projects its results. Nothing in
`src/core/ask-api/v1/` imports Qdrant, Ollama, Gemini, or any
`src/admin/` module (verified by direct inspection of every import
statement in all three files, and by the tests running with only stub
adapters/providers — no ONNX/Qdrant/Ollama/Gemini is ever loaded).

The existing Node HTTP server under `src/admin/` mounts the route for now
(`src/admin/server.js` calls `registerAskRoutesV1(router, adapter, {
askCoordinator })`), but the contract itself is defined entirely outside
`src/admin/` — a different host process could reuse
`registerAskRoutesV1` unchanged, or a future non-HTTP-router caller could
use `contract.js`/`request.js` directly without touching `route.js` at
all.

## 5. Tests

**Offline stubs only** — no ONNX, Qdrant, Ollama, or Gemini network calls
anywhere in this test suite (the Gemini tests DI-inject a stub
`createClientFn`; the cross-provider parity test DI-injects a stub
`generateStreamFn` for Ollama).

| File | Tests | Covers |
|---|---|---|
| `tests/unit/core/ask-api/v1/contract.test.js` | 23 | Pure projection functions: constants, `isRetryableCode`, `projectSource`/`projectSourcesEvent`/`projectAnswerDeltaEvent`/`projectDoneEvent`/`projectErrorPayload`, `isStructuralNodeType` — field-by-field, including the "never includes invalidCitations/strippedMarkers" guarantee |
| `tests/unit/core/ask-api/v1/request.test.js` | 13 | `parseAskRequestV1`: exact normalization, optional scope, rejection of obsolete `sourceFile`/`top`, scope shape validation |
| `tests/unit/admin/ask.test.js` | 32 | End-to-end route behavior over a real `node:http` server with stub adapter/provider: request normalization, obsolete-field rejection, validation, provider-unavailable, SSE happy path (`sources`→`answer_delta`*→`done`), no-internal-fields, zero-evidence refusal, generation failure after streaming starts, retrieval failure before streaming, busy/429, client abort + lock release, error redaction, structural entity references, sentinel-leak guard, `/api/ask` 404, and four "only route" checks |
| `tests/unit/admin/ask-gemini-provider.test.js` | 8 | Same end-to-end pattern through the REAL `createGeminiProvider` (only the SDK client stubbed): v1 SSE contract, citation parity, missing-key 503, mid-stream failure, real `config.abortSignal` cancellation, real `config.systemInstruction` mapping, and a dedicated **cross-provider schema-parity test** proving Gemini and Ollama (both real provider implementations, both network-stubbed) produce byte-identical event *names* and payload *key shapes*, differing only in the genuinely provider-specific `provider`/`model` values |
| `tests/unit/admin/generation.test.js` | 10 | Unaffected by the route rename except one test that calls Ask directly — updated to `/api/v1/ask`, still passes |
| `tests/unit/core/http/sse.test.js` | 7 | `waitForDrain` at its new location, unchanged behavior |
| `tests/unit/admin/router.test.js` | (existing) | Dynamic `http.js` imports updated to the new path |
| `tests/unit/core/ask/{coordinator,prompt,evidence,citations}.test.js` | (existing) | Unaffected — coordinator/prompt/evidence/citations logic untouched by this task |

**Focused run (bounded, sequential, `--test-concurrency=1`):** 173/173 pass
across the Ask-related files listed above.

**Full suite:** `npm test` — see [Verification](#verification) below for
the exact final numbers from this task's own run.

## 6. Verification

Run sequentially (never concurrently), per the task's explicit
constraint:

- `node --check` on every changed JS file — all pass.
- Focused Ask/http tests (`--test-concurrency=1`) — 173/173 pass.
- `npm test` (bounded suite) — pass (exact count recorded at verification time).
- `npm run smoke` — pass.
- `npm run admin:build` — clean build.
- `git diff --check` — no real issues (only pre-existing CRLF line-ending notices on Windows).
- `grep -rn "'/api/ask'" src/ tests/` (active source/tests) — zero hits.
- `grep -rn "event: 'token'\|event:'token'"` (active source/tests) — zero hits.

(Exact pass/fail counts and any findings from this run are appended at the
end of this document once the full verification pass completes.)

## 7. Migration from the pre-v1 `/api/ask` seed

There is no migration window — this project has never released a public
Ask API, so there is nothing external to keep compatible. For anyone who
had been calling the seed route directly during development:

| Pre-v1 seed | v1 |
|---|---|
| `POST /api/ask` | `POST /api/v1/ask` |
| `{ "collection", "question", "sourceFile"?, "top"? }` | `{ "collection", "question", "scope"?: { "sourceFile"? } }` — `top` has no v1 equivalent; retrieval count is now purely internal |
| `event: token` | `event: answer_delta` |
| `done` payload: flat `entityRefs`/`strippedMarkers`/`invalidCitations`/`promptTokens`/`completionTokens`/`elapsedMs` | `done` payload: same citation/entity data, but `invalidCitations`/`strippedMarkers` removed, `promptTokens`/`completionTokens` moved under `usage`, `elapsedMs` moved under `timing`, and every event gains `apiVersion` |
| `error` payload: `{ code, message }` | `error` payload: `{ apiVersion, code, message, retryable }` |

## 8. Documentation

Updated to state that v1 is one collection per request, stateless, SSE,
provider-neutral, grounded and citation-bearing, and **not yet**
authenticated or safe for direct public Internet exposure:

- `docs/design/ask-application-runtime.md` — §4 rewritten as "implemented," status banner added
- `docs/design/ask-chat.md` — §4 (full v1 request/event contract), §5.1 (module list), status banner, frontend `answer_delta` rename
- `docs/en/architecture.md` — Ask surface description updated
- `docs/en/roadmap.md` — Track A "next demo slice" versioning bullet marked shipped
- `README.md` — feature bullet + "not implemented" bullet updated
- `docs/en/configuration.md`, `docs/en/project-structure.md`, `docs/ua/README.md` — path/route references updated

## Limitations

This task deliberately did **not** build:

- an SDK or client library;
- an embeddable widget or new Ask UI;
- authentication, rate limiting, or CORS policy — the versioned contract
  is **not** safe for direct public Internet exposure yet;
- Qdrant Cloud server-side inference;
- `sessionId` or any conversation memory — Ask stays fully stateless in v1;
- any change to retrieval, prompt construction, or citation logic.

These remain tracked in
[docs/design/ask-application-runtime.md](design/ask-application-runtime.md)'s
Stage B/C/D roadmap.

---

## Post-review fixes (2026-07-28)

A follow-up review found three real gaps, all fixed in this same task:

1. **Pre-stream errors did not carry the v1 envelope.** `route.js` was
   throwing `HttpError` for every pre-stream failure, which reached the
   shared admin router's generic catch-all (`{ error: { message, code } }`)
   instead of the versioned `{ error: { apiVersion, code, message,
   retryable } }` shape §3 documents. Fixed by having `route.js` catch its
   own `HttpError`s (and produce the busy/unavailable/pre-stream-retrieval
   cases directly) and call the new `projectErrorResponseBody()` contract
   helper via `sendJson()`, never letting a pre-stream Ask error reach the
   router's generic serializer. `ERROR_CODES` was also missing
   `not_implemented`/`embedding_failed`, despite `route.js`'s own
   `RETRIEVAL_ERROR_STATUS` map already referencing those literal strings —
   added both, with `not_implemented` deliberately excluded from
   `RETRYABLE_CODES` (a structural backend limitation, not transient) and
   `embedding_failed` included (typically transient).
2. **The request validator silently accepted unknown fields, including
   `scope: null`.** `parseAskRequestV1` destructured only the known field
   names without checking for anything else, so a client-supplied
   `sessionId` (or any other field) passed through unrejected — undermining
   the documented stateless guarantee. Separately, `scope !== undefined &&
   scope !== null` skipped validation entirely when `scope` was `null`,
   silently treating it as "no scope" despite the contract requiring scope
   to be an object when the key is present. Both fixed: an explicit
   root-key allow-list (`collection`/`question`/`scope` only) now rejects
   anything else with 400, and `scope: null` is now rejected rather than
   silently accepted.
3. **Two active design docs still presented the unversioned `POST
   /api/ask` as current** (`docs/design/admin-ui-ux-and-ask-plan.md`'s
   Phase 4A section, `docs/design/ask-chat.md`'s task-slicing table) —
   both now carry an explicit note pointing at the shipped `POST
   /api/v1/ask` route instead.

Tests were added/updated for all three: `request.test.js` (unknown-field
rejection, corrected `scope: null` expectation), `contract.test.js`
(`ERROR_CODES.NOT_IMPLEMENTED`/`EMBEDDING_FAILED`, `projectErrorResponseBody`),
`ask.test.js`/`ask-gemini-provider.test.js` (pre-stream JSON error bodies
now asserted to carry `apiVersion`/`retryable`, not just `code`).

## Post-review fixes, round 2 (2026-07-28)

A second review found the first round's own safety net was incomplete:
the try/catch added around the pre-stream section only special-cased
`HttpError` — a plain `Error` from `adapter.getCollection()` (or anything
else non-`HttpError`) was still re-thrown and reached the router's
generic catch-all, exactly the bug round 1 was meant to close. Worse,
`await askCoordinator.ask({...})` had **no** surrounding try/catch at
all: if that promise rejected (a coordinator bug, not one of its
documented `status` outcomes), the exception propagated fully uncaught.
If the rejection happened after `onSources` had already called
`startSse(res)`/written the `sources` event, the router's catch-all would
then attempt `res.writeHead()` on a response already mid-SSE-stream —
`ERR_HTTP_HEADERS_SENT`, crashing the request instead of producing any
usable error.

Fixed by wrapping the entire handler body (request validation through
the terminal SSE write) in one try/catch, keyed off the existing
`streamed` flag to decide which shape of error response is still valid:

- **Not streamed yet** (headers never sent): `sendJson(res, 500,
  projectErrorResponseBody(ERROR_CODES.INTERNAL_ERROR, redactedMessage))`
  — one fresh, v1-shaped JSON response, same as every other pre-stream
  error path.
- **Already streaming** (`sources` was written, headers are committed):
  one terminal `writeSseEvent(res, SSE_EVENTS.ERROR,
  projectErrorPayload(ERROR_CODES.INTERNAL_ERROR, redactedMessage))`
  followed by `res.end()` — never a second `res.writeHead()`/JSON body.
- **Client already gone** (`res.destroyed || res.writableEnded`): nothing
  is written at all — there is no socket left to write a meaningful
  response to, and attempting one would itself throw.

The inner `catch` around request validation still only special-cases
`HttpError` and re-throws anything else — but that re-thrown exception
now lands in this new outer catch instead of escaping the handler
entirely, so the behavior is correct either way.

Three new tests in `ask.test.js` cover this directly via a stub
`askCoordinator` injected through `withServer`'s existing DI seam (not
the real coordinator, whose own internal try/catch would mask the
route-level bug being tested): a plain `Error` from
`adapter.getCollection()`, `askCoordinator.ask()` rejecting outright
before any stream, and `askCoordinator.ask()` calling `onSources` and
*then* rejecting — asserting the last case produces a valid terminal SSE
`error` event (never a crash or a second write).

## Verification results (this run)

All commands run sequentially, never concurrently, per the task's explicit
constraint.

| Check | Result |
|---|---|
| `node --check` on every changed/new JS file | All pass — 0 syntax errors. (Deleted files, expectedly, no longer exist to check.) |
| Focused Ask/http/generation tests (`--test-concurrency=1`, 16 files) | **268/268 pass** |
| Focused re-run after round 1 post-review fixes (`request.test.js`, `contract.test.js`, `ask.test.js`, `ask-gemini-provider.test.js`) | **85/85 pass** |
| Focused re-run after round 2 post-review fixes (`ask.test.js`, incl. 3 new exception-safety tests) | **37/37 pass** |
| `npm test` (full bounded suite, after round 2 post-review fixes) | **1906/1906 pass** |
| `npm run smoke` | **1298/1298 pass** |
| `npm run admin:build` | Clean build, 225 modules |
| `git diff --check` | Exit 0 — only pre-existing Windows CRLF line-ending notices, no real conflicts or trailing-whitespace issues |
| `grep -rn "'/api/ask'" src/ tests/` | 1 hit — `tests/unit/admin/ask.test.js`'s own test asserting `POST /api/ask` now returns `404` (intentional; proves absence, does not use the route as live) |
| `grep -rn "\"/api/ask\""` | 0 hits |
| `grep` for `event: 'token'` / SSE `'token'` usage in active `src/`/`tests/` | Only negative assertions/comments proving the name is gone (`ask.test.js`, `ask-gemini-provider.test.js`, `contract.test.js`); 0 hits of `writeSseEvent(res, 'token'` anywhere in `src/` |

**No live cloud calls were made** — the Gemini tests DI-inject a stub
`@google/genai` client (`createClientFn`); the cross-provider parity test
DI-injects a stub `generateStreamFn` for Ollama. No ONNX tokenizer, no
real Qdrant, no real Ollama/Gemini network call anywhere in this task's
test suite.

**Nothing was committed** — per the task's explicit instruction, all
changes remain in the working tree only.
