# dynB Default Promotion Report

**Date:** 2026-06-06
**Verdict:** DYNB_DEFAULT_PROMOTED

---

## Changes promoted to production defaults

| Parameter | Old default | New default |
|---|---|---|
| `MAX_CHUNK_TOKENS` | 400 | 512 |
| `MIN_CHUNK_TOKENS` | 30 | 160 |
| `CHUNK_OVERLAP_TOKENS` | — (new param) | 80 |
| `OVERLAP_SENTENCES` | 2 (active) | 2 (legacy fallback when `CHUNK_OVERLAP_TOKENS=0`) |
| `CHUNKING_SCHEMA_VERSION` | 2 | 3 |

---

## Code changes

| File | Change |
|---|---|
| `src/indexer/phases/chunk.js` | Defaults bumped; `safeLastTokens()` + `addSplitOverlapAsync()` added; `finalizeChunksAsync()` wired |
| `src/core/token-count.js` | `CHUNKING_SCHEMA_VERSION` 2 → 3 |
| `src/smoke/sections/36-token-count.js` | Schema version assertion updated to 3 |
| `src/smoke/sections/39-dynamic-overlap.js` | New smoke section: 39a–39d overlap tests, 39e fallback |
| `src/smoke/index.js` | Section 39 registered |
| `docs/en/configuration.md` | Defaults updated, `CHUNK_OVERLAP_TOKENS` documented |
| `docs/en/architecture.md` | Phase 1 overlap description updated |
| `docs/en/chunking-quality.md` | "No overlap leakage" section updated |
| `docs/ua/README.md` | Defaults table updated |
| `benchmarks/retrieval/custom-50/queries.json` | 5 surgical qrel migrations (c35–c38 drift from MIN=160) |

---

## Smoke result

```
Smoke tests: 729 passed, 0 failed
```

Section 39 tests exercised with dynB defaults (no env override needed):
- 39a: forced split → overlap added → final tokens ≤ MAX ✓
- 39b: zero mid-word cuts across split boundaries ✓
- 39c: no chunk exceeds MAX_CHUNK_TOKENS ✓
- 39d: no overlap across section boundaries ✓

---

## Fixture chunking sanity check

Corpus: 11 fixture files (fixtures/ + custom-50/fixtures/), 137 total chunks.

| Metric | Value |
|---|---|
| Total chunks | 137 |
| Chunks > MAX (512) | 1 |
| Over-MAX file | `hard-boundary.md#2` (566 tok, "Long Checklist Section") |

The single over-MAX chunk is in `hard-boundary.md` — a stress-test fixture with checklist-style content that has no sentence boundaries. The section body (566 tokens) exceeds MAX and cannot be split by the sentence splitter. This is a pre-existing unsplittable-section failure mode, not introduced by dynB. The same file produced 8 >MAX chunks in the production baseline (MAX=400) benchmark. Over normal documentation fixtures: 0 >MAX.

---

## Retrieval validation (from 2026-06-06T1646 report)

Benchmark: custom-50, 20 docs, BGE-M3 tokenizer.

| Metric | Baseline | dynB | Delta |
|---|---|---|---|
| chunkRecall@3 | 79.6% | 79.6% | 0 |
| chunkRecall@5 | 89.8% | 87.8% | **−2.0pp** |
| chunkRecall@10 | 93.9% | 93.9% | 0 |
| windowRecall@5 | 95.9% | 95.9% | 0 |
| windowRecall@10 | 98.0% | 98.0% | 0 |
| supportRecall@10 | 98.0% | 98.0% | 0 |
| nDCG@10 | 0.719 | 0.719 | 0 |
| MRR@10 | 0.676 | 0.675 | −0.001 |
| fileRecall@1 | 71.4% | 71.4% | 0 |
| fileRecall@10 | 100.0% | 100.0% | 0 |
| negativePass | 100.0% | 100.0% | 0 |
| chunks > MAX | 8 | 0 | −8 |

The −2.0pp cR@5 is attributable to c41 (borderline query, rank 5→7, cR@10 unchanged). All other metrics unchanged. Over-MAX problem eliminated.

---

## Qrel migration

5 qrels migrated to account for MIN_CHUNK_TOKENS=160 merging short sub-chunks in `project-structure.md` (10→9 chunks, indices #4–#9 shifted by −1):

| Query | Change |
|---|---|
| c35 | `project-structure.md#6 → #5` |
| c36 | `project-structure.md#7 → #6` |
| c37 | `project-structure.md#9 → #8` |
| c38 | `project-structure.md#5 → #4`, `#6 → #5` |

Content verified identical for all 5 migrated qrels before editing.

---

## Expected reindex behavior

Any collection indexed with `CHUNKING_SCHEMA_VERSION=2` (old defaults) will trigger automatic full reindex on next indexing run. The schema version is stored in Qdrant payload. Users must reindex to benefit from dynB overlap and the new token limits.

---

## Verdict

**DYNB_DEFAULT_PROMOTED** — all gates passed:
- Smoke: 729/729 ✓
- cR@5 −2.0pp from single borderline query (c41), cR@10 unchanged ✓
- MRR@10 −0.001, nDCG@10 unchanged: no meaningful regression ✓
- Chunks >MAX on retrieval benchmark: 8 → 0 ✓
- Schema version bumped to force reindex ✓
- Qrel migration applied (5 entries) ✓
