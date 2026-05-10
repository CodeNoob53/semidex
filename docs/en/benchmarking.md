# Benchmarking

semidex includes both offline smoke tests and a live retrieval benchmark.

## Commands

```bash
npm run smoke
npm run bench:retrieval
npm run bench:retrieval:compare
npm run bench:retrieval:rerank
npm run bench:retrieval:mmr
```

## Smoke Tests

`npm run smoke` is fast and does not require Qdrant or Ollama.

It covers:

- provider resolution
- invalid provider combinations
- reindex detection
- chunking edge cases
- reranker top-1 protection

## Retrieval Benchmark

The retrieval benchmark uses a dedicated Qdrant collection:

```text
bench-retrieval
```

It indexes fixture documents from:

```text
benchmarks/retrieval/fixtures/docs/
```

and runs queries from:

```text
benchmarks/retrieval/queries.json
```

Detailed benchmark implementation docs live in:

```text
benchmarks/retrieval/README.md
```

## Metrics

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

The bundled benchmark is a regression suite, not a scientific corpus evaluation. It is designed to catch quality regressions when changing:

- chunking
- provider config
- sparse vectors
- Qdrant schema
- RRF settings
- reranking
- MCP search behavior
