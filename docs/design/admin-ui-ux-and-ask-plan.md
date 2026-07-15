# Admin UI: UX Improvements + Ask (LLM) Track — Consolidated Plan

> Status: design document, 2026-07-02, **rev. 2** (review feedback applied:
> IA pivot promoted to the front, usability baseline added as its own phase,
> structured progress fixed as the contract, `entity_refs` promoted to the
> architectural contract, Ask reframed as future-primary). Builds on
> `admin-ui-and-storage-adapter.md` (layering rules and the §14 review
> checklist remain in force). Nothing here is implemented yet. Ordering is
> strict: phases are listed in execution order, each independently shippable.

## 0. Direction

The dashboard evolves from a debug console into the primary user surface of
semidex. **Ask (grounded local LLM) is a future primary path — it does not
become the default screen until the groundedness gate (Phase 4E) passes.**
Until then, the primary surface is the navigate-and-search experience defined
in Phase 3A. Deterministic admin operations (index/reindex/repair/delete,
health) remain buttons at all times — never chat-ops.

Two standing principles govern every phase:

1. **Evidence stays authoritative.** The LLM references original entities and
   chunks; it never re-types them. Every rendered convenience (stitched view,
   rendered tables) has a one-click path back to the raw original.
2. **Layering holds.** UI → Local API → domain services → StorageAdapter.
   Generation is provider logic (a `GenerationProvider` seam beside
   embeddings), never storage logic, never UI logic.

## 1. Feature inventory (agreed decisions)

| # | Feature | Key decisions |
|---|---------|---------------|
| F0 | **Usability baseline** | Finish the painful basics: folder picker flow, human-readable collection names without slug-only UX, Ollama readiness checks with actionable manual-start guidance, delete-modal completion, simplified indexing form. This is not polish — it is minimum usable admin behavior |
| F0.5 | **Information architecture pivot** | The core UX turn: **sidebar = collection selector + skeleton navigation tree; main area = one content surface** showing either search results or the selected file/section chunks. Search moves to a persistent top-of-main bar scoped to the selected collection/node. Kills the "five stacked panels" page |
| F1 | Accessibility/polish | `--ink-faint` → ≥4.5:1 contrast; `:focus-visible` everywhere; `prefers-reduced-motion`; min 11px labels |
| F2 | Toast component | Single host node, `aria-live="polite"`, queue, variants, optional action button; async events only (form errors stay inline) |
| F3 | Unified job status modal | One `JobStatusModal` for index/reindex/repair (operation = label); **non-blocking**: minimize → topbar chip with progress; progress rendered from the **existing structured `[semidex:progress]` events** (phase-aware `job.progress` in the registry) — **no log parsing**; completion → toast |
| F4 | Search QoL | Query in hash (permalink/back), recent queries (localStorage), score bar normalized to top-1 |
| F5 | Entity rendering in chunks | Typed rendering: GFM table → HTML (zero-dep mini-parser, escape-first), code → highlight.js (bundled locally, no CDN); **rendered/raw toggle** on every card |
| F6 | Code language detection | L0: persist fence info-string in `lang` payload (index time); L1: highlight.js `highlightAuto` limited to a common-language subset, marked "guessed" (UI fallback); L2: `@vscode/vscode-languagedetection` at index time — only if measurement shows the unlabeled rate matters |
| F7 | Chunk stitching (assembly) | **Architectural contract: explicit `entity_refs` (ordered node links) in prose-chunk payload**, written by the indexer and **backfillable** onto existing collections (payload-only — no vector reindex, same mechanism as tags). Placeholder lines remain a display/text artifact and serve only as the **fallback parser for not-yet-backfilled collections**, never the primary machine truth. One assembly service/endpoint reused by file view, chunk preview, and later chat; entities render from node `raw_content`; chunk boundaries = subtle gutter marks; **stitched/chunked toggle**; search results stay ranked cards (+ small "table →" chip only) |
| F8 | Ask (grounded LLM) | `GenerationProvider` seam (`ollama` first, `onnx` opt-in fallback); SSE; **two-phase render** (retrieval evidence instantly → answer streams after); inline citations [1][2] → chunk cards; cite-or-refuse prompt policy; per-collection scope only |
| F9 | Entity cards in chat | LLM emits node markers, UI resolves via node endpoint and renders the **original** (hallucination-proof by construction); deterministic display of structural top-hits independent of the model |
| F10 | Images | Persist collection `sourceRoot` in config.json; guarded asset endpoint (path under sourceRoot + image-extension allow-list + traversal guard); findability via alt+caption+carryover (no vision model needed for v1) |
| F11 | Groundedness gate | Eval on custom-50-style questions (claims covered by cited chunks) before Ask becomes the default screen |
| F12 | Command palette (Ctrl+K) | Deferred — high demo value, zero dependencies, can slot in any time |
| F13 | User settings | Dashboard settings surface for runtime/provider status, indexing defaults, collection defaults, local model settings, and advanced diagnostics. Settings UI must explain where each value comes from: OS environment, `.env`, local semidex config, collection metadata, or session-only override |
| F14 | Local + cloud model providers | Semidex Lite track: `GenerationProvider` and embedding provider configuration must support local runtimes (Ollama, ONNX Runtime, and future local backends) plus cloud/API providers through explicit adapters (OpenAI/ChatGPT, OpenRouter, Anthropic, Gemini, and OpenAI-compatible endpoints). Local model settings include model path/name, task role (embedding/context/tags/ask), and device policy (`auto`, `cpu`, `gpu` where supported). Secrets come from OS env or an explicit local secret store, never from committed config |

## 2. Dependency graph

```text
F0, F1, F2, F4          (no dependencies)
F0.5 ──► after F0       (IA pivot lands on a usable baseline)
F3   ──► needs F2       (completion toasts)
F5   ──► needs F6-L0/L1 (lang for highlighting)
F7   ──► needs F5       (stitched view uses the same entity renderer)
         + indexer entity_refs write + backfill script
F8   ──► independent of F5–F7 at the API level; UI benefits from F5
F9   ──► needs F5 + F8  (renderer + ask panel)
F10  ──► independent; consumed by F7 (images in stitched view) and F9
F11  ──► needs F8
F13  ──► should land before F8 UI (Ask needs visible provider readiness)
F14  ──► extends F8's GenerationProvider; required for semidex lite demos
F12  ──► independent (any time)
```

Critical path to the demo story ("ask → answer with citations → click →
original table/image"): **F0 → F0.5 → F5 → F8 → F9 → F10**. The usability
baseline and IA pivot are on the path because the ask panel and stitched view
need a usable indexing flow and the single-content-surface layout to land well.

Critical path to the semidex lite story ("small PC / local-or-cloud provider /
usable settings"): **F13 → F14 → F8**. Provider configuration is not an
advanced debug panel; it is part of the product surface for users who need to
choose between local runtimes, device placement, and cloud/API providers.

## 3. Phases — what first, what later

### Phase 3A0 — Usability baseline (first; fixes what hurts today)

Scope: F0. Folder picker flow completed (recent paths, validation feedback);
human-readable collection names accepted directly (spaces/Cyrillic allowed;
no slug-only guidance; no `displayName`/technical-id split in this phase);
Ollama readiness state surfaced before any LLM-dependent action with honest
"start Ollama manually" guidance when unavailable (no autostart in this phase);
delete-confirmation modal finished; indexing form simplified to the happy-path
defaults (advanced options collapsed behind progressive disclosure).

Exit gate: a first-time user can index a folder and find a document without
reading docs or touching env vars; every failure state they can hit in that
flow has a visible, actionable message.

### Phase 3A — Information architecture pivot (the core UX turn)

Scope: F0.5. Restructure the shell:

```text
┌ topbar: health lamp · active jobs chip · settings ─────────────┐
│ sidebar                │ main                                   │
│  collection selector   │  [search bar — always visible,        │
│  skeleton nav tree     │   scoped to selection]                │
│  (or directory/file    │  content surface (ONE of):            │
│   tree fallback)       │   · search results                    │
│                        │   · selected file/section chunk view  │
└────────────────────────┴────────────────────────────────────────┘
```

- Sidebar owns navigation: pick collection → its skeleton tree (or
  directory/file fallback) lives there permanently; clicking a node loads it
  into main. No more skeleton-as-a-panel.
- Main owns content: search results OR the selected file/section chunks —
  one surface, one scroll, replacing the stacked
  metadata/search/documents/skeleton/preview panels.
- Collection metadata moves to a compact header strip + expandable details.
- Routes: `#/c/:name` (collection home = search), `#/c/:name/f/<sourceFile>`
  (file view), `#/c/:name/n/<nodePath>` (section view) — all linkable.

Exit gate: the five-panel collection page is gone; navigation never loses
the user's place (sidebar selection ↔ main content ↔ URL stay in sync);
search from any node scopes to that node's file/section.

### Phase 3B — Polish, toasts, search QoL (after the IA exists)

Scope: F1 + F2 + F4, applied to the new layout (this ordering is deliberate:
polishing the old layout would be wasted work).

Exit gate: contrast/focus/reduced-motion pass on the new shell; toast host
reachable from any view; a search URL pasted into a new tab reproduces the
search.

### Phase 3C — Unified job status — **shipped 2026-07-11 (Phase 3S)**

Scope: F3. One global operation status modal for index/reindex/repair driven
by the job registry's **structured progress** (`[semidex:progress]` →
`job.progress`, phase-aware) — rendering phases and counts directly from the
contract, no output parsing; topbar chip subscribes to a shared client-side
store instead of polling independently; completion/failed toast with a
"View"/"View details" action.

Exit gate: all three operations run through the one modal; start → navigate
away → return via toast works; legacy per-operation progress UIs are deleted
(not hidden); the modal renders every phase the progress contract emits. **All
met** — see `docs/admin-ui-phase3s-unified-operation-status-2026-07-11.md`
for the full report. Implemented contract, where it differs from the
original sketch above:

- **No `JobStatusModal` class** — plain functions in
  `operation-modal.js`/`operation-render.js`/`operation-store.js`, matching
  this codebase's existing module style (no class-based UI components
  anywhere else in `src/admin/ui-src/`).
- **No progress ring** — the topbar chip reuses the existing pulsing-dot +
  text pattern (`.job-chip-dot`), now also showing a live percentage when
  known (e.g. "Indexing my-docs 43%") and an indeterminate dot alone when
  not, rather than a new ring widget.
- **Repair is a genuine tracked operation, not a synthetic one.** A new
  `src/admin/jobs/task-registry.js` (running/succeeded/failed only — no
  queued/cancelling, since an in-process function has no OS-scheduling
  delay and no genuine cancel point) tracks repair calls; `GET
  /api/operations` merges it with the existing job registry into one shape.
  `POST /api/collections/:name/sync-schema` keeps its original synchronous
  200-with-result contract (repair is fast — a handful of Qdrant round
  trips) while ALSO being visible in the shared operation feed for its
  duration.
- **`kind: 'index' | 'reindex'` is a new optional field** on `POST
  /api/jobs/index`'s request body (defaults to `'index'`) — purely a
  display-label distinction for the modal; both run through the identical
  spawn/env/progress path.
- One shared poller (`operation-store.js`, started once at app boot,
  independent of route lifecycle) is the sole thing that calls `GET
  /api/operations` — the modal and topbar chip both subscribe to it
  (pub/sub), neither polls on its own. This is what makes an operation
  survive navigation and keeps the chip and modal from double-polling.

### Phase 3D — Entity rendering in chunks (unblocks the chat track) — **shipped 2026-07-11 (Phase 3T)**

Scope: F5 + F6-L0/L1. Shared entity renderer (table + code) used by search
results, chunk view, and file view in the new main surface; rendered/raw
toggle; highlight.js bundled through Vite (curated grammar subset); verify
the indexer persists fence info-strings into `lang` (add if missing —
payload-only); UI autodetect fallback marked "guessed"; measure the
unlabeled-lang rate on real collections → decision input for F6-L2.

Exit gate: table renders as HTML and toggles to byte-exact raw; fenced code
highlights with the right language; XSS attempt in cell/code renders inert;
renderer covered by linkedom-based unit tests. **All met** — see
`docs/admin-ui-phase3t-structural-entity-renderer-2026-07-11.md` for the full
report. Implemented contract, where it differs from the original sketch
above:

- **The indexer already persisted `raw_content`/`lang`** — confirmed in the
  production write path (`skeleton-chunk.js`/`skeleton-payload.js`) before
  any code change; no payload/schema change was needed. Only the storage
  adapter's read-side domain mapping (`toChunk()`/`toStructuralNodeChunk()`
  in `qdrant-adapter.js`) was missing `rawContent`/`lang` — that's the one
  mapping this phase actually added.
- **`checklist` is unchanged this phase** — `STRUCTURAL_RENDER_TYPES` (the
  new module's own type set) covers `table`/`code_block` only, matching the
  task's explicit scope; checklist chunks keep rendering as plain text via
  the existing (Phase 3O/3P) `STRUCTURAL_NODE_TYPES` badge/label path.
- **F6-L2 decision input measured on real data**: a 25-file sample of a real
  Python/web course collection showed only ~29% of fenced code blocks carry
  an explicit, curated-grammar-resolvable `lang` — most either have no
  fence label at all, or carry a label that isn't a real language name
  (author/tooling noise). Autodetection across the curated 15-language
  subset is doing real, necessary work on real content, not just covering a
  rare edge case.
- **Bundle-size cost is real and worth naming explicitly**: adding
  `unified`+`remark-parse`+`remark-gfm`+`highlight.js` (core + 15 curated
  grammars) grew the admin UI's JS bundle from 56.3 kB to 256.2 kB raw
  (16.2 kB → 76.5 kB gzip) — see the Phase 3T report for the full before/
  after breakdown and confirmation that only the curated grammar set is
  bundled (no CDN/dynamic remote import).

### Phase 3E — Assembly & stitching (closes roadmap Stage 2 "content assembly")

Scope: F7, in three steps:

1. **Indexer:** write ordered `entity_refs` (node ids/paths) into prose-chunk
   payload at skeleton-chunking time.
2. **Backfill:** payload-only script (like `backfill:tags`) deriving
   `entity_refs` from existing placeholder lines for already-indexed
   collections — no vector reindex.
3. **Assembly service + API:**
   `GET /api/collections/:name/assembly?nodePath=|sourceFile=&scope=section|file`
   returning ordered `[{kind: 'prose'|'entity', ...}]`; consumes
   `entity_refs` when present, falls back to placeholder parsing for
   not-yet-backfilled collections (fallback logged, never silent).

UI: stitched view in the file/section surface (gutter chunk marks,
matched-chunk highlight, stitched/chunked toggle); "table →"/"code →" chip
on search results. Update `docs/en/roadmap.md` Stage 2 (assembly shipped via
Local API; MCP `qdrant_get_content` can reuse the same service later).

Exit gate: prose + table + code section reads as one continuous document;
toggle reveals exact chunk boundaries; a legacy non-skeleton collection
degrades to plain chunk sequence; backfilled and freshly-indexed collections
produce identical assembly output.

### Phase 4A — GenerationProvider + `POST /api/ask` (start of the LLM track)

Scope: F8 backend. `src/core/generation/` seam (`ollama` provider first;
capability-gated, DI-able for tests); `POST /api/ask` (SSE): retrieve via the
existing search service → grounded prompt (evidence-only, inline citation
markers, refusal on weak retrieval — port the MCP retrieval-safety rules) →
stream; events: `sources` (immediately) → `token`* → `done{citations,
refused?}`. No UI yet; testable via curl + stub provider.

The seam must be **registry-shaped from day one** (same pattern as
`src/core/storage/factory.js`): 4A ships one registered provider (`ollama`),
and Phase 4A.5 plugs local/cloud adapters into the same registry without
reworking the seam. This resolves the phase-order note in §2: the lite
critical path (F13 → F14) extends 4A's seam; it does not precede it.

Exit gate: stub-provider unit tests for prompt assembly, citation extraction,
refusal path, SSE framing; live manual check against Ollama documented.

**Status (2026-07-15): backend exit gate met.** See
`docs/admin-api-phase4a-ask-backend-2026-07-15.md` for the implementation
report and `docs/design/ask-chat.md`'s own status note for the module-level
detail. No UI work from this plan's later phases has started.

### Phase 4A.5 — Settings + external provider configuration

**Status (2026-07-15): 4A.5a (runtime/config/status backend) done; Settings
UI and cloud adapters not started.** See
`docs/admin-api-phase4a5a-generation-runtime-2026-07-15.md` for the
implementation report. What exists now: `resolveGenerationRuntimeConfig()`
(pure config resolver with OS-env/`.env`/default provenance), the
generation runtime service (`src/core/generation/runtime.js`, wraps the
registry, never crashes admin startup on bad config), `GET
/api/generation/status` (backend-neutral, redacted), and the explicit admin
bootstrap (`src/admin/bootstrap.js`, `npm run admin`'s real entry point —
snapshots OS env before any `dotenv/config` import can mutate it). Ask and
the status endpoint now share one `generationRuntime` instance per server
process. Still entirely deferred to a later 4A.5 slice: the Settings UI
itself, cloud/API adapters, API-key persistence, session provider
switching, local config-file writes.

Scope: F13 + F14. Add a dashboard Settings surface and provider/runtime
registry.
Settings must separate:

- **Runtime status:** Qdrant reachable, Ollama reachable, ONNX Runtime
  available, active generation provider, active embedding provider.
- **Config source:** OS env, `.env`, local semidex config, collection metadata,
  or session-only override. OS env is a first-class source, not an invisible
  implementation detail.
- **Secrets:** API keys are shown only as detected/missing/redacted. They are
  read from OS env by default. If a local secret store is added later, it must
  be explicit and excluded from git by construction.
- **Local runtime adapters:** Ollama, ONNX Runtime, and future local backends.
  The provider contract must not assume that local LLM means Ollama. Local
  settings include model name/path, task role (`embedding`, `context`, `tags`,
  `ask`), quantization/runtime notes where available, and device policy:
  `auto`, `cpu`, `gpu` where the backend supports it. Unsupported device
  choices must be visible and rejected clearly, not silently ignored.
- **Cloud/API adapters:** OpenAI/ChatGPT, OpenRouter, Anthropic/Claude, Gemini,
  and generic OpenAI-compatible endpoints. OpenRouter should not need a
  separate generation core if the OpenAI-compatible adapter can cover it
  cleanly.
- **Semidex Lite defaults:** cloud/API generation is allowed; local indexing
  and Qdrant-native capabilities remain available. The UI should make both
  tradeoffs visible before enabling a provider: locality/privacy for cloud
  APIs, and speed/memory/device placement for local models.
- **Generation vs embedding providers are NOT symmetric, and the UI must not
  present them as such.** Generation is *stateless*: switchable at any time,
  affects only the next answer. Embedding is *stateful*: it is baked into a
  collection's vectors, guarded by the provider-mismatch reindex detection.
  Therefore: the generation provider is a freely switchable runtime setting;
  the embedding provider in Settings is only a **default for newly created
  collections**, existing collections display their embedding provider as
  read-only collection metadata, and any path that would change it must show
  an explicit "requires full reindex of N points" confirmation — never a
  silent dropdown switch.
- **Remote-exposure precondition (restated because cloud keys raise the
  stakes):** with API keys configured, an exposed Local API becomes a proxy
  to paid providers and private data. `ADMIN_ALLOW_REMOTE=1` without
  `ADMIN_TOKEN` must hard-fail once any cloud provider is configured — the
  loopback-only default is no longer a sufficient boundary on its own.

Exit gate: a user can see why Ask is unavailable, which provider is active,
which env var or setting is missing, and how to switch providers without
editing source code. A user can also see where local embedding and LLM models
will run (`auto`/`cpu`/`gpu`) when the backend exposes that control. Unit tests
cover config precedence, redaction, and unsupported device-policy handling.

### Phase 4B — Ask panel UI

Scope: F8 frontend, as a tab/mode of the main content surface (not another
stacked panel). Two-phase render — source cards on `sources`, answer streams
after; inline [n] citations link to source cards; "show retrieval" expander;
refusal and degraded states shown verbatim. Copy keeps the evidence framing.

Exit gate: full ask flow works against a stub SSE fixture offline; manual
live checklist (slow model, refusal case, Ollama down mid-stream).

### Phase 4C — Entity cards in chat

Scope: F9. Deterministic: structural nodes among retrieved sources render as
entity cards (Phase 3D entity renderer) under the answer. Model markers: prompt teaches
`[node: <path>]`; UI resolves markers through the node endpoint and swaps in
the original entity card; unresolvable marker degrades to a plain citation.

Exit gate: "покажи таблицю X" renders the original from `raw_content`; a
fabricated node path shows "node not found", never fabricated content.

### Phase 4D — Images end-to-end

Scope: F10. Indexer: persist `sourceRoot` per collection; image nodes carry
alt/caption + carryover (findability without vision). API:
`GET /api/collections/:name/asset?path=` — security-reviewed: resolved path
strictly under the collection's sourceRoot, image-extension allow-list,
traversal tests (reuse the static.js guard pattern). UI: image cards
(thumbnail → lightbox → "open source") in stitched view and chat.

Exit gate: the LEGO scenario works end-to-end; traversal/extension escapes
covered by tests; collections without a recorded sourceRoot degrade to a
clear "reindex to enable originals" notice.

### Phase 4E — Groundedness gate

Scope: F11. Eval harness over custom-50-style questions: every answer claim
attributable to a cited chunk; refusal correctness on negative queries. Ask
becomes the default landing surface **only** after this gate passes with
numbers recorded in `benchmarks/.../results/`.

### Later (deliberately unscheduled)

- F12 command palette — any time.
- F6-L2 ML language detection — only if 3D's measurement shows a real gap.
- Overview "5–7 metrics" home — after the IA pivot settles.
- Vision/OCR image understanding — existing roadmap track, unchanged.
- Multi-collection ask, chat history persistence — post-lite scope.

## 4. Cross-cutting requirements (every phase)

- `npm test` + `npm run smoke` green; `git diff --check` clean; report doc
  per phase (existing convention).
- No new runtime dependencies without justification in the report (expected:
  highlight.js in 3D — bundled, offline; nothing else currently justified).
- §14 review checklist from `admin-ui-and-storage-adapter.md` applies, plus:
  **"rendered convenience has a raw toggle; original content is never
  re-generated by a model."**
- All rendered strings escaped; new endpoints use the JSON error envelope.

## 5. Risks

| Risk | Mitigation |
|---|---|
| IA pivot (3A) is the largest UI change and could stall | it ships behind the existing router — old routes can alias to new ones during the transition; exit gate demands deletion of the old layout, but the phase may land in 2–3 PRs |
| `entity_refs` backfill drifts from placeholder-derived data | backfill unit-tested against `placeholderFor()`'s actual output (shared fixture); assembly asserts refs and placeholders agree during the transition window |
| highlight.js bundle size | curated grammar subset only |
| Local LLM answer latency hurts the demo | two-phase render makes retrieval useful before the first token; document expected latency per model in settings |
| Users trust chat over evidence | cite-or-refuse prompt, structural citations, groundedness gate 4E before Ask becomes default |
| Asset endpoint = disk access from browser | strict sourceRoot + extension allow-lists + traversal tests; security-reviewed in 4D exit gate |
| Settings lets a user "switch" embedding provider and silently break search | generation/embedding asymmetry codified in 4A.5: embedding is per-collection index-time metadata; Settings only sets the default for new collections; changes demand an explicit reindex confirmation |
| Cloud API keys + remote exposure = open proxy to paid providers | `ADMIN_ALLOW_REMOTE=1` hard-fails without `ADMIN_TOKEN` when any cloud provider is configured; keys never returned by any endpoint (redacted status only) |
| Provider adapter sprawl | one generic OpenAI-compatible adapter covers OpenRouter and compatible endpoints; dedicated adapters only where the wire format genuinely differs (Anthropic, Gemini) |
