# Deterministic Chunking Cleanup

**Date:** 2026-06-06  
**Scope:** Finish deterministic chunking cleanup: remove exposed split-boundary metadata from final chunk output and update fixture/doc references.

---

## Pre-existing state

The LLM merge path (`shouldMerge` / `mergeChunksWithDecisions`) was already removed from production in a prior session (validated in `2026-06-06T0015-deterministic-chunking-v2-validation.md`). Legacy helpers were moved to `benchmarks/retrieval/legacy-merge.js` and marked benchmark-only.

This task completed the remaining cleanup:

1. The historical `needsBoundaryCheck` name was still used for split-boundary overlap bookkeeping. It is now renamed to `_split_boundary`, making it explicit that this is a private chunker field, not an LLM merge decision.

2. `_split_boundary` is used only within `chunk.js` to trigger `addSplitOverlapAsync`, then stripped by `reindexChunks()` before chunks reach `index.js`, `context.js`, or Qdrant payloads.

3. `benchmarks/retrieval/fixtures/hard-boundary.md` still described split-boundary chunks as "candidates for LLM merge decisions" and referenced the old default of 400.

---

## Files changed

| File | Change |
|------|--------|
| [src/indexer/phases/chunk.js](src/indexer/phases/chunk.js) | Rename internal split flag from `needsBoundaryCheck` to `_split_boundary`; strip `_split_boundary` from final chunk output in `reindexChunks()` alongside `_split_group`. |
| [src/smoke/sections/06-chunking-edge-cases.js](src/smoke/sections/06-chunking-edge-cases.js) | Added assertion: `_split_boundary` is not exposed on finalized chunks. |
| [benchmarks/retrieval/fixtures/hard-boundary.md](benchmarks/retrieval/fixtures/hard-boundary.md) | Updated intro and `MAX_CHUNK_TOKENS` description: removed "candidates for LLM merge decisions", updated default from 400 to 512, replaced overlap description to mention `addSplitOverlapAsync` and `CHUNK_OVERLAP_TOKENS`. |

---

## Production chunking flow (current)

```text
chunkFileFromPath(filePath, sourceFile)
  └─> chunkFileAsync(filePath, text, sourceFile, countFn)
        ├─> chunkSectionsAsync()           — parse markdown, split oversized sections
        │     sets _split_boundary=true on sub-chunks (internal only)
        └─> finalizeChunksAsync(chunks, countFn)
              ├─> mergeShortChunksAsync()  — deterministic: merge fragments < MIN_CHUNK_TOKENS
              │     within same section (sameChunkScope), never across heading boundaries
              ├─> markSplitBoundaries()    — tag chunks that need overlap (internal)
              ├─> addSplitOverlapAsync()   — add token-budgeted prefix from previous chunk
              └─> reindexChunks()         — drop _split_group, _split_boundary; assign
                                            chunkIndex / totalChunks
```

Output chunks carry: `text`, `section`, `source_file`, `meta`, `links`, `chunkIndex`, `totalChunks`. No `_split_boundary`, no `_split_group`.

`context.js` is a pure contextualization module — no chunk boundary decisions, no imports from `legacy-merge.js`.

---

## Grep result

Remaining matches in `src/`, `docs/en/`, `benchmarks/retrieval/` (excluding `results/`):

| Location | Pattern | Status |
|----------|---------|--------|
| `src/indexer/phases/chunk.js` | `_split_boundary` (multiple) | **Internal-only** — set and consumed within chunk.js, stripped by `reindexChunks()`. Not exported. |
| `src/smoke/sections/06-chunking-edge-cases.js` | `_split_boundary` | **New assertion** — confirms field is absent from finalized output. |
| `docs/en/chunking-quality.md:61` | "LLM merge/split decision" | Past-tense reference: "This removes the former LLM merge/split decision from the production indexing path." Correct and accurate. |
| `benchmarks/retrieval/legacy-merge.js` | `shouldMerge`, `mergeChunks*`, `needsBoundaryCheck` | **Benchmark-only.** File header: "Legacy LLM merge helpers kept only for historical merge-strategy diagnostics." Not imported by any production module. |
| `benchmarks/retrieval/merge-strategy-bench.js` | All patterns | **Benchmark script.** Imports from `legacy-merge.js` only. Not on any production path. |

All `results/` matches are historical reports — not edited per task spec.

---

## Boundary drift check

`reindexChunks()` only destructures `_split_boundary` from the spread (drop it from output). It does not affect `chunkIndex`, `totalChunks`, or `text`. All chunk boundaries, indices, and content are identical before and after this change. No qrel update needed.

---

## Smoke result

```
Smoke tests: 673 passed, 0 failed
```

New assertion added (`[6]`): `_split_boundary is not exposed on finalized chunks` — passes.

---

## git diff --check

Clean (CRLF line-ending warnings only, no whitespace errors).

---

## Verdict

**DETERMINISTIC_CHUNKING_CLEANUP_ACCEPT**

- LLM merge path was already removed; this task completed the field-level cleanup.
- `_split_boundary` is now purely internal to `chunk.js` — set, used for overlap, and dropped before output.
- `context.js` has no involvement in chunk boundary decisions.
- No chunk boundaries changed; no qrel impact.
- Smoke: 673/0.
