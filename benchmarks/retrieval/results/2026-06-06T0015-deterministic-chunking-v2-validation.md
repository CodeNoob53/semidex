# Deterministic Chunking v2 — Validation Report

**Date:** 2026-06-06  
**Schema version:** `CHUNKING_SCHEMA_VERSION=2` (`chunkFileFromPath`, BGE-M3 tokenizer)  
**Provider:** `bge-m3-onnx/bge-m3-onnx` (`ONNX_EMBED=1` in `.env`)  
**Verdict:** ✅ ACCEPT

---

## What changed

`CHUNKING_SCHEMA_VERSION=2` replaces LLM `mergeChunks()` with deterministic
`mergeShortChunks()` in `chunk.js`. Fragments below `MIN_CHUNK_TOKENS` within the same
`sameChunkScope()` boundary are merged statically; overlap is added via `finalizeChunks()`.
Legacy merge helpers moved to `benchmarks/retrieval/legacy-merge.js` (not imported by production).

`run-v3.js` migrated from `chunkFile` (sync, v1) to `chunkFileFromPath` (async, v2).  
`queries.json` qrels updated: `project-structure.md` indices `#4→#5`, `#5→#6`, `#6→#7`, `#8→#9`.

---

## Static checks

| Check | Result |
|---|---|
| `shouldMerge` / `mergeChunks` in `src/` | not found ✅ |
| `shouldMerge` / `mergeChunks` in `docs/en/` | not found ✅ |
| smoke 717/0 | ✅ |
| `git diff --check` | clean ✅ |

---

## Chunk count delta — all 10 corpus fixtures

| File | v1 | v2 | Δ |
|---|---|---|---|
| project-structure.md | 9 | 10 | **+1** |
| all other 9 files | 87 | 87 | 0 |
| **TOTAL** | **96** | **97** | **+1** |

The Source Tree section splits from 2 chunks into 3 under v2, shifting all subsequent
section indices by +1. Four qreli updated accordingly (c35/c36/c37/c38).

---

## Results — v1 baseline vs v2

| Metric | v1 (sync, old qrels) | v2 (async, updated qrels) | Δ |
|---|---|---|---|
| chunkRecall@3 | 79.6% | 79.6% | 0 |
| chunkRecall@5 | 87.8% | **89.8%** | +2.0pp |
| chunkRecall@10 | 93.9% | 93.9% | 0 |
| windowRecall@5 | 95.9% | 95.9% | 0 |
| windowRecall@10 | 98.0% | 98.0% | 0 |
| supportRecall@10 | 98.0% | 98.0% | 0 |
| nDCG@10 (graded) | 0.718 | **0.719** | +0.001 |
| MRR@10 | 0.675 | **0.676** | +0.001 |
| fileRecall@1 | 71.4% | 71.4% | 0 |
| fileRecall@10 | 100.0% | 100.0% | 0 |
| negativePass | 100.0% | 100.0% | 0 |
| Latency p50/p95 | 93ms / 111ms | 87ms / 110ms | — |

n=49 for both runs. No regression on any metric.

---

## Persistent misses (both v1 and v2)

| Query | cr@5 | Note |
|---|---|---|
| c02 | ✗ | valid combi providers — conceptual, multi-chunk |
| c12 | ✗ | named vectors storage — dense@5 miss |
| c29 | ✗ | agent session workflow — fixture/qrel gap |
| c33 | ✗ | Obsidian frontmatter — conceptual |
| c37 | ✗ | bench entry point — source-navigation hard case |

c37 remains a miss in v2 (`project-structure.md#9`, Entry Points) — retrieval issue,
not a chunking boundary issue.
