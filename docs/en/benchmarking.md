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
BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 npm run bench:custom150:ce-routing
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

`PROVIDERS` env var selects which providers to test (default: `cpu,dml,cuda`). `cuda` always falls back to CPU — CUDA EP is not bundled in `onnxruntime-node`; results will be identical to CPU.

**Important:** Switching `ONNX_EXECUTION_PROVIDER` is performance-only — it does not change embedding model or provider metadata and does not require reindexing. Minor numeric differences between providers are possible but do not affect retrieval quality in practice. Windows DirectML (`dml`) is the only provider with a confirmed indexing speedup (see `2026-05-17-onnx-batching-provider-comparison.md`).

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

### custom-50 — Tier A (dev regression loop)

Collection: `bench-retrieval-custom-50`

Fixtures: `benchmarks/retrieval/fixtures/docs/` (shared 4) +
`benchmarks/retrieval/custom-50/fixtures/docs/` (6 new)
Queries: `benchmarks/retrieval/custom-50/queries.json` (50 queries, v3 schema)
Docs: `benchmarks/retrieval/custom-50/README.md`

Chunk-level evaluation with graded relevance (`relevantChunks`, `relevance: 1/2/3`).
Primary dev-regression loop: run when evaluating retrieval quality beyond
file-level recall, and use it as the primary tuning target for retrieval
parameter changes, reranking experiments, and guard iteration. custom-50 is
intentionally inspectable — per-query failure analysis and guard tuning against
specific query IDs is acceptable here.

custom-150 (Tier B) is the confirmation layer after custom-50 validates a
change. A change that passes custom-50 but fails custom-150's class-level gate
is not yet promotable.

### custom-150 — Tier B (class-level generalization check)

Collection: `bench-retrieval-custom-150`

Fixtures: `benchmarks/retrieval/fixtures/docs/` (shared 4) +
`benchmarks/retrieval/custom-50/fixtures/docs/` (6 custom-50) +
`benchmarks/retrieval/custom-150/fixtures/docs/` (custom-150 additions, if any)
Queries: `benchmarks/retrieval/custom-150/queries.json` (75 queries, v3 schema, target 150)
Docs: `benchmarks/retrieval/custom-150/README.md`

Broader in-domain validation. Sits between the fast dev-regression loop of
custom-50 (Tier A) and the sealed blind holdout (Tier C). Use it after custom-50
confirms a change, to check class-level generalization across a wider and harder
query set.

**Key constraints:**
- Not the primary tuning target. Parameter changes and guard rules must be
  validated on custom-50 first, then confirmed here.
- No query-id hardcoding. Guard rules must generalize by query class or semantic
  pattern, not by specific `c150-NNN` IDs.
- Not blind — fixture docs and per-class metrics can be inspected for diagnostics.
- A class-level MRR drop ≥ 0.030 blocks promotion even if aggregate metrics improve.

```bash
npm run bench:custom150
BENCH_SKIP_INDEX=1 npm run bench:custom150
BENCH_PROVIDER=onnx npm run bench:custom150
RERANK_ENABLED=1 npm run bench:custom150
npm run bench:custom150:ce-routing
```

**ONNX hybrid baseline (2026-05-15, 75 queries):**

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

**CE routing v4 result (2026-05-16, mmarco text+meta, 75 queries): GATE FAILED.**

Guard iterations v2/v3/v4 brought aggregate metrics up substantially and reduced
rank≤3 regressions to zero — but the class-level gate blocks promotion:

| Metric | hybrid | ce-routed-v4 | Delta |
|--------|-------:|-------------:|------:|
| MRR@10 | 0.526 | 0.557 | +0.031 |
| chunkRecall@5 | 68.1% | 73.6% | +5.5 pp |
| chunkRecall@10 | 76.4% | 81.9% | +5.5 pp |
| negativePass | 100% | 100% | 0 |
| rank≤3→>3 regressions | — | 0 | — |
| provider-activation MRR | 0.479 | 0.375 | −0.104 ✗ |

The gate requires no query type to drop MRR ≥ 0.030 vs hybrid. `provider-activation`
(4 queries) drops −0.104 — the v4 guard lifts `providers.md` activation-guide
chunks above the target `config-env.md` env-var chunks for activation queries.
This is a class-specific regression that aggregate MRR (+0.031) does not capture.

Result files:
- `benchmarks/retrieval/results/2026-05-15-custom150-ce-routing-mmarco-mminilmv2-l12-h384-v1.txt` (v1 guard)
- `benchmarks/retrieval/results/2026-05-16-custom150-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt` (v4 guard)

**CE routing promotion status:** benchmark-only, not promotable. See
[CE Routing Benchmark](#ce-routing-benchmark) and
[ColBERT Benchmark Plan](#colbert-benchmark-plan) for the next investigation.

```bash
BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 \
CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 CE_INPUT=text+meta \
  npm run bench:custom150:ce-routing
```

### Tier C — blind holdout (not implemented)

A sealed blind holdout set for final promotion decisions. Not yet implemented.
Queries will not overlap with custom-50 or custom-150 IDs and will not be
inspectable during development. A change must pass both custom-50 and custom-150
gates before running against Tier C. Tier C is used only for final promotion
approval, never for tuning.

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

## CE Routing Benchmark

CE routing is a benchmark-only experiment combining a deterministic query
classifier with a lexical guard on top of the mmarco cross-encoder. It is
**not production runtime code** — nothing in `src/` is modified.

**Entrypoints:**

- [`benchmarks/retrieval/custom-50/ce-routing-bench.js`](../../benchmarks/retrieval/custom-50/ce-routing-bench.js)
- [`benchmarks/retrieval/custom-150/ce-routing-bench.js`](../../benchmarks/retrieval/custom-150/ce-routing-bench.js)

**Shared benchmark-only helpers** (not imported by production code):

- `benchmarks/retrieval/lib/ce-model.js` — lazy-singleton cross-encoder loader and batch scorer
- `benchmarks/retrieval/lib/ce-routing-guards.js` — all classifier and guard variants (v1/v2/v3/v4/oracle)
- `benchmarks/retrieval/lib/ce-routing-metrics.js` — aggregate metrics, regression analysis, per-class rows
- `benchmarks/retrieval/lib/ce-routing-format.js` — formatting helpers shared across both entrypoints

**Current v4 status (guard heuristic-v4, mmarco text+meta, ONNX provider):**

- `custom-50`: gate **passes** — MRR@10 0.764, zero rank≤3 regressions, all watched queries stable. c03 recovered to hybrid rank by v4 guard.
- `custom-150`: gate **fails** — `provider-activation` type MRR drops −0.104 vs hybrid (gate blocks drops worse than −0.030). All other criteria pass: MRR lift +0.031, zero rank≤3 regressions, chunkRecall@5 +5.5 pp.

Result files:
- `benchmarks/retrieval/results/2026-05-16-custom50-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt`
- `benchmarks/retrieval/results/2026-05-16-custom150-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt`

**Ordering-loss diagnostic (v4 vs hybrid, top-3 only):**

Ordering loss = query where the correct chunk stays within top-3 but moves down from a better hybrid rank. Cause classification: `CE` = cross-encoder already demoted it before any guard; `guard` = CE was fine, guard insertion caused the demotion; `mixed` = both contributed.

`custom-50` (2 queries, total MRR loss 1.000):

| ID | Type | hybrid | v4 | Cause | Query |
|----|------|-------:|---:|-------|-------|
| c08 | exact-token | #1 | #2 | CE | як працює RRF k параметр |
| c11 | exact-token | #1 | #2 | CE | getStoredMeta які поля читає з Qdrant payload |

Both are CE-caused: CE demotes the correct `qdrant.md` chunk and puts an adjacent irrelevant chunk at rank #1. The guard cannot intervene because the correct chunk never leaves top-3. No guard-caused or mixed losses on custom-50.

`custom-150` (6 queries, total MRR loss 3.500):

| ID | Type | hybrid | v4 | Cause | MRR loss | Query |
|----|------|-------:|---:|-------|-------:|-------|
| c150-032 | exact-token | #1 | #3 | CE | 0.667 | mmrSearch dense MMR search function |
| c150-048 | source-navigation | #1 | #3 | mixed | 0.667 | where is MCP server name 'qdrant' registered |
| c150-069 | provider-activation | #1 | #3 | mixed | 0.667 | як увімкнути bge-m3-onnx для обох dense та sparse |
| c150-040 | config-env | #1 | #2 | CE | 0.500 | OLLAMA_URL default value |
| c150-042 | config-env | #1 | #2 | CE | 0.500 | MAX_CHUNK_TOKENS default range |
| c150-054 | troubleshooting | #1 | #2 | guard | 0.500 | sync записує неправильний провайдер |

Key cases:
- **c150-032**: CE puts `benchmarking.md#18` (rel=0) at rank #1; correct `project-structure.md#6` falls to #3. CE-caused — token overlap with irrelevant benchmark doc.
- **c150-069**: CE promotes `providers.md#2` (rel=2) above `config-env.md#2` (rel=3); v4 guard then inserts `providers.md#1` (rel=0) at rank #2, pushing the rel=3 chunk from CE-rank #2 to rank #3. Mixed — CE demoted first, guard displaced further.
- **c150-040 / c150-042**: CE demotes exact env-var chunks in favour of adjacent configuration prose. CE-caused exact-token demotions that the guard has no signal to catch.

**Conclusion:** 3 of 6 ordering losses on custom-150 are CE-caused (the ranker itself), not guard-caused. Further guard tuning resolves at most 1–2 losses (`mixed` cases where the guard's own insertion is the final displacement). The `provider-activation` MRR drop is partly structural — the CE model prefers instructional guides (`providers.md`) over reference env-var chunks (`config-env.md`) for activation queries, which is the wrong preference when the qrel assigns rel=3 to the env-var chunk. A stronger late-interaction ranker (ColBERT) is the logical next experiment.

**Interpreting aggregate vs class-level results:** CE routing v4 improves
aggregate MRR@10 by +0.031 and chunkRecall@5 by +5.5 pp on custom-150, yet the
gate blocks promotion. This is by design: aggregate metrics can improve while a
specific query class regresses, and that class-level regression matters more for
agent safety than the aggregate gain. custom-150 is specifically structured to
surface this — its broader class distribution catches overfitting to custom-50's
query mix. A fix that passes custom-50 and fails custom-150's class-level gate is
not promotable regardless of aggregate delta.

**Rerun variance note:** CE reranking result files may drift slightly between
reruns. Qdrant tie-breaking, CE score precision, and collection rebuilds can
shift rank positions within top-K. Treat MRR changes smaller than ±0.010 near a
gate threshold as requiring confirmation across multiple runs, not as proof of a
logic change.

See [retrieval.md — Cross-encoder reranking](retrieval.md#cross-encoder-reranking)
for the per-guard history, class-level findings, and promotion criteria.

## ColBERT Benchmark — Stage 1 Results (2026-05-16)

ColBERT late-interaction reranking was evaluated using the `colbert_vecs` head of `aapot/bge-m3-onnx` — the same model already used for dense+sparse indexing. The experiment is **benchmark-only**: no `src/` changes, no MCP runtime changes.

**Motivation:** CE routing v4 shows that part of the top-3 ordering loss is CE-caused, not guard-caused. The hypothesis was that token-level MaxSim interaction would better preserve rank-1 for exact-token and config-env queries.

**Result:** MRR@10 improves substantially over hybrid (+0.043–0.055 depending on token policy), but the promotion gate fails due to ordering-loss count = 3 on custom-50 (gate requires < 2). The losses are structural — ColBERT promotes lexically-matching but non-relevant `config-env.md` chunks above the hybrid top-1 for c05 and c32. This is a ranker-level limitation not addressable by guard iteration.

Two token policies were benchmarked (`COLBERT_TOKEN_POLICY` env):

| Metric | official | no-eos | Gate |
|--------|----------|--------|------|
| MRR@10 (colbert-top40) | 0.718 | **0.720** | ≥ 0.705 ✓ |
| Rank≤3 regressions | **1** (c36) | **0** | zero required |
| Ordering losses | **3** | **3** | < 2 required ✗ |
| Total MRR loss | 1.500 | **1.167** | — |
| p50 latency | 11 400 ms | 11 195 ms | — |
| Gate | FAILED | FAILED | — |

`official` keeps EOS(2) per released FlagEmbedding scoring code (parity reference). `no-eos` excludes EOS based on an open upstream issue — it eliminates the c36 hard regression and reduces total MRR loss, making it the better experimental policy. Both fail the gate on ordering-loss count.

**Latency:** colbert-top40 p50 ≈ 11 200 ms on CPU (~63× slower than hybrid). Not suitable for interactive use without GPU acceleration or a top-N reduction strategy.

**Stage 1 verdict: DEFER standalone ColBERT.** Next experiment, if continuing, should be a guarded/blended variant: top-1 protection, hybrid/ColBERT score blend, or trigger-only rerank. Not standalone replacement of hybrid ranking.

Result files:
- `benchmarks/retrieval/results/2026-05-16-custom50-colbert-top40-maxlen512-mean-official.txt`
- `benchmarks/retrieval/results/2026-05-17-custom50-colbert-top40-maxlen512-mean-no-eos.txt`
- Probe and full analysis: `benchmarks/retrieval/results/2026-05-16-bge-m3-colbert-head-probe.md`

Scripts: `benchmarks/retrieval/custom-50/colbert-bench.js`, `benchmarks/retrieval/lib/colbert-rerank.js`, `benchmarks/retrieval/lib/colbert-math.js`.

### Gate criteria (for reference)

| Criterion | Threshold |
|-----------|-----------|
| MRR@10 improvement vs hybrid | ≥ +0.030 |
| negativePass | 100% |
| chunkRecall@5 | ≥ hybrid baseline |
| chunkRecall@10 | ≥ hybrid baseline |
| rank≤3 → >3 regressions | zero |
| type MRR drop vs hybrid | < 0.030 for all watched classes |
| ordering-loss count | < 2 on custom-50 |

### Watched queries

- `custom-50`: c03, c08, c11, c16, c23, c36, c46
- `custom-150`: c150-032, c150-040, c150-042, c150-048, c150-054, c150-069 (not yet evaluated)

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

## Retrieval Diagnostics Conclusions

Practical guidance distilled from custom-50 diagnostics, threshold sweep, MMR
matrix, duplicate-source audit, full-text audit, and live agent review.
Source reports are linked throughout; conclusions do not duplicate their tables.

Most signal experiments below were run on the custom-50 corpus (Tier A). Where
custom-150 (Tier B) provides a confirming or contradicting data point, it is
noted. If a conclusion is custom-50-only and has not yet been validated on
custom-150, treat it as a Tier A finding pending broader confirmation.

### RRF scores are not confidence values

Hybrid RRF scores fall in a narrow band (~0.016–0.033) regardless of how well
the query matched. A score of 0.017 at rank #1 may be the only correct chunk
in the corpus. A low absolute score alone must never trigger a fallback or be
reported to the user as "low confidence."

What to use instead of score magnitude:
- rank order within the result set (rank #1 is better than rank #3)
- `source_file` and `section` — does the result come from the expected file?
- exact token overlap — do the query's identifiers appear in the chunk text?
- `context` field — does the LLM summary confirm the chunk is on-topic?
- `window=1` neighbors — is the surrounding context consistent?

See also: [retrieval.md — Interpreting Scores](retrieval.md#interpreting-scores).

### Recommended agent search defaults

From the live agent review (2026-05-12, 32 positive queries, 0 risky windows):

| Query type | Recommended call |
|------------|-----------------|
| Normal positive query | `qdrant_search(query, collection, top=3, window=1, window_format="compact")` |
| Ambiguous, negative, or scope-sensitive | `top=5`, same window settings |

`window=1, window_format="compact"` is load-bearing for ~3% of positive queries
(the case where the exact-answer chunk needs its neighbor for completeness) and
harmless for the rest. Do not disable it to save tokens — compact format already
caps neighbor snippets at ~150 chars.

Full report: `benchmarks/retrieval/results/2026-05-12-clean-live-agent-review.md`

### Trigger signals are diagnostic, not runtime rules

The search diagnostics benchmark (2026-05-10) computes observable signals
(`topScoreSpread`, `sourceDiversity`, `exactQueryTokenHits`, `technicalTokenHits`)
and evaluates whether they predict top-5 misses. Key findings:

- **`topScoreSpread`**: range is 0.001–0.017 for this corpus. The default
  `SPREAD_THRESHOLD=0.05` fires on 100% of queries and is useless as a
  discriminator. The useful range (FPR < 50%) is below 0.003 — catching only
  ~25% of misses with FPR=0%. Not a reliable standalone trigger.
- **`sourceDiversity < 2`**: fires on 2/49 queries, catches 2/8 misses, FPR=0%.
  High precision but very low recall — only useful as a secondary gate.
- **`technicalTokenHits`**: 100% hit rate on all exact-token queries in this
  corpus, so it fires on 0/49 — no discrimination.
- **No tested trigger achieves both high missRecall and low FPR** on a single run.
  Cross-validate across multiple runs before treating any threshold as reliable.

Signals flagged as "eval-only" (`hasNeighborCandidate`, `top5ContainsExpectedFile`,
`isMiss`) depend on qrels — they are not observable at runtime and must never
be used in production triggers.

Full reports:
- `benchmarks/retrieval/results/2026-05-10-custom50-diagnostics.txt`
- `benchmarks/retrieval/results/2026-05-10-custom50-threshold-sweep.txt`

### Dense MMR is deferred

Dense MMR (`mmrSearch`) is benchmark-only and not exposed in `qdrant_search`.
Measured results (2026-05-10, 21 queries):

- `ollama-mmr0.3`: Recall@1 unchanged (90.5%), dupSourceRate −11.4pp — the only
  variant where MMR is a net win.
- `onnx-mmr0.3`: Recall@1 −4.8pp at all tested diversity values. For the ONNX
  provider, hybrid RRF dominates.

The 61.9% `dupSourceRate` baseline from the technical-query corpus is not evidence
that hybrid RRF creates harmful duplicate pressure for broad queries. For
exact-token and config queries, multiple chunks from the same file are often
adjacent context the agent needs, not redundancy. For broad/exploratory queries,
hybrid RRF naturally pulls from 3–4 distinct files; predicted `dupSourceRate`
~30–50%, below the baseline.

Stage 2 runtime opt-in requires: a live broad-query `dupSourceRate` measurement
exceeding 60% for ≥3 of the 12 defined evaluation queries, confirmed agent answer
quality degradation, and onnx Recall@1 regression within a defined budget. None
of these are currently met.

Full audits:
- `benchmarks/retrieval/results/2026-05-14-mmr-mcp-opt-in-audit.md`
- `benchmarks/retrieval/results/2026-05-14-duplicate-source-pressure-audit.md`

### Full-text / literal search is deferred

BGE-M3 sparse (`bge-m3-onnx`) already handles all confirmed exact-token use
cases: custom-raw benchmark (2026-05-12) achieved **100% tokenHit@5** across
7 exact-token queries including error strings with file paths (`OOM killed at
/src/indexer.js:42`), env var assignments (`ONNX_EMBED=1`, `OVERLAP_SENTENCES=2`),
and timeout values in ms — without any payload text index.

For exact-token queries, use verbatim terms in the query string. BGE-M3 sparse
encodes technical tokens as neural lexical units and retrieves them reliably.

If using `ollama + hashed-tf` and exact literal recall is critical for raw logs
or config dumps, switch to `ONNX_EMBED=1` — hashed-TF has no IDF and may miss
rare tokens in high-noise corpora. This is a provider choice, not a missing
feature.

Adding a Qdrant payload `text` index is deferred: implementation cost is
non-trivial (large RAM-resident index, sync changes, Qdrant version sensitivity),
the benefit is narrow, and Qdrant `match: { text: "..." }` filters are still
tokenized — not true verbatim substring search.

Full audit: `benchmarks/retrieval/results/2026-05-14-full-text-literal-search-audit.md`

### Scope and ambiguity handling

From the live agent review and custom-raw scope simulations (2026-05-12):

- If a query lacks a source scope and multiple valid values coexist in the corpus
  (e.g. two different Qdrant timeout values from different source files), surface
  both values and ask the user to clarify. Do not pick rank #1 blindly.
- If the user names an exact filename or a high-confidence domain alias ("prod
  config", "incident log"), apply a `source_file` filter. When no scope is given,
  do not invent a filter.
- Scope mismatch detection is entirely agent-side — RRF scores and chunk rank do
  not suppress cross-scope results. An agent must verify that the evidence scope
  matches the query scope before answering.

Full reports:
- `benchmarks/retrieval/results/2026-05-12-custom-raw-timeout-source-filter.md`
- `benchmarks/retrieval/results/2026-05-12-custom-raw-staging-prod-scope-sentinel.md`

### Window utility

Across 32 positive queries (live agent review, 2026-05-12):

- `window=1, window_format="compact"` is load-bearing in ~3% of queries (the
  case where the exact-answer chunk needs its neighbor for completeness).
- USEFUL_CONTEXT (neighbor adds helpful adjacent detail): ~54% of queries.
- HARMLESS_FILLER (neighbor is an anchor-only or section-header chunk): ~38%,
  concentrated in custom-large fixture docs.
- RISKY_CONTEXT (neighbor introduces conflicting or misleading content): 0/32.

Compact format keeps neighbor snippets short (~150 chars) and includes stored
metadata, making window filler safe. Do not disable `window=1` to save tokens —
the format is already optimised for this.

Full reports:
- `benchmarks/retrieval/results/2026-05-12-positive-compact-window-smoke.md`
- `benchmarks/retrieval/results/2026-05-12-expanded-window-utility-audit.md`

## Current Role

The regression benchmark catches quality regressions when changing chunking,
providers, sparse vectors, Qdrant schema, RRF settings, reranking, or MCP search
behavior. It is not a scientific corpus evaluation.

The **custom-50 (Tier A)** benchmark is the primary tuning and dev-regression
harness. Use it when making changes that could affect chunk-level retrieval
precision — provider switches, embedding schema changes, RRF/MMR parameter
tuning, or reranking guard iteration. Per-query analysis and guard tuning against
specific query IDs is acceptable here.

The **custom-150 (Tier B)** benchmark is the class-level confirmation layer.
Run it after custom-50 validates a change, to check whether improvements
generalise across the broader and harder query set. A change that passes custom-50
but fails custom-150's class-level gate (MRR drop ≥ 0.030 for any watched type)
is not promotable. The baseline here is 0.508 MRR@10 / 68.1% chunkRecall@5
(hybrid ONNX, 2026-05-15, 75 queries).

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
