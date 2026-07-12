# Admin UI Phase 3V — Structural Document Assembly Service + Local API

Backend assembly layer that turns ordered skeleton chunks into a continuous
document representation, consuming Phase 3U's `entity_refs` through the real
storage path. One reusable service (`src/core/assembly/`) for the file view,
section view, future MCP content assembly, and future Ask/chat source
rendering. Backend only — no stitched UI in this phase.

## Critical prerequisite fix — `CONTENT_NODE_FIELDS` omitted `entity_refs`

`src/core/qdrant/payload.js`'s `CONTENT_NODE_FIELDS` — the payload projection
`getFileChunks()` (and now `getSectionChunks()`) requests from Qdrant — did
not include `entity_refs`. Qdrant's `with_payload: [fields]` returns exactly
the requested keys and drops everything else, so every stored reference was
silently stripped **before** the adapter's `toChunk()` ever saw the payload —
even though `toChunk()` itself mapped the field correctly, and every direct
`toChunk()` unit test passed. Classic projection-gap bug: the unit under test
was fine, the pipe feeding it was not.

Fixed by adding `entity_refs` to `CONTENT_NODE_FIELDS`, and pinned by a
**projection-chain regression test**
(`tests/unit/core/assembly/projection-chain.test.js`) that proves the
complete path — never just a hand-built `toChunk()` fixture:

```text
chunkFromSkeleton (real chunker, real ref attachment)
  -> skeletonPayloadFields (the real stored-payload composition)
  -> CONTENT_NODE_FIELDS projection (simulated exactly as Qdrant applies it:
     requested keys kept, everything else dropped — so a field missing from
     the constant is dropped in the test exactly like production would)
  -> store post-processing (nav filter + chunk_index sort; the server-side
     wiring of getFileChunks/getSectionChunks is pinned by source-level
     assertions in the same file)
  -> toChunk() -> domain Chunk.entityRefs
  -> assembleDocument() -> assemblyMode: 'entity_refs'
```

The suite also includes the inverse: with `entity_refs` filtered OUT of the
projection, the same path silently degrades to `placeholder_fallback` —
demonstrating the field is load-bearing and the class of bug this test
guards against.

## Architecture

```text
src/core/assembly/
  contract.js   — ASSEMBLY_MODES / SEGMENT_KINDS / ASSEMBLY_WARNINGS constants
                  + JSDoc typedefs; zero imports
  assemble.js   — assembleDocument(); imports ONLY core/entity-reference.js
                  and ./contract.js
```

- The service accepts **domain Chunk objects** (camelCase, StorageAdapter
  output). It imports no Qdrant SDK, no filter DSL, no admin UI, no MCP —
  verified by inspection of its import list (two pure core modules).
- The admin API route (`src/admin/api/assembly.js`) is a thin shell:
  validate parameters → adapter → `assembleDocument()` → serialize. No
  assembly logic in the route, no Qdrant imports under `src/admin/`.
- **`src/indexer/entity-reference.js` moved to `src/core/entity-reference.js`**
  (the task's "reuse or move the canonical pure placeholder/reference logic
  into a core-safe module"). It was already pure (zero imports); the move
  fixes the dependency direction — core must not import indexer, while
  indexer→core is the established direction (`skeleton-chunk.js`,
  `node-policy.js` already import several core modules). All four importers
  updated; no re-export shim left behind. There remains exactly one
  placeholder format and one matching implementation, now shared by fresh
  indexing, the backfill, and assembly's fallback.

## API contract

```text
GET /api/collections/:name/assembly?scope=file&sourceFile=docs/guide.md
GET /api/collections/:name/assembly?scope=section&nodePath=docs/guide.md%23setup
```

Validation (400 `bad_request` envelope):
- `scope` required, must be `file` or `section`;
- `scope=file` requires `sourceFile` and rejects a conflicting `nodePath`;
- `scope=section` requires `nodePath` and rejects a conflicting `sourceFile`;
- a `nodePath` that resolves to a non-section skeleton node (file/collection)
  is a 400 — `scope=section` means a section node, not "anything with a path".

404 (normal `not_found` envelope):
- unknown collection;
- unknown file (`getFileChunks` returns zero chunks);
- unknown section OR a legacy collection with no skeleton at all (no section
  identity exists — the endpoint refuses to invent one from heading labels).

A real section with zero content chunks is a 200 with empty `segments`, not
a 404 — the section exists; it is just empty.

### Section identity

Sections are resolved **through the skeleton node**: the route calls
`getSkeletonNode(name, { nodePath })`, verifies `nodeType === 'section'`,
then fetches content chunks by the node's `nodeId`. In the store this is an
exact `parent_id === section node_id` match (the same link
`getFirstContentChunkByParent` follows) — never a heading-text match
(headings can repeat) and never a chunk-index-range guess. Only chunks
belonging to that exact section node are included (direct children;
subsections have their own node identity).

## Response / segment contract

```json
{
  "collection": "my-docs",
  "scope": "file",
  "sourceFile": "docs/guide.md",
  "nodePath": null,
  "assemblyMode": "entity_refs",
  "segments": [
    { "kind": "prose",  "chunkIndex": 0, "nodeType": "paragraph",
      "text": "...", "context": "...", "section": "Setup", "headingPath": ["Setup"] },
    { "kind": "entity", "chunkIndex": 1, "nodeId": "...", "nodePath": "docs/guide.md#setup/table-1",
      "nodeType": "table", "rawContent": "| ... |", "lang": null,
      "context": "...", "section": "Setup", "headingPath": ["Setup"] }
  ],
  "warnings": []
}
```

Backend-neutral and camelCase throughout — an HTTP test recursively collects
every JSON key in the response and asserts none is a raw Qdrant field
(`entity_refs`, `node_id`, `source_file`, `vector`, `payload`, …). Note
`assemblyMode`'s *value* is legitimately the string `entity_refs` (the
task's own mode vocabulary); the neutrality contract is about field keys.

To carry `headingPath` (segments) and `parentId` (section identity,
diagnostics), the domain Chunk mapping in `toChunk()` gained both fields —
snake_case (`heading_path`, `parent_id`) stays confined to the Qdrant
adapter, as before.

## Ordering and deduplication rules

- Segments are emitted by walking the input chunk array in its given order
  (both adapter primitives return chunks sorted by `chunk_index`), **one
  segment per chunk**. Structural chunks already occupy their correct source
  positions, so an entity is never inserted a second time because a prose
  chunk references it — refs drive placeholder *removal*, never entity
  *insertion*. Both real shapes stay correct without reordering:
  `prose(placeholder) → table chunk` and `table chunk → prose(placeholder)`
  (entity at section start).
- **Prose chunks**: only the exact standalone placeholder lines listed in
  `entityRefs` are removed — a line whose trimmed content byte-equals the
  ref's `placeholder`, one line consumed per ref, in ref order. Inline
  placeholder-looking text is never touched (the chunker only ever emits
  placeholders as whole lines). Surrounding prose is byte-identical except
  the newline normalization line removal makes unavoidable (a removed
  standalone paragraph's doubled blank separator is collapsed; untouched
  text passes through byte-for-byte — normalization is applied only when
  something was actually removed). A prose chunk whose entire text was
  placeholders is omitted, never emitted empty.
- **Structural chunks** (table/code_block/checklist, classified by the SAME
  `STRUCTURAL_TYPES` set `core/entity-reference.js` resolves against): emit
  exactly one entity segment carrying authoritative `rawContent` — never
  `context` or `summary` substituted. (`text` is an acceptable fallback when
  `rawContent` wasn't stored: for skeleton entity chunks the two fields hold
  the same raw markdown bytes.)

## Integrity warnings (machine-readable, never guessed content)

Every warning is `{ code, message, chunkIndex?, placeholder?, nodePath? }`:

- `ref_placeholder_not_found` — a listed ref's placeholder is not in the
  chunk's text as a standalone line. Nothing removed, nothing fabricated.
- `ref_entity_missing` — a listed ref points at an entity absent from the
  input set. The placeholder line is **kept** in the prose (removing it
  would silently delete the pointer with no entity segment to land on).
- `orphan_placeholder` — a placeholder line neither covered by a stored ref
  nor resolvable by the canonical matcher (its entity is genuinely absent
  from the scope). Left in the prose, reported once — a line covered by a
  stored ref whose entity is missing is reported only as
  `ref_entity_missing`, never double-counted as an orphan.
- `placeholder_fallback` — mode-level, see below.

## Fallback and legacy behavior

Reference resolution is **per chunk, hybrid** (reworked in code-review round
1 — see below):

1. Skeleton scope (any chunk carries `nodeType`, OR the caller passed the
   explicit `skeleton: true` marker): one canonical `attachEntityRefs()` run
   over the whole scope — the exact function fresh indexing and the backfill
   use, called via two tiny internal camelCase↔snake_case shape mappers,
   never a second parser. Then per prose chunk:
   - stored `entityRefs` are used first (occurrence-count coverage by
     placeholder string, so duplicate refs stay balanced);
   - every derived occurrence stored refs do NOT cover is an **extra** —
     resolved and removed through the canonical fallback (its entity is
     guaranteed in scope, since the canonical matcher only resolves against
     scope entities);
   - an uncovered UNRESOLVABLE placeholder line is an orphan warning, left
     in the prose.
   The scope is `entity_refs` **only when stored refs alone fully covered
   every placeholder occurrence**. The moment the canonical resolver had to
   handle anything (a resolvable extra or an uncovered orphan), the whole
   result is marked **`placeholder_fallback`**, with a machine-readable
   warning and exactly one log line per request (through an injectable
   `logFn`; the server passes a real logger, tests a spy). A scope with no
   placeholders at all stays `entity_refs` vacuously, with no misleading
   warning.
2. No `nodeType` anywhere and no marker → legacy non-skeleton collection →
   **`plain_chunks`**: ordered prose segments, text passed through
   byte-identical (no placeholder handling of any kind), no fabricated
   entities, no warnings. Section scope on such a collection 404s at the
   skeleton-node lookup — a clear "no section identity exists" response.

The fallback never silently pretends refs existed: the mode string and the
warning are always present when it engages.

## Adapter / store changes

- `store.getSectionChunks(collection, parentId)` — exact `parent_id` match,
  `withNavExcluded` + client-side `isNavPoint` (belt-and-suspenders, same as
  `getFileChunks`), `CONTENT_NODE_FIELDS` projection, exhaustive pagination
  via `scrollAllFiltered` (which always sets `with_vector: false` — no
  vectors fetched), sorted by `chunk_index`.
- `adapter.getSectionChunks(name, { nodeId, nodePath })` — resolves the nav
  node, returns `null` when it doesn't exist (vs `[]` for an empty section),
  maps through `toChunk()`.
- Added to the StorageAdapter contract (`adapter.js` typedef +
  `REQUIRED_ADAPTER_METHODS`) and to **every** test stub
  (`ui-test-helpers.js`'s `makeStubAdapter` plus the five inline stubs in
  `search/server/operations/system/jobs.test.js`).

## Tests

New files (all run individually first, then in the full sequential suite):

- `tests/unit/core/assembly/assemble.test.js` — 24 pure tests: prose+table,
  prose+code block, prose+checklist (hint containing `]`), two consecutive
  entities on one prose chunk (order + no duplicates), entity at section
  start, exact placeholder removal (byte-identical surroundings), inline
  placeholder-looking prose untouched, placeholder-only prose omitted,
  ref-placeholder-not-found warning, ref-entity-missing keeps the
  placeholder, partial-drift orphan warning, duplicate refs (two removals,
  one entity segment), segment/response key contracts, input-not-mutated,
  fallback mode + once-per-request logging + fallback orphan + vacuous
  no-placeholder case, mixed partially-backfilled scope (review round 1),
  the explicit skeleton marker for empty/legacy-shaped input (review round
  1), plain legacy chunks (including bracketed lines passed through
  untouched), empty input.
- `tests/unit/core/assembly/projection-chain.test.js` — 6 tests: the
  complete-path proof described above, the load-bearing inverse, the
  `CONTENT_NODE_FIELDS` guards, and source-level wiring assertions for
  `getFileChunks`/`getSectionChunks`.
- `tests/unit/admin/assembly-api.test.js` — 16 HTTP tests: valid file
  request (ordering, mode, cleaned prose), valid section request (identity
  resolved via skeleton node, chunks fetched by `nodeId`), all six invalid
  parameter combinations (400), unknown collection/file/section (404
  envelopes), non-section nodePath (400), empty section (200), transitional
  fallback (mode + warning + one log line through `createApp`'s new
  `assemblyLogFn` DI), legacy plain-chunk response, and the recursive
  no-raw-Qdrant-keys check.

Updated: `qdrant-adapter.test.js`'s two full-shape `deepEqual` assertions
(toChunk gained `parentId`/`headingPath`), the five inline adapter stubs,
`makeStubAdapter`, and the import path in `entity-reference.test.js`
(module moved to core; the test file itself stays under
`tests/unit/indexer/` since it also exercises the chunker end-to-end).

## Limitations / explicitly not done

- **No stitched UI** — this phase ships the backend only. The admin file
  view still renders chunk cards; nothing consumes the new endpoint yet.
- **No MCP assembly tool** (`qdrant_get_content` remains roadmap work — it
  should consume this same core service when built).
- **No pagination** on the assembly response — a very large file returns all
  its segments in one body. Acceptable for the admin UI's local use; a
  pagination/depth control is roadmap work alongside the MCP tool.
- Section scope returns the section's **direct** chunks only — a subsection
  is its own node with its own assembly request. This is the "exact section
  node" rule, not a limitation to fix.
- `entity_refs` remains payload-only metadata: no schema-version bump, no
  vector/embedding change, no payload index. Existing collections use
  `COLLECTION=... npm run backfill:entity-refs` for the preferred path;
  un-backfilled ones get the explicit fallback until then.

## Code review fixes

### Round 1

**P1 — partial backfill broke assembly.** The mode decision switched the
ENTIRE scope to stored-refs-only the moment ANY chunk carried `entityRefs` —
chunks whose refs were never backfilled no longer went through the canonical
fallback, so their placeholders stayed in the assembled text (flagged only
as orphans) even though the referenced entity was right there in the scope.
Reproduced exactly: prose with a stored table ref + un-backfilled prose
referencing a present code block → `entity_refs` mode, the code block's
placeholder left in the output. **Fix**: resolution is now per-chunk hybrid —
one canonical `attachEntityRefs()` run over the scope, then per chunk:
stored refs are used first (occurrence-count coverage by placeholder
string, so duplicates stay balanced), every derived occurrence they don't
cover is resolved and removed through the canonical fallback, and uncovered
unresolvable lines warn as orphans. If the fallback path was needed for any
chunk, the whole result is marked `placeholder_fallback`. The old
leftover-line rescan (and the `isStructuralPlaceholderLine` helper it used)
became redundant — the canonical run's own orphan report plus coverage
bookkeeping subsume it, with covered-but-entity-missing lines reported only
as `ref_entity_missing`, never double-counted. New test: the reviewer's
exact mixed scope (table backfilled, code block not) asserting both
placeholders removed, both entities emitted, mode `placeholder_fallback`.

**P2 — an empty skeleton section was mislabeled `plain_chunks`.** Skeleton
detection inferred only from the chunks; a real-but-empty section passes
`[]`, so the inference concluded "legacy". The route, however, had just
resolved a REAL skeleton section node — it knew. **Fix**:
`assembleDocument()` accepts an explicit `skeleton: true` marker
(authoritative over inference); the section route passes it. The HTTP
empty-section test now asserts `assemblyMode: "entity_refs"` (and empty
warnings), not just empty segments; pure tests cover marker-vs-inference
for empty and legacy-shaped input.

## Verification run

All sequential, foreground, `--test-concurrency=1`:

- `node --check` on every new/changed JS file — clean.
- `node --max-old-space-size=768 --test --test-concurrency=1` on the new
  test files individually — 24/24, 6/6, 16/16.
- Full suite `"tests/**/*.test.js"` (all under `tests/unit/`) — **1005/1005**
  (959 pre-existing after stub/assertion updates + 46 new).
- `npm run smoke` — **1293/1293** (includes the skeleton-chunk and
  structural-carryover suites exercising the moved `entity-reference.js`
  through the real chunker).
- `npm run admin:build` — clean Vite build, 223 modules, bundle byte-size
  unchanged (no UI-side scope leak).
- `git diff --check` — clean (only benign LF→CRLF autocrlf warnings).

Nothing committed.

## Next task

Stitched file/section UI: the admin file view (and section view) consuming
`GET /api/collections/:name/assembly` — rendering prose segments as
continuous text and entity segments through the existing structural renderer
(tables/code/checklists from `rawContent`), with the chunked card view kept
as the alternate mode. `assemblyMode`/`warnings` surface as a small
transitional banner when the fallback engages.

## Verdict

STRUCTURAL_ASSEMBLY_API_ACCEPT
