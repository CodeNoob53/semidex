# MCP Phase 3X — Bounded Anchored Content Assembly

A new MCP tool, `qdrant_get_content`, lets an agent expand a `qdrant_search`
hit into coherent section/file context without loading an entire document
into its context window. It reuses the Phase 3V/3W core assembly service
end to end — no second assembly implementation for MCP — and adds a pure
token-bounded, cursor-paginated windowing layer on top of it.

## Implemented contract

### `qdrant_get_content`

```text
qdrant_get_content(
  collection: string,
  anchor_node_id: string,
  scope: "section" | "file" = "section",
  max_tokens: integer = 2000,   // 200-8000
  cursor?: string,
  format: "text" | "nodes" = "text",
)
```

Flow: resolve `anchor_node_id` through `StorageAdapter.getContentNode()` →
reject a missing or navigation-node anchor → resolve scope (`section`: the
anchor's exact containing section via `parentId` + `getSectionChunks()`;
`file`: `getFileChunks()`) → run `assembleDocument()` (the identical
function the admin Local API's `/assembly` endpoint and Phase 3W's document
reader use) → locate the anchor's own segment in the assembled array →
`buildAssemblyWindow()` for the bounded, anchor-centered, paginated slice.

- **`format=text`**: reconstructed ordered Markdown/text (verbatim
  concatenation of segment `text`/`rawContent`, never rewritten or
  summarized) plus compact metadata and pagination state.
- **`format=nodes`**: ordered structured items — `node_id`, `node_path`,
  `chunk_index`, `node_type`, `section`, `heading_path`, `content`, and an
  `is_anchor` marker on every non-oversized item.
- Both modes omit vectors, provider internals, and raw Qdrant payload
  fields — confirmed by a test that walks the full response object's key
  set (not a substring match, since `assembly_mode`'s legitimate *value*
  `"entity_refs"` would otherwise false-positive against a naive
  `"entity_refs"` substring check).

### `max_tokens` bounds — chosen and documented

Default **2000**, range **200–8000**, validated strictly (an out-of-range
or non-integer value is a clear validation error, never silently clamped).
Reasoning: 200 is the floor below which a bounded window stops being
useful (smaller than most single paragraphs); 2000 gives a meaningful
section of context without dominating an agent's turn; 8000 caps a single
call at roughly `qdrant_get_node`'s own `preview_chars` ceiling (8000
chars ≈ 2000 tokens) times four, since content assembly spans multiple
nodes rather than one — high enough for a genuinely large section, low
enough that one call can never accidentally consume an agent's whole
context budget.

**`max_tokens` bounds the real reconstructed text** — every `text`/
`rawContent` token count, PLUS the `\n\n` separator rendered between
consecutive items (code review round 2), PLUS the fixed `OVERSIZED_NOTE`
token cost for each oversized entity included (code review round 1) — never
other diagnostic metadata (node identity, cursors, counts, the JSON
envelope itself, or the `omitted_entities` list, which is unbounded by
design since it is metadata, not renderable content). This is stated
explicitly in the tool's own schema description, in `contract.js`'s
`AssemblyWindowResult` typedef, and verified by tests that check both
`returned_tokens <= max_tokens` and — the stricter, round-2 assertion —
`countTokens(response.text) <= max_tokens` against the actual joined string
an LLM would read (20-small-segment fixture across several budgets; and the
round-1 oversized repro, 20 oversized entities at `max_tokens=200`,
previously `returned_tokens=0`, now genuinely bounded).

## Adapter changes

**`getStructuralNode` → `getContentNode`** (rename, no compatibility
alias). Investigation confirmed the underlying store primitives
(`getContentNodeById`/`getContentNodeByPath`) never filtered by
`node_type` — only by `point_kind !== 'skeleton_nav'` — so the old name
was actively misleading: it already resolved prose nodes, not just
structural ones. Updated: `StorageAdapter` JSDoc typedef,
`REQUIRED_ADAPTER_METHODS`, the Qdrant adapter implementation and its
`toStructuralNodeChunk` → `toContentNodeChunk` mapper, the one real call
site (`src/admin/api/node.js`), and every test stub (`server.test.js`,
`search.test.js`, `jobs.test.js`, `operations.test.js`, `system.test.js`,
`ui-test-helpers.js`). No alias was left behind — the only consumer was
the one route file, updated directly.

**`toContentNodeChunk` gained `parentId`/`headingPath`** — the field
`qdrant_get_content`'s anchor resolution needs to walk from "one content
node" to "its containing section" without a new adapter method: `anchor.
parentId` → `getSkeletonNode({ nodeId: parentId })` → verify `nodeType ===
'section'`. `CONTENT_NODE_FIELDS` already projected `parent_id`/
`heading_path` (added in Phase 3V for a different reason); the adapter
mapping simply hadn't surfaced them on this particular shape yet.

**`assembleDocument()` prose segments gained `nodeId`/`nodePath`**
(additive) — a prose chunk is already a real skeleton node with its own
identity; only entity segments exposed it before. Bounded anchored
retrieval needs every segment addressable, prose included, so a
search hit landing on a paragraph can be used as an anchor exactly like a
table hit can. `null` on legacy (`plain_chunks`) segments — never
fabricated. Verified for all four segment kinds the task named: prose,
table, code_block, checklist.

## Cursor semantics

A lightweight, versioned (`ac1.` prefix), base64url-encoded JSON envelope
(`src/core/assembly/cursor.js`) — no encryption, no persistence, no
registry, per the task's explicit "lightweight is sufficient" guidance.

- **Opaque**: callers never construct or parse it themselves.
- **Deterministic**: identical payload → identical cursor string; identical
  request replayed with the same cursor → identical page.
- **Validated against the current request**: `cursorMatchesRequest()`
  checks version, collection, scope, a cheap `sourceKey` (source
  file/node-path/assembly-mode composite — never a content hash), the
  anchor, and `totalSegments`. A cursor minted for a different
  collection/scope/anchor, or one whose underlying scope changed shape
  (e.g. a reindex altered the segment count), is rejected outright — never
  silently reinterpreted.
- **Independent of Qdrant scroll offsets by construction**: a cursor
  encodes a plain array index into the already-assembled `segments` array;
  it has no relationship to a Qdrant `next_page_offset` token.
- **No overlap, no gaps**: `edgeIndex` is the last array index *not yet*
  returned in a direction; continuation starts exactly there. Verified by
  walking `before + initial-page + after` and asserting the combined
  chunk-index sequence is strictly contiguous with no duplicates.

## Windowing algorithm (`src/core/assembly/window.js`)

Pure, given an already-assembled `AssemblyResult`, an injected
`countTokens`, and the literal `separatorText` the caller renders between
items. Every candidate page is serialized and counted in one tokenizer call,
because BPE tokenization is not additive across separately-counted segments
and separators. If the whole scope — including its inter-segment separators —
fits `maxTokens`, returns everything unpaginated. Otherwise: the anchor is
always represented in the initial page (as itself, or as an oversized
descriptor if it alone exceeds budget), then expansion alternates
backward/forward one whole segment at a time, stopping a direction the
moment the next segment (its content **plus** the separator that would
precede it) would exceed the remaining budget — a segment is never split or
truncated to fit partially.

**Oversized single segment policy**: a table/code/checklist entity that
alone exceeds `maxTokens` is never dumped or truncated mid-row/mid-block.
It becomes a bounded descriptor — `{ nodeId, nodePath, chunkIndex,
nodeType, oversized: true, tokenCount, content: null }` — that charges its
own real, fixed `OVERSIZED_NOTE` token cost (computed once via the same
injected `countTokens`) against `returnedTokens` (code-review round 1: this
used to be silently ~0, which let an unbounded run of oversized entities
ride for free — fixed so the descriptor's real cost genuinely bounds how
many a single page can ever hold). `format=text` never inlines the note
into the reconstructed text (its per-item interpolated shape, including
`nodeId`/`tokenCount`, doesn't match the fixed-cost accounting exactly) —
oversized entities are instead listed once each, structurally, in a
separate `omitted_entities` metadata array; `format=nodes` carries the same
identity fields as a normal structured item, just with `content: null`.

## Token counting

`src/core/token-count.js` was inspected before choosing a runtime
strategy, per the task's explicit instruction. `qdrant_get_content` **always**
counts with the real BGE-M3 tokenizer via `getTokenCounter({ mode: 'bge-m3' })`
— the exact same tokenizer the indexer itself uses at chunk-boundary time,
cached at the module level after first load so repeated calls in one MCP
server process don't reload it.

The `chars/4` heuristic is **never** used by this tool — not on a load
failure, and not even when the operator set `TOKEN_COUNT=heuristic`
project-wide (code review, round 2). A hard `max_tokens` cap is a promise
this tool makes to protect an agent's context window, and `chars/4`
measurably *undercounts* real tokens for Cyrillic and code-shaped text
(empirically ~1.2–1.7× against the real tokenizer on representative
samples). `TOKEN_COUNT=heuristic` is a legitimate *indexer* speed choice;
letting it silently weaken this tool's cap — with a `token_count_mode`
label reported only *after* an already-overflowed page was built — would
not actually protect the model. So if the accurate tokenizer can't load
(network/cache unavailable), this tool returns a clear, hard error
(`tokenizerUnavailableMessage`), never a heuristic substitution.
`token_count_mode` is still reported (always `"bge-m3"` in production,
`"injected"` on the test DI path) for transparency, but it is informational
now, not a degradation signal.

The pure `buildAssemblyWindow()` function itself never chooses a strategy —
it only ever receives `countTokens` and the caller's literal `separatorText`
by injection; tests use a deterministic `chars/4`
stub so window-boundary assertions are exact and don't depend on tokenizer
availability. Two DI seams on `createGetContentHandler()`
(`countTokens`, `getTokenCounterFn`) make both the happy path and the
load-failure hard-error path unit-testable without touching the real model.

## Search-result anchors (`qdrant_search`)

Every `qdrant_search` hit that carries `node_id` (skeleton-aware
collections) now includes a `**Node:** node_id=... node_path=...
node_type=...` line in its formatted Markdown block (all three fields, per
the documented contract — `node_path` was missing in the first cut, fixed
in code-review round 1), and every window chunk (when `window > 0`) exposes
`node_id`/`node_path`/`node_type` in both `full` and `compact`
`window_format`. Fields are **omitted entirely** (never a fabricated
`null`) on legacy collections whose payloads never had node identity —
confirmed live: `bitwize-music` (a genuine legacy collection) returns
chunks with no `nodeId` field at all, so a request can't even be formed
against it. Ranking/retrieval itself is untouched — `hybridSearch`/
`rerankResults`/`ceRerank` call sites are unchanged; this phase only added
output formatting.

## Live verification (real cloud Qdrant, no live Qdrant in unit tests)

Ran the admin server against the project's real Qdrant Cloud instance and
called the production code paths directly (`createStorageAdapter()` +
`createGetContentHandler({})`, and `search.js`'s real `handle()`):

- `qdrant_get_content(collection: "demo", anchor_node_id: <a real table's
  node_id>, scope: "section")` resolved the anchor to its exact section
  (`docs/data-security.md#безпека-даних/типи-інцидентів`), returned the
  authoritative raw Ukrainian-language table content, `assembly_mode:
  "entity_refs"`, `returned_tokens: 116` (well under the 500-token budget
  used), zero pagination needed. `format=nodes` returned the same content
  as one structured item, with `is_anchor: true` on it.
- A missing anchor id produced the documented clear error string.
  A genuinely legacy collection (`bitwize-music`) returned chunks with no
  `nodeId` at all — anchored retrieval is correctly unreachable for it
  without first reindexing with `SKELETON_CHUNKING=1`.
- `qdrant_search(query: "типи інцидентів безпеки даних", collection:
  "demo")` returned the exact same `node_id` used as the anchor above on
  its top hit, confirming the full loop (search → anchor → bounded
  assembly) works end to end against real indexed data, not just fixtures.

## Test counts

All new/changed files pass `node --check`. Sequential, foreground,
`--max-old-space-size=768`, `--test-concurrency=1` throughout (no live
Qdrant in any unit test):

- Targeted Phase 3X + adapter suite:
  **195/195** (`cursor.test.js` 30, `window.test.js` 68, `anchored-content.
  test.js` 16, `assemble.test.js` +8 net for the identity additions,
  `projection-chain.test.js` unchanged/still green, `getContent.test.js`
  30, `searchAnchors.test.js` 10, `qdrant-adapter.test.js` +8 net for the
  rename/parentId coverage).
- Full suite `"tests/**/*.test.js"`: **1150/1150** (959 prior baseline +
  191 net new/changed across this phase, including the review
  fixes) — includes the full Phase 3W admin document-reader suite
  unchanged and green, confirming the `getStructuralNode`→`getContentNode`
  rename and the additive prose-identity field broke nothing on that
  surface.
- `npm run smoke`: **1293/1293**.
- `npm run admin:build`: clean Vite build, 223→same module count,
  bundle size unchanged (zero UI-side scope leak from this backend/MCP
  phase).
- `git diff --check`: clean (only benign LF→CRLF autocrlf warnings).

Coverage against the task's explicit test list: whole-scope-fits,
anchor-centered selection, deterministic ordering, exact budget boundary,
`cursor_before`/`cursor_after`, no-overlap/no-gap, invalid/tampered/
mismatched cursors (11 tamper-field cases + 4 mismatch-field cases),
missing anchor, navigation-node-anchor rejection, exact section-parent
scope, file scope, prose/table/code/checklist anchors, authoritative raw
content preserved, no duplicate entity through a resolved placeholder,
legacy collection without node identity, oversized structural anchor
(both as the anchor and as a neighbor), hostile text inertness,
`format=text`, `format=nodes`, search output node identity, window-chunk
node identity, `returned_tokens` never exceeding `max_tokens` (checked
across 7 budget values), no direct Qdrant import under the MCP tool layer
(source-level pin on `getContent.js` and `anchored-content.js`).

## Code review fixes (round 1)

**[P1] `max_tokens` could actually be exceeded.** Oversized descriptors were
added to `items` at ~0 token cost (unconditionally), but `getContent.js`'s
`format=text` inlined a bracketed note per oversized item into the
reconstructed `text` string — that note's own rendered text was never
counted, so `returned_tokens` could report far less than the caller's LLM
would actually spend reading it. Reproduced exactly as reported: 20
oversized tables at `max_tokens=200` produced `items.length=20`,
`returned_tokens=0`, real rendered text ≈747 heuristic tokens. There was
also no cap on how many oversized descriptors a single page could ever
admit. Fixed two ways: (1) `window.js` now charges each included oversized
descriptor its own real, fixed note-token cost (`OVERSIZED_NOTE`'s own
`countTokens` result, computed once, via the exact same injected counter)
against the budget — this alone bounds how many oversized entities a page
can ever hold; (2) `format=text` no longer inlines the note into `text` at
all — oversized entities are excluded from the reconstructed text entirely
and reported once each, structurally, in a new `omitted_entities` metadata
array (metadata is never bounded by `max_tokens`, by design — this is the
honest way to report "these were skipped" without inflating `text` past
budget). `format=nodes` already kept oversized items structurally distinct
(`oversized: true`, `content: null`) and needed no shape change. New tests:
the exact 20-oversized-tables repro (asserting `returnedTokens` stays
bounded and `items.length` is genuinely capped, never all 20), a budget too
small even for one descriptor (anchor correctly omitted, not force-included
over budget), and the `omitted_entities` shape in `format=text`.

**[P1] The automatic heuristic fallback silently broke the strict token
bound.** `getContent.js` caught any `getTokenCounter()` failure (e.g. the
BGE-M3 tokenizer failing to load — no network, empty cache) and silently
substituted `heuristicTokenCount` (chars/4). Measured empirically against
the real tokenizer on representative samples (Cyrillic, code, English):
chars/4 undercounts real tokens by roughly **1.04×–1.69×** — worst on
code-shaped text, still meaningfully off on Cyrillic. A silent substitution
under that error margin would let `max_tokens` quietly stop being a real
bound exactly when the tokenizer is unavailable, while the tool kept
promising "never over max_tokens." Fixed: a real tokenizer **load failure**
is now a **hard error** (`tokenizerUnavailableMessage`), never a silent
substitution. (Round 1 initially still allowed an explicit
`TOKEN_COUNT=heuristic` to select the heuristic counter for this tool;
round 2 removed even that — see below.) Every response carries
`token_count_mode` for transparency, and `createGetContentHandler()` gained
DI seams (`getTokenCounterFn`) so the load-failure path is unit-testable
without touching the real model.

**[P2] The cursor accepted a well-formed but out-of-range `edgeIndex`.**
`decodeCursor()` only checked that `edgeIndex` was an integer, never that
it was a real position for its own declared `totalSegments` — the exact
reported repro (`edgeIndex=999` against a 3-segment scope) decoded
successfully and would have produced a silently-empty "successful" page.
Fixed in `cursor.js`: `decodeCursor()` now rejects any cursor whose
`edgeIndex` is out of range for its own declared `totalSegments`, using
only information already present in the cursor's own payload — no new
dependency. (Round 1 used `0 <= edgeIndex <= totalSegments`; round 2
tightened the upper bound to `< totalSegments`, since `edgeIndex` is a real
segment array index whose last valid value is `totalSegments - 1` — see
below.) The related staleness gap the reviewer flagged (`sourceKey` +
segment count can't detect an in-place edit that preserves segment count)
was also closed, cheaply: `sourceKeyOf()` now folds in a first/last-segment
boundary fingerprint (`nodeId`, or `chunkIndex` for legacy `plain_chunks`
segments) — O(1), no full content re-hash (which the task's own
"lightweight cursor" instruction rules out). This is a boundary check, not
a full-content integrity guarantee, and the code/docs say so explicitly: an
edit strictly *inside* the scope, touching neither the first nor last
segment, is not detected by this cheap check — the same honest tradeoff the
segment-count check it augments already made.

**[P2] The primary search hit didn't return `node_path`.** `search.js`'s
per-hit `**Node:**` line included only `node_id`/`node_type`, while
`assembleWindowChunks()` (window chunks) already exposed all three fields —
inconsistent with the documented `node_id`/`node_path`/`node_type` contract
this phase's own docs claim. Fixed: the primary hit's Node line now
includes `node_path` whenever the payload carries one, in the same
"omitted, never fabricated" style as the other two fields. New tests cover
both the source-level presence and the line's exact rendered shape
(including the "field is just omitted, not `undefined`" case a naive fix
could get wrong).

**[P2] A literal NUL byte in `window.js`'s source.** `sourceKeyOf()`'s
template-literal separator between fields resolved to a real `\0` byte in
the written file (not the visible space it appeared to be), which made `rg`
classify the whole file as binary. Fixed by rewriting `sourceKeyOf()` to
encode its fields as a `JSON.stringify([...])` array instead of string
concatenation with any separator character — unambiguous by construction,
and there is no delimiter character left to get corrupted. (This fix and
the boundary-fingerprint fix above landed in the same rewrite of
`sourceKeyOf()`.)

All five findings verified fixed both in the unit suite and live against
real cloud Qdrant data (`demo` collection): `token_count_mode` now surfaces
on every response, the primary search hit's `**Node:**` line now includes
`node_path`, and a hand-crafted tampered cursor (`edgeIndex: 999` against a
real 3-segment scope) is correctly rejected end to end through the real
adapter.

## Code review fixes (round 2)

**[P1] `max_tokens` still wasn't strict — inter-item separators went
uncounted.** `window.js` counted each segment's tokens in isolation, but
`getContent.js`'s `format=text` joins them with `\n\n`, and those
separators were never charged against the budget. Reproduced with the same
chars/4 test counter: `max_tokens=200` reported `returned_tokens=200` while
`countTokens(response.text)` was 399. Fixed by making the bound reflect the
*real serialized text*: `buildAssemblyWindow()` receives the literal
`separatorText`, joins each candidate page exactly as `getContent.js` will,
and runs the tokenizer once over that complete string. A segment is included
only when the exact resulting candidate fits. This also avoids repeated
special-token overhead from separately tokenizing each segment and separator,
which was safe but substantially under-filled the available context. The
"whole scope fits" check uses the same exact serialization. New tests include
the reviewer's 20-small-segment fixture and a non-additive counter assertion:
`returned_tokens === countTokens(response.text) <= max_tokens` for ordinary
text pages.

**[P1] `TOKEN_COUNT=heuristic` contradicted the hard-cap contract.** Round 1
still let an operator's `TOKEN_COUNT=heuristic` select the chars/4 counter
for this tool, reporting `token_count_mode="heuristic"` in the response. But
that label is emitted *after* the (potentially already-overflowed) page is
built — it doesn't protect the model. Since chars/4 undercounts real tokens,
any heuristic count makes the cap unsound regardless of how it was chosen.
Fixed: `qdrant_get_content` now **always** requests `getTokenCounter({ mode:
'bge-m3' })`, hard-coded, ignoring the project-wide `TOKEN_COUNT` env
entirely (that setting remains a legitimate *indexer* speed choice — it just
has no say over this tool's cap). An unavailable accurate tokenizer is a
hard error, full stop; there is no heuristic path left for this tool. The
`resolveTokenCountModeFn` DI seam and the error message's
`TOKEN_COUNT=heuristic` opt-in suggestion were both removed. New test: the
handler always asks for `mode: 'bge-m3'` regardless of environment.

**[P2] The cursor accepted `edgeIndex === totalSegments`.** Round 1's bound
was `0 <= edgeIndex <= totalSegments`, but `edgeIndex` is a real segment
array index (the last valid value is `totalSegments - 1`); `totalSegments`
itself is one past the end and can never be legitimately minted. Round 1's
own test wrongly pinned `edgeIndex === totalSegments` as accepted. Fixed to
`edgeIndex < totalSegments` in `decodeCursor()`, and the test corrected to
assert `totalSegments - 1` is the last accepted value and `totalSegments` is
rejected. Verified no legitimate cursor is ever minted with
`edgeIndex >= totalSegments` (a page only emits a continuation cursor when
there's a real next/previous segment, so the recorded edge is always a real
in-range index).

**[P2] Report contradicted the implementation.** This report's "Token
counting" section still described the heuristic auto-engaging after a
tokenizer failure. Rewritten to match the round-2 behavior (always bge-m3,
hard error otherwise, no heuristic path), and the round-1 fix descriptions
above were corrected in place where they referenced the since-superseded
`TOKEN_COUNT=heuristic` opt-in and `<= totalSegments` bound.

## Code review fixes (round 3)

**[P2] The safe separator fix still under-filled the context window.** The
round-2 implementation added separately computed segment and separator token
counts. That prevented overflow, but BGE-M3 adds special-token overhead to
each tokenizer call and BPE tokenization is not additive. A real tokenizer
check showed `returned_tokens=189` for a response whose serialized text was
only 114 tokens at `max_tokens=200`; larger samples used only about 57-62% of
the available budget. Fixed by replacing `separatorTokens` with the literal
`separatorText`: every candidate page and the full-scope count are serialized
first, then passed through the tokenizer once. Real BGE-M3 verification now
gives exact equality (`200/200`, `246/246`, `331/331`, `499/499` for reported
vs actual tokens across representative budgets). A non-additive injected
counter test prevents a future return to summing separately-tokenized parts.

The report's test totals were also refreshed after the new regression test:
targeted **195/195**, full unit **1150/1150**, smoke **1293/1293**.

## Known limitations

- The Local API's own `/assembly` endpoint (Phase 3V/3W, admin UI) remains
  unbounded/unpaginated — only the new MCP path is bounded. Extending
  pagination to the admin reader is explicitly out of scope for this phase
  and noted as roadmap remaining work.
- `qdrant_get_content` cannot help a legacy (pre-skeleton) collection at
  all, by design — there is no node identity to anchor on. The tool's own
  error message and the docs are explicit about this; the fix is
  reindexing with `SKELETON_CHUNKING=1`, not a workaround in this tool.
- The bounded window's expansion is symmetric/alternating, not
  importance-weighted — it does not attempt to prefer, say, a nearby
  table over three paragraphs of plain prose when budget is tight. This
  was not requested and would add real complexity for a benefit that
  hasn't been demonstrated as needed yet.
- `.claude/skills/semidex/SKILL.md` was updated on disk but is gitignored
  (`.claude/` is a local-only directory per this repo's `.gitignore`) —
  the two tracked copies (`SKILL.md`, `plugin/skills/semidex/SKILL.md`)
  are the ones that ship.

## Verdict

MCP_BOUNDED_CONTENT_ACCEPT
