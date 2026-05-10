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
npm run bench:custom50:tune
npm run bench:custom50:compare
npm run bench:custom50:agent
BENCH_SKIP_INDEX=1 npm run bench:custom50:agent
npm run bench:custom50:diagnostics
BENCH_SKIP_INDEX=1 npm run bench:custom50:diagnostics
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

## Tuning Matrix

```bash
npm run bench:custom50:tune
```

Tests combinations of `RRF_K`, `HYBRID_PREFETCH_LIMIT`, and `RERANK_ENABLED` against
the ONNX baseline on the custom-50 corpus. This is for retrieval parameter exploration,
not regression testing — it does not catch bugs, it informs default selection.

All variants use `bge-m3-onnx`. The first variant indexes fresh; all others reuse the
collection with `BENCH_SKIP_INDEX=1` to avoid measuring reindex variance.

Output is saved to `benchmarks/retrieval/results/YYYY-MM-DD-custom50-tuning-matrix.txt`.

### How to interpret the tuning matrix

- **`chunkRecall@5`** — primary recall signal; higher is better. A variant that reduces
  this vs baseline should not be promoted.
- **`windowRecall@5`** — includes ±1 chunk neighbors; the gap between this and
  `chunkRecall@5` shows boundary effects vs true ranking improvements.
- **`nDCG@10`** — weighted ranking quality; favours variants that push exact-answer
  chunks to rank 1–3 rather than rank 8–10.
- **`MRR@10`** — reciprocal rank of the first hit; particularly sensitive to the
  top-3 position, useful for evaluating rerank benefit.
- **`p95 latency`** — tail latency; rerank and large prefetch add overhead, check this
  before committing to a configuration.

The "Best candidates" block at the end of the output summarises per-metric winners and
the lowest p95 among variants that do not reduce `chunkRecall@5` vs baseline. A single
run is not sufficient to change production defaults — cross-validate across multiple
runs before adjusting `RRF_K`, `HYBRID_PREFETCH_LIMIT`, or `RERANK_ENABLED`.

## Candidate Comparison

```bash
npm run bench:custom50:compare
```

Runs 4 fixed candidate presets (baseline, prefetch-20, rerank, prefetch-20+rerank)
and produces a failure-level diff rather than just aggregate metrics. Use this after
the tuning matrix to understand *which specific queries* improve or regress between
configurations before promoting a preset.

Output includes:

- aggregate metrics per candidate (same metrics as the tuning matrix)
- per-query best rank of the rel≥3 chunk across all candidates
- improved and regressed queries per candidate vs baseline (with rank deltas)
- remaining failure categories (rank6-10 / window / support-only / total-miss)
- auto-derived recommendation block (does not change production defaults)

Output is saved to `benchmarks/retrieval/results/YYYY-MM-DD-custom50-candidate-comparison.txt`.

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

## Agent Policy

```bash
npm run bench:custom50:agent
BENCH_SKIP_INDEX=1 npm run bench:custom50:agent
```

Models semidex as a two-step agentic retrieval system. Evaluates 5 policies:

| Policy | Description |
|--------|-------------|
| `baseline-top5` | Single hybrid search, top-5 |
| `baseline-top10` | Single hybrid search, top-10 |
| `top5→top10-on-miss` | top-5 first; on miss, widen to top-10 |
| `top5→rerank-on-miss` | top-5 first; on miss, fetch top-40 + rerank |
| `top5→window-on-miss` | top-5 first; on miss, if a ±1 neighbor of the exact chunk is in top-5, fetch via `qdrant_get_chunk` |

Metrics per policy:

| Metric | Meaning |
|--------|---------|
| `singleShotRecall@5` | Fraction of queries where baseline-top5 finds the rel≥3 chunk |
| `agentSuccess@1step` | Fraction found without a recovery step |
| `agentSuccess@2steps` | Fraction found after any steps (including recovery) |
| `avgSearchCalls` | Average number of Qdrant calls per query |
| `avgLatency ms` | Average end-to-end latency including embedding |
| `remainingMisses` | Queries where no step succeeded |

**Important — oracle upper bounds:** Policies 3–5 use qrels to detect misses and
decide whether to fire a recovery step. A real agent cannot inspect qrels. Therefore
`agentSuccess@2steps`, `avgSearchCalls`, and `avgLatency` are **oracle upper bounds**,
not realistic estimates. Treat them as the theoretical ceiling for each policy's
recovery approach.

Always uses ONNX provider (bge-m3-onnx, hybrid RRF). `RRF_K` and
`HYBRID_PREFETCH_LIMIT` must be unset or at their defaults (60/2) — the script
exits with an error if either is set to a non-default value, because `qdrant.js`
reads them at module load time and they cannot be reset in-process.

Output is saved to `benchmarks/retrieval/results/YYYY-MM-DD-custom50-agent-policy.txt`.

## Search Diagnostics

```bash
npm run bench:custom50:diagnostics
BENCH_SKIP_INDEX=1 npm run bench:custom50:diagnostics
SPREAD_THRESHOLD=0.03 BENCH_SKIP_INDEX=1 npm run bench:custom50:diagnostics
```

**Experiment — does not change runtime or MCP behavior.**

Computes per-query signal features from a baseline top-5 hybrid search and
tests simple trigger rules that could predict when top-5 is weak and a recovery
step should fire. Qrels are used **only** to evaluate whether triggers correctly
predict misses — never to compute signals or fire triggers.

Observable signals (no qrel access, safe to use as triggers):

| Signal | Description |
|--------|-------------|
| `topScoreSpread` | score(rank1) − score(rank5) |
| `topScoreRatio` | score(rank1) / score(rank5), guarded for zero |
| `sourceDiversity` | unique `source_file` count in top-5 |
| `duplicateSourceRate` | fraction of top-5 results sharing the top-1 source |
| `exactQueryTokenHits` | fraction of query tokens found in top-5 text/section/source |
| `technicalTokenHits` | fraction of semidex technical tokens found in top-5 text |
| `top1SourceRepeated` | top-1 source appears ≥3 times in top-5 |

Eval-only signals (qrel-dependent — not usable in triggers):

| Signal | Description |
|--------|-------------|
| `hasNeighborCandidate` | a ±`BENCH_WINDOW` neighbor of any rel≥3 chunk is in top-5 |
| `top5ContainsExpectedFile` | a result from any expected file is in top-5 |
| `isMiss` | no rel≥3 chunk in top-5 |

Trigger rules tested:

| Rule | Condition |
|------|-----------|
| `low-diversity` | `sourceDiversity < 2` |
| `low-spread` | `topScoreSpread < SPREAD_THRESHOLD` (default 0.05) |
| `no-tech-token` | `technicalTokenHits === 0` (exact-token queries only) |
| `combined` | any of the above |

Trigger evaluation metrics per rule:

| Metric | Meaning |
|--------|---------|
| `triggerRate` | % of positive queries where trigger fires |
| `missRecall` | % of real misses caught by trigger |
| `falsePositiveRate` | % of non-misses incorrectly triggered |
| `recoveryPotential@10` | % of triggered queries recovered by widening to top-10 |
| `recoveryPotential@rerank` | % of triggered queries recovered by top-40 + rerank |
| `recoveryPotential@window` | % of triggered queries recovered by window expansion |

`SPREAD_THRESHOLD` tunes the `low-spread` rule (default 0.05). Always uses ONNX
provider; `RRF_K` and `HYBRID_PREFETCH_LIMIT` must be at defaults (exits with error
otherwise).

Output is saved to `benchmarks/retrieval/results/YYYY-MM-DD-custom50-diagnostics.txt`.
