# Benchmarking

semidex includes both offline smoke tests and a live retrieval benchmark.

## Commands

```bash
npm run bench:onnx-provider
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
npm run bench:custom-large
BENCH_SKIP_INDEX=1 npm run bench:custom-large
ONNX_EMBED=1 npm run bench:custom-large
npm run bench:custom150
BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 npm run bench:custom150
BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 RERANK_ENABLED=1 npm run bench:custom150
```

Optional live retrieval smokes (require Qdrant, not default CI):

```bash
npm run smoke:retrieval-live          # aggregate: runs all three below sequentially
npm run smoke:window-live             # compact window utility (bench-retrieval-custom-50)
npm run smoke:source-filter-live      # source_file disambiguation (bench-retrieval-custom-raw)
npm run smoke:answer-policy-live      # answer-policy evidence contracts (bench-retrieval-custom-raw)
npm run smoke:prune-live              # destructive-isolated: creates and deletes a temp collection
```

## Indexing Phase Profiler

```bash
INDEX_PROFILE=1 COLLECTION=my-docs npm run index ./docs
```

Prints a per-file timing table for each indexing phase without changing any
behavior. Intended for local profiling before optimization work — not for CI.

Sample output:

```
→ docs/en/architecture.md
  [1/5] chunking...
        18 chunks
  ...
  [profile] 18→17 chunks, ~4210 tokens
    pre                12 ms
    chunk               8 ms
    context          4230 ms
    tag              2140 ms
    embed+upsert     3180 ms
    link             2950 ms
    chunks_out          4 ms
    total           12524 ms  (1.4 chunks/s)
  ✓ done
```

Phase labels: `pre` (hash + stored-meta lookup), `chunk` (parse + split),
`context` (LLM context summaries), `tag` (LLM tags), `embed+upsert` (ONNX/Ollama
embeddings + Qdrant upsert), `link` (semantic link search + backlink updates),
`chunks_out` (Obsidian review file write).

`tokensEst` is a rough estimate: `sum(chunk.text.length / 4)`. Not a precise
token count — use it to normalise throughput across files of different sizes.

## ONNX Provider Speed Benchmark

```bash
npm run bench:onnx-provider
PROVIDERS=cpu,dml npm run bench:onnx-provider
```

A local hardware benchmark — not a retrieval quality benchmark. Measures ONNX session init time and embedding throughput for each execution provider (`cpu`, `dml`, `cuda`) against a fixed set of 20 mixed short/medium/multilingual texts.

Does not use Qdrant. Requires the ONNX model to be cached in `./models/` (run any `ONNX_EMBED=1` indexing task first to trigger the download).

Outputs a plain-text table with init time, total time, avg ms/text, and speedup vs CPU baseline.

`PROVIDERS` env var selects which providers to test (default: `cpu,dml,cuda`). `cuda` is expected to fall back to CPU on most setups since it is not bundled in `onnxruntime-node`.

**Important:** GPU providers are performance-only. Switching `ONNX_EXECUTION_PROVIDER` does not change embedding model or provider metadata and does not require reindexing. Minor numeric differences between providers are possible but do not affect retrieval quality in practice.

## Smoke Tests

`npm run smoke` is fast and does not require Qdrant or Ollama. It runs in CI on every push and pull request (`.github/workflows/smoke.yml`).

It covers:

- provider resolution
- invalid provider combinations
- reindex detection
- chunking edge cases
- reranker top-1 protection
- compact window chunk formatting (`assembleWindowChunks` — `is_match`, dedup, truncation)

`npm run smoke:window-live` is an optional live regression that requires Qdrant. Sets `ONNX_EMBED=1` internally — no env prefix needed. It verifies that the `bench-retrieval-custom-50` corpus still exposes the `getStoredMeta` discriminator fields through `window=1, window_format="compact"`. Not part of default CI.

`npm run smoke:source-filter-live` is an optional live regression for `source_file` disambiguation behavior against `bench-retrieval-custom-raw`. Sets `ONNX_EMBED=1` internally. Runs three searches on "What is the Qdrant timeout?" — unfiltered (both sources must appear), config-filtered (resolves to `qdrant_timeout_ms: 10000`, incident content absent), incident-filtered (resolves to `Qdrant timeout after 5000ms`, config content absent). Not part of default CI.

`npm run smoke:answer-policy-live` is an optional live regression for agent answer-policy evidence contracts against `bench-retrieval-custom-raw`. Sets `ONNX_EMBED=1` internally. Validates five deterministic cases: ambiguous unfiltered query (both valid contexts present → `CLARIFICATION_REQUIRED`), config-scoped query (`ANSWER_CONFIG_VALUE`), incident-scoped query (`ANSWER_INCIDENT_VALUE`), staging scope sentinel where no staging evidence exists (`SCOPE_MISMATCH_REFUSAL_REQUIRED`), and prod-service query (`ANSWER_OBSERVED_PROD_SERVICE_VALUE`). No LLM calls — asserts evidence conditions only. Not part of default CI.

`npm run smoke:retrieval-live` aggregates all three live smokes above (`smoke:window-live`, `smoke:source-filter-live`, `smoke:answer-policy-live`) into a single command. Runs them sequentially and stops on first failure, propagating the exit code. Optional, live-Qdrant-dependent, not part of default CI.

`npm run smoke:prune-live` is a destructive-isolated live integration smoke for `PRUNE_STALE=1`. It creates a uniquely named temporary Qdrant collection (`smoke-prune-<timestamp>`), indexes two small fixture files, deletes one from disk, re-runs the indexer with `PRUNE_STALE=1`, and asserts the deleted file's `source_file` is absent from Qdrant and the graph. Cleans up the temp collection, graph file, and temp directory on exit. Not included in `smoke:retrieval-live` — it is more expensive (two indexer runs, collection create/delete) and destructive in scope.

## Three Benchmark Tiers

semidex has three benchmark tiers with different purposes:

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

### custom-150 Tier B benchmark

Collection: `bench-retrieval-custom-150`

Fixtures: `benchmarks/retrieval/fixtures/docs/` (shared 4) +
`benchmarks/retrieval/custom-50/fixtures/docs/` (6 custom-50) +
`benchmarks/retrieval/custom-150/fixtures/docs/` (custom-150 additions, if any)
Queries: `benchmarks/retrieval/custom-150/queries.json` (75 queries, v3 schema)
Docs: `benchmarks/retrieval/custom-150/README.md`

Broader in-domain validation. Sits between the fast dev-regression loop of
custom-50 (Tier A) and the sealed holdout (Tier C). Use it after custom-50
confirms a change, to check class-level generalization across a wider and
harder query set. Not the primary tuning target.

```bash
BENCH_PROVIDER=onnx npm run bench:custom150
BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 npm run bench:custom150
BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 RERANK_ENABLED=1 npm run bench:custom150
```

**ONNX hybrid vs rerank baseline (2026-05-15, 75 queries):**

| Metric | hybrid | rerank | Delta |
|--------|-------:|-------:|------:|
| MRR@10 | 0.508 | 0.509 | +0.001 |
| nDCG@10 | 0.562 | 0.549 | −0.013 |
| chunkRecall@3 | 55.6% | 58.3% | +2.8 pp |
| chunkRecall@5 | 68.1% | 63.9% | −4.2 pp |
| chunkRecall@10 | 76.4% | 70.8% | −5.6 pp |
| windowRecall@5 | 88.9% | 87.5% | −1.4 pp |
| windowRecall@10 | 95.8% | 93.1% | −2.8 pp |
| supportRecall@10 | 79.2% | 75.0% | −4.2 pp |
| negativePass | 100.0% | 100.0% | 0 |
| p50/p95 latency | 93/104 ms | 96/126 ms | +3/+22 ms |

Result files:
- `benchmarks/retrieval/results/2026-05-15-custom150-onnx-hybrid.txt`
- `benchmarks/retrieval/results/2026-05-15-custom150-onnx-rerank.txt`

**Rerank decision:** deterministic rerank is not promotable as a global default
on this corpus. MRR@10 is flat (+0.001), but chunkRecall@5 and @10 both drop,
nDCG drops, and `cross-lingual-ua-en` regresses sharply (MRR 0.520→0.438,
cR@5 75%→50%). The only class that improves is `provider-activation` (4
queries), which is too small to justify global enablement. Rerank remains off
by default; class-specific routing is a possible future path, pending validation
on a larger dataset.

**CE routing result (2026-05-15, mmarco text+meta, 75 queries): GATE FAILED.**
MRR lift +0.009 (gate requires +0.030); 4 rank≤3→>3 regressions concentrated in
`config-env` (2 regressions, MRR 0.524→0.387) and a guard misfire in
`provider-activation`. Recall and cross-lingual improved. The `heuristic-v1`
guard from custom-50 does not generalise to custom-150 without a `config-env`
route class. CE routing remains benchmark-only and not promotable.

```bash
BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 \
CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 CE_INPUT=text+meta \
  npm run bench:custom150:ce-routing
```

Result file: `benchmarks/retrieval/results/2026-05-15-custom150-ce-routing-mmarco-mminilmv2-l12-h384-v1.txt`

### custom-large stress benchmark

Collection: `bench-retrieval-custom-large`

Fixtures: `benchmarks/retrieval/custom-large/fixtures/docs/` (5 large docs)
Queries: `benchmarks/retrieval/custom-large/queries.json` (46 queries, v4 schema)
Docs: `benchmarks/retrieval/custom-large/README.md`

Large-document chunking and retrieval stress test. Fixture docs contain
`[[BENCH_ANCHOR: NAME]]` markers; qrels are derived at runtime by scanning
chunk text — no hardcoded chunk indices. Run when evaluating chunking quality
on large structured documents, after changing `MIN_CHUNK_TOKENS`, `MAX_CHUNK_TOKENS`,
or the section-aware splitting logic.

custom-50 = controlled chunk-level retrieval quality on short, well-structured docs.
custom-large = large structured document stress benchmark (API references, migration
guides, multilingual workflows, runbooks).

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

**Benchmark conclusions (2026-05-10, 21 queries):**

- `ollama-mmr0.3`: same Recall@1 as RRF baseline (90.5%), dupSourceRate −11.4pp.
  Best tradeoff found across all tested diversity values.
- `onnx-mmr0.3`: Recall@1 −4.8pp vs onnx-rrf at all tested diversity values.
  Hybrid RRF dominates for ONNX; MMR is not a net win.
- Conclusion: hybrid RRF remains the best default for recall. Dense MMR is a
  niche opt-in for exploratory/diversity-first queries on ollama. For ONNX,
  only use MMR if dupSourceRate reduction is more important than Recall@1.

Full audit: `benchmarks/retrieval/results/2026-05-14-mmr-mcp-opt-in-audit.md`

**MCP opt-in status:** `qdrant_search` does not yet expose a `search_mode`
parameter. Stage 2 runtime opt-in is deferred — see criteria in
`benchmarks/retrieval/results/2026-05-14-duplicate-source-pressure-audit.md`
and in the roadmap.

**`dupSourceRate` is query-class dependent.** The 61.9% baseline comes from
exact/technical queries where single-file dominance is structural (each query
has one correct source file). This is not evidence of harmful duplication:

- For exact-token and config queries, multiple chunks from the same file
  are often adjacent context that helps the agent — not redundancy.
- For broad/exploratory queries, hybrid RRF naturally pulls from 3–4 distinct
  files without any diversity mechanism. Predicted `dupSourceRate` for
  exploratory queries: ~30–50%, below the technical baseline.
- HIGH_PRESSURE (≤ 2 unique sources in top-5) is only harmful when it blocks
  the agent from seeing cross-file context needed to answer. This failure mode
  is not confirmed for the current benchmark corpora.

Duplicate source audits:
- `benchmarks/retrieval/results/2026-05-14-duplicate-source-pressure-audit.md`

Full-text / literal search audit:
- `benchmarks/retrieval/results/2026-05-14-full-text-literal-search-audit.md`

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

`SPREAD_THRESHOLD` tunes the `low-spread` rule (default 0.05). **Do not rely on
this default** — see Threshold Sweep below. Always uses ONNX provider; `RRF_K` and
`HYBRID_PREFETCH_LIMIT` must be at defaults (exits with error otherwise).

Output is saved to `benchmarks/retrieval/results/YYYY-MM-DD-custom50-diagnostics.txt`.

## Threshold Sweep

```bash
npm run bench:custom50:sweep
BENCH_SKIP_INDEX=1 npm run bench:custom50:sweep
```

**Experiment — does not change runtime or MCP behavior.**

Finds a realistic `SPREAD_THRESHOLD` for the `low-spread` trigger by sweeping
`[0.001, 0.002, 0.003, 0.005, 0.008, 0.01, 0.015, 0.02]` and evaluating
`triggerRate`, `missRecall`, `FPR`, and `recoveryPotential` at each level.

Why `SPREAD_THRESHOLD=0.05` cannot be the default: the `topScoreSpread` for
custom-50 ranges from ~0.001 to ~0.017. A threshold of 0.05 fires on 100% of
queries (FPR=100%), making it useless as a trigger. The sweep identifies the
narrow band where the signal becomes discriminative.

Three sections in the output:

| Section | What it sweeps |
|---------|----------------|
| 1. low-spread | `topScoreSpread < threshold` only |
| 2. combined | `sourceDiversity < 2 OR topScoreSpread < threshold` |
| 3. low-diversity (fixed) | `sourceDiversity < 2` alone, no sweep |

The recommendation block selects the threshold with the highest precision among
candidates where FPR < 50% and missRecall > 0, breaking ties by missRecall then
threshold. Cross-validate across multiple runs before using any
threshold as a non-oracle trigger gate.

Output is saved to `benchmarks/retrieval/results/YYYY-MM-DD-custom50-threshold-sweep.txt`.

## custom-large Benchmark

```bash
npm run bench:custom-large
BENCH_SKIP_INDEX=1 npm run bench:custom-large
ONNX_EMBED=1 npm run bench:custom-large
```

Stress-tests chunking quality on five large fixture documents. Fixture docs contain
`[[BENCH_ANCHOR: NAME]]` comments. After indexing, the runner scans chunk text
to build an anchor→chunkId map. `queries.json` uses `expectedAnchors` (anchor names
with relevance scores) instead of hardcoded chunk indices; the runner resolves them
at runtime and fails loudly if any anchor is missing.

### Chunking Guardrails

Reported in addition to retrieval metrics. Do not fail the run; they diagnose
whether the fixture docs are chunked appropriately.

| Guardrail | Meaning |
|-----------|---------|
| `zeroChunkFiles` | Files that produced 0 chunks |
| `anchorCoverage` | Fraction of queried anchors found in indexed chunks (should be 100%) |
| `missingAnchors` | Anchor names not found in any chunk (fail-fast for qrels) |
| `duplicateAnchors` | Anchors found in more than one chunk |
| `oversizedChunkCount` | Chunks exceeding `MAX_CHUNK_TOKENS` threshold |
| `maxChunkTokensObserved` | Largest chunk seen |
| `sectionlessRate` | Fraction of chunks with no section heading |
| `anchorsPerChunk p50/p95` | Distribution of anchor count per chunk |

Output is saved to `benchmarks/retrieval/results/YYYY-MM-DD-custom-large.txt`.

## Agent Window Evaluation

```bash
ONNX_EMBED=1 npm run bench:custom-large:agent-default
```

Agent-facing manual evaluation of `qdrant_search(window=1, window_format="compact", top=3)` vs baseline. This is not a ranking benchmark; it evaluates the shape, size, and utility of context windows appended to search results.

Latest Results (`top=3`/`window=1`):
- `full` mode avg ~7.7k chars
- `compact` mode avg ~5.2k chars (~32% reduction)
- `compact` mode preserved expected hints 5/5
- The programmatic tool default remains `window=0`
- The recommended agent pattern is `qdrant_search(window=1, window_format="compact", top=3)`
- Note: The baseline follow-up metric is a heuristic assumption based on missing context, not a strict ranking metric.

## Live Agent Review Findings

Source: `benchmarks/retrieval/results/2026-05-12-clean-live-agent-review.md`

Qualitative live-agent review across all four bge-m3-onnx benchmark collections (bench-retrieval, custom-50, custom-large, custom-raw). Not a statistically complete benchmark.

**Key findings:**

- For structured documentation collections (bench-retrieval, custom-50, custom-large), most answerable queries return the correct evidence at rank 1 or 2 with no false positives.
- The confirmed recommended agent call pattern is `qdrant_search(query, collection, top=3, window=1, window_format="compact")`. Use `top=5` for ambiguous, negative, or scope-sensitive queries.
- window=1 compact rescued one silent wrong-answer case (q6 in bench-retrieval) with no observed regressions across 40 tested queries.
- RRF scores fall uniformly in 0.016–0.033 across all collections. Do not use absolute score as confidence.
- The one confirmed FAIL_FALSE_POSITIVE (raw-neg-01: staging Qdrant timeout) is a corpus-level scope-absence issue, not a retrieval algorithm failure. It requires agent-side scope verification to mitigate.
- Ukrainian and mixed-language queries are correctly handled by the neural sparse component of bge-m3-onnx.

**custom-raw negative query cleanup (2026-05-12):**

Source: `benchmarks/retrieval/results/2026-05-12-custom-raw-negative-query-cleanup.md`

Rewrote raw-neg-03 and raw-neg-06 to test missing evidence rather than vocabulary overlap. `negativePassRate` improved from 50% to 83.3%. The remaining 16.7% failure (raw-neg-01) is intentional — it is the corpus-level scope-absence sentinel for the agent scope-check instruction.

**custom-raw scope policy simulation (2026-05-12):**

Source: `benchmarks/retrieval/results/2026-05-12-custom-raw-scope-policy-simulation.md`

Tested whether a simple agent scope-verification rule ("if evidence refers to a different scope than the query, state mismatch and decline") prevents the false positive confirmed above. Result: 4/6 PASS, 2/6 FAIL. The policy fully resolves raw-neg-01 (staging vs prod — the only confirmed FAIL_FALSE_POSITIVE). It has no effect on clean negatives (raw-neg-02, 04, 05). It does not resolve raw-neg-03 and raw-neg-06 because both had vocabulary overlap in the corpus — those were query-design problems, resolved by the query rewrites above.

**custom-raw agent behavior reports (2026-05-12):**

Seven qualitative live-agent simulations over `bench-retrieval-custom-raw`, mostly using `qdrant_search(top=5, window=1, window_format="compact")` — except distractor discipline, which used `top=3`.

- **Distractor discipline** — `benchmarks/retrieval/results/2026-05-12-custom-raw-distractor-discipline.md`
  5/6 PASS_WITH_DISTRACTOR, 1 AMBIGUOUS. All distractors in current fixtures use the `Distractor:` prefix label; a careful agent handles them. The raw-noise-04 case (compact vs full snippets — direct opposites, same syntax) is the highest-risk instance. Unlabelled stale values in real-world corpora remain the next stress test.

- **Timeout ambiguity** — `benchmarks/retrieval/results/2026-05-12-custom-raw-timeout-ambiguity.md`
  Two legitimate Qdrant timeout values coexist: `qdrant_timeout_ms: 10000` (configured client timeout, config dump) and `Qdrant timeout after 5000ms` (observed incident timeout, incident log). Both rank at 0.033 for the bare query "What is the Qdrant timeout?" — no score signal resolves the tie. Queries that name the source context ("prod config", "incident log") are answerable; bare scopeless queries require clarification.

- **Timeout answer discipline** — `benchmarks/retrieval/results/2026-05-12-custom-raw-timeout-answer-discipline.md`
  All 3 queries PASS: specific queries answered correctly from rank 1; bare scopeless query surfaces both values and asks for clarification rather than picking rank 1 blindly.

- **Source filter disambiguation** — `benchmarks/retrieval/results/2026-05-12-custom-raw-timeout-source-filter.md`
  Applying `source_file` filter when the user names a document fully resolves cross-file ambiguity (FILTER_CONFIG_CLEAR, FILTER_INCIDENT_CLEAR). Unfiltered search returns both values at equal rank (UNFILTERED_AMBIGUOUS). When no scope is given, do not invent a filter — surface both values and ask.

- **Agent filter decision** — `benchmarks/retrieval/results/2026-05-12-custom-raw-agent-filter-decision.md`
  5 prompts, all PASS. Exact filename → apply `source_file` (certain). Domain alias ("prod config", "incident log") → apply `source_file` (high confidence). No scope → no filter; ask for clarification.

- **Staging/prod scope sentinel** — `benchmarks/retrieval/results/2026-05-12-custom-raw-staging-prod-scope-sentinel.md`
  4 prompts. Staging queries (P1, P4) correctly refuse — "staging" and "qdrant-staging-svc" are absent from the entire corpus, but the retriever still returns prod evidence at equal rank. Scope mismatch detection is entirely agent-side; scores and rank do not suppress cross-scope chunks.

- **Negative answer regression** — `benchmarks/retrieval/results/2026-05-12-custom-raw-negative-answer-regression.md`
  All 6 negative queries pass at agent-answer level (6/6, up from 3/6 before query cleanup). raw-neg-01 and raw-neg-04 are scope sentinel cases — forbidden tokens present in retrieved text but correctly withheld. raw-neg-03 and raw-neg-06 fixed by query rewrite. raw-neg-01 remains the intentional corpus-level scope sentinel.

- **Positive compact-window smoke** — `benchmarks/retrieval/results/2026-05-12-positive-compact-window-smoke.md`
  8 positive queries across bench-retrieval and bench-retrieval-custom-50; 8/8 PASS. `window=1 compact` is strictly load-bearing in 1/8 (Q6 getStoredMeta — rank 1 alone does not list the six reindex fields; the next-chunk window does). Q4 (Ukrainian, score 0.017) is still rank-1 correct, confirming RRF scores must not be used as confidence thresholds. Window filler is harmless.

- **Expanded window utility audit** — `benchmarks/retrieval/results/2026-05-12-expanded-window-utility-audit.md`
  24 positive queries across bench-retrieval (8), custom-50 (8), and custom-large (8); 24/24 PASS. Window RISKY_CONTEXT: 0. Window USEFUL_CONTEXT: 13/24 (54%). Window HARMLESS_FILLER: 9/24 (38%, higher in custom-large due to anchor-only chunks and empty section headers). Window strictly LOAD_BEARING: 0/24 — rare but real (~3% across 32 total positive queries combining smoke + expanded). Custom-large filler is a fixture-design artifact; production collections are expected lower.

**Window pattern recommendation (2026-05-12):**

- Use `qdrant_search(top=3, window=1, window_format="compact")` for normal positive agent queries — confirmed across 32 positive queries with 0 risky windows.
- Use `top=5` for scope-sensitive, negative, or ambiguous queries.
- Defer a dedicated window-behavior fixture; create one only if a RISKY_CONTEXT case or unexpected window failure is observed in live use.
