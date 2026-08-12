# Ask API v2 — Bounded Conversational Context

> Status: implemented, 2026-08-12. Adds `POST /api/v2/ask` alongside the
> unchanged `POST /api/v1/ask`. See
> [ask-chat.md](ask-chat.md) §9 for the pointer from the dashboard reference
> client's own deferred-features list, and
> [ask-application-runtime.md](ask-application-runtime.md) for the broader
> product/runtime boundary this endpoint sits inside.
>
> **Live acceptance status (2026-08-12):** a real client
> (`packages/lite/examples/ask-v2-sse-client.mjs`), a stateless demo
> conversation manager (`packages/lite/examples/conversation-manager.mjs`),
> a fully-offline integration test suite
> (`tests/integration/ask-v2-conversation-flow.integration.test.js`), and a
> disposable-collection live acceptance script
> (`scripts/ask-v2-live-acceptance.mjs`, real Qdrant Cloud + Gemini, never
> run as part of `npm test`) all exist and are described in this document's
> own sections. See `packages/lite/README.md`'s "Backend integration:
> multi-turn Ask" section for the integrator-facing narrative this document
> underpins.

## 1. Problem and ownership model

Semidex Lite is meant to be embedded as a retrieval+Ask core inside
third-party assistants, bots, and backend services. `POST /api/v1/ask`
answers exactly one question against one collection, with zero conversational
memory — every request is independent by design. Integrators building an
actual multi-turn assistant on top of Semidex had no way to give the model
awareness of prior turns without either re-sending the entire transcript as
part of `question` (uncontrolled, unbounded, indistinguishable from the
question itself to the prompt/citation pipeline) or forking Semidex's own Ask
logic.

Semidex does not become a chat-storage product at this stage — it has no
users, auth, or persistence layer, and building one now would preempt product
decisions (which database, multi-tenancy model, retention policy) that belong
to whichever application embeds Semidex.

**Ownership split:**

| Concern | Owner |
|---|---|
| Users, auth, tenant isolation | Integrating application |
| Assistant → allow-listed collection mapping | Integrating application |
| Conversation creation, complete message history, DB persistence | Integrating application |
| `conversation.id`/`expectedVersion` optimistic concurrency | Integrating application |
| Request validation | Semidex |
| Conversational token budgeting | Semidex |
| Follow-up query rewriting | Semidex |
| Retrieval from the explicit collection | Semidex |
| Evidence-grounded prompt assembly | Semidex |
| Generation + citations | Semidex |
| Optional bounded summary updates (returned, not persisted) | Semidex computes; caller persists |

Semidex remains **stateless between HTTP requests**. `conversation` is
caller-supplied on every call; Semidex never reads or writes any store keyed
by `conversation.id`. `conversation.id` is an opaque correlation identifier —
Semidex echoes it back in the `done` event but never uses it as authorization
proof or to fetch server-side state.

## 2. Wire contract

```json
POST /api/v2/ask
{
  "collection": "company-support",
  "question": "А які винятки?",
  "conversation": {
    "id": "conv_123",
    "summary": "Обговорювали строки та умови повернення товарів.",
    "recentMessages": [
      { "role": "user", "content": "Скільки часу є на повернення?" },
      { "role": "assistant", "content": "Зазвичай повернення можливе протягом 14 днів." }
    ]
  }
}
```

`conversation` is entirely optional — omitted on a first turn. When present,
`conversation.id` is required; `summary`/`recentMessages` are both optional.
Only `role: "user"` and `role: "assistant"` are accepted in `recentMessages`
— `system`/`developer`/`tool`/any unknown role is rejected with `400` +
`invalid_message_role` at parse time (`src/core/ask-api/v2/request.js`).
Unknown root/conversation/message keys are rejected outright, matching v1's
own "no undocumented second contract" discipline.

SSE event names/shapes (`sources`/`answer_delta`/`done`/`error`) are
unchanged from v1 (`src/core/ask-api/v2/contract.js` mirrors
`src/core/ask-api/v1/contract.js` exactly). The `done` event gains one
additive, optional block:

```json
{ "conversation": { "id": "conv_123", "summaryChanged": true, "updatedSummary": "...", "compactedMessageCount": 5 } }
```

`conversation` is omitted entirely from `done` when the request had no
`conversation` field at all (a first-turn request) — never present as `null`
or `{}`. `updatedSummary`/`compactedMessageCount` are present only when
`summaryChanged` is `true` — see §9 for exactly what `compactedMessageCount`
means and how a caller uses it.
Summary compaction is never attempted on every request — only when the
caller-supplied history exceeds a configurable threshold
(`ASK_SUMMARY_COMPACTION_THRESHOLD`).

`/api/v1/ask`'s own three files (`src/core/ask-api/v1/{route,request,contract}.js`)
are byte-for-byte unchanged by this work.

## 3. Privacy and retention

Semidex has no database, no Redis, no in-memory session map, no filesystem
session file keyed by `conversation.id` — nothing in this codebase persists a
conversation across requests. Every request's `conversation` block exists
only for the duration of that single HTTP request/response cycle. Retention,
deletion, and data-subject-access requests for conversation content are
entirely the integrating application's responsibility, since Semidex never
stores that content in the first place.

## 4. Concurrency and consistency

Single-flight-per-process lock (existing v1 behavior, reused via a shared,
injectable `SingleFlightGate` — `src/core/ask/single-flight-gate.js`) — one
Ask generation (v1 or v2) at a time, process-wide. `createAskCoordinatorBundle()`
(`src/core/ask/coordinator-v2.js`) is the recommended construction path: it
builds one `createAskCore()` instance and one gate, and wires both v1's and
v2's coordinators from them, so there is no code path in the default
production wiring that could produce a mismatched gate/core pair. v2's own
`ask()` holds the gate for its ENTIRE operation — query rewrite, the main
answer, and summary compaction all run inside one `gate.run()` callback — so
v1 and v2 traffic, and v2's own rewrite/compaction steps (which run outside
the shared core call), all genuinely contend on one lock, not two independent
ones.

No per-conversation locking exists or is needed, because Semidex holds no
per-conversation mutable state to protect. Optimistic concurrency (version
numbers) is the integrating app's own concern for its message-history writes
— Semidex's only involvement is returning `updatedSummary` for the app to
persist under its own optimistic-lock scheme (see §11's `commitTurn()`);
Semidex never reads or validates any version/expectedVersion field itself —
no such field exists in the v2 wire contract on purpose.

## 5. Collection pinning and authorization

`collection` must be resolved **server-side** by the integrating backend from
its own `assistantId`/`conversationId` → allow-listed-collection mapping.
Semidex performs no inference, no fuzzy matching, and no authorization check
of its own — `collection` is a required, explicit field, and the loopback
bind (or whatever network boundary the integrating app places in front of
Semidex) is the only access-control boundary that exists. **Never pass a
browser-supplied collection name directly to `/api/v2/ask`** — resolve it
server-side, in the integrating backend, from an allow-list keyed by the
authenticated user/assistant, exactly the same discipline the README's own
integration example demonstrates.

## 6. Token budgeting design

`src/core/ask/conversation-context.js`'s `budgetConversationContext()` is the
one module that owns "how much history fits." Independent, simultaneously-
enforced hard caps: message count (`ASK_HISTORY_MAX_MESSAGES`), aggregate
characters (`ASK_HISTORY_MAX_CHARS`), aggregate tokens
(`ASK_HISTORY_MAX_TOKENS`) — all three settings, `appliesAt: 'next_search'`
(resolved fresh per request, never frozen at process start). A newest-first
greedy walk retains a contiguous newest-N suffix of `recentMessages`, never a
sparse/gapped selection, and never truncates a kept message mid-way. History
can never claim more than `numCtx - RESERVED_HEADROOM_TOKENS -
MIN_EVIDENCE_RESERVATION_TOKENS` tokens (the answer path) — evidence always
keeps a guaranteed minimum reservation.

The per-message structural ceiling (`PROTOCOL_MAX_MESSAGE_CHARS`, 50,000
chars, in `src/core/ask-api/v2/request.js`) is a **fixed, non-configurable**
protocol constant, checked synchronously at request-parse time — genuinely
distinct from `ASK_HISTORY_MAX_CHARS`, which governs only the AGGREGATE
trimmed-history budget consumed later, inside `budgetConversationContext()`.
Conflating the two (one setting doing double duty as both an individual cap
and an aggregate cap) was an earlier design defect, corrected before
implementation.

Alongside it, `PROTOCOL_MAX_RECENT_MESSAGES` (200 entries, same file) is a
second fixed, non-configurable ceiling — on the ARRAY LENGTH of
`conversation.recentMessages` itself, checked at the same parse time,
independent of `ASK_HISTORY_MAX_MESSAGES` (which governs only how many of
those entries the answer path actually USES, not how many the wire
protocol accepts at all). A request whose `recentMessages` array exceeds
this ceiling is rejected outright with `400 invalid_conversation` before
any retrieval/generation is attempted — see §9's discussion of
`conversation-manager.mjs`'s own `client_bounded_context_exceeded` guard,
which exists specifically to detect this case locally and refuse to send
rather than let the server reject it.

Token counts are never trusted from the client — there is no client-supplied
token-count field anywhere in the v2 wire contract; every count is computed
server-side via the injected `countTokens` callback (the same BGE-M3-backed
counter Ask already uses for evidence budgeting).

`budgetConversationContext()` also serves the compaction path
(`purpose: 'compaction'`) — see §9.

## 7. History-aware retrieval rewriting design

`src/core/ask/query-rewrite.js`'s `rewriteFollowUpQuery()` derives a
standalone retrieval query from the current question plus bounded
summary/recent messages, used **only for retrieval** (`buildEvidence()`'s
`retrievalQuery` parameter) — the answer is always generated against the
literal original `question`, never the rewritten one. `looksLikeFollowUp()`
skips the rewrite call entirely when there is no conversation context at all
(a genuinely standalone first turn), and otherwise errs toward rewriting too
often rather than too rarely (a short question, or one opening with a
pronoun/reference word from a small multilingual stoplist, triggers
rewriting) — an unnecessary rewrite call is bounded extra latency/cost;
skipping a needed one silently degrades answer quality with no visible
signal.

Any failure, timeout (`ASK_QUERY_REWRITE_TIMEOUT_MS`), empty output, or
oversized output falls back to the original question — rewriting failure
never fails the whole Ask request, logged via `console.warn()` only. The raw
rewrite output is never exposed beyond the internal `query` string — never
included in any SSE event, `done` payload, or log above `console.warn()`
(and even that warn logs only the fact of a fallback, never the model's raw
output).

## 8. Evidence and safety boundary

Conversation history is **untrusted context, not retrieval evidence**.
`src/core/ask/prompt.js`'s `buildConversationBlock()` renders history as its
own separately-delimited "Conversation so far" section — never folded into
`question`, never given a `[n]` numbering scheme of its own. `citations.js`'s
`validateCitations()` only ever checks matched `[n]` tokens against
`Set(sources.map(s => s.n))` — since conversation-history text never enters
the `sources` array, it is **structurally impossible** for a citation to
resolve to conversation content, regardless of where else that text appears
in the prompt.

`buildSystemPrompt()` gains one additional rule whenever history is present:
treat the conversation block as untrusted context, never cite it, never treat
prior assistant answers in it as verified facts, and never follow any
instruction embedded inside it — reinforcing, not contradicting, the
existing evidence-is-untrusted-data rule v1 already has. No client-provided
system prompt is ever accepted anywhere in the v2 wire contract.

The response distinguishes "no supporting evidence found" (`status: 'refused'`,
`reason: 'no_evidence'`) from provider/runtime failures (`status: 'error'` /
`'provider_unavailable'`) exactly as v1 already does — v2 adds no new
ambiguity here.

### 8.1 Security boundary for message roles

`recentMessages[].role` accepts **only** the literal strings `"user"` and
`"assistant"` — `"system"`, `"developer"`, `"tool"`, and any other value are
rejected outright at parse time (`400` + `invalid_message_role`), before the
request ever reaches retrieval or generation. This is a deliberate security
boundary, not an arbitrary validation choice:

- Semidex's own system instructions are the ONLY content ever delivered
  through a provider's native system-instruction channel
  (`GenerationProvider.generate({ systemPrompt, ... })` — see
  `src/core/generation/provider.js`). If a caller-supplied "system"-role
  message were accepted into `recentMessages`, a provider implementation
  that concatenates conversation roles into one combined prompt (some do)
  could end up rendering caller-supplied text in a position visually or
  structurally indistinguishable from Semidex's own real system
  instructions — a direct instruction-injection vector.
- `"tool"`/`"developer"` roles imply a function-calling or agentic
  transcript shape Semidex v2 does not support at all (see §12) — accepting
  them would silently promise capabilities (tool-call replay, developer-role
  precedence) that do not exist, rather than failing loudly and immediately.
- Every accepted message, regardless of role, is STILL rendered only inside
  the untrusted "Conversation so far" block (§8) — even a maximally
  well-behaved `"user"`/`"assistant"` message never gains any special
  authority. The role restriction is a defense-in-depth boundary on top of
  that, not a substitute for it.

## 9. Summary compaction design

`src/core/ask/summary-compaction.js`'s `compactSummaryIfNeeded()` is
best-effort and attempted only when `(recentMessages.length + 2) >=
ASK_SUMMARY_COMPACTION_THRESHOLD` (the raw, caller-visible pre-trim count —
the integrating app's own source of truth for "does my history look long").

**Standard rolling-summary boundary — compact the oldest, retain the
newest, never re-summarize the current turn.** `conversation.recentMessages`
is split into two disjoint parts: the newest `ASK_SUMMARY_RETAINED_MESSAGES`
messages are the **retained raw tail** — this function never touches them,
never sends them to the summarizer, and the caller must keep them as-is —
and everything older is the **to-compact oldest prefix**, the ONLY material
actually sent to the summarizer. If the whole history fits inside the
retained tail (a short conversation, even one that crosses the trigger
threshold), there is nothing old enough to compact and compaction is
skipped (`{ changed: false }`) rather than pointlessly regenerating a
summary that would just restate what's already there.

`ASK_SUMMARY_RETAINED_MESSAGES` is its **own dedicated setting** (default
4), deliberately independent of `ASK_HISTORY_MAX_MESSAGES`/
`ASK_HISTORY_MAX_CHARS`/`ASK_HISTORY_MAX_TOKENS` — those bound how much raw
history a single *request* may include (an unrelated request-size safety
cap, applied whether or not compaction ever runs). An earlier version of
this design derived the retained-tail boundary from those request-size caps
via `budgetConversationContext({purpose:'compaction'})` — a real defect
(caught in code review): with the default 20-message request-size cap, any
conversation shorter than 20 messages had NOTHING old enough to compact,
regardless of how low `ASK_SUMMARY_COMPACTION_THRESHOLD` was set — the
threshold decided *whether* to attempt compaction, but the unrelated
request-size cap silently decided there was never any material *to*
compact. The two concerns are now fully independent knobs.

The current turn's `question`/`answer` are **never** included in the
summarization input — they already exist, in full, as the caller's own next
raw message pair once appended, so summarizing them too would mean they
appear twice with no way for a caller to know that and deduplicate. This,
together with the retained/compacted boundary being inverted, was a real
defect in an earlier version of this design: the boundary arithmetic
reported the RETAINED tail as "compacted" and the DROPPED prefix as "safe
to keep," and the current turn was folded into the summarization input
while ALSO being appended raw by every caller — together these caused a
caller applying the returned boundary to lose real history, duplicate other
history, and always duplicate the current turn. The design below is what
actually ships.

**Whole-prompt budgeting for what IS sent.** The model input is built in a
fixed order: (1) fixed system-prompt overhead, counted once; (2) the
to-compact oldest prefix (never the retained tail, never the current turn)
is rendered via `buildCompactionPrompt({priorSummary, recentMessages})`; (3)
the REAL, literal prompt (never a hand-summed estimate) is measured with one
real `countTokens()` call, deterministically shrinking the to-compact
prefix from its **NEWEST** end on overflow (the message closest to the
retained-tail boundary is dropped first, working backward toward index 0),
then degrading to a skip — never dropping `priorSummary` — if formatting
overhead alone pushes the combined `systemPrompt + prompt` over
`numCtx - RESERVED_HEADROOM_TOKENS`. This is the one true invariant the
whole design guarantees: the literal provider input, not an estimate
reconstructed from its parts, always fits — and it is built ENTIRELY from
material the caller has already agreed is safe to compact (the oldest
prefix), never from the retained tail or the current turn.

Shrinking from the to-compact prefix's *newest* end, not its oldest end, is
itself load-bearing and was a second real defect caught in code review: the
prefix starts as `rawMessages.slice(0, N)` — a contiguous run from index 0
— and `compactedMessageCount` (below) is reported as its final length.
Dropping the OLDEST element first (`.slice(1)`) would leave the shrunk
array no longer starting at index 0, while `compactedMessageCount` would
still tell the caller "drop `rawMessages.slice(0, compactedMessageCount)`"
— a range that includes messages the summarizer never actually saw once
they were shrunk away, permanently losing them even though the caller was
told they were safely folded into `summary`. Shrinking from the newest end
instead keeps the to-compact array a true index-0 prefix at every step, so
`compactedMessageCount` always exactly matches what was rendered into the
prompt.

**`priorSummary` is never silently dropped.** If, after the to-compact
prefix has been fully shrunk to empty, the summarization input still
doesn't fit (an oversized `priorSummary` alone exceeding the budget),
compaction degrades to a skip — it never discards `priorSummary` and
regenerates a fresh one covering only a fragment of history. Doing so would
silently erase the conversation's entire prior long-term context while
returning a `summary` that looks perfectly valid, with no way for a caller
to detect the loss. The prior summary is left completely untouched (Ask v2
never returns `updatedSummary` on `changed: false`), so nothing is lost —
only deferred to a later turn once there's genuinely room.

**`compactedMessageCount`** is the coverage boundary returned to the caller
on `{changed: true}`: the exact count of messages, from the OLDEST end of
the `conversation.recentMessages` array the caller sent THIS turn, that
were actually rendered into the summarization prompt (after any
newest-end shrinking of the to-compact prefix — see above) and are
therefore now covered by `summary`.

A caller does NOT need to physically delete anything to use this
correctly — see `packages/lite/examples/conversation-manager.mjs` for the
recommended shape: keep a full, append-only, NEVER-pruned **archive** of
every message as the source of truth, plus a separate
**`summarizedThroughArchiveIndex`** boundary that only ever *advances* by
`compactedMessageCount` when `summaryChanged: true`. The bounded array
actually SENT to Semidex each turn is a derived view,
`archive.slice(summarizedThroughArchiveIndex)`, never the archive itself.
This is deliberately NOT "slice `recentMessages` and overwrite local
state" — that approach (an earlier, simpler version of this example)
conflated "no longer sent" with "no longer retained," which meant any
compaction failure (provider down, repeated generation errors) could
leave a caller with no correct way to shrink its own stored array without
risking permanent, silent history loss. Keeping the full archive and only
narrowing the derived view sidesteps that entirely: nothing is ever
deleted locally, and the outbound request only ever grows or shrinks
based on what Semidex itself has confirmed.

If the derived view itself grows past the wire protocol's hard ceiling on
`recentMessages` (`PROTOCOL_MAX_RECENT_MESSAGES`, 200 entries — see §6
above) — which can only
happen if compaction keeps failing to confirm any coverage turn after
turn — a well-behaved caller must refuse to send that turn rather than
either truncating its own history or letting the server reject it with a
generic `invalid_conversation`. `conversation-manager.mjs` implements this
as an explicit `client_bounded_context_exceeded` error, checked and
returned BEFORE any network call is made for that turn.

**A failed or oversized compaction never turns a successful answer into an
error.** Every degenerate case — threshold not met, nothing old enough to
compact, timeout, generation failure, formatting overhead still overflowing
after every shrink step — resolves to `{ changed: false }` inside
`compactSummaryIfNeeded()`'s own try/catch boundary; no exception ever
crosses that function's own boundary. `coordinator-v2.js` calls it strictly
AFTER the main answer has already returned `status: 'done'`, so a compaction
problem can only ever affect the trailing `updatedSummary`/`summaryChanged`/
`compactedMessageCount` fields merged onto an already-successful result —
the `done` SSE event still completes normally with `summaryChanged: false`
and no `updatedSummary`/`compactedMessageCount` keys.

The compaction system prompt explicitly instructs the model never to present
prior assistant answers as verified collection facts — mirroring §8's
evidence/citation safety framing.

## 10. Failure semantics — one summary table

Every failure mode a v2 caller can observe, and exactly how it degrades —
collected in one place since the individual sections above (§6-9) each
describe their own failure path inline, in context, but a caller integrating
against this API needs the full picture at a glance.

| Failure | HTTP / SSE surface | Does it fail the whole request? |
|---|---|---|
| Malformed root body / missing `collection`/`question` | `400 bad_request`, pre-stream | Yes — request never starts |
| Malformed `conversation`/message shape | `400 invalid_conversation`, pre-stream | Yes — request never starts |
| `role` not `"user"`/`"assistant"` | `400 invalid_message_role`, pre-stream | Yes — request never starts |
| A single message over `PROTOCOL_MAX_MESSAGE_CHARS` | `400 message_too_large`, pre-stream | Yes — request never starts |
| Unknown `collection` | `404 not_found`, pre-stream | Yes — request never starts |
| Model context window too small to answer at all (even with zero history) | `422 context_budget_exceeded`, pre-stream | Yes — a genuinely degenerate `numCtx`, not a normal operating case |
| Another Ask request already in flight (v1 or v2) | `429 busy`, pre-stream | Yes — caller retries later; nothing was attempted |
| Generation provider not ready (e.g. Gemini unreachable) | `503 dependency_unavailable`, pre-stream | Yes |
| Zero retrieval evidence found | `done` event, `refused: true`, `refusalReason: 'no_evidence'` | No — a normal, successful (if unhelpful) response, not an error |
| Query rewrite fails/times out/returns empty or oversized output | *(invisible to the caller)* — silently falls back to the original `question` for retrieval | No — `console.warn()` only, answer proceeds normally |
| Summary compaction fails/times out/nothing old enough to compact/still-oversized after every shrink step | `done.conversation.summaryChanged: false`, no `updatedSummary`/`compactedMessageCount` keys | No — `console.warn()` only; the already-successful answer is never touched |
| Generation itself fails mid-stream | terminal `error` SSE event, `generation_failed` (or the retrieval-stage code that produced it) | Yes, but only after `sources` may have already streamed — never a second pre-stream response |
| Client disconnects / aborts | terminal `error` SSE event, `stream_aborted`; the shared single-flight gate is released via `finally`, regardless of where in the pipeline the abort happened | Yes for that request; never leaves the gate stuck for the next one |

The two "no" rows (query rewrite, summary compaction) are the load-bearing
design decision this whole document keeps returning to: **a best-effort
convenience feature failing must never downgrade a successful, evidence-
grounded answer into an error.** Every other row is a real, request-ending
failure — but even there, the failure is reported through the SAME
`{code, message, retryable}` shape v1 already uses (`src/core/ask-api/v2/contract.js`'s
`projectErrorPayload()`), never a bespoke v2-only error envelope.

This table covers only failures the SERVER can produce. A well-behaved
caller can also refuse to send a request locally, before any network call,
when it can already tell the request would be invalid — the one example of
this in this codebase is `conversation-manager.mjs`'s
`client_bounded_context_exceeded` (§9): if `ASK_SUMMARY_COMPACTION_THRESHOLD`
never manages to confirm any coverage over many turns, the caller's own
unsummarized view can grow past `PROTOCOL_MAX_RECENT_MESSAGES` — the
example detects that locally and returns this same `{code, message,
retryable}` shape rather than either truncating history itself or letting
the request reach the server only to bounce off `invalid_conversation`.
This is client-side error synthesis (matching the `client_*`-prefixed codes
`ask-v2-sse-client.mjs` already produces for its own local failures, e.g.
`client_timeout_or_abort`), never a code the server itself returns.

The guard's boundary is deliberately `> PROTOCOL_MAX_RECENT_MESSAGES`, not
`>=`: a view of EXACTLY the ceiling is still legal under the server's own
wire contract (`request.js` itself only rejects `> PROTOCOL_MAX_RECENT_MESSAGES`),
and is also the conversation's LAST legal opportunity for a turn that
could let compaction confirm coverage and shrink the view back down before
it becomes unrecoverable. Refusing a legal, exactly-at-the-ceiling request
locally would be stricter than the protocol itself for no benefit, and
would throw away that final chance. Once the guard DOES trip (the view is
already over the ceiling), the error message deliberately does not tell
the caller to simply retry — an ordinary retry sends the exact same
oversized view and is rejected locally again every time, so no request
ever reaches Semidex again for that conversation, and a recovering
generation provider has no way to help. `retryable: true` on this error
describes only that it isn't a permanent client bug, not that retrying the
same call achieves anything; the message instead points at the two real
ways out — start a new conversation, or a manual/future compaction-recovery
mechanism (not implemented by this demo) that trims or re-derives the
archive out of band.

## 11. The future ConversationStore port (NOT implemented in this task)

```ts
// FUTURE — architectural contract only. Not implemented, not instantiated,
// anywhere in this codebase. No database/Redis/Mongo/Qdrant-chat-storage/
// in-memory-session/filesystem persistence exists as of this document.
interface ConversationStore {
  getConversation(conversationId: string, ownerId: string): Promise<Conversation>;

  // Atomically appends the just-completed user+assistant turn AND replaces
  // the summary (when one was supplied) in ONE operation against ONE
  // expectedVersion — eliminates the stale-version race a literal
  // appendMessages()-then-updateSummary() pair would have (if
  // appendMessages() increments the stored version, a second call using the
  // SAME expectedVersion is already stale), and guarantees messages and
  // their matching summary are never persisted out of step with each other.
  commitTurn(input: {
    conversationId: string;
    ownerId: string;
    expectedVersion: number;
    messages: Message[];        // the new turn(s) to append, newest last
    updatedSummary?: string;    // present only when Ask returned conversation.summaryChanged: true
  }): Promise<{ version: number }>;  // the NEW version, for the caller's next request
}

interface Conversation {
  id: string;
  ownerId: string;         // tenant/user scoping — owned and enforced entirely by the integrating app
  assistantId: string;     // maps to an allow-listed collection, resolved by the integrating app
  collection: string;
  summary: string;
  recentMessages: Message[];
  version: number;         // optimistic concurrency token
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}
```

A future implementation may still expose separate lower-level
`appendMessages`/`updateSummary` methods internally (e.g. as private helpers
`commitTurn` composes within one database transaction), but the public port
this document specifies leads with `commitTurn` as the one correct way to
persist a completed turn — precisely so no integrator is tempted to call two
separate version-checked writes for what is really one atomic event.

## 12. Explicit scope boundary vs. Stage D and Track F

This is a bounded, non-durable precursor slice. It does NOT implement Stage
D's ([ask-application-runtime.md](ask-application-runtime.md) §6) full
durable session/production-application feature set, or Track F's
([docs/en/roadmap.md](../en/roadmap.md) "Track F — Agent Memory Overlay",
[agent-memory-and-conversation-context.md](agent-memory-and-conversation-context.md))
durable, scoped, provenance-tracked long-term/episodic memory with promotion
workflows and cross-conversation retrieval. v2 has no persistence, no
promotion workflow, no cross-conversation retrieval, and no memory that
outlives a single HTTP request. A future `ConversationStore`-backed
implementation remains a distinct, larger undertaking this document
deliberately does not attempt.

## 13. Non-goals (restated for auditability)

- No persistent chat storage of any kind — `ConversationStore` is documented
  only, never instantiated, never even given a stub in-memory implementation
  "for now."
- No user accounts, authentication, or session management —
  `conversation.id` is never used to look up or authorize anything.
- No dashboard chat history UI. The admin dashboard has no Ask panel at
  all — only retrieval search. Manual/debugging exercise of Ask (v1 or v2)
  happens via `curl` or the runnable `packages/lite/examples/` client, not
  through any dashboard UI; this design does not add one.
- No semantic/episodic long-term memory, no cross-conversation retrieval, no
  promotion workflow.
- **No editable/client-supplied system prompts.** A configurable system
  prompt (letting an integrating application supply its own behavioral
  instructions rather than accepting Semidex's fixed one) is explicitly a
  CANDIDATE FOR A SEPARATE FUTURE TASK, not something this design leaves a
  half-finished extension point for — `parseAskRequestV2()`'s
  `KNOWN_ROOT_KEYS`/`KNOWN_CONVERSATION_KEYS` sets contain nothing
  system-prompt-shaped, and §8.1's message-role security boundary is
  independent of and would need its own explicit reconsideration alongside
  any future work in that direction (a configurable system prompt and the
  "reject system/developer/tool roles" rule are two different concerns that
  happen to both touch "what counts as an instruction" — solving one does
  not automatically solve or weaken the other).
- No automatic collection selection — `collection` remains a required,
  explicit, caller-supplied field.
- No real ONNX LLM generation work.
- No provider-specific conversational APIs (no Ollama chat-thread IDs, no
  Gemini multi-turn session objects) — the existing single-shot `generate()`
  contract is reused unchanged for the main answer, the rewrite call, and the
  compaction call alike; conversation state is assembled into plain prompt
  text by Semidex on every call.
- Zero changes to `/api/v1/ask`'s own three files.
