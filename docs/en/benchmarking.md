# Benchmarking

semidex includes both offline smoke tests and a live retrieval benchmark.

## Commands

```bash
npm run smoke
npm run bench:retrieval
npm run bench:retrieval:compare
npm run bench:retrieval:rerank
npm run bench:retrieval:mmr
npm run bench:custom50
BENCH_JSON=1 BENCH_SKIP_INDEX=1 npm run bench:custom50 | npm run bench:custom50:failures
```

## Smoke Tests

`npm run smoke` is fast and does not require Qdrant or Ollama.

It covers:

- provider resolution
- invalid provider combinations
- reindex detection
- chunking edge cases
- reranker top-1 protection

## Two Benchmark Tiers

semidex has two benchmark tiers with different purposes:

### 21-query regression benchmark

Collection: `bench-retrieval`

Fixtures: `benchmarks/retrieval/fixtures/docs/` (4 docs)
Queries: `benchmarks/retrieval/queries.json` (21 queries, v2 schema)
Docs: `benchmarks/retrieval/README.md`

Fast file-level smoke. Run before merges to catch regressions in chunking,
providers, RRF settings, or reranking.

### custom-50 quality benchmark

Collection: `bench-retrieval-custom-50`

Fixtures: `benchmarks/retrieval/fixtures/docs/` (shared 4) +
`benchmarks/retrieval/custom-50/fixtures/docs/` (6 new)
Queries: `benchmarks/retrieval/custom-50/queries.json` (50 queries, v3 schema)
Docs: `benchmarks/retrieval/custom-50/README.md`

Chunk-level evaluation with graded relevance (`relevantChunks`, `relevance: 1/2/3`).
Run when evaluating retrieval quality beyond file-level recall.

## Metrics

### Regression benchmark (v2 schema)

| Metric | Meaning |
|--------|---------|
| `fileRecall@1` | Correct file is rank 1 |
| `fileRecall@K` | Correct file appears in top K |
| `MRR` | Mean reciprocal rank |
| `nDCG@K` | Binary relevance discounted by rank |
| `sectionHit@K` | Expected section appears in top-K chunks from expected file |
| `tokenHit@K` | Expected tokens appear in top-K chunks from expected file |
| `negativePassRate` | Negative queries do not return strong hits |
| `dupSourceRate` | Duplicate source-file rate in top K |
| `sourceDiversity` | Average unique source files in top K |
| `p50/p95 latency` | Query latency percentiles |

### Quality benchmark (v3 schema)

| Metric | Meaning |
|--------|---------|
| `chunkRecall@3` | Exact answer chunk (rel≥3) in top-3 |
| `chunkRecall@5` | Exact answer chunk (rel≥3) in top-5 |
| `chunkRecall@10` | Exact answer chunk (rel≥3) in top-10 |
| `windowRecall@5` | Exact chunk or ±1 neighbor in top-5 |
| `windowRecall@10` | Exact chunk or ±1 neighbor in top-10 |
| `supportRecall@K` | Supporting chunk (rel≥2) in top-K |
| `nDCG@K (graded)` | Gain = 2^relevance − 1, normalised |
| `MRR@10` | Reciprocal rank of first rel≥3 chunk |
| `fileRecall@1/K` | File-level recall (secondary) |
| `negativePassRate` | Negative queries do not return strong hits |
| `p50/p95 latency` | Query latency percentiles |

`windowRecall` measures whether the correct answer is reachable via
`qdrant_get_chunk(window=N)` — the gap between `windowRecall` and `chunkRecall` at
the same depth shows how many misses are chunk-boundary effects rather than true
retrieval failures. Control the adjacency window with `BENCH_WINDOW` (default: 1).

### Relevance scale (v3)

| Score | Meaning |
|-------|---------|
| 3 | Exact answer — chunk directly answers the query |
| 2 | Supporting context — useful neighboring or related chunk |
| 1 | Same-topic, not sufficient alone |

## Provider Compare

```bash
npm run bench:retrieval:compare
```

Runs default env provider and ONNX provider side by side.

## Rerank Matrix

```bash
npm run bench:retrieval:rerank
```

Runs:

- default provider without rerank
- default provider with rerank
- ONNX without rerank
- ONNX with rerank

Rerank variants reuse the same index where possible to avoid measuring reindex variance as ranking quality.

## MMR Diversity Matrix

```bash
npm run bench:retrieval:mmr
```

Runs hybrid RRF baselines and dense MMR variants for both providers. MMR is
evaluated as a dense-nearest Qdrant query mode, not as a production replacement
for hybrid dense+sparse RRF.

Default diversity values:

```bash
MMR_DIVERSITIES=0.3,0.5,0.7
```

Useful overrides:

```bash
MMR_DIVERSITIES=0.2,0.5,0.8 npm run bench:retrieval:mmr
MMR_CANDIDATES_LIMIT=200 npm run bench:retrieval:mmr
```

Judge MMR by both relevance and diversity:

- `Recall@1`, `MRR`, `nDCG@K` should not regress too much.
- `dupSourceRate` should go down.
- `sourceDiversity` should go up.

## Current Role

The regression benchmark catches quality regressions when changing chunking,
providers, sparse vectors, Qdrant schema, RRF settings, reranking, or MCP search
behavior. It is not a scientific corpus evaluation.

The custom-50 quality benchmark is a more demanding evaluation harness. Use it
when making changes that could affect chunk-level retrieval precision — provider
switches, embedding schema changes, or RRF/MMR parameter tuning.

ONNX baseline on custom-50 (2026-05-10, bge-m3-onnx, hybrid RRF, top-10, corrected qrels):

| Metric | Value |
|--------|-------|
| chunkRecall@3 | 77.6% |
| chunkRecall@5 | 87.8% |
| chunkRecall@10 | 93.9% |
| windowRecall@5 | 95.9% |
| windowRecall@10 | 98.0% |
| supportRecall@10 | 98.0% |
| nDCG@10 (graded) | 0.710 |
| MRR@10 | 0.655 |
| fileRecall@10 | 100% |

Remaining failures: 3 chunkRecall@10 misses — 2 window hits (c02, c33) and 1 genuine
total-miss (c29: collection-discovery session-start query). Inspect with
`benchmarks/retrieval/results/2026-05-10-custom50-failure-analysis.txt`.

Raw result: `benchmarks/retrieval/results/2026-05-10-custom50-onnx-baseline.txt`
