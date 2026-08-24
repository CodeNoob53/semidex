# Ask spend/token budget ceiling — design and operations record

**Status: IMPLEMENTED (2026-08-24).** Closes the last P0 gap named in
`docs/en/roadmap.md`'s "Public-facing hardening" section: request **rate**
was already bounded (`docs/security/integration-api-auth-design-note.md`),
but the billable generation **work** one accepted request can cause was not.
One `POST /api/v2/ask` call can invoke the generation provider up to three
times (query rewrite, final answer, summary compaction); nothing previously
stopped a single request, or a bearer key's aggregate usage over time, from
being unboundedly expensive.

This document is the design record for that gap's closure: enforcement
order, the reservation/reconciliation contract, provider capability
differences, legacy-key behavior, the client-visible error contract,
configuration surface, audit fields, and every known MVP limitation. Terms
matter throughout this document: **estimated**, **reserved**, and **budget**
are used deliberately, never "exact cost" or "billed amount" — this system
governs a conservative token/call ceiling, not a metered invoice.

## 1. Scope

**In scope:** `POST /api/v1/ask` and `POST /api/v2/ask` — the only two
routes that ever invoke a `GenerationProvider`. Every generation call on
that path: v1/v2's shared final-answer call, v2's query-rewrite call, v2's
summary-compaction call.

**Out of scope (see `docs/en/roadmap.md`'s "Non-goals" for this task and
§9 below for the full list):** payments, invoices, a pricing table, currency
conversion, an exact cost dashboard; a PostgreSQL/Redis/distributed quota
service; persistent chat/history storage; retrieval ranking/RAG quality;
`POST /api/search` or any other Admin-surface route (none of them invoke a
generation provider); anything that would weaken existing request-rate
limiting, auth, collection scopes, SSRF controls, or prompt-injection
hardening — all of that is unchanged.

## 2. Investigated request path (summary)

Traced before any code changed — see the "Required investigation" section
of the originating task for the full method; summarized here as the facts
this design depends on:

- **Exactly three call sites** ever invoke `generationProvider.generate()`
  on the Ask path, and no internal retry loop exists anywhere in it:
  `core/ask/coordinator.js`'s `createAskCore()` (the shared final-answer
  call, used by both v1 and v2), `core/ask/query-rewrite.js`'s
  `rewriteFollowUpQuery()` (v2 only, best-effort), and
  `core/ask/summary-compaction.js`'s `compactSummaryIfNeeded()` (v2 only,
  best-effort, runs only after a successful answer). A client-driven retry
  is therefore always a **brand-new HTTP request** re-entering the whole
  chain from scratch — there is no code path that can retry a call
  internally without going through this system's own reservation gate
  again.
- **The single-flight gate** (`core/ask/single-flight-gate.js`, shared by
  v1 and v2 via `createAskCoordinatorBundle()`) already bounds
  *concurrency* to one generation at a time per coordinator instance. It is
  a correctness/consistency guarantee (documented as such since it
  shipped), not a cost control — a caller can still fire requests as fast
  as each prior one completes.
- **The generation-provider contract** (`core/generation/provider.js`) had
  no output-length concept before this task: `options` was an untyped
  passthrough object. Gemini's provider already forwarded
  `options.maxOutputTokens` into `generationConfig.maxOutputTokens`, but no
  caller ever set it (dead code). Ollama's provider never read any
  output-length field at all.
- **Existing budget concepts on this path are all *input-context* budgets,
  not spend ceilings**: `fitEvidenceToContextBudget()` (evidence.js) and
  `budgetConversationContext()` (conversation-context.js) both bound how
  much gets *sent* to the model against its context window; neither bounds
  how many *calls* happen or what a call may cost across the three call
  sites of one request.

## 3. One request-scoped ledger

`core/ask/budget-ledger.js`'s `createRequestBudgetLedger()` is constructed
**once per HTTP request** (`core/ask-api/v1/route.js`, `v2/route.js`, via
the shared `createAskRequestBudget()` helper) and threaded as a new,
optional `budget` argument through every call in that request's chain:
`askCore` → `generate()` (v1 and v2's shared answer call);
`rewriteFollowUpQuery()` → `generate()`; `compactSummaryIfNeeded()` →
`generate()`. No module constructs an independent ledger of its own — the
same object flows through `coordinator-v2.js`'s `ask()` into all three
downstream calls it makes.

The ledger tracks, per request: `calls` (count), `totalReserved` (tokens),
and one `Map` of outstanding reservations keyed by an internal
`reservationId`. Two `snapshot()`-visible ceilings are enforced against it,
both operator-tunable (§7):

- `ASK_MAX_CALLS_PER_REQUEST` (default 5 — v2's own worst case is 3, this
  leaves headroom without being unbounded).
- `ASK_MAX_RESERVED_TOKENS_PER_REQUEST` (default 60,000).

### Reserve before, reconcile after

`ledger.reserve({ label, estimatedInputTokens, maxOutputTokens })` is
called **before** every `generate()` call, with a conservative worst-case
cost: `estimatedInputTokens + maxOutputTokens` — the actual output could be
anywhere from zero up to the hard cap the provider is about to be told to
respect (§4), so the cap itself is the honest upper bound to reserve
against, never an average or a guess. `estimatedInputTokens` is always the
real, measured token count of the *literal* prompt about to be sent
(`countTokens(systemPrompt + userPrompt)`), mirroring the codebase's
existing "measure the real payload, never estimate from raw fragments"
discipline (`fitEvidenceToContextBudget()`'s own header comment makes the
same point about evidence sizing).

A `reserve()` call checks, in order:

1. **This request's own ceilings** (`calls < ASK_MAX_CALLS_PER_REQUEST`,
   `totalReserved + cost <= ASK_MAX_RESERVED_TOKENS_PER_REQUEST`) — purely
   local, in-memory, no shared state touched. A request that would blow its
   own ceiling is denied without ever consulting the per-key aggregate
   bucket.
2. **The per-key aggregate bucket** (`core/auth/token-budget.js`'s
   `tracker.reserve(keyId, cost, limits)`) — see §5. Only reached if (1)
   passed.

Only on `ok:true` do `calls`/`totalReserved` actually increment and a
reservation get recorded. A denial at either stage returns
`{ ok:false, code, message, retryAfterSeconds? }` and reserves nothing —
the provider is **never called** for that attempt.

`ledger.reconcile(reservationId, { tokensIn, tokensOut })` runs **after** a
successful `generate()` call, and only ever **refunds** — it can never make
an already-denied `reserve()` call retroactively succeed (there is nothing
to reconcile for a call that never ran), and it never charges more than was
already reserved (the reservation was already the worst case). When
`tokensIn`/`tokensOut` are both present, finite, and non-negative, the
refund is `max(0, reservedCost - (tokensIn + tokensOut))`, applied to both
this request's own `totalReserved` and the shared per-key bucket
(`tracker.release(keyId, refund)`). When usage is **absent** (a provider
that doesn't report it) or **ambiguous** (negative, non-finite, or only one
of the two fields present), **no refund happens** — the full conservative
reservation stays charged. This is the literal implementation of "must not
pretend estimated tokens are exact billing": the system only ever tightens
its own charge downward when it has trustworthy evidence to do so, and
defaults to the pessimistic number otherwise.

### Provider errors, aborts, and retries have explicit accounting semantics

- **A `generate()` call that throws, or a request whose `AbortSignal` fires
  mid-stream:** the calling code's own `catch`/abort branch never calls
  `reconcile()`. The reservation stays fully charged. This is deliberately
  conservative — a thrown error or an observed abort is not proof no
  billable work happened server-side. It is explicitly *not* proof either
  way for Gemini, whose `abortSignal` is SDK-documented as client-only
  ("Using it to cancel an operation will not cancel the request in the
  service. You will still be charged usage for any applicable
  operations.") — see `cloud/generation/gemini-provider.js`'s own header
  comment, unchanged by this task. A local stream cutoff was never treated
  as a spend control by this design for exactly that reason.
- **A retry is a new HTTP request.** Because no internal retry loop exists
  anywhere on this path (§2), "a retry cannot bypass the ceiling" reduces
  to: does a *second* `reserve()` call, from a *second* request-scoped
  ledger, still see the first attempt's uncredited spend against the
  shared per-key bucket? Yes — the per-key tracker (§5) is the one piece of
  state that outlives any single request-scoped ledger, so an unreconciled
  first attempt's cost remains charged against it regardless of how many
  new requests follow. Proven directly:
  `tests/unit/security/ask-budget-ledger.test.js` ("Retries cannot bypass
  the ceiling") and end to end over real HTTP:
  `tests/unit/security/ask-spend-token-budget-http.test.js` (task
  requirement #3).
- **v2's rewrite and compaction calls are best-effort, exactly as they were
  before this task** — a denied reservation for either degrades exactly
  like an existing timeout/provider-failure already does (rewrite falls
  back to the original question; compaction skips and leaves the prior
  summary untouched), never failing the whole request. Only the shared
  **final-answer** call's denial fails the request — there is no answer to
  return without it. This preserves each module's pre-existing degrade
  philosophy; the budget ledger did not need to invent a new one.

## 4. Provider-neutral hard output cap

`options.maxOutputTokens` is now a first-class, documented field on the
`GenerationProvider` contract (`core/generation/provider.js`) — every
budgeted `generate()` call sets it to the value the just-succeeded
`reserve()` returned. Each concrete provider maps it to its own official
hard-limit request option:

| Provider | Native option | Enforcement point | `capabilities().hardOutputCap` |
|---|---|---|---|
| Gemini (`cloud/generation/gemini-provider.js`) | `generationConfig.maxOutputTokens` | Server-side, before/during generation (official, documented Gemini API field) | `true` |
| Ollama (`core/generation/ollama-provider.js`) | `options.num_predict` | Server-side (Ollama's own request-time cap) | `true` |

**A local stream truncation alone is never presented as a spend control.**
This system does not, anywhere, stop reading tokens from an
already-in-flight stream as a substitute for a real cap — by the time this
process could truncate a stream client-side, the provider may already have
generated (and, for Gemini specifically, already billed for) more output
than that. The only control this design relies on is the provider's own
official request-time parameter, set *before* the call.

**Fail-closed capability check.** Before reserving for *any* call, the
coordinator/rewrite/compaction code checks
`generationProvider.capabilities().hardOutputCap === true`. If a configured
provider ever reports anything else (including a provider that simply
never declares the field), the call is denied with
`budget_unenforceable` — the whole point of this system is server-enforced
output caps; a provider that cannot honor that must never be allowed to run
a "budgeted" call uncapped, which would silently claim a guarantee this
codebase cannot actually provide for it. Both shipped providers report
`hardOutputCap: true` today; this is the narrowest justified safe behavior
for a hypothetical future provider that does not.

**`ASK_MAX_OUTPUT_TOKENS`** (default 1024, matching `RESERVED_HEADROOM_TOKENS`
— the figure the existing evidence-fitting logic already reserves as
generation headroom) is the operator-tunable cap for the shared
final-answer call. v2's rewrite and compaction calls use their own fixed,
derived caps (`REWRITE_MAX_OUTPUT_TOKENS`, `SUMMARY_MAX_OUTPUT_TOKENS` in
`query-rewrite.js`/`summary-compaction.js`) — computed from each module's
own **pre-existing** post-hoc char-truncation limit
(`MAX_OUTPUT_CHARS`/`SUMMARY_OUTPUT_CAP_CHARS`) via a conservative
3-chars-per-token ratio plus a fixed margin
(`budget-ledger.js`'s `outputTokenCapFromCharLimit()`), so the new pre-call
provider cap is never tighter than the truncation limit that already
existed for that call's output, and both trace back to one source of
truth rather than two independently-chosen numbers.

## 5. Per-key aggregate ceiling — process-local MVP guard

`core/auth/token-budget.js`'s `createTokenBudgetTracker()` is a direct
structural mirror of the existing `core/auth/rate-limiter.js` (same
clock-injection contract, same lazy no-timer sweep, same
"`undefined` override falls back to default / present-but-invalid throws"
per-key rule) generalized from a fixed 1-unit-per-request cost to a
caller-supplied variable cost per reservation, plus a `release()` operation
rate-limiter.js has no equivalent of (needed for reconciliation refunds).

**Window semantics, stated explicitly (task requirement):** a continuous
token bucket. Capacity = the key's `tokenBudgetBurst` (the largest single
burst of Ask activity the key can do from full); refill = continuous, at
`tokenBudgetPerHour / 3,600,000` tokens/ms. This is a smooth rolling
window, not a fixed calendar-hour bucket that resets on the hour — a key
idle for a full hour has exactly `min(capacity, tokenBudgetPerHour)`
tokens available, the same model rate-limiter.js already uses for request
counts, just denominated in tokens and over an hour instead of a minute.

**Atomicity.** `tracker.reserve()` is fully synchronous (no `await` inside
it) — exactly like `rate-limiter.js`'s own `consume()` — so JS's
single-threaded event loop makes the check-and-decrement atomic by
construction. Two concurrent requests sharing one key cannot both reserve
the same remaining budget, because there is no `await` point between
reading the bucket and decrementing it where a second call could interleave.
Proven directly at the tracker level
(`tests/unit/security/token-budget.test.js`, "Concurrent-reservation
atomicity") and at the ledger level
(`tests/unit/security/ask-budget-ledger.test.js`).

**Per-key configuration** lives on the key record itself
(`core/auth/key-store.js`: `tokenBudgetPerHour`/`tokenBudgetBurst`,
optional, `null` when unset), exposed via
`semidex-lite key add --token-budget-per-hour <n> --token-budget-burst <n>`
(and `src/key.js` for Full) — mirroring `--requests-per-minute`/`--burst`
exactly, including validation bounds
(`MIN/MAX_TOKEN_BUDGET_PER_HOUR` = [1,000, 50,000,000],
`MIN/MAX_TOKEN_BUDGET_BURST_TOKENS` = [1,000, 5,000,000]) and `key list`'s
effective-value display (never the raw stored `null`).

**Defaults (used when a key has no explicit override):**
`DEFAULT_TOKEN_BUDGET_PER_HOUR` = 200,000 tokens/hour,
`DEFAULT_TOKEN_BUDGET_BURST_TOKENS` = 40,000. These are deliberately
generous MVP defaults — enough headroom for normal single-backend
integration traffic without being unbounded — not a tuned production SLA;
operators with real usage data should set explicit per-key values.

**Legacy/absent-field policy (task requirement).** A key record predating
this feature (or one deliberately left at the default) has
`tokenBudgetPerHour`/`tokenBudgetBurst` genuinely **absent** from its JSON,
never merely `null`-with-different-meaning. `key-store.js`'s
`validateRecord()`/`buildPrincipal()` resolve that absence to the tracker's
real, finite default — **never** "unlimited" — identically to how
`requestsPerMinute`/`burst` already behave. A record with a
**present-but-invalid** value (out of range, non-integer, or explicitly
`null` where a number was expected downstream) fails the *whole key store*
closed (`STORE_UNAVAILABLE` → 503), the same fail-closed contract every
other malformed field in this store already has — a malformed budget field
is never silently ignored or treated as "no limit." Proven:
`tests/unit/security/integration-key-store.test.js` ("Per-key token budget
(spend ceiling)").

### MVP limitations — named explicitly, not glossed over

- **Process-local, not durable.** The tracker's state is an in-memory
  `Map`, exactly like `rate-limiter.js`'s own buckets. It resets to full
  capacity on every process restart, and is never shared across replicas
  or processes. This is a local-process guard against runaway per-key
  spend within one running instance — it is **not** a durable account
  quota, a billing system, or a multi-replica-safe rate limiter. An
  operator running multiple replicas behind a load balancer gets, in
  effect, `replicaCount × tokenBudgetBurst` of real aggregate headroom per
  key, not a globally enforced single ceiling. A PostgreSQL/Redis-backed
  distributed quota service is an explicit non-goal of this task (see
  `docs/en/roadmap.md`); the process-local guard is the whole of what this
  phase ships.
- **Estimation error.** `estimatedInputTokens` uses the same real
  tokenizer/heuristic (`countTokens`, injected — BGE-M3 tokenizer in
  production, `shared/core/token-count.js`) already used for context-window
  budgeting elsewhere in Ask — it is a real measurement of the literal
  prompt text, not a guess, but it still measures a *different* tokenizer's
  input than whatever the configured generation provider's own tokenizer
  would report; the two are not guaranteed identical.
- **Provider usage uncertainty.** `tokensIn`/`tokensOut` are optional on
  both providers' own return shape (`Promise<{ text, tokensIn?, tokensOut?,
  aborted? }>`) and can legitimately be absent — e.g. Gemini omitting
  `usageMetadata` on a given chunk, or a call that errored/aborted before
  reaching a `done`/final chunk. §3 already covers the reconciliation
  consequence (no refund, conservative reservation retained); this bullet
  names the underlying cause.
- **The client-visible ceiling message discloses the STATIC, operator-
  configured limit** (e.g. "would exceed the maximum of 5 calls allowed per
  request"), never the caller's *current remaining/used* amount — this is
  intentional (telling an authenticated key its own configured ceiling is
  not a cross-tenant leak) but is named here so it is a documented,
  reviewed choice rather than an accident. See §6 for the full error-body
  redaction guarantee.

## 6. Error contract

**One typed code family**, added identically to both `v1/contract.js` and
`v2/contract.js` (never diverging — v1 and v2 must share one contract):

- `budget_exceeded` — transient per-key aggregate exhaustion. **HTTP 429**,
  `retryable: true`, with a `Retry-After` header (integer seconds, rounded
  up), mirroring `rate-limiter.js`'s own
  `rateLimitedDecision()` rounding rule exactly) and absent for the
  structural per-request-ceiling case, since retrying an unchanged
  over-ceiling request will fail again regardless of delay.
- `budget_limit_exceeded` — structural per-request call/token ceilings or a
  key whose configured burst is too small for one required reservation.
  **HTTP 429**, `retryable: false`, without `Retry-After`: retrying the same
  unchanged request cannot succeed.
- `budget_unenforceable` — the fail-closed provider-capability case (§4).
  **HTTP 503**, `retryable: false` (an identical retry cannot change what
  the configured provider supports; only an operator reconfiguring it can).

**Pre-stream, not mid-stream, by construction.** Every budget denial for
the shared final-answer call happens **before** `onSources()` is ever
called — the reservation check runs, and the `sources` SSE event is only
emitted once it succeeds (`core/ask/coordinator.js`). Consequently a
budget-denied request always produces a single, clean JSON error response
(`{ error: { apiVersion, code, message, retryable } }`, the same versioned
envelope `busy`/`provider_unavailable` already use) — **never** a partial
SSE stream that starts and then errors. This is a deliberate ordering
choice (task requirement: "Select HTTP/SSE semantics consistent with the
existing API and tests; explain the choice") — it required moving the
existing `onSources()` call to run *after* the reservation succeeds
instead of before, since evidence retrieval (the one genuinely unavoidable
piece of pre-reservation work — reserving before it would mean estimating
input tokens from nothing, since no evidence yet exists to measure)
already has to complete first to produce a real, measured
`estimatedInputTokens`. v2's rewrite/compaction denials never reach the
client as an error at all (§3 — they degrade silently, exactly like an
existing timeout).

**Never leaked in any error response or audit event:** the question text,
retrieved evidence/citations, conversation history, system prompts, bearer
tokens, provider credentials, or a raw provider error string.
`ask-spend-token-budget-http.test.js`'s task-requirement-#8 test proves
this with a unique sentinel string placed directly in the question field
and asserts it never appears in the response body.

## 7. Configuration surface

New settings, category `ai`, in `core/settings/definitions.js`, exposed to
both Full and Lite (`core/settings/lite-policy.js` — backend-agnostic,
matching the existing Ask v2 settings' own exposure precedent):

| Setting | Default | Range | Governs |
|---|---|---|---|
| `ASK_MAX_OUTPUT_TOKENS` | 1024 | [64, 32768] | Final-answer call's provider-side output-token cap |
| `ASK_MAX_CALLS_PER_REQUEST` | 5 | [1, 20] | Per-request generation-call ceiling |
| `ASK_MAX_RESERVED_TOKENS_PER_REQUEST` | 60,000 | [1,000, 2,000,000] | Per-request total reserved-token ceiling |

Per-key aggregate limits (`tokenBudgetPerHour`/`tokenBudgetBurst`) are
**not** global settings — they live on the key record itself (§5),
mirroring `requestsPerMinute`/`burst`'s own placement, set via
`key add --token-budget-per-hour/--token-budget-burst`.

## 8. Audit

One new event type, `budget.reservation_denied`
(`core/audit/event.js`'s `AUDIT_EVENT_TYPE.BUDGET_RESERVATION_DENIED`),
emitted from `createAskRequestBudget()`'s `onDenied` callback — the same
per-request `auditSink`/`requestId`/`route` context every other Ask audit
event already uses (`authorize.js`'s `recordCollectionDenied()` is the
direct precedent this mirrors). Allow-listed fields, enforced by
`buildAuditEvent()`'s per-type schema exactly like every other event type
(unknown/missing/wrong-shaped fields throw at construction, are dropped at
the logging boundary):

| Field | Type | Notes |
|---|---|---|
| `keyId` | string | The denied request's authenticated key |
| `label` | enum | `'rewrite'` \| `'answer'` \| `'compaction'` — which of the up to three calls was denied |
| `estimatedInputTokens` | number | The measured input-token count for the denied call |
| `maxOutputTokens` | number | The output cap that would have been requested |
| `retryAfterSeconds` | number, optional | Present only for the transient per-key-aggregate case |

(`reason` — the specific denial code — reuses the shared envelope's
existing `reason` field, mirroring `authz.collection_denied`'s own
pattern, rather than adding a redundant second field.)

**No reservation-SUCCESS or reconciliation event is emitted.** This
mirrors `auth.rate_limited`'s own existing precedent exactly — that event
type also only fires on denial, never on every successful `consume()` —
keeping audit volume proportional to security-relevant events rather than
every billable call. Aggregate usage/reconciliation auditing was
considered ("if useful" per the task) and deliberately deferred as a
possible future addition, not because it is unneeded but because it is not
required for this phase's security guarantee and would meaningfully
increase audit volume on the hot path.

**Never logged, anywhere, by this feature:** the question, the answer, any
evidence/citation text, conversation history, system prompts, or bearer
tokens/secrets — enforced structurally by `buildAuditEvent()`'s
allow-list-only field contract (§ design note:
`docs/security/audit-logging-design-2026-08.md`), not by after-the-fact
redaction. Proven with negative-sentinel assertions across every recorded
event in `ask-spend-token-budget-http.test.js`'s task-requirement-#9 test.

## 9. Non-goals (unchanged from the originating task)

No payments, invoices, pricing table, currency conversion, or exact cost
dashboard. No PostgreSQL/Redis/distributed quota service. No persistent
chat/history storage. No changes to retrieval ranking or RAG quality. No
live Gemini/Ollama/Qdrant calls, model downloads, or secrets were touched
or required to build or test this feature. Existing request ceilings,
auth, collection scopes, rate limiting, SSRF controls, and prompt-injection
hardening are all unchanged — this feature only adds a new, independent
enforcement stage alongside them.

## 10. Full/Lite and v1/v2 parity

Both `createApp()` (Full) and `createLiteApp()` (Lite) now accept an
optional `budgetTracker` and forward it to
`shared/admin/register-neutral-routes.js`'s `registerNeutralRoutes()`,
which constructs a default (`createTokenBudgetTracker()`) when the caller
supplies none — exactly mirroring how `askCoordinators`/`generationRuntime`
already default inside that same function, and guaranteeing that real Ask
traffic through either composition root always has budget enforcement
active, never silently disabled by an unwired parameter. `settingsService`
is threaded the same way, so `ASK_MAX_OUTPUT_TOKENS`/
`ASK_MAX_CALLS_PER_REQUEST`/`ASK_MAX_RESERVED_TOKENS_PER_REQUEST` resolve
identically in both editions. v1 and v2 share one ledger-construction
helper (`createAskRequestBudget()`), one tracker instance per composition
root, and one error-code family — there is no version-specific budget
logic anywhere. Proven end to end:
`tests/unit/security/ask-spend-token-budget-http.test.js` (task
requirement #10) runs the identical denial scenario through both
composition roots and both Ask versions and asserts byte-identical error
shapes.

## 11. Files changed

**New:**
- `src/core/auth/token-budget.js` — per-key aggregate tracker.
- `src/core/ask/budget-ledger.js` — per-request ledger + `createAskRequestBudget()` route helper.
- `tests/unit/security/token-budget.test.js`
- `tests/unit/security/ask-budget-ledger.test.js`
- `tests/unit/security/ask-spend-token-budget-http.test.js`
- `tests/unit/core/ask/budget-wiring.test.js`
- This document.

**Modified:**
- `src/core/generation/provider.js` — `options.maxOutputTokens`/`capabilities().hardOutputCap` documented on the contract.
- `src/core/generation/ollama-provider.js` — maps `maxOutputTokens` → `num_predict`; `hardOutputCap: true`.
- `src/cloud/generation/gemini-provider.js` — `hardOutputCap: true` (mapping already existed).
- `src/core/ask/coordinator.js` — reserve/reconcile around the shared answer call; fail-closed capability check; `onSources()` moved after the reservation.
- `src/core/ask/query-rewrite.js` — `budget`/`countTokens` params; reserve/skip/reconcile.
- `src/core/ask/summary-compaction.js` — `budget` param; reserve/skip/reconcile.
- `src/core/ask/coordinator-v2.js` — threads `budget` through rewrite/core/compaction.
- `src/core/ask-api/v1/route.js`, `v2/route.js` — construct the request ledger; Retry-After header.
- `src/core/ask-api/v1/contract.js`, `v2/contract.js` — `budget_exceeded`/`budget_limit_exceeded`/`budget_unenforceable` codes.
- `src/core/audit/event.js` — `BUDGET_RESERVATION_DENIED` event type.
- `src/core/auth/key-store.js` — `tokenBudgetPerHour`/`tokenBudgetBurst` fields.
- `src/core/auth/key-cli.js` — `--token-budget-per-hour`/`--token-budget-burst` flags.
- `src/shared/admin/register-neutral-routes.js` — default `budgetTracker` construction; DI threading.
- `src/admin/server-full.js`, `src/admin/composition/lite.js` — `budgetTracker` param threading.
- `src/core/settings/definitions.js`, `src/core/settings/lite-policy.js` — new settings.
- `scripts/audit/full-lite-module-classification.json` — regenerated (two new `shared`-classified modules).
- Several existing test fixtures' fake `GenerationProvider.capabilities()` — added `hardOutputCap: true` to match the real providers' new capability field (mechanical, no behavior-under-test change).
