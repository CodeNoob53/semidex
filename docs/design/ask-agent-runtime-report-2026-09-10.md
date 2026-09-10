# Agent Runtime (Ask v3) — implementation report

Date: 2026-09-10. Status: implemented, offline-verified, **live-verified**.

## 1. What shipped

A universal agent mode: `POST /api/v3/ask` plus `askAgent()`/`agentStep()` in
the Lite client. The model receives the application's instructions and tool
definitions and returns structured tool calls; the application executes them
and continues the run with their results.

No Budget Guardian or Silpo coupling exists anywhere in the code. The word
"Silpo" appears in no source file; the only domain vocabulary in the whole
slice is the neutral `lookup_items` used by the example and tests.

## 2. Actual production call chain

Verified by enumerating what a real composition root registers, not from a
hand-kept list:

```
POST /api/v1/search | op=search   | cost=qdrant | collection=body
POST /api/v1/ask    | op=generate | cost=llm    | collection=body
POST /api/v2/ask    | op=generate | cost=llm    | collection=body
POST /api/v3/ask    | op=agent    | cost=llm    | collection=none
```

Request path:

```
HTTP request
  -> src/shared/admin/router.js            createRouter() — stage-1 auth, rate limit
  -> src/core/agent-api/v3/route.js        registerAgentRoutesV3 — authorize/validate/project only
  -> src/core/agent-api/v3/request.js      parseAgentRequestV3 — start vs continuation
  -> src/core/agent/runtime.js             createAgentRuntime — capability gate, limits, budget
       -> src/core/agent/tool-schema.js        validateToolDefinitions / validateToolArguments
       -> src/core/agent/continuation-store.js atomic claim, TTL, identity binding
       -> src/core/ask/budget-ledger.js        createAskRequestBudget (SHARED with Ask v1/v2)
  -> src/cloud/generation/gemini-provider.js   agentStep()
       -> src/cloud/generation/gemini-agent-step.js  native @google/genai mapping
  -> @google/genai generateContentStream
```

Composition wiring: `src/shared/admin/register-neutral-routes.js` constructs
one `createAgentRuntime` per call (instance-scoped, never a module singleton)
and both `createApp()` (Full) and `createLiteApp()` (Lite) thread an optional
`agentRuntime` DI override through unchanged.

## 3. Files

**New (production)**

| File | Role |
|---|---|
| `src/core/generation/agent-step.js` | provider-neutral AgentStepCapability contract + typed errors |
| `src/core/agent/tool-schema.js` | the supported JSON Schema subset; definition + argument validation |
| `src/core/agent/continuation-store.js` | instance-scoped run store: opaque ids, TTL, caps, atomic claim |
| `src/core/agent/runtime.js` | transport-neutral runtime (no HTTP/Admin/CLI/provider imports) |
| `src/core/agent-api/v3/contract.js` | wire contract, error codes, HTTP status map, projections |
| `src/core/agent-api/v3/request.js` | request envelope parsing/validation |
| `src/core/agent-api/v3/route.js` | the HTTP route |
| `src/cloud/generation/gemini-agent-step.js` | Gemini native function-calling mapping |

**Modified (all additive)**

`src/cloud/generation/gemini-provider.js` (+21/-1, adds `agentStep` and
`toolCalling: true`), `src/core/generation/runtime.js` (+17/-1, forwards
`agentStep`, defaults `toolCalling: false`), `src/core/http/route-audience.js`
(+7, `OPERATION.AGENT`), `src/core/auth/key-store.js` (+15/-6, `agent` scope),
`src/shared/admin/register-neutral-routes.js` (+20/-1),
`src/admin/server-full.js` (+10/-4), `src/admin/composition/lite.js` (+10/-4),
`packages/lite/lite-src/client/index.js` (+116/-1),
`packages/lite/lite-src/client/index.d.ts` (+160),
`scripts/audit/classify-modules.mjs` (+6), `package.json` (+2/-1).

**Ask v1/v2 compatibility:** `src/core/ask-api/**` and `src/core/ask/**` are
**byte-for-byte unchanged** (`git status --porcelain` on both paths is empty).
No tool/system role was added to the v1/v2 conversation schema.

**New (docs/examples/tooling)**: `docs/en/agent-api-v3.md`,
`packages/lite/examples/agent-tool-loop.mjs`,
`scripts/agent-live-characterization.mjs`; `docs/design/embedded-sdk-plan-2026-09-06.md`
updated with the tool-calling status.

## 4. Design decisions worth naming

**Separate capability, not a `generate()` option.** A step that can end in
"the model wants these tools called" is a different terminal shape, not a
variant of text. `capabilities().toolCalling` lets the runtime refuse an
unsupported backend *before* retrieval or billed generation.

**Its own scope (`agent`), not `generate`.** Agent mode hands the caller
control of the model's system instructions and tool surface — materially
wider authority than grounded Ask. Sharing `generate` would have silently
granted it to every existing Ask key. Existing keys get 403 and must be
re-created; the migration is documented.

**`collectionSource: none` is accurate, not a weakening.** Agent mode does no
retrieval of its own. Retrieval reaches a run only via an application-declared
tool whose own Search/Content call passes stage-2 collection authorization, so
a collection name inside tool arguments grants nothing.

**Continuation fidelity via real native parts.** The next request's `contents`
is rebuilt from the captured native parts (including `thoughtSignature`),
never re-synthesized from `{name, args, text}`. That state is server-side only
and is asserted never to cross the wire.

**Unsupported schema keywords are rejected, not stripped.** `const`, `format`,
`pattern`, `minimum` and friends *look* like enforceable constraints; silently
ignoring them would be worse than refusing them. `additionalProperties`
defaults to `false` when validating model arguments (JSON Schema's own default
is `true`) because an undeclared argument reaching an executor is exactly what
this validation exists to prevent.

**Verified against the installed SDK, not memory.** `@google/genai` 2.12.0
type declarations were read directly for `Tool.functionDeclarations`,
`FunctionDeclaration.parametersJsonSchema` (documented mutually exclusive with
`parameters`), `FunctionCall.{id,args,partialArgs,willContinue}`,
`FunctionResponse.response` (`output`/`error` keys), `Part.thoughtSignature`,
and the `FinishReason` enum.

## 5. Test results

All commands run on this working copy.

| Command | Result |
|---|---|
| `npm test` (full unit suite) | **5067 tests, 5063 pass, 0 fail, 4 skipped** |
| `npm run typecheck:lite-client` | pass (no output) |
| `npm run smoke` | **1316 passed, 0 failed** |
| `node build.mjs` (Lite package) | **OK — 169 files staged, closure validated clean** |
| agent tests only | **168 tests, 168 pass, 0 fail** |
| architecture tests (`--test-concurrency=1`) | **410 pass, 0 fail** |

Agent test breakdown (168):

- `tests/unit/core/agent/tool-schema.test.js` — 47: subset acceptance, every
  unsupported keyword rejected individually, argument validation.
- `tests/unit/core/generation/gemini-agent-step.test.js` — 25: native mapping,
  multiple calls, missing-id synthesis, thoughtSignature preservation, full
  round trip, and every non-completed terminal state (safety, MAX_TOKENS,
  malformed call, interrupted stream, unknown tool, invalid arguments,
  partial arguments, pre-call abort, key redaction).
- `tests/unit/core/agent/continuation-store.test.js` — 21: opaque ids,
  cross-principal indistinguishability, exact result matching, two concurrent
  claims, replay, TTL, memory caps, instance isolation.
- `tests/unit/core/agent/runtime.test.js` — 25: capability gate with zero
  generation, frozen run context, malformed results without token
  consumption, aggregate ceilings, budget reserve-before/reconcile-after.
- `tests/unit/core/agent-api/v3-request.test.js` — 19: envelope validation,
  continuation immutability, discriminated results.
- `tests/unit/core/agent-api/v3-route.test.js` — 23: the mandatory
  offline end-to-end chain (real router → real route → real core → real
  Gemini adapter → fake SDK transport → tool result → continuation → final),
  terminal SSE semantics, authorization, replay, partial results.
- `tests/unit/lite/client/agent-end-to-end.test.js` — 8: the packaged client
  over **real HTTP** against a real `createLiteApp()` with a real temp key
  store enforcing real scopes.

Two required proofs called out explicitly:

- **Semidex never executes a tool** — asserted in both the route test and the
  packaged-client test: a local executor function exists in the process, the
  run returns `requires_action`, and the flag proving execution stays false;
  exactly one model step occurs per HTTP request.
- **A fake-model test is not live tool calling** — stated in both test file
  headers and in the docs.

Runnable example verified as a real child process against a real server:
`requires_action` → backend executes → continuation → `There are 3 milk
options.` → exit 0.

## 6. Access changes

- New operation scope `agent` in `SUPPORTED_OPERATIONS` and `OPERATION.AGENT`.
- `POST /api/v3/ask` joins the integration surface. The exhaustive
  classification allowlist in
  `tests/unit/security/route-audience-classification.test.js` was updated
  deliberately, with a new assertion pinning agent mode's own scope,
  `costClass: llm`, and `collectionSource: none`.
- No Admin route was touched. No route gained wider collection access.
- Existing `generate`/`search` keys are **not** widened; they receive 403 from
  the new endpoint (asserted at both route and packaged-client level).

## 7. Live evidence

**The live native call/result round trip is CONFIRMED for this build.**

```
$ ASK_MODEL=gemini-3.6-flash npm run agent:live-characterization
{
  "model": "gemini-3.6-flash",
  "steps": [
    { "n": 1, "status": "requires_action",
      "toolCalls": [{ "name": "get_warehouse_count", "arguments": { "item": "widget-A" } }] },
    { "n": 2, "status": "completed",
      "text": "There are 4,173 units of widget-A in the warehouse." }
  ],
  "verdict": "LIVE_NATIVE_ROUND_TRIP_CONFIRMED",
  "finalAnswerContainsToolValue": true
}
```

`4173` is a synthetic value obtainable only from the tool result, so the
answer is evidence the result genuinely reached the model — not recall.

### thoughtSignature confirmed on real traffic

A separate live probe inspected the captured native parts (server-side state
that never crosses the wire):

```
native model parts:
  keys=functionCall,thoughtSignature   thoughtSignature.len=684
  keys=text                            (no thoughtSignature)
step2 status: completed
replayed model turn kept signature: true
```

Gemini 3.6 attaches a **684-character opaque `thoughtSignature`** to the
`functionCall` part. This is the decisive validation of the continuation
design: rebuilding the next request from `{name, args, text}` — the obvious
shortcut — would have silently dropped that signature on every multi-step
run. Because the adapter replays the real native parts, it survives.

Live Gemini also supplied its own call id (`call_435511`), so the synthetic-id
fallback was not exercised on this path; it remains covered by offline tests
for providers/responses that omit one.

### Two real findings from running it

1. **A stale default model.** The script defaulted to `gemini-2.5-flash`,
   which returns `404 "no longer available to new users"` for this key. Fixed
   to `gemini-3.6-flash` (the replacement the 404 body itself names).
   Worth recording: `models.list()` and real `generateContent` availability
   **disagree** — the list includes `gemini-2.5-flash` while calling it 404s.
   A capability check based only on the model list would be wrong.

2. **A false negative in the verification itself.** The first successful run
   was reported `INCONCLUSIVE` because the check was `includes("4173")` while
   the model answered `"4,173 units."`. The round trip had genuinely worked;
   the *check* was wrong. Now both sides are compared digits-only, so locale
   number formatting cannot mask a real success.

Both were only findable by running against the real API — which is exactly
why "correct by construction" was not accepted as evidence.

### Scope of the live claim

Confirmed: Gemini 3.6 returns native function calls in the shape this adapter
maps, tool results reach the model through the native `functionResponse`
channel, and thought signatures survive a continuation.

**Not** covered by this run: multi-call parallel responses, safety refusals,
`MAX_TOKENS` truncation, malformed calls, and the synthetic-id path. Those
remain offline-tested against a fake transport only.

The script is opt-in, bounded (3 model steps, one read-only synthetic local
tool, small output ceiling), reads only `GEMINI_API_KEY`, never prints it,
creates and deletes nothing, and touches no Qdrant collection.

No secrets and no real user payloads appear in this report or in any test
fixture.

## 8. Explicit non-guarantees

- **Continuations are process-local and non-durable.** A restart invalidates
  every id honestly (404), never a silent resume against reconstructed state.
- **Not exactly-once for external side effects.** A claimed result means this
  process accepted it once. If a response is lost after a tool already ran, an
  executor must not re-run it merely because Semidex was unreachable.
- **No automatic grounding.** Agent mode makes no claim that answers are
  grounded in the index. Tool-result text is application data, never a
  Semidex-verified citation, and never becomes a system instruction.
- **Gemini only.** Every other backend returns `capability_unavailable`
  before any billed work; ordinary text Ask keeps working on all backends.
- **No hidden compaction.** Exceeding the context or size ceiling returns
  `context_budget_exceeded` / `tool_result_too_large`; arguments and results
  are never silently truncated and an unfinished call/result pair is never
  dropped.

## 8b. Pre-release code-review fixes

Five defects were found in review after the initial implementation and are
fixed here. Each was reproduced against the shipped code first, and each fix
carries a regression test that was verified to FAIL with the fix reverted.

**P1 — an unfinished stream could yield an executable tool call.**
`gemini-agent-step.js` used a deny-list of bad finish reasons, and the
"no terminal state" check lived inside the *no-tool-calls* branch. A response
carrying a `functionCall` with no `finishReason` skipped it entirely and came
back as `requires_action`; `OTHER` came back as `completed`. Replaced with an
explicit **allowlist** (`STOP`) applied before any result is built, so an
absent or unrecognized terminal state fails closed for text and tool calls
alike. *(5 regression tests; all fail without the fix.)*

**P1 — the aggregate run token ceiling was claimed but never enforced.**
`runtime.js` accumulated `usage.reservedTokens` and compared it to nothing;
HTTP builds a fresh per-request ledger per step, which preserves the per-key
budget but gave a run no budget of its own. Added
`maxReservedTokensPerRun` (default 120000), checked before every reservation,
surfacing `run_token_ceiling_exceeded` (422). Also gave `maxContextTokens` a
real default (200000) — it was only settable by a caller and therefore always
`null` in production, making `context_budget_exceeded` unreachable over HTTP.

**P2 — the "universal" core actually depended on Gemini.**
`runtime.js` recovered tool names by walking
`providerState.nativeContents[].parts[].functionCall`. A provider with a
differently-shaped opaque state started a run fine and then failed every
continuation with `results_mismatch` (reproduced). The store now owns neutral
`pendingCalls: [{id, name}]` records, and the runtime reads names from those —
the opaque state is threaded through untouched and never parsed. The mismatch
check also moved *inside* the cleanup block: it previously threw before the
`try`, leaving the run wedged `IN_FLIGHT` forever.

**P2 — expiry of an in-flight run corrupted memory accounting.**
`sweep()` deleted even an `IN_FLIGHT` run and returned its bytes; the still
running step's `release()` then subtracted the same bytes again
(reproduced: `totalBytes: -15`), distorting the store-wide memory limit.
Every removal now goes through one `dropRun()` that subtracts once and zeroes
`run.bytes`, and `sweep()` never touches an `IN_FLIGHT` run — its own
`release()` is the single authority on whether that run continues or ends.

**P2 — v3 bypassed the shared generation gate.**
`register-neutral-routes.js` built the agent runtime with no gate, so agent
mode ran outside the process's one-generation-at-a-time policy (reproduced:
two concurrent `start()` calls ran two real generations). The runtime now
accepts the same `createSingleFlightGate()` instance Ask v1/v2 contend on,
held **only** for the model step and released while a run waits for tool
results — a run that idles between HTTP requests must never hold a
process-wide lock. The loser of a race gets `429 busy`.

Verified after the fixes: `npm test` 5117 tests / 5113 pass / 0 fail;
smoke 1316/0; architecture 410/0; typecheck clean; Lite build 171 files,
closure clean; and the live Gemini round trip still reports
`LIVE_NATIVE_ROUND_TRIP_CONFIRMED` (the `STOP` allowlist matches real traffic).

## 8c. Second-round review fixes (defects introduced by 8b)

The gate fix in 8b introduced three defects of its own. All three came from
one mistake — the generation slot was acquired *around the provider call*,
i.e. AFTER the run had been claimed and AFTER tokens were reserved — so a
`busy` refusal was destructive rather than free.

**P1 — `busy` destroyed a valid continuation.**
`continue()` claimed the run, then hit the gate; the refusal ran the error
path, which closes the run. Reproduced: first attempt -> `busy`, retry after
the gate freed -> `run_not_found`. The application's tool results had already
been executed and could never be delivered. The slot is now acquired
**before** the claim, so a refusal leaves the run untouched and the identical
retry succeeds.

**P2 — a `busy`-refused request still spent token budget.**
The reservation was taken before the gate, and the `finally` called
`reconcile(id, undefined)`, which the ledger documents as "usage unknown —
retain the full conservative reservation". Zero generations, real spend.
Reserving now happens only inside a successfully held slot.

**P2 — `close()` followed by a late `release(READY)` corrupted accounting.**
`release()`'s READY branch rewrote `totalBytes` unconditionally, so a run
that `close()` (client disconnect/abort) had already removed got its bytes
added back for a record the store no longer held. Reproduced as
claim -> close -> release(READY): `runs: 0` but `totalBytes: 7`, leaking a
little more of the memory limit on every repetition. `release()` is now a
strict no-op once the run is gone.

Supporting change: `createSingleFlightGate()` gained `tryAcquire()` — the
same mutual exclusion with a caller-held lifetime instead of a
callback-scoped one, which is what lets the slot be decided before any
destructive step. `run()` is unchanged and Ask v1/v2 keep using it; both
styles share the one `busy` flag, so they still exclude each other.

`429 busy` is now a documented **guaranteed-no-work** outcome: nothing
claimed, nothing reserved, nothing generated — retry the identical request,
continuation id and already-executed tool results included.

Each fix carries regression tests verified to FAIL with that fix reverted:
5 for the ordering/budget pair, 2 for the store guard. Verified after:
`npm test` 5127 tests / 5123 pass / 0 fail; smoke 1316/0; architecture
410/0; typecheck clean; Lite build 171 files, closure clean; live Gemini
still `LIVE_NATIVE_ROUND_TRIP_CONFIRMED`.

## 8d. Third-round review fix — a retryable denial that could not be retried

**P1 — a temporary budget denial destroyed the continuation.**
`continue()`'s catch closed the run on **every** failure, including ones
raised before the model was ever called. Reproduced: continuation ->
`key_budget_exceeded` (zero generations) -> budget refills -> retry ->
`run_not_found`. The API advertises that denial as `retryable: true` and
returns `429` with a `Retry-After`, yet there was nothing left to retry
against, and the tool results the application had already executed — with
whatever side effects they carried — were stranded permanently.

The distinction the catch was missing is **whether any work happened**.
`AgentRuntimeError` gained a `noWorkPerformed` flag, set at the five sites
that refuse before the provider is reached: `busy`, `key_budget_exceeded`,
`run_step_limit_exceeded`, `run_token_ceiling_exceeded` and
`context_budget_exceeded`. For those, `continue()` now releases the run back
to `READY` with its `providerState`, `pendingCalls` and `usage` unchanged,
so the identical request — same continuation id, same tool results — works
once the condition clears.

Two deliberate exclusions:

- **Any failure at or after the model call still closes the run.** Once
  Gemini has been invoked the provider state is no longer trustworthy;
  preserving it would offer a retry that silently resumes from a turn that
  may have half-happened.
- **`results_mismatch` still closes the run**, even though it is also raised
  pre-generation. It means the stored pending list and the submitted results
  disagree — the run's own state is inconsistent, and an identical retry
  could never succeed. Keeping it would advertise a recovery that does not
  exist.

The 422s in that list (step limit, run token ceiling, context budget) stay
permanent for the run; preserving them is not about retrying but about the
run not vanishing mid-request, so the caller can inspect or close it
deliberately.

Regression tests, all verified to FAIL with the fix reverted: 6 in
`tests/unit/core/agent/runtime.test.js` — including the exact case asked for
(denial -> budget restored -> the same id and the same tool results complete,
with the results reaching the model unchanged), that the preserved run
returns to `READY` rather than staying `IN_FLIGHT`, and that repeated
denials do not drift the store's byte accounting — plus 2 at the HTTP level
in `tests/unit/core/agent-api/v3-route.test.js`, which prove the wire
promise end-to-end: `429 key_budget_exceeded` with `retryable: true`, zero
model steps, then a `200 completed` from the byte-identical retry. Reverting
the fix fails exactly those 6, while the two "must still close" tests keep
passing — the fix is narrow, not a blanket preserve.

Docs: `docs/en/agent-api-v3.md` gained a "Guaranteed-no-work failures
preserve the continuation" section stating per code whether an unchanged
retry is safe, and `key_budget_exceeded` was added to the error table it had
been missing from.

Verified after: `npm test` 5135 tests / 5131 pass / 0 fail / 4 skipped
(+8 tests, all of them these regressions); smoke 1316/0; architecture 410/0;
`typecheck:lite-client` clean; Lite build 171 files, closure clean; live
Gemini `gemini-3.6-flash` still `LIVE_NATIVE_ROUND_TRIP_CONFIRMED`
(`finalAnswerContainsToolValue: true`).

## 9. Not done (deliberately out of scope)

- Budget Guardian is **not** integrated: no wiring, no agent UI, no Silpo tool
  allowlist, no demonstration. That is the next task, after review of this API.
- The package is **not published**.
- Embedded SDK, JSON storage and the indexing refactor remain separate tasks;
  this slice neither closes nor blocks them.
- An automatic grounded-agent preset is out of scope by design.
