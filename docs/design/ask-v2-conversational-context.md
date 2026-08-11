# Ask API v2 — Bounded Conversational Context

> Status: implemented, 2026-08-12. Adds `POST /api/v2/ask` alongside the
> unchanged `POST /api/v1/ask`. See
> [ask-chat.md](ask-chat.md) §9 for the pointer from the dashboard reference
> client's own deferred-features list, and
> [ask-application-runtime.md](ask-application-runtime.md) for the broader
> product/runtime boundary this endpoint sits inside.

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
{ "conversation": { "id": "conv_123", "summaryChanged": true, "updatedSummary": "..." } }
```

`conversation` is omitted entirely from `done` when the request had no
`conversation` field at all (a first-turn request) — never present as `null`
or `{}`. `updatedSummary` is present only when `summaryChanged` is `true`.
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
persist under its own optimistic-lock scheme (see §10's `commitTurn()`);
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

## 9. Summary compaction design

`src/core/ask/summary-compaction.js`'s `compactSummaryIfNeeded()` is
best-effort and attempted only when `(recentMessages.length + 2) >=
ASK_SUMMARY_COMPACTION_THRESHOLD` (the raw, caller-visible pre-trim count —
the integrating app's own source of truth for "does my history look long").

**Whole-prompt budgeting, not independent per-field budgets.** The model
input is built in a fixed order: (1) fixed system-prompt overhead, counted
once; (2) the just-completed current turn (`question`+`answer`), the
highest-priority content, budgeted BEFORE history — with deterministic,
char-safe truncation of `answer` if the turn alone doesn't fit; (3) only THEN
is the remainder handed to `budgetConversationContext({...,
purpose:'compaction'})` — the SAME shared trimming algorithm the answer path
uses, fed a synthetic `numCtx` derived from the real remainder, never a
second, independently-implemented trimming path; (4) a final verification
pass renders the REAL, literal prompt via `buildCompactionPrompt()` (never a
hand-summed estimate) and measures it with one real `countTokens()` call,
deterministically shrinking history (oldest first), then summary, then
degrading to a skip if formatting overhead alone pushes the combined
`systemPrompt + prompt` over `numCtx - RESERVED_HEADROOM_TOKENS`. This is the
one true invariant the whole design guarantees: the literal provider input,
not an estimate reconstructed from its parts, always fits.

**A failed or oversized compaction never turns a successful answer into an
error.** Every degenerate case — threshold not met, current turn alone
doesn't fit, timeout, generation failure, formatting overhead still
overflowing after every shrink step — resolves to `{ changed: false }`
inside `compactSummaryIfNeeded()`'s own try/catch boundary; no exception ever
crosses that function's own boundary. `coordinator-v2.js` calls it strictly
AFTER the main answer has already returned `status: 'done'`, so a compaction
problem can only ever affect the trailing `updatedSummary`/`summaryChanged`
fields merged onto an already-successful result — the `done` SSE event still
completes normally with `summaryChanged: false` and no `updatedSummary` key.

The compaction system prompt explicitly instructs the model never to present
prior assistant answers as verified collection facts — mirroring §8's
evidence/citation safety framing.

## 10. The future ConversationStore port (NOT implemented in this task)

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

## 11. Explicit scope boundary vs. Stage D and Track F

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

## 12. Non-goals (restated for auditability)

- No persistent chat storage of any kind — `ConversationStore` is documented
  only, never instantiated, never even given a stub in-memory implementation
  "for now."
- No user accounts, authentication, or session management —
  `conversation.id` is never used to look up or authorize anything.
- No dashboard chat history UI — the existing browser Ask panel remains a
  manual/debugging workflow, not extended into a multi-turn chat UI.
- No semantic/episodic long-term memory, no cross-conversation retrieval, no
  promotion workflow.
- No editable/client-supplied system prompts.
- No automatic collection selection — `collection` remains a required,
  explicit, caller-supplied field.
- No real ONNX LLM generation work.
- No provider-specific conversational APIs (no Ollama chat-thread IDs, no
  Gemini multi-turn session objects) — the existing single-shot `generate()`
  contract is reused unchanged for the main answer, the rewrite call, and the
  compaction call alike; conversation state is assembled into plain prompt
  text by Semidex on every call.
- Zero changes to `/api/v1/ask`'s own three files.
