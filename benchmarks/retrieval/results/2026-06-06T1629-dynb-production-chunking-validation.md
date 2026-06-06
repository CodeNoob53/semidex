# dynB Production Chunking Validation

**Date:** 2026-06-06  
**Decision:** DYNB_BLOCKED_BY_QREL_DRIFT

---

## Environment

```
MAX_CHUNK_TOKENS=512
MIN_CHUNK_TOKENS=160
CHUNK_OVERLAP_TOKENS=80
TOKEN_COUNT=bge-m3
BENCH_PROVIDER=onnx
```

Baseline (current production):
```
MAX_CHUNK_TOKENS=400 (default)
MIN_CHUNK_TOKENS=30  (default)
CHUNK_OVERLAP_TOKENS=0 (not set — sentence-overlap fallback)
TOKEN_COUNT=bge-m3
```

---

## Production chunker patched?

**Yes.** The dynamic overlap model was implemented in `src/indexer/phases/chunk.js`:

- Added `CHUNK_OVERLAP_TOKENS` env var (default 0, read at module load).
- Added `safeLastTokens(text, maxTokens, countFn)`: binary search + word-boundary snap via `/\s/`. No mid-word cuts.
- Added `addSplitOverlapAsync(chunks, countFn)`: dynamic budget model. Body is split to MAX first; `available = MAX - bodyTokens`; `cap = min(CHUNK_OVERLAP_TOKENS, available)`; overlap skipped if `available ≤ 0` or no safe boundary.
- `finalizeChunksAsync` now calls `addSplitOverlapAsync` instead of `addSplitOverlap` (sentence-based fallback is preserved when `CHUNK_OVERLAP_TOKENS === 0`).
- Sync path (`chunkFile`, `finalizeChunks`, `addSplitOverlap`, `overlapPrefixFrom`) is unchanged.

No temporary benchmark code was copied into production.

---

## Smoke result

```
MAX_CHUNK_TOKENS=512 MIN_CHUNK_TOKENS=160 CHUNK_OVERLAP_TOKENS=80 TOKEN_COUNT=bge-m3
node src/smoke.js

Smoke tests: 723 passed, 0 failed
```

Baseline smoke (no CHUNK_OVERLAP_TOKENS):
```
Smoke tests: 721 passed, 0 failed
```

New section 39 covers:
- 39a: no chunk exceeds MAX_CHUNK_TOKENS after dynamic overlap
- 39b: overlap prefix starts at a word boundary
- 39c: no chunk exceeds MAX when body fills budget
- 39d: no overlap across section boundaries
- 39e: sentence-overlap fallback when CHUNK_OVERLAP_TOKENS=0

---

## Chunk count comparison (10 fixture files)

| File | Baseline | dynB | Changed? |
|---|---|---|---|
| providers.md | 6 | 6 | no |
| qdrant.md | 8 | 8 | no |
| chunking.md | 9 | 9 | no |
| sync.md | 6 | 6 | no |
| mcp-workflow.md | 9 | 9 | no |
| obsidian.md | 7 | 7 | no |
| project-structure.md | 10 | 9 | **YES** |
| benchmarking.md | 21 | 21 | no |
| config-env.md | 12 | 12 | no |
| multilingual.md | 9 | 9 | no |
| **TOTAL** | **97** | **96** | — |

---

## Qrel integrity result

**1 file drifted: `project-structure.md` (10 chunks → 9).**

Root cause: `MIN_CHUNK_TOKENS=160` (dynB) vs `MIN_CHUNK_TOKENS=30` (baseline). The `Source Tree` section in `project-structure.md` previously produced 3 sub-chunks (#1, #2, #3); with a higher MIN, two of the three were merged, eliminating one chunk and shifting all subsequent indices by −1.

Chunk index mapping (`project-structure.md`):

| Baseline idx | Section | dynB idx | Shift |
|---|---|---|---|
| #0 | Project Structure | #0 | 0 |
| #1 | Source Tree (part 1) | #1 | 0 |
| #2 | Source Tree (part 2) | #2 (merged #2+#3) | 0 |
| #3 | Source Tree (part 3) | (merged into #2) | −1 |
| #4 | src/core/config.js | #3 | −1 |
| #5 | src/core/embeddings.js | #4 | −1 |
| #6 | src/core/qdrant.js | #5 | −1 |
| #7 | src/indexer/phases/chunk.js | #6 | −1 |
| #8 | src/mcp/server.js | #7 | −1 |
| #9 | Entry Points | #8 | −1 |

**Affected qrels (4 queries):**

| Query | Stale chunkId | Correct chunkId (dynB) | Type |
|---|---|---|---|
| c35 | project-structure.md#6 | project-structure.md#5 | rel=3 |
| c35 | project-structure.md#1 | project-structure.md#1 | ok |
| c36 | project-structure.md#7 | project-structure.md#6 | rel=3 |
| c36 | project-structure.md#1 | project-structure.md#1 | ok |
| c37 | project-structure.md#9 | project-structure.md#8 | rel=3 |
| c37 | project-structure.md#2 | project-structure.md#2 | ok |
| c38 | project-structure.md#5 | project-structure.md#4 | rel=3 |
| c38 | project-structure.md#6 | project-structure.md#5 | rel=2 |

The content of each drifted chunk is identical — only the index changed. This is not a quality regression.

---

## Baseline retrieval metrics (before reindex)

```
Provider: onnx (bge-m3-onnx/bge-m3-onnx), hybrid, top-10
Queries: 49 positive, 1 negative

chunkRecall@3     : 79.6%
chunkRecall@5     : 89.8%
chunkRecall@10    : 93.9%
windowRecall@5    : 95.9%  (±1 window)
windowRecall@10   : 98.0%  (±1 window)
supportRecall@10  : 98.0%
nDCG@10 (graded)  : 0.719
MRR@10            : 0.676
fileRecall@1      : 71.4%
fileRecall@10     : 100.0%
negativePass      : 100.0%
```

Per-class:
```
exact-token  (19): MRR=0.842  cR@5=94.7%  nDCG=0.823
conceptual   (12): MRR=0.600  cR@5=75.0%  nDCG=0.651
config-env   (10): MRR=0.503  cR@5=100.0% nDCG=0.662
```

---

## dynB retrieval metrics

**Not available — validation aborted due to qrel drift.**

The benchmark runner detected that `project-structure.md#9` is not present in the dynB index and exited with error code 1. Running the benchmark with stale qrels would produce misleading cR@5/MRR numbers for c35/c36/c37/c38 (they would appear as misses when the content is actually present at a different index).

---

## What is not a regression

The chunk count change from 10→9 in `project-structure.md` is caused by `MIN_CHUNK_TOKENS=160` causing short Source Tree sub-chunks to merge. The content of each chunk is intact; only the index numbers shifted. The content at `project-structure.md#8` (dynB) is identical to `project-structure.md#9` (baseline).

---

## Required next step: qrel migration task

Before dynB validation can complete, the following must be done:

1. Update `queries.json` to map stale chunkIds to the correct dynB indices:
   - c35: `#6 → #5`
   - c36: `#7 → #6`
   - c37: `#9 → #8`
   - c38: `#5 → #4`, `#6 → #5`
2. Verify each migrated chunk still contains the expected content (not a different section).
3. Re-run `CHUNK_OVERLAP_TOKENS=80 ... npm run bench:custom50` after migration.
4. Report result as DYNB_ACCEPT or DYNB_REJECT based on metric comparison.

The migration is mechanical (index shift −1 for all chunks after the merge point in `project-structure.md`). Content verification is mandatory before committing.

---

## CHUNKING_SCHEMA_VERSION

**Not bumped.** Production chunking behavior changes only after:
1. Qrel migration is complete.
2. Retrieval benchmark runs without errors.
3. Metrics hold or improve vs baseline.

Current `CHUNKING_SCHEMA_VERSION = 2` (in `src/core/token-count.js`) remains unchanged.

---

## Implementation summary

Files changed:
- `src/indexer/phases/chunk.js` — added `CHUNK_OVERLAP_TOKENS`, `safeLastTokens`, `addSplitOverlapAsync`; updated `finalizeChunksAsync`
- `src/smoke/sections/39-dynamic-overlap.js` — new smoke section (5 cases)
- `src/smoke/index.js` — registered section39

Files not changed:
- `src/core/token-count.js` (CHUNKING_SCHEMA_VERSION stays 2)
- `benchmarks/retrieval/custom-50/queries.json` (qrel migration is a separate task)
- Any tag/context/embed/MCP code
