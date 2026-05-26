# custom-50 Quality Benchmark — Post Empty-Section Removal

*Generated: 2026-05-26*

## Context

This run follows the empty-section chunk removal change documented in
`benchmarks/retrieval/results/2026-05-26T1200-empty-section-removal.md`.
The chunker no longer emits `(empty section: ...)` chunks for heading-only
Markdown sections. Three fixture files had stale chunk counts in the live
collection; `queries.json` was updated and locally validated before this run.

## Command

```powershell
$env:ONNX_EMBED = "1"
$env:BENCH_PROVIDER = "onnx"
Remove-Item Env:BENCH_SKIP_INDEX -ErrorAction SilentlyContinue
npm run bench:custom50
```

## Reindex

Full reindex performed (no `BENCH_SKIP_INDEX`). All 10 fixture docs indexed at
current chunk counts — qrel validation passed with zero errors:

| Fixture | Pre-fix chunks | Post-fix chunks |
|---------|---------------|-----------------|
| `benchmarking.md` | 24 | 21 |
| `project-structure.md` | 10 | 9 |
| `multilingual.md` | 10 | 9 |
| all other fixtures | unchanged | unchanged |

Empty sections removed from `benchmarking.md`: Benchmark Tiers, Query Schema
Versions, Metrics.

## Live Qdrant Chunk Counts (post-run)

Verified via MCP against `bench-retrieval-custom-50`:

| File | Expected | Actual |
|------|----------|--------|
| `benchmarking.md` | 21 | 21 ✓ |
| `project-structure.md` | 9 | 9 ✓ |
| `multilingual.md` | 9 | 9 ✓ |

## Results

| Metric | Value |
|--------|-------|
| Provider | onnx (bge-m3-onnx / bge-m3-onnx) |
| Queries | 49 positive, 1 negative |
| chunkRecall@3 | 79.6% |
| chunkRecall@5 | 89.8% |
| chunkRecall@10 | 93.9% |
| windowRecall@5 | 95.9% |
| windowRecall@10 | 98.0% |
| supportRecall@10 | 98.0% |
| nDCG@10 | 0.732 |
| MRR@10 | 0.695 |
| fileRecall@1 | 71.4% |
| fileRecall@10 | 100.0% |
| negativePass | 100.0% |
| Latency p50/p95 | 96ms / 110ms |

### Per-type breakdown

| Type | Count | MRR@10 | rank-1 hits | cR@5 | nDCG@10 |
|------|-------|--------|-------------|------|---------|
| exact-token | 19 | 0.842 | 14 | 94.7% | 0.823 |
| conceptual | 12 | 0.642 | 7 | 75.0% | 0.665 |
| config-env | 10 | 0.553 | 3 | 100.0% | 0.703 |
| troubleshooting | 3 | 0.833 | 2 | 100.0% | 0.829 |
| source-navigation | 3 | 0.281 | 0 | 66.7% | 0.390 |
| provider-activation | 1 | 0.500 | 0 | 100.0% | 0.598 |
| cross-lingual-ua-en | 1 | 1.000 | 1 | 100.0% | 0.956 |
| negative | 1 | n/a | n/a | n/a | n/a |

### Per-query outcomes for corrected qrels (c35–c42, c48, c49)

| Query | cr@3 | cr@5 | Note |
|-------|------|------|------|
| c35 | ✗ | ✓ | `project-structure.md#5` (qdrant.js) in top-5 but not top-3 |
| c36 | ✓ | ✓ | `project-structure.md#6` (chunk.js) found |
| c37 | ✗ | ✗ | `project-structure.md#8` (Entry Points) outside top-5; supportRecall ✓ |
| c38 | ✓ | ✓ | `project-structure.md#4` (embeddings.js / SCHEMA_VERSION) found |
| c39 | ✓ | ✓ | `benchmarking.md#7` (Chunk-level metrics) found |
| c40 | ✓ | ✓ | `benchmarking.md#5` (v3 schema) found |
| c41 | ✗ | ✓ | `benchmarking.md#1` (21q regression) in top-5 |
| c42 | ✓ | ✓ | `benchmarking.md#20` (BENCH_SKIP_INDEX) rank-1 |
| c48 | ✓ | ✓ | `multilingual.md#3` (cross-lingual section) found |
| c49 | ✓ | ✓ | `multilingual.md#8` (recommended provider) found |

## Comparability Note

Results for c41 and c48 from runs prior to this change (e.g., the combined-mode
regression diagnostics from 2026-05-25) used different qrel chunkIds. Those older
results are not directly comparable without accounting for the qrel correction:

- c41 previously referenced `benchmarking.md#2`/`#3`; now `#1`/`#2`. The baseline
  retrieval behavior is the same, but rank comparisons across the fix boundary are
  invalid.
- c48 previously referenced `multilingual.md#4` (Ukrainian-specific chunking notes)
  as the primary rel=3 chunk — that was a stale qrel pointing to the wrong section.
  The corrected target is `multilingual.md#3` (Query Language vs Document Language).
  c48 now scores ✓ cr@3.

## source-navigation weakness

c35 and c37 remain weak under ONNX (source-navigation class MRR@10 = 0.281, no
rank-1 hits, cR@5 = 66.7%). Both qrels are now correct; the issue is retrieval
quality for module-location queries against the project-structure fixture. This
is a known gap, not a qrel error.
