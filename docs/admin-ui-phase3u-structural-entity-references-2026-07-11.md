# Admin UI Phase 3U — Structural Entity References

Data foundation for document assembly (Phase 3E in the design doc): prose
chunks now carry an ordered `entity_refs` array pointing at the structural
entities (table/code_block/checklist) their placeholder lines name, by
`node_id`/`node_path` — no heuristic path parsing needed at assembly time.

## Payload contract

Given prose like:

```
Configuration options:

[table node: guide.md#setup/table-1 — Option | Default]
```

its Qdrant payload now includes:

```json
{
  "entity_refs": [
    {
      "node_id": "...",
      "node_path": "guide.md#setup/table-1",
      "node_type": "table",
      "placeholder": "[table node: guide.md#setup/table-1 — Option | Default]"
    }
  ]
}
```

- The array order matches placeholder order in the prose text, exactly.
- Only prose chunks (node_type outside table/code_block/checklist) ever
  carry `entity_refs` — an entity chunk never references itself, and a
  `skeleton_nav` point is excluded up front.
- The field is **additive and write-only-if-present**: a chunk with no
  recognized placeholder gets no `entity_refs` key at all (not an empty
  array) — `skeletonPayloadFields()` mirrors the existing convention already
  used for `lang`.
- No Qdrant payload index was created for `entity_refs` (see Schema
  Decision below — it is metadata for the assembly service to read by
  point, never a search/filter field).

### Domain mapping

`src/core/storage/qdrant-adapter.js`'s `toChunk()` now maps
`payload.entity_refs` (snake_case, an array of `{ node_id, node_path,
node_type, placeholder }`) to `chunk.entityRefs` (camelCase, `{ nodeId,
nodePath, nodeType, placeholder }`) via a small `toEntityRef()`/
`toEntityRefs()` helper pair. A chunk with no `entity_refs` field maps to
`entityRefs: []` — an empty array, not `null`/`undefined` — so callers can
always safely `.map()`/`.length` it without a null check, matching this
adapter's existing convention for `tags`. No raw `entity_refs`, `node_id`,
or other snake_case field can leak above the adapter — verified directly
(see Tests).

`toStructuralNodeChunk()` deliberately does NOT gain an `entityRefs` field
— structural content nodes (table/code_block/checklist) never carry
`entity_refs` by design, and `toStructuralNodeChunk()` is only ever called
for content nodes fetched by `node_id`/`node_path` (`getStructuralNode()`),
never for prose. Adding a permanently-empty field there would be noise, not
a real domain concept for that shape.

## Implementation

### `src/indexer/entity-reference.js` — the single source of truth

New module, extracted from `skeleton-chunk.js`'s previously-inline
`placeholderFor()`/`nodePathOf()` logic. **Final shape (post round-3
review), owning**:

- **`placeholderForReference(sourceFile, node, nodePath)`** — builds the
  placeholder line (`[<label> node: <path> — <hint>]`). `skeleton-chunk.js`
  now calls this through a thin `placeholderFor()` wrapper that only
  supplies the precomputed `node_path` — there is exactly one place that
  constructs the placeholder string.
- **`PLACEHOLDER_LINE_RE`** — the canonical whole-line "looks like a
  placeholder" pattern, used only to locate candidate spans and to render a
  readable orphan report — never to derive a `node_path` (see Round 3
  below for why that split is not attempted at all). `src/indexer/phases/
  node-policy.js`'s `isContentBearing()` gate (a *different* concern — "is
  this line non-content for token-counting purposes") imports this same
  constant instead of keeping its own copy, closing the "do not maintain
  two regex/format implementations" requirement.
- **`attachEntityRefs(chunks)`** — the matching engine, and the ONLY public
  entry point that resolves a placeholder to an entity (there is no
  longer a standalone "extract placeholders from arbitrary text" function
  — resolution always requires the entity context, see Round 3). Indexes
  every structural chunk's own real `node_path` by `(source_file,
  section)`, then for every prose chunk resolves each placeholder-shaped
  span against that scope's KNOWN, exact node_path set — never by parsing
  the span's interior. Returns `{ chunks, orphans }` — a placeholder-shaped
  span that resolves to no known node_path in scope is reported via
  `orphans`, never silently fabricated into a reference.

### Wired into `chunkFromSkeleton()` as a second pass, not interleaved

`attachEntityRefs()` runs once, **after** `chunkFromSkeleton()`'s forward
walk and `flushProse()` have fully assembled every chunk's final text —
right before the existing `chunkIndex`/`totalChunks` assignment. This is
deliberate, not incidental: `entity_refs` must describe the chunk's
**actual final text**, including placeholders `chunkFromSkeleton` appends
*post-hoc* to an already-emitted prose chunk (the "last emitted prose chunk
of this section" branch, used when an entity has no preceding-prose
accumulator of its own — e.g. two structural entities back to back with no
prose between them). A forward walk interleaved into the single pass cannot
know that append will happen at the moment it first emits that chunk; a
second pass over the finished array can, because by then every append has
already happened. Confirmed directly (see Tests) with a "consecutive
entities" fixture: a table immediately followed by a code block, no prose
between — both entities' placeholders end up appended to the *same*
preceding prose chunk, and `entity_refs` correctly captures both, in
textual order.

Orphans from this in-chunker call are silently dropped (not surfaced) —
`chunkFromSkeleton`'s own construction guarantees every placeholder it
emits has a matching entity in that same call's chunk array, so an orphan
here would indicate a bug in `skeleton-chunk.js` itself, not a legitimate
runtime case. The backfill script (which reconstructs chunks from
potentially-partial stored payloads, where a genuinely-missing entity is a
real possibility) is the caller that actually needs and reports the
`orphans` return value.

## Backfill

`src/backfill-entity-refs.js` — `COLLECTION=my-docs npm run
backfill:entity-refs`, `DRY_RUN=1` supported. Same conventions as the
existing `backfill-tags.js` (env-var driven, payload-only, `scrollAllPoints`
+ `updatePayload`).

Structured as a **pure planning core plus a thin I/O shell**, specifically
so the matching logic is unit-testable without a live Qdrant:

- **`computeBackfillPlan(points)`** — pure, no network. Given raw
  `{ id, payload }` points (as `scrollAllPoints` returns them), excludes nav
  points and non-skeleton/legacy points up front (mirroring
  `skeletonPayloadFields()`'s own `isSkeletonChunk` gate — only skeleton-v1
  points ever carry `entity_refs`), groups the remainder by `source_file`,
  and reconstructs the same snake_case chunk shape `chunkFromSkeleton()`
  itself produces so it can call the **exact same `attachEntityRefs()`
  function** fresh indexing uses — not a second, parallel matching
  implementation reading the same data differently. Returns `{ scanned,
  contentPoints, updates, unchanged, orphans }`.
- The CLI entry point (`isMainModule` guard, using the same
  `pathToFileURL(process.argv[1]).href === import.meta.url` pattern already
  used in `src/indexer/index.js`) does the actual `scrollAllPoints`/
  `updatePayload` I/O and prints the four required counts. Importing the
  module (as the tests do) never triggers this path.

Requirements met:
- **Payload-only, no vectors**: `scrollAllPoints(collection, PAYLOAD_FIELDS,
  250)` requests only `point_kind, node_type, node_id, node_path, section,
  source_file, text, raw_content, entity_refs, chunking_model` — no vector
  fetch, no re-embed anywhere in this file.
- **Excludes `skeleton_nav` points** via `isNavPoint()`.
- **Groups by `source_file`** before matching, so `attachEntityRefs()`'s own
  "never cross files" guarantee is enforced at the backfill layer too, not
  just trusted.
- **Updates only `entity_refs`**: `updatePayload()` → Qdrant `setPayload`,
  which merges rather than replaces — only the `entity_refs` key is ever
  touched on a point.
- **`DRY_RUN=1`**: `computeBackfillPlan()` is called identically either way
  (it never writes anything itself); the CLI shell simply skips the
  `updatePayload()` loop when `DRY_RUN=1` — confirmed by a dedicated test
  asserting the plan itself is identical regardless (see Tests).
- **Prints scanned/updated/unchanged/orphan counts** — all four, plus up to
  10 orphan samples (source file + placeholder text) when any exist.
- **Idempotent**: a chunk whose stored `entity_refs` already matches what
  `attachEntityRefs()` would compute (compared field-by-field via a small
  `sameRefs()` helper — order-sensitive, since order carries meaning) counts
  as `unchanged`, not `updates` — confirmed with a two-pass simulation
  (apply plan 1, re-scan, assert plan 2's `updates` is empty) and a
  multi-file variant of the same check.
- **Legacy collections finish cleanly with zero updates**: the
  `isSkeletonChunk` gate excludes every point with no (or a non-skeleton-v1)
  `chunking_model` before any matching happens — `scanned > 0`, `updates ===
  0`, no error.
- **Fresh-index and backfill produce byte-equivalent `entity_refs`**:
  confirmed directly — chunk a realistic document through the real
  `chunkFromSkeleton()` (fresh-index ground truth, `entity_refs` already
  attached by Phase 3U's in-chunker wiring), strip `entity_refs` back off to
  simulate a Phase-3T-era stored collection, run it through
  `computeBackfillPlan()`, and assert the backfilled `entity_refs` for every
  node matches the fresh-index reference via `assert.deepEqual` — passes,
  because both paths call the identical `attachEntityRefs()` function. This
  covers the "set" case; the "clear" case (a point whose stored
  `entity_refs` is now stale) is made byte-equivalent by round 3's fix —
  see Round 3 under Code review fixes below — which removes the key
  entirely via Qdrant's `deletePayload` rather than writing an empty array.

## Orphan handling

An orphan is a placeholder that matches the recognized `[<table|code
block|checklist> node: <path>...]` format but resolves to no structural
chunk within the scope being matched (same file, same section). Two
distinct situations produce one, both handled the same way — **reported,
never fabricated**:

1. **Cross-file/cross-section drift** — a placeholder whose path exists in
   the collection but in a different file or section than the prose chunk
   containing it. `attachEntityRefs()` scopes its entity index to
   `(sourceFile, section)` before matching, so this can never accidentally
   resolve to the wrong entity — it becomes an orphan instead.
2. **Genuinely missing entity** — the backfill's real-world case: a stored
   collection where a structural chunk referenced by a placeholder was
   deleted, filtered, or never made it into the scanned batch for some
   other reason.

`attachEntityRefs()` returns orphans as `{ chunkIndex, sourceFile,
placeholder }`; `computeBackfillPlan()` re-shapes them to `{ sourceFile,
placeholder }` per the backfill CLI's reporting format. Neither path ever
turns an orphan into a partial or guessed reference — the chunk simply gets
no `entity_refs` entry for that placeholder (or no `entity_refs` key at all,
if it was the chunk's only placeholder).

## Schema-version decision

`INDEXING_SCHEMA_VERSION` stays at **4** — not bumped for this phase.
Documented directly in `src/indexer/skeleton-payload.js`'s own comment
block, reasoning:

The version exists to flag changes that affect **embedding input** or
**point/chunk boundaries** — the reasons a collection would need a full
reindex, not just a payload patch. `entity_refs` is purely additive metadata
derived from content already in the payload (each chunk's own `raw_content`/
`node_path`, and its neighbors' `node_id`/`node_path`/`node_type`) — it
changes neither the text handed to the embedder nor how many points/chunks
a file produces. Any existing skeleton-v1 collection can receive
`entity_refs` via `npm run backfill:entity-refs` (payload-only, confirmed no
vector touch) instead of a full reindex — bumping the schema version would
have forced exactly the reindex this backfill path exists to avoid, for a
field that doesn't need one.

## Tests

**`tests/unit/indexer/entity-reference.test.js`** (28 tests) — two layers:

- Pure-module tests against `placeholderForReference`/`extractPlaceholders`/
  `PLACEHOLDER_LINE_RE`/`attachEntityRefs` directly with hand-built chunk
  fixtures: one table after prose; multiple entities in textual order;
  unrelated bracketed prose (`[the appendix]`, `[Issue #42]`) never
  mistaken for a reference; duplicate-looking placeholders (the same entity
  referenced twice in one chunk) both resolve, in order; an orphan
  placeholder is reported, not fabricated; no cross-section attachment
  (same `node_path` text, different `section` — never resolves); no
  cross-file attachment (same `node_path` text, different `source_file` —
  never resolves); structural chunks never receive `entity_refs` even if
  their own raw text happens to contain a placeholder-shaped string; nav
  chunks never receive `entity_refs`; an unchanged chunk is returned by
  reference (not cloned), for cheap equality checks by callers.
- End-to-end tests through the real `parseSkeleton()` → `chunkFromSkeleton()`
  pipeline (matching this codebase's existing smoke-test fixture style):
  one table after prose gets a real `entity_refs` entry whose `node_id`
  matches the table chunk's own `node_id`; consecutive entities (table
  immediately followed by code, no prose between) both attach to the same
  preceding prose chunk, in order; an entity at the very start of a section
  (no preceding prose) attaches to the *following* prose chunk instead; no
  cross-section attachment holds through the real chunker too, not just the
  hand-built fixture; structural and nav chunks carry no `entity_refs` in
  real chunker output.

**`tests/unit/indexer/skeleton-payload-entity-refs.test.js`** (6 tests) —
the payload write side: writes `entity_refs` when present; omits the key
entirely (not an empty array) when absent or explicitly empty; a structural
chunk never carries the field; a legacy (non-skeleton) chunk gets no fields
at all; `INDEXING_SCHEMA_VERSION` is confirmed still 4.

**`tests/unit/core/storage/qdrant-adapter.test.js`** (+3 new, 2 existing
`deepEqual` assertions updated for the new `entityRefs: []` field) — the
payload read side: `entity_refs` maps to `entityRefs` with camelCase keys
throughout, preserving order; a chunk with no `entity_refs` field maps to
`[]`; a malformed (non-array) `entity_refs` value is ignored rather than
thrown on.

**`tests/unit/core/backfill-entity-refs.test.js`** (8 tests) — the backfill
planning core: a legacy collection produces zero updates and finishes
cleanly; `skeleton_nav` points are excluded even with a skeleton-shaped
`chunking_model`; `computeBackfillPlan()` is pure (dry-run and real-run
compute an identical plan); idempotency (single-file and multi-file,
two-pass apply-then-rescan simulations both produce zero updates on the
second pass); fresh-index vs. backfill byte-equivalence (see Backfill
section above); orphan reporting; `PAYLOAD_FIELDS` includes every field the
matching logic actually needs.

No UI test uses `assert.equal(DOMNode, null)` — this phase touched no UI
code at all (backend/data-layer only, per the explicit out-of-scope list),
so there was nothing to check there; the constraint is noted as satisfied
by scope, not by a specific fix.

All new test files were run individually first (`node --test
tests/unit/indexer/entity-reference.test.js`, etc.), then together, then as
part of the full suite — no background test launches were used anywhere in
this phase.

## Out of scope (confirmed untouched)

Assembly API, stitched file/section UI, placeholder replacement in the
browser, MCP assembly tools, Ask/chat, vector/embedding changes — none of
these were touched. Confirmed directly: the admin UI's built JS bundle
contains zero occurrences of `entity_refs`/`entityRefs` (`grep -c
"entity_refs\|entityRefs" dist/admin-ui/assets/index-*.js` → `0`); every
file this phase changed lives under `src/indexer/`, `src/core/storage/`, or
is the new `src/backfill-entity-refs.js` — no `src/admin/ui-src/` file was
touched.

## Code review fixes (post-initial-implementation)

Two review passes found issues before this phase was accepted, all fixed
and covered by new regression tests.

### Round 1

### P1 — backfill did not clear stale entity_refs

`computeBackfillPlan()`'s original write gate (`if (after.length) push
update; else unchanged++`) treated a transition from a stale, non-empty
stored `entity_refs` down to zero resolvable references as "nothing to
write" — indistinguishable from a chunk that never had any. Root cause was
one level deeper than the gate itself: `attachEntityRefs()`'s early-return
branch (`if (!found.length) return c;`) passed a chunk straight through,
stale `entity_refs` and all, whenever its current text had zero
placeholders — the function was never actually recomputing `entity_refs`
for that case, just echoing back whatever the caller passed in.

Fixed at the source: `attachEntityRefs()` now **always fully recomputes**
`entity_refs` from the chunk's current text on every call — a chunk with no
resolvable placeholder always ends the function with `entity_refs`
*removed* (not left stale), and only returns the original object by
reference when there was truly nothing to change (no placeholders found
*and* no stale value to clear). `computeBackfillPlan()`'s existing
before/after diff now sees a real `[stale] → undefined` transition and
plans a clearing update instead of silently skipping it. Two failure modes
covered: a placeholder removed from the prose text entirely, and a
placeholder still present but its entity now orphaned (missing from the
scan). *(Round 1's fix wrote this clearing update as `{ id, entityRefs:
[] }`, applied via `setPayload`. Round 3 replaced that with a proper
`{ id, op: 'clear' }` applied via Qdrant's `deletePayload` — see Round 3
below — because `setPayload({ entity_refs: [] })` cannot reproduce the
byte-exact "key absent" shape a fresh index of the same content actually
produces.)* Idempotency re-verified: a second run against an
already-cleared point stays `unchanged`.

### P2 — fresh indexing silently dropped an internal invariant failure

`chunkFromSkeleton()`'s call to `attachEntityRefs()` discarded the
`orphans` return value entirely. An orphan during fresh indexing is not a
legitimate runtime case the way it is during backfill (which reconstructs
chunks from potentially-partial stored payloads) — `chunkFromSkeleton`
builds every placeholder and every entity chunk from the same single walk
over the same node list, so a placeholder with no matching entity in that
same call's output can only mean a bug in `skeleton-chunk.js` itself (e.g.
a placeholder built against the wrong `node_path`). Silently shipping an
incomplete payload in that case would look fine at index time and only
misbehave later, at assembly time, with no diagnostic trail back to the
cause.

Fixed: `chunkFromSkeleton()` now throws a clear, actionable `Error`
(naming the source file and the first orphan's placeholder text) if
`attachEntityRefs()` reports any orphans during fresh indexing. Confirmed
this does not fire on any real content — the full smoke suite (1293 tests,
including the skeleton-chunk and structural-carryover sections that
exercise `chunkFromSkeleton` directly against realistic fixtures) still
passes 100% after the change.

### P3 — DRY_RUN was never actually tested

The original test suite only ever called `computeBackfillPlan()` twice and
diffed the results — it asserted the *planner* is pure, but never touched
the CLI shell that decides whether to call `updatePayload()`, so nothing
verified that `DRY_RUN=1` genuinely skips writes end to end.

Fixed: extracted the CLI shell's fetch → plan → (maybe) write → report
sequence into a new exported, DI-able `runBackfill({ collection, dryRun,
scrollAllPointsFn, updatePayloadFn, logFn })`. The real CLI entry point
now just wires the real `scrollAllPoints`/`updatePayload`/`console.log`
into it; tests inject spy functions instead. Four new tests in
`backfill-entity-refs.test.js` assert against the spies directly: `dryRun:
true` computes the same plan but the `updatePayloadFn` spy is asserted to
have been called zero times; a real (non-dry) run calls it exactly once per
planned update with the correct collection/id/payload; a real run against a
stale-ref point specifically asserts the write payload is `{ entity_refs:
[] }`; a legacy-collection dry run confirms zero plan updates AND zero spy
calls together, not just one or the other.

### Round 2

A second review pass, run against round 1's fixes, found two more P1
blockers in `entity-reference.js`'s placeholder-matching regexes — both
real data-corruption bugs, not edge cases:

### P1 (round 2) — a node_path containing a space silently failed to resolve

`PLACEHOLDER_SCAN_RE`'s path capture group was `([^\s\]]+)` — a path
built from a real `source_file` name that itself contains a space (a
legitimate, common real-world filename — `docs/My Guide.md#setup/table-1`,
not a hypothetical) stopped matching at the first space, so
`extractPlaceholders()` returned zero matches for that placeholder
entirely. Reproduced directly: `refs` came back `undefined`/empty for
exactly this input, confirmed before any fix.

### P1 (round 2) — a checklist hint containing "]" truncated the match

A checklist/table/code hint is the entity node's own first line of content
— for a checklist, that is literally its first item, e.g. `"- [x] done"`,
which contains a literal `]`. Both the interior-matching regex
(`PLACEHOLDER_SCAN_RE`'s `(?: — [^\]]*)?\]`) and, it turned out on closer
inspection, `PLACEHOLDER_LINE_RE` itself (`[^\]]*\]$`) stopped at that
FIRST `]` — the one inside the hint — instead of the placeholder's real
closing bracket. Reproduced directly:
`[checklist node: tasks.md#todo/checklist-1 — - [x] done]` re-extracted as
`[checklist node: tasks.md#todo/checklist-1 — - [x]`, truncated exactly
where the reviewer's repro showed, corrupting the stored `raw`/
`placeholder` text (which would then never match its own source text again
on any future re-scan, e.g. during a backfill).

**Root cause, both bugs**: trying to parse a placeholder's *interior*
(path, hint) with one bounded regex, when neither a path nor a hint has a
character set that's actually safe to bound with a simple negated class —
paths can contain spaces (real filenames), hints can contain almost
anything (they're the entity's own first line of raw content, sliced to 60
chars with no sanitization, by design — hints are for a human to skim, not
for placeholder self-description).

**Fix**: replaced interior-parsing with prefix-anchored, boundary-relative
scanning. `PLACEHOLDER_PREFIX_RE` (`/\[(?:table|code block|checklist) node:
/g`) finds every occurrence of the FIXED prefix in one pass. For each
occurrence, the placeholder's real closing bracket is the *last* `]` within
the window bounded by that occurrence and the START of the *next* prefix
occurrence (or end of string, for the last one) — this correctly handles a
hint containing its own `]` (nothing after it in the window until the next
placeholder or end-of-string can be a "later" closing bracket that isn't
this one) while also correctly separating two placeholders on the same
line or text block. The path/hint split still uses `lastIndexOf(' — ')`
within that bounded content (em dash cannot occur inside a node_path by
construction, so its last occurrence unambiguously marks the real
separator). `PLACEHOLDER_LINE_RE`'s own interior was changed from
`[^\]]*` to a greedy `.*`, which — via normal regex backtracking — extends
to the line's *final* `]` rather than its first, fixing the exact same
class of bug in that separate, narrower whole-line matcher (used only by
`node-policy.js`'s content-bearing gate, not by `extractPlaceholders()`
itself anymore).

Confirmed via direct repro before and after both fixes, then covered with
9 new tests in `entity-reference.test.js`: a placeholder with leading prose
text on the same line (not whole-line-anchored — this is
`extractPlaceholders()`'s real contract, distinct from
`PLACEHOLDER_LINE_RE`'s own whole-line one); two placeholders on the same
line; a dedicated `describe` block for the space-in-path case (unit-level
`extractPlaceholders()` check, a `placeholderForReference()` →
`extractPlaceholders()` round-trip check, and a full `attachEntityRefs()`
end-to-end resolution check); a matching dedicated `describe` block for the
checklist-hint-with-`]` case (placeholder construction, re-extraction
byte-for-byte, `PLACEHOLDER_LINE_RE` itself, and full `attachEntityRefs()`
resolution); and two new end-to-end tests through the REAL
`chunkFromSkeleton()` pipeline — a real checklist fixture (`- [x] pull
model`) and a real `docs/My Guide.md`-named source file — confirming both
fixes hold through the actual production chunking path, not only a
hand-built `attachEntityRefs()` fixture.

### Round 3

A third review pass found round 2's fix still incomplete — the interior
was still being PARSED via `lastIndexOf(' — ')`, and two more real,
reproducible cases broke it: a source_file containing " — " itself (e.g.
`docs/Guide — Draft.md`), where the split landed on the WRONG em dash and
produced `nodePath = "docs/Guide"` (truncated, silently wrong — not even an
orphan); and a hint containing its own " — " (e.g. table cell text `"Option
— Default"`), where the split produced `nodePath = "a.md#setup/table-1 —
Option"` (the hint's separator matched instead of the placeholder's real
one). Both reproduced exactly as reported before any fix, confirmed via
direct repro scripts.

**Root cause — architectural, not a regex edge case**: `lastIndexOf(' —
')` (round 2) and every earlier interior-parsing attempt share the same
flaw — there is no way to identify "the" path/hint separator by looking at
a placeholder string in isolation, because BOTH the path (via its
source_file component) and the hint can independently contain " — ". No
regex or string-scanning refinement fixes this; the ambiguity is inherent
to the format once a real source_file name is allowed to contain an em
dash.

**The actual fix — exact matching, per the review's explicit prescription**:
`attachEntityRefs()` no longer parses a placeholder's interior AT ALL. For
every prose chunk, it finds placeholder-SHAPED spans (the same
prefix-anchored, bounded-window scan from round 2, kept only to locate
candidate spans and to produce a readable orphan report — never to derive a
node_path from them), then resolves each span's content against the SET of
KNOWN, exact `node_path` values already sitting on every real structural
chunk in that prose chunk's own `(source_file, section)` scope — checked
longest-path-first, matching either the whole span content (no hint) or a
known path immediately followed by `" — "` (hint follows, its exact text
irrelevant to resolution). A node_path is the one piece of identity that
survives on every chunk regardless of hint-source data loss (see below), so
this is the only approach that can be exact without needing a second,
richer field on the payload.

This fix also surfaced and closed a real bug in the round-2 implementation
that had gone unnoticed because it happened to work on every prior test
fixture: `chunkFromSkeleton()` builds each entity's placeholder HINT from
the raw mdast node's own `.text` field (`mdastToText()` — a flattened
plain-text rendering, e.g. a table's cells concatenated with no
separators), but the final CHUNK object never stores that field — the
chunk's own `text`/`raw_content` holds the RAW MARKDOWN instead
(`sliceRaw()`). Round 2's `attachEntityRefs()` tried to recompute each
candidate's placeholder from the chunk's `raw_content ?? text`, which is
the WRONG field for the hint — this silently produced a candidate
placeholder that never matched what was actually embedded in the prose,
which is exactly why fresh indexing started throwing the round-1 P2
internal-invariant error on ordinary content (caught immediately by the
existing smoke suite once this round's fix was applied and re-run). Exact
node_path matching sidesteps this entirely, since resolution never depends
on reconstructing a hint at all — this is also why it is the only
approach that works identically for fresh indexing (real chunk objects, no
hint field) and for backfill (payloads reconstructed from storage, also no
hint field).

**Round 3 — P2 (native payload-key deletion)**: confirmed via the Qdrant
JS SDK's own type definitions
(`node_modules/@qdrant/js-client-rest/dist/types/qdrant-client.d.ts`) that
`client.deletePayload(collection, { keys: [...], points: [...] })` is a
real, existing method distinct from `setPayload` — it removes specified
payload KEYS entirely, rather than merging/overwriting them. Added
`deletePayloadKeys(collection, id, keys)` to `src/core/qdrant/store.js`
(re-exported through the stable `core/qdrant.js` facade, same as every
other store primitive) and split `computeBackfillPlan()`'s update shape
into two explicit ops: `{ id, op: 'set', entityRefs }` (a real, non-empty
reference set — written via `setPayload`, same as before) and `{ id, op:
'clear' }` (the point's stored `entity_refs` is now stale — written via
`deletePayload(['entity_refs'])`, which leaves the point genuinely
byte-equivalent to one freshly indexed with no references at all, not one
carrying an explicit empty array). `runBackfill()` now takes both
`updatePayloadFn` and `deletePayloadKeysFn` as separate DI'd functions and
calls the correct one per op.

New/updated tests (`entity-reference.test.js`, `backfill-entity-refs.test.js`):
a dedicated `describe` block with the exact review repros — `docs/Guide —
Draft.md` (em dash in source_file), hint `"Option — Default"` (em dash in
hint), a Cyrillic source_file path containing both a space and a dash, the
checklist `- [x]` case (re-verified under the new resolution strategy), and
an explicit ordinal-suffix collision case (`table-1` vs `table-10`,
confirming longest-path-first matching never falsely resolves to a shorter
prefix); a new test confirming two placeholders in one chunk preserve
TEXTUAL order even when their entity chunks are listed out of that order in
the input array (order is a property of the text, never of chunk-array
position); two new end-to-end tests through the real `chunkFromSkeleton()`
pipeline for the em-dash-in-source_file and space-in-source_file cases
specifically (not just hand-built fixtures); all backfill idempotency/
stale-clearing tests updated to assert `{ id, op: 'clear' }` and to
simulate a REAL key deletion (destructuring the key out of the fixture
payload) rather than setting `entity_refs: []`; two `runBackfill()` DI
tests updated/added to assert the CORRECT primitive is called per op — a
`'set'` update calls `updatePayloadFn` and never `deletePayloadKeysFn`, a
`'clear'` update calls `deletePayloadKeysFn` with exactly `['entity_refs']`
and never `updatePayloadFn` with an empty array.

### Round 4 — small fix: `runBackfill()`'s JSDoc claimed defaults that didn't exist

`runBackfill()`'s JSDoc marked `scrollAllPointsFn`/`updatePayloadFn`/
`deletePayloadKeysFn` as optional (`?`) and said they "default to the real
network calls" — but the destructuring never actually supplied any such
default (only `dryRun` and `logFn` had real defaults). Omitting one of the
three didn't fall back to anything; it just crashed later with a
confusing `undefined is not a function` — and for `updatePayloadFn`/
`deletePayloadKeysFn` specifically, only on a REAL run, since they're only
called conditionally inside `if (!dryRun)`, so a caller could pass a dry
run successfully with a typo'd/missing function name and only discover the
mistake on the first real run.

Fixed by making the contract match reality rather than inventing network
defaults inside the DI-able core (which would have reintroduced a network
dependency into the one function this file deliberately keeps import-free
of `core/qdrant.js`): the three are now documented as required, and
`runBackfill()` checks all three up front — before the first `await`, so
nothing (not even the scroll fetch) runs first — throwing a clear
`TypeError` naming the missing parameter if any is not a function. Four new
tests confirm each of the three throws the expected message (including
under `dryRun: true`, closing the "only fails on a real run" gap) and that
the check runs before any network call.

### Round 5 — `scanPlaceholderShapedSpans()` still spanned across lines, swallowing later Markdown brackets

Round 3's span scanner bounded a placeholder's closing `]` search by "the
next placeholder-prefix occurrence, or the end of the WHOLE TEXT" — that
window could span multiple lines. When a real placeholder was followed,
several lines later (a genuinely common shape — prose continues after a
table/code/checklist reference), by ordinary Markdown bracketed text with
no placeholder prefix of its own (e.g. `[appendix]`), that later bracket's
`]` became "the last `]` in the (multi-line) window" and got absorbed into
the FIRST placeholder's `raw`/`placeholder` value. Reproduced exactly as
reported: `entity_refs[0].placeholder` came back as `'[table node:
a.md#s/table-1 — A | B]\n\nSee [appendix]'` instead of stopping at the real
closing bracket. The reference itself still resolved correctly (the
`node_path` match was unaffected), but the stored `placeholder` field — the
one field a future assembly service would use to find-and-replace this
exact span in the prose — was corrupted with content that doesn't belong
to it.

**Fix**: `scanPlaceholderShapedSpans()` now scans strictly **per line**,
never across a `\n` boundary. This is safe (not just a narrower band-aid)
because skeleton-chunk.js always emits a placeholder as its own whole
paragraph (`\n\n`-joined) — `PLACEHOLDER_LINE_RE` already encodes "a
placeholder is a whole line" as this module's own contract — so a real
placeholder's hint (which CAN contain its own literal `]`, e.g. a
checklist item `- [x] done`) is still found correctly, since that entire
placeholder sits on one line and the closing-bracket search is bounded to
that same line, never spilling into a *different* line's unrelated
content. Multiple placeholders are represented as separate standalone
lines, matching the format emitted by `skeleton-chunk.js`.

New test added with the exact review repro: a placeholder followed by
`\n\nSee [appendix] for details.`, asserting `entity_refs[0].placeholder
=== '[table node: a.md#s/table-1 — A | B]'` (exact string equality, not
just a length/count check — the existing "unrelated bracketed prose"
test was strengthened with the same exact-equality assertion, since a
length-only check is exactly what let this bug through undetected in round
3). All round 3/4 regression cases (em dash in path, em dash in hint,
Cyrillic path, checklist `]`, ordinal-suffix collision, two-on-one-line)
re-verified passing after this fix — none of them relied on the removed
cross-line window.

### Round 6 — an inline (non-standalone-line) placeholder-shaped substring could still resolve

Round 5's per-line scanner still located the `[<label> node: ` prefix
*anywhere inside a line* via `matchAll`, not by first requiring the whole
(trimmed) line to match `PLACEHOLDER_LINE_RE`. So a line of ordinary prose
that merely *contained* placeholder-shaped text as a substring — e.g. `See
[table node: a.md#s/table-1 — A | B] below.` — was still scanned and could
still resolve to a real reference. This contradicts the module's own stated
contract (`PLACEHOLDER_LINE_RE` "encodes a placeholder is a whole line") and
the actual chunker's behavior: `skeleton-chunk.js` only ever emits a
placeholder as its **own, standalone** paragraph/line — an inline mention is
never something the real pipeline produces, so it should never be
recognized as a live reference either.

**Fix**: `scanPlaceholderShapedSpans()` now requires the trimmed line, in
full, to match `PLACEHOLDER_LINE_RE` before extracting anything from it —
`PLACEHOLDER_PREFIX_RE` was changed from a global, unanchored pattern to a
`^`-anchored one, matched only against a line already confirmed
placeholder-shaped in its entirety. A line like `prefix [table node: ...]
suffix` now fails the whole-line check and is skipped: no ref, and
(deliberately) no orphan report either, since it was never a real
placeholder reference to begin with — only a coincidental substring.
`PLACEHOLDER_LINE_RE` also accepts `list`/`image` labels (a broader
allowance shared with `node-policy.js`'s separate `isContentBearing()`
gate), which are not structural entity types this module resolves
(`STRUCTURAL_TYPES` is only `table`/`code_block`/`checklist`); the narrower
`PLACEHOLDER_PREFIX_RE` correctly excludes those labels, so a
`[list node: ...]`/`[image node: ...]` line — whole-line placeholder-shaped
but not a type this module handles — is also skipped, not orphan-reported.
The prefix regex is deliberately non-global: each line is scanned
independently, so RegExp `lastIndex` state cannot cause the second of two
adjacent placeholder lines to be skipped. A dedicated regression test
checks that both adjacent lines resolve in textual order.

Two existing hand-built fixtures had the placeholder embedded inline
(`Missing: [table node: ...]`, `... as shown again: [table node: ...]`) —
a shape the real chunker never produces. These were rewritten to place the
placeholder on its own line (matching real chunker output), and a new test
was added asserting the inline case is explicitly *ignored* (`entity_refs`
undefined, `orphans` empty) rather than resolved or reported. All prior
rounds' end-to-end tests through the real `chunkFromSkeleton()` pipeline
(section "attachEntityRefs — end to end through chunkFromSkeleton") passed
unchanged before and after this fix, confirming the real chunker never
relied on the inline-matching behavior that was removed.

## Verification run

- `npm test` — 959/959 passing (including the adjacent-placeholder-line
  regression test added during final review).
  `entity-reference.test.js` was
  substantially rewritten in round 3 (the old `extractPlaceholders()`-based
  tests no longer apply — that function was removed entirely, since
  resolution now always requires entity context) rather than purely added
  to; net test count across the whole suite reflects that rewrite plus the
  new round-3-specific cases (em dash in source_file, em dash in hint,
  Cyrillic path with a space and a dash, checklist `[x]` re-verified,
  ordinal-suffix collision, cross-order-array textual-order preservation),
  the `store.js` `deletePayloadKeys` DI wiring in `backfill-entity-refs.test.js`,
  and the `skeletonPayloadFields`/adapter tests carried over unchanged from
  earlier rounds.
- `npm run smoke` — 1293/1293 passing, including the pre-existing skeleton
  structural-carryover suite (section 57) and skeleton-chunk suite (section
  45) — this is the test that actually caught round 2's hidden bug
  (`attachEntityRefs()` recomputing a candidate placeholder from the wrong
  chunk field): once round 3's exact-node_path-matching fix was applied,
  the full smoke suite was re-run and confirmed 0 failures, meaning the
  round-1 P2 fresh-indexing invariant check never fires on any real smoke
  fixture.
- `npm run admin:build` — clean Vite build (223 modules, unchanged from
  Phase 3T — confirms zero UI-side scope leak).
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings on
  files this phase touched).

## Verdict

STRUCTURAL_ENTITY_REFERENCES_ACCEPT
