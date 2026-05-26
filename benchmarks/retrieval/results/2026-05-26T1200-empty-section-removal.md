# Empty-Section Chunk Removal

*Generated: 2026-05-26*

## What Changed

Markdown sections with no direct text (heading-only, immediately followed by a child heading
or end of file) previously created synthetic chunks with text `(empty section: <heading>)`.
These are non-content artifacts that occupy Qdrant points and retrieval window slots.

**Before:**
```
## Benchmark Tiers          ← heading only → emitted (empty section: Benchmark Tiers)

### 21-query regression ...
text A                      → chunk #2

### 50-query quality ...
text B                      → chunk #3
```

**After:**
```
## Benchmark Tiers          ← no chunk emitted

### 21-query regression ...
text A                      → chunk #1

### 50-query quality ...
text B                      → chunk #2
```

## Files Changed

| File | Change |
|------|--------|
| `src/indexer/phases/chunk.js` | `chunkSections`: skip section when `section.text` is empty/whitespace; remove synthetic placeholder |
| `src/indexer/index.js` | Removed `partitionChunks` / `reassembleChunks` / `finalizeEmptySectionChunk` calls; added defensive pre-upsert guard using `isEmptySectionChunk` |
| `src/indexer/phases/empty-section.js` | No changes — `isEmptySectionChunk` kept for defensive guard in indexer |
| `src/smoke/sections/31-empty-section.js` | Rewritten: tests now assert chunker suppression, contiguous indexes, multi-empty headings; removed tests for `finalizeEmptySectionChunk`, `partitionChunks`, `reassembleChunks` |
| `benchmarks/retrieval/custom-50/queries.json` | Updated qrel chunkIds for `benchmarking.md`, `project-structure.md`, and `multilingual.md` (see below) |

## Before/After Example: `benchmarking.md`

The fixture previously produced 24 chunks (3 were empty-section placeholders).
After this change it produces 21 chunks.

Empty sections removed:
- `Benchmark Tiers` (was chunk #1)
- `Query Schema Versions` (was chunk #4)
- `Metrics` (was chunk #9)

## Affected Qrels (`benchmarks/retrieval/custom-50/queries.json`)

### `benchmarking.md` — 3 empty sections removed (Benchmark Tiers #1, Query Schema Versions #4, Metrics #9)

| Query | Field | Old chunkId | New chunkId | Section |
|-------|-------|-------------|-------------|---------|
| c39 | rel=3 | `benchmarking.md#10` | `benchmarking.md#7` | Chunk-level (v3 only) |
| c39 | rel=2 | `benchmarking.md#8` | `benchmarking.md#6` | Relevance Scale |
| c40 | rel=3 | `benchmarking.md#7` | `benchmarking.md#5` | v3 (graded chunk-level) |
| c40 | rel=2 | `benchmarking.md#3` | `benchmarking.md#2` | 50-query quality benchmark |
| c41 | rel=3 | `benchmarking.md#2` | `benchmarking.md#1` | 21-query regression benchmark |
| c41 | rel=2 | `benchmarking.md#3` | `benchmarking.md#2` | 50-query quality benchmark |
| c42 | rel=3 | `benchmarking.md#23` | `benchmarking.md#20` | BENCH_SKIP_INDEX |
| c42 | rel=2 | `benchmarking.md#17` | `benchmarking.md#14` | Skip reindex |

### `project-structure.md` — pre-existing stale qrels (not caused by this change, corrected here)

| Query | Field | Old chunkId | New chunkId | Section |
|-------|-------|-------------|-------------|---------|
| c35 | rel=3 | `project-structure.md#6` | `project-structure.md#5` | src/core/qdrant.js |
| c36 | rel=3 | `project-structure.md#7` | `project-structure.md#6` | src/indexer/phases/chunk.js |
| c37 | rel=3 | `project-structure.md#9` | `project-structure.md#8` | Entry Points |
| c38 | rel=3 | `project-structure.md#5` | `project-structure.md#4` | src/core/embeddings.js |
| c38 | rel=2 | `project-structure.md#4` | `project-structure.md#5` | src/core/qdrant.js |

### `multilingual.md` — pre-existing stale qrels (not caused by this change, corrected here)

| Query | Field | Old chunkId | New chunkId | Section |
|-------|-------|-------------|-------------|---------|
| c48 | rel=3 | `multilingual.md#4` | `multilingual.md#3` | Query Language vs Document Language |
| c48 | rel=2 | `multilingual.md#3` (removed) | — | was duplicate of new rel=3 target |
| c49 | rel=3 | `multilingual.md#9` | `multilingual.md#8` | Recommended Provider for Multilingual Use |

All qrel chunkIds across `benchmarking.md`, `project-structure.md`, and `multilingual.md`
verified against actual `chunkFile()` output after this change. No missing chunk references remain.

## Defensive Guard

`src/indexer/index.js` adds a pre-upsert guard using `isEmptySectionChunk`. If any
empty-section chunk reaches the upsert gate (from a non-markdown path or a future
regression), it throws before embedding or upserting. Silent filtering was rejected
because it would leave `chunkIndex`/`totalChunks` non-contiguous and cause
`deleteTrailingChunks` to delete valid higher-index points.

## Test Results

```
npm run smoke
Smoke tests: 650 passed, 0 failed
```

Section [31] covers:
- `isEmptySectionChunk` detection (defensive guard)
- heading-only parent → no chunk
- parent + two children → exactly 2 chunks
- contiguous `chunkIndex` / `totalChunks` over real chunks only
- non-empty short section still preserved
- multiple consecutive empty headings → no chunks

## Invariants Preserved

- `chunk_index` and `total_chunks` are contiguous over real content chunks only.
- Non-empty short sections (below `MIN_TOKENS`) that have a heading are still preserved
  (the existing guard `if (!section.heading && countTokens < MIN_TOKENS) continue` is
  unchanged — headingless body-text sub-threshold is still skipped, headed short sections
  are not).
- PDF and plain-text paths are unaffected (they never produced `(empty section: ...)` text).
