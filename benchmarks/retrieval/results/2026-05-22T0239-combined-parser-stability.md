# Combined Context+Tags Parser Stability — 2026-05-22

## Purpose

Verify parser stability of the COMBINED_LLM=1 path (one LLM call per chunk,
returns `{"context":"...","tags":[...]}`) across gemma3:4b and qwen2.5:3b-instruct.
Diagnostic only — no Qdrant indexing, no production default changes.
Corpus = private files; report contains only aggregate counts.

## Corpus Summary

| Metric | Count |
|--------|-------|
| Files | 6 (0 skipped) |
| Raw chunks | 247 |
| Merged chunks | 238 |
| Normal chunks total | 200 |
| Normal chunks tested | first 100 of 200 (COMBINED_MAX_CHUNKS=100) |
| Empty-section skipped | 38 |
| Too-short skipped (< 80 chars) | 1 |

## Model Matrix

| model | chunks tested | parse fail | fail rate | empty tags | mean tags | mean ms | p50 ms | p95 ms |
|-------|---------------|------------|-----------|------------|-----------|---------|--------|--------|
| gemma3:4b | 99 | 0 | 0.0% | 0 | 6.8 | 1106 | 1112 | 1251 |
| qwen2.5:3b-instruct | 99 | 0 | 0.0% | 0 | 3.6 | 1860 | 1741 | 2835 |

## Failure Reasons

### gemma3:4b

No parse failures.

### qwen2.5:3b-instruct

No parse failures.

## Interpretation

**gemma3:4b**: stable (0.0% parse fail rate).
**qwen2.5:3b-instruct**: stable (0.0% parse fail rate).

## Comparison vs Separate Tag Batch Path

Separate path (tag-batch-fallback-diagnostic, pre-fix baseline):

| model | batchSize | fail rate (tag batch) | fail rate (combined) |
|-------|-----------|-----------------------|----------------------|
| gemma3:4b | 3 | 21.2% | see above |
| qwen2.5:3b-instruct | 3 | 15.2% (post-fix) | see above |

Combined path sends one `{context, tags}` JSON object per chunk vs the separate
path's array-of-arrays over a batch. The simpler object shape is expected to
produce fewer format failures on small models.

## Verdict

**COMBINED_BOTH_STABLE**

All models pass with <5% parse fail rate. COMBINED_LLM=1 parser path is stable on this sampled corpus; quality still depends on retrieval benchmarks.

*Generated: 2026-05-22*
