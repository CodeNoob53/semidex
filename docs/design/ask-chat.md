# Ask Chat — Detailed Design (Dashboard Main Page)

> Status: design document, 2026-07-02. This is the detailed specification for
> phases 4A / 4B / 4C of `admin-ui-ux-and-ask-plan.md` — it does not change
> that plan's ordering, it fills it in. Depends on: Phase 3A layout (chat is
> a mode of the single main content surface), Phase 3D entity renderer
> (entity cards), Phase 4A.5 settings (provider readiness display).
> The groundedness gate (4E) still decides when chat becomes the default
> landing surface; until then it is a first-class tab, not the home screen.
>
> **Phase 4A backend status (2026-07-15): implemented.** `POST /api/ask` and
> the `src/core/generation/`, `src/core/ask/`, `src/core/retrieval/` modules
> described below exist and are tested — see
> `docs/admin-api-phase4a-ask-backend-2026-07-15.md` for the implementation
> report. §5.1's module list gained one file not listed below,
> `src/core/ask/coordinator.js` (orchestrates evidence -> prompt -> provider
> -> citation validation and owns the single-generation lock — the task that
> commissioned this phase required it explicitly). §5.1's evidence.js reuses
> the Phase 3X bounded-assembly primitive `getAnchoredContent()` for
> skeleton hits (section-scope expansion, per-source token budget), not a
> plain retrieval-only implementation — see that module's own comments.
> Everything in §6 (frontend) remains unbuilt — this status note covers the
> backend only.

## 1. Product definition

**What it is:** a grounded question-answering chat over **one selected
collection**. Every answer is produced exclusively from retrieved chunks of
that collection, cites them inline, and can display original entities
(tables, code, later images). It is the conversational face of the retrieval
system the dashboard already exposes as search.

**What it is not:**

- not a general-purpose chatbot (no answers from model world-knowledge);
- not an agent (no tool calls, no multi-step planning in v1);
- not chat-ops (index/reindex/delete/repair stay buttons);
- not multi-collection (per-collection scope only, per the consolidated plan).

**Multi-turn decision (v1):** the UI is a transcript (persistent visual
conversation), but **each question is answered independently** — fresh
retrieval, no conversation carried into the prompt. Rationale: a ~4B local
model with an ~8k context cannot afford both conversation history and a full
evidence block without degrading groundedness, and independent turns keep
every answer verifiable against its own `sources` event. Follow-up question
condensation ("what about its default value?" → rewritten standalone query)
is explicitly **v2**, listed in §9.

## 2. Placement & information architecture

- Chat is a **mode of the main content surface** from Phase 3A — a segmented
  `Ask | Search` switch at the top of main, sharing the collection/node
  scope from the sidebar. Not a new stacked panel, not a floating widget.
- Routes: `#/c/:name/ask` (chat in collection scope). After gate 4E passes,
  `#/` becomes "pick collection → ask"; until then `#/` keeps its current
  behavior.
- Scope chip: like the search playground's file filter — asking from a file
  or section node pins a scope chip (`sourceFile` filter into retrieval),
  clearable with `×`.
- The header of the chat surface shows: active generation provider + model
  (from 4A.5 settings/status), readiness state, and expected-latency hint.
  If the provider is not ready, the composer is disabled with an inline
  explanation and a "open settings" link — never a dead send button.

## 3. UX specification

### 3.1 Layout

```text
┌ main ──────────────────────────────────────────────────────┐
│ [Ask | Search]           provider: ollama/gemma3:4b ● ready │
│ ┌ transcript (scrolls) ─────────────────────────────────┐  │
│ │  user bubble (right-aligned, plain text)              │  │
│ │  answer block:                                        │  │
│ │    ── sources strip (cards, appear first) ──          │  │
│ │    streamed answer text with [1][2] links             │  │
│ │    entity cards (tables/code/images) when referenced  │  │
│ │    footer: model · elapsed · copy · show retrieval ▾  │  │
│ └───────────────────────────────────────────────────────┘  │
│ [scope chip ×]  ┌ composer ───────────────┐ [send/stop]    │
│                 │ textarea, autosize       │                │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Two-phase render (the core interaction)

1. User sends a question → user bubble appears instantly; composer disables;
   send button becomes **Stop**.
2. `sources` SSE event (sub-second): source cards render immediately —
   rank, `sourceFile § section`, snippet. The user has something real to
   read while the model warms up. A subtle "generating…" shimmer sits where
   the answer will stream.
3. `token` events append to the answer text (rAF-batched, not per-token DOM
   writes). The transcript stays pinned to bottom **unless the user scrolls
   up** (pin re-engages via a "↓ latest" button).
4. `done` event: citations finalized into links, entity markers resolved to
   cards, footer rendered (model, elapsed seconds, copy-as-markdown).

### 3.3 States (exhaustive)

| State | Behavior |
|---|---|
| Provider not ready | composer disabled + reason + "open settings" link (readiness from the 4A.5 status endpoint; degraded copy for "Ollama installed but model not pulled" vs "Ollama unreachable") |
| Empty question | client-side validation, no request |
| Retrieval found nothing | **server refuses without calling the LLM**; UI shows a distinct "nothing indexed matches this question" block + suggestion to rephrase / clear scope chip / open Search — this is not an error state |
| Model refusal (weak evidence) | answer block styled as refusal, sources still shown ("here is the closest indexed material") |
| Stream error mid-answer | partial text preserved, marked "⚠ interrupted: <reason>"; Retry button re-sends the same question |
| User cancel (Stop / Esc) | stream aborted client & server side; partial text preserved, marked "stopped" |
| Question with `<script>` etc. | rendered inert (all strings through `esc()`) |
| Very long answer | answer block max-height with expand; transcript virtualization is NOT v1 (session transcripts are short) |

### 3.4 Citations & entities

- Inline `[n]` in the streamed text become links on `done`; click scrolls
  to + flashes the matching source card. Invalid `[n]` (outside 1..N) is
  rendered as plain text — the server already flags it (§5.4).
- Entity markers `[node: <path>]` in the answer are replaced by entity cards
  (Phase 3D renderer) **only if that path is present in this answer's
  evidence set**; otherwise the marker degrades to plain text with a
  "not in retrieved evidence" tooltip. Structural nodes that were retrieved
  as sources render as entity cards in the sources strip regardless of the
  model mentioning them.
- Every source card: "open in Search view" action (jumps to file/section
  view at that chunk) — the debug path from answer to raw evidence.

### 3.5 Keyboard & a11y

- `Enter` send, `Shift+Enter` newline, `Esc` cancels an active stream.
- Streamed answer container: `aria-live="polite"` on sentence-ish flushes
  (not per token — screen-reader spam).
- Focus returns to composer after `done`/cancel; source cards and citation
  links are tabbable; all states announce via the toast/aria conventions
  from Phase 3B.

### 3.6 Copy

Idle hint: *"Answers are generated only from this collection's indexed
chunks and always cite them. Click a citation to verify."* Refusal copy
never apologizes for the model; it states what was searched and what wasn't
found.

## 4. API contract — `POST /api/ask` (SSE)

Request:

```json
{
  "collection": "my-docs",           // required
  "question": "how do I set the chunk size?",  // required, non-empty
  "sourceFile": "docs/guide.md",     // optional scope (from scope chip)
  "top": 5                            // optional 1..10, default 5
}
```

Response: `text/event-stream`. Event sequence:

```text
event: sources        (exactly once, first)
data: { "searchMode": "hybrid",
        "sources": [ { "n": 1, "sourceFile", "chunkIndex", "totalChunks",
                        "section", "snippet", "nodeType", "nodePath" }, ... ] }

event: token          (0..N times)
data: { "text": "..." }

event: done           (exactly once, last on success)
data: { "citations": [1,3], "invalidCitations": [],
        "entityRefs": ["docs/a.md#table-2"], "strippedMarkers": [],
        "refused": false, "model": "gemma3:4b", "provider": "ollama",
        "elapsedMs": 6120, "promptTokens": 2810, "completionTokens": 340,
        "evidenceCount": 5 }
        // zero-evidence refusal instead sends only:
        // { "citations": [], "invalidCitations": [], "entityRefs": [],
        //   "strippedMarkers": [], "refused": true,
        //   "refusalReason": "no_evidence", "evidenceCount": 0 }
        // (no provider/model/elapsedMs/token counts — the provider was
        // never called)

event: error          (terminal, replaces done on failure)
data: { "code": "generation_failed" | "stream_aborted", "message": "..." }
        // provider_unavailable is NOT an SSE `error` event — it is a
        // plain JSON 503 sent before any stream starts (see Rules below).
```

**Implementation note (2026-07-15):** the event/field names above are
exactly what `src/admin/api/ask.js` sends today; `promptTokens`/
`completionTokens` map to the coordinator's `tokensIn`/`tokensOut`, which
in turn come from Ollama's `prompt_eval_count`/`eval_count` — both
`undefined` when the provider stream ends without a final `done: true`
frame (e.g. an aborted stream), so clients must treat them as optional.

Rules:

- Validation errors (bad body, unknown collection) are plain JSON 400/404
  **before** the stream starts — same envelope as every other endpoint.
- Zero retrieval results → no LLM call; the stream emits `sources` (empty) +
  `done { refused: true, refusalReason: "no_evidence" }`.
- Client disconnect aborts the provider request server-side
  (AbortController through the GenerationProvider contract).
- One concurrent ask per server process in v1 (small local models thrash
  under parallel generations); a second request gets `429 busy` with a clear
  message. Configurable later.
- Provider unreadiness → `503 provider_unavailable` pre-stream, with the
  same reason strings the settings surface shows.

## 5. Backend design

### 5.1 Modules

```text
src/core/generation/
  provider.js        - GenerationProvider contract + validator (mirrors
                       storage/adapter.js): name(), capabilities(),
                       ready(): {ok, reason}, generate({prompt, options,
                       signal, onToken}) → {text, usage}
  registry.js        - provider registry + factory (mirrors storage/factory.js)
  ollama-provider.js - first implementation over src/core/ollama.js
src/core/ask/
  evidence.js        - retrieval → numbered evidence blocks (uses the same
                       search service as /api/search; excludeNav always on).
                       For a skeleton hit (nodeId present), expands to
                       section scope via the Phase 3X primitive
                       getAnchoredContent() (bounded per-source token
                       budget); legacy hits with no node identity fall back
                       to the hit's own chunk text, truncated to the same
                       budget. Hits resolving to the same section are
                       deduplicated to one evidence block.
  prompt.js          - grounded prompt assembly + the deterministic refusal
                       sentinel (pure)
  citations.js       - pure post-processing: [n] validation, [node:] marker
                       validation against the evidence set, refusal-sentinel
                       detection
  coordinator.js     - orchestrates evidence → prompt → provider.generate()
                       → citation validation; owns the single-generation-
                       at-a-time lock (busy 429), always released in
                       finally{} on every exit path
src/admin/api/ask.js - route: validation, SSE framing, event sequencing;
                       DI: { askCoordinator } (adapter/embedQuery flow into
                       the coordinator via createApp(), not the route itself)
```

Layering: `ask` service sits **above** StorageAdapter (retrieval via the
existing search service) and **beside** embeddings (generation is provider
logic). Nothing under `src/admin/` imports Ollama/ONNX directly — the
layering test extends to forbid `core/ollama.js` imports in `src/admin/`.

### 5.2 Prompt design (v1, deterministic template) — as implemented

```text
System:
  You answer questions using ONLY the numbered evidence below.
  Rules:
  - Every factual claim must carry an inline citation like [1] or [2][4].
  - If the evidence does not contain the answer, respond with exactly
    [[INSUFFICIENT_EVIDENCE]] and nothing else. Do not guess. Do not use
    outside knowledge.
  - Answer in the language of the question.
  - To show an original table or code block from the evidence, emit
    [node: <node_path>] on its own line instead of re-typing it. Only use
    a node_path that appears in the evidence below.
  - Be concise.

Evidence:
  [1] (docs/guide.md § Configuration)
  <chunk text>
  [2] ...

Question: <user question>
```

Notes: rules are ported from the MCP retrieval-safety guidance; the
node-marker instruction is included **only** when the evidence contains
structural nodes (don't teach a tool that can't fire). The template is a
pure function → unit-testable snapshot-free (assert on structure, not full
string).

**Refusal sentinel (implemented, supersedes "say so plainly"):** the model
is instructed to emit the exact literal `[[INSUFFICIENT_EVIDENCE]]` and
nothing else when evidence is insufficient — a fixed, language-independent
marker (`src/core/ask/prompt.js`'s `REFUSAL_SENTINEL`) rather than free-form
refusal prose. This lets `citations.js` detect model refusal with an exact
string match instead of guessing refusal phrasing per language. The
sentinel is stripped from `text` before it reaches the client; `done`'s
`refused: true` is the only client-visible refusal signal.

### 5.3 Context budgeting (pure, tested) — as implemented

- Evidence packing: take hits in rank order; per-source token cap (default
  `DEFAULT_PER_SOURCE_TOKEN_BUDGET = 700`, real BGE-M3 tokenizer via
  existing `token-count.js`, same instance the Phase 3X assembly window
  uses); a skeleton hit's cap is enforced by `getAnchoredContent()`'s own
  bounded window, a legacy hit's cap by a simple char-ratio trim in
  `evidence.js`. **Never truncated mid-chunk silently** — every source
  carries its own `truncated: boolean` flag.
- Whole-prompt enforcement is active. The Ollama provider reports an
  effective `numCtx = min(DEFAULT_ASK_NUM_CTX, modelMax)` and the coordinator
  passes that same value as `options.num_ctx` on the generation request.
  `fitEvidenceToContextBudget()` reconstructs and counts the complete prompt
  (rules + evidence + question), reserves
  `RESERVED_HEADROOM_TOKENS = 1024` for generation, and drops the
  lowest-ranked sources until the prompt fits. If no source fits, the turn
  becomes a `no_evidence` refusal instead of exceeding the configured
  context window.
- **Honesty boundary (bounded estimate, not exact generation-tokenizer
  accounting):** evidence and reconstructed-prompt counts use the real
  BGE-M3 tokenizer, which is exact for the indexed text it measures but is
  only a proxy for the generation model's own tokenizer (for example,
  Gemma's SentencePiece vocabulary differs from BGE-M3's). The implementation
  therefore enforces one consistent estimated budget and runtime `num_ctx`,
  but does not claim exact Gemma token accounting. See `evidence.js` and
  `prompt.js` for the same boundary.
- Defaults sized for gemma3:4b @ 8k ctx: top=5 × ≤700 ≈ 3.5k evidence
  tokens, same target as originally planned.

### 5.4 Grounding enforcement (server-side, deterministic)

- Citation validation: `[n]` outside 1..evidenceCount → listed in
  `invalidCitations`, UI renders them inert.
- Marker validation: `[node: path]` not in the evidence set → stripped to
  plain text, listed in `strippedMarkers`. The model can only "show" what
  retrieval actually returned.
- Refusal detection: `refused` is true when (a) zero evidence (server
  decision, no LLM call), or (b) the model's answer matches the refusal
  contract phrase it is instructed to use. No absolute RRF-score thresholds
  anywhere — scores are rank-only signals, per project doctrine.

### 5.5 GenerationProvider contract sketch

```js
{
  name(): 'ollama',
  capabilities(): { streaming: true, cancellation: true },
  ready(): Promise<{ ok, reason?, model? }>,
  generate({ prompt, model, options, signal, onToken }): Promise<{
    text, tokensIn?, tokensOut?, aborted?
  }>
}
```

Registry-shaped from day one (consolidated plan 4A note): 4A.5 registers
cloud adapters into the same registry; the ask route never knows which.

## 6. Frontend design

- `ui-src/js` gains `ask-view.js` (transcript state machine + SSE client)
  and reuses: entity renderer (3D), source-card template (extends
  `tpl-search-result`), toast host, scope chip pattern.
- New templates: `tpl-ask-user-turn`, `tpl-ask-answer`, `tpl-ask-source-card`,
  `tpl-ask-refusal`.
- SSE client: `fetch` + `ReadableStream` reader (not `EventSource` — POST
  body needed); explicit `AbortController` wired to Stop/Esc.
- Transcript state: in-memory per tab (array of turns); composer draft in
  `localStorage`; "New chat" clears the transcript. Persistence of history
  is out of scope (post-lite, consistent with the consolidated plan).
- Rendering rules: user text and streamed tokens are escaped; answer text is
  plain text + citation links + entity cards — **no markdown rendering of
  model output in v1** (a 4B model's markdown is unreliable; plain text with
  real entity cards is more honest and simpler).

## 7. Testing plan

**Unit (pure):** prompt assembly (rules present, evidence numbering, marker
instruction conditional); context budgeting (packing order, per-chunk cap,
truncation flag, headroom); citation/marker validation (in-range, out-of-
range, path-not-in-evidence); refusal decision matrix.

**HTTP-level (stub adapter + stub provider):** full SSE happy path (sources
→ tokens → done with correct metadata); zero-evidence refusal without
provider call (assert stub provider never invoked); provider-unready 503;
mid-stream provider error → `error` event with partial tokens already sent;
client abort → provider `signal` fired; busy 429 on concurrent ask;
validation 400/404 pre-stream. Stub provider emits scripted token sequences,
including one containing `[1]`, an invalid `[9]`, a valid and an invalid
`[node:]` marker.

**UI (linkedom/vm, existing pattern):** answer-turn rendering from a fixture
`done` payload (citation links, entity card swap, refusal styling); source
card rendering; escape of hostile strings in question/tokens.

**Manual live checklist:** slow-model feel (two-phase render visibly useful),
Esc mid-stream, Ollama killed mid-stream, UA question → UA answer with
correct citations, "покажи таблицю" → entity card, scope chip narrows
evidence to one file.

## 8. Task slicing (maps to consolidated-plan phases)

| Task | Phase | Content | Acceptance |
|---|---|---|---|
| C1 | 4A | `generation/` contract + registry + ollama provider | contract validator tests; provider ready()/generate()/abort against stub HTTP |
| C2 | 4A | `ask/` evidence + prompt + budgeting (pure) | unit tests §7; no admin imports |
| C3 | 4A | `citations.js` validation + refusal rules | unit tests incl. marker-not-in-evidence |
| C4 | 4A | `POST /api/ask` SSE route + DI + busy/abort semantics | HTTP-level tests §7 green; curl demo documented |
| C5 | 4B | ask-view: transcript, SSE client, two-phase render, states | linkedom tests + manual checklist §7 |
| C6 | 4B | provider readiness header + settings link (needs 4A.5 status) | unready → disabled composer with reason |
| C7 | 4C | entity cards in answers + sources strip | fixture with table/code node renders original; stripped marker inert |
| C8 | 4E | groundedness eval harness feeding the default-screen decision | numbers in benchmarks results; gate criteria from consolidated plan |

C1–C4 are backend-only and land before any UI. C5 ships behind the
`Ask | Search` toggle immediately (no feature flag needed — it's a tab, not
the default).

## 9. Explicitly deferred (v2+)

- Follow-up condensation (multi-turn memory via standalone-question rewrite).
- Markdown rendering of model output.
- Multi-collection ask; chat history persistence/export beyond
  copy-as-markdown; regenerate-with-different-provider.
- Answer streaming into MCP (assistant runtime API) — shares `core/ask/`
  when it happens, by construction.
- Reranker/CE integration into ask retrieval (inherits whatever
  `/api/search` uses; no ask-specific ranking).

## 10. Risks

| Risk | Mitigation |
|---|---|
| 4B-model answers cite sloppily | server-side citation validation + UI inert rendering of invalid refs; groundedness gate 4E before default |
| Streaming jank on slow machines | rAF-batched DOM appends; plain-text answer (no re-parse per token) |
| Concurrent asks thrash a local model | single-flight 429 v1; queue later if needed |
| Refusal phrase drift (model paraphrases) | refusal contract phrase pinned in prompt + tested; zero-evidence path never depends on the model |
| Transcript grows unbounded in a long session | "New chat" + max-turns soft cap with notice; virtualization only if real usage demands it |
| Prompt-injection inside indexed chunks ("ignore previous instructions") | evidence is data, not instructions: template frames it as quoted material; no tool calls exist to hijack in v1; noted for the future agent track |
