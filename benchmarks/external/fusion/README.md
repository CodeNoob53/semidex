# Cross-dataset fusion diagnosis — BEIR SciFact vs MIRACL Russian

This directory holds an **offline diagnostic analysis** of hybrid (RRF)
fusion behavior across the already-completed BEIR SciFact and MIRACL
Russian benchmark runs. It does not run any new benchmark, does not touch
ONNX or Qdrant, and does not make any network request — it only reads
already-written TREC run files and already-committed JSON reports.

Goal: explain **when sparse retrieval helps, when it damages dense
rankings, and why hybrid behavior differs between datasets/providers** —
not to recommend a production fusion default.

## Strictly offline, by construction

- No ONNX, no Qdrant, no network, no indexing, no background processes.
- Every loader this module calls
  (`loadDataset()`/`validateDataset()` from `../beir/fetch-scifact.mjs`,
  `loadCachedMiniSet()` from `../beir/build-rrf-mini-set.mjs`,
  `loadCachedMiraclSubset()` from `../miracl/build-miracl-subset.mjs`)
  reads **only** already-written local cache files and never falls back to
  fetching. `loadCachedMiniSet()`/`loadCachedMiraclSubset()` were added
  specifically for this task — the pre-existing
  `buildAndCacheMiniSet()`/`buildAndCacheMiraclSubset()` always call their
  dataset's fetch-and-validate function first (a network call in
  principle, even though it is a no-op when a valid local cache already
  satisfies it), so this analyzer uses the strictly-offline variants
  instead.
- `analyze-fusion.test.mjs` proves this directly: it replaces
  `global.fetch` with a function that throws on every call and confirms
  every scope still loads and analyzes correctly.
- If a required cache file (dataset extraction, mini-set cache, MIRACL
  subset cache, or a `.trec` run file) is missing, the analyzer throws a
  clear, actionable error telling you to run the original BEIR/MIRACL
  harness online first — it never silently rebuilds or fetches.

## Why this analyzes only ACTUAL Qdrant hybrid runs — no local RRF replay

The saved dense/sparse TREC lane files are capped at **top-100** results
per query. The real Qdrant hybrid requests that produced the committed
`hybrid_k2`/`hybrid_k60` TREC files used **prefetch limit 200** per lane.
Reconstructing an arbitrary RRF `k` locally from the saved top-100 lane
files would therefore operate on an incomplete candidate pool and could
never be presented as equivalent to a real Qdrant hybrid result.

**This analyzer contains no such replay.** It only ever analyzes a
`hybrid_k*` TREC file that was itself written by a live Qdrant hybrid
query during the original BEIR/MIRACL benchmark run. A scope simply has no
`hybrid_k2` entry if that combination was never actually run against
Qdrant (e.g. BEIR's full local profile only ever ran hybrid at `k=60` —
see `../beir/profiles.mjs`) — the analyzer never fills that gap with a
locally-reconstructed approximation.

## Files

| File | Purpose |
|---|---|
| `analyze-fusion.mjs` | The analyzer: strict TREC validation (including a raw-line pre-check that catches malformed/truncated rows `parseTrecRun()` would otherwise silently drop — see below), per-scope aggregate metrics (reusing `../beir/metrics.mjs`), paired bootstrap comparisons (reusing `../miracl/bootstrap.mjs`), dense/sparse overlap, relevant-document overlap, rescue/harm classification with rank movement, the oracle upper bound, representative-case selection, and the overall descriptive verdict. |
| `analyze-fusion.test.mjs` | Targeted `node:test` suite — pure-function unit tests plus live, offline, real-data integration tests against the actual committed BEIR/MIRACL runs. |

Reused, not duplicated:

- `parseTrecRun()` from `../beir/build-rrf-mini-set.mjs` (TREC parsing).
- `computeMetrics()`, `ndcgAtK()` from `../beir/metrics.mjs` (aggregate and
  per-query metrics — the exact same formulas the original benchmarks
  used, so recomputed numbers are directly comparable, not a second
  implementation that could silently diverge).
- `pairedBootstrap()`, `perQueryMetrics()` from `../miracl/bootstrap.mjs`
  (the same deterministic, seeded paired bootstrap the MIRACL harness
  already validated).
- `loadDataset()`/`validateDataset()` from `../beir/fetch-scifact.mjs` for
  the full 300-query BEIR qrels.
- `loadCachedMiniSet()` (new, offline-only) from
  `../beir/build-rrf-mini-set.mjs` for the 100-query BEIR mini-set qrels.
- `loadCachedMiraclSubset()` (new, offline-only) from
  `../miracl/build-miracl-subset.mjs` for the 100-query MIRACL pooled
  subset qrels.

No Qdrant client, retry, redaction, or ID-mapping code is duplicated here
— none of it is needed for offline analysis.

## Scopes analyzed (kept strictly separate, never merged)

| Scope ID | Description | Query count | Modes present |
|---|---|---:|---|
| `beir_full_local` | SciFact full test split — local BGE-M3, common-512 | 300 | dense, sparse, hybrid_k60 |
| `beir_full_cloud` | SciFact full test split — Qdrant Cloud E5+BM25, common-512 | 300 | dense, sparse, hybrid_k2, hybrid_k60 |
| `beir_mini_local` | SciFact **LOCAL MINI** pooled subset — **not** full SciFact | 100 | dense, sparse, hybrid_k2, hybrid_k60 |
| `miracl_local` | MIRACL Russian pooled subset — local BGE-M3 | 100 | dense, sparse, hybrid_k2, hybrid_k60 |
| `miracl_cloud` | MIRACL Russian pooled subset — Qdrant Cloud E5+BM25 | 100 | dense, sparse, hybrid_k2, hybrid_k60 |

`beir_full_local` has no `hybrid_k2` entry because the full BEIR harness
never ran the local profile at `k=2` (only the mini-set did) — this is a
gap in what was measured, not a gap this analyzer fills in.

## What each scope's analysis contains

- **Strict TREC validation**: every `.trec` file is checked TWICE before
  its metrics are trusted. First, `strictCheckRawTrecLines()` scans the
  raw text and throws on any non-blank line that does not have exactly 6
  whitespace-separated fields — this exists specifically because
  `parseTrecRun()` (reused from `../beir/build-rrf-mini-set.mjs`, written
  for the benchmark runners where silently tolerating a stray malformed
  line is acceptable) SILENTLY DROPS any such line, which would otherwise
  let a truncated/corrupted run pass "validation" with fewer rows than it
  should have and no error at all. Second, `validateTrecRun()` checks the
  now-trusted parsed structure: positive unique ranks per query, no
  duplicate doc IDs per query, and the query ID set matching the scope's
  benchmark contract exactly (no missing or unexpected query).
- **Aggregate metrics** per mode: nDCG@10 (primary), MAP@100, Recall@10/100,
  Precision@10, MRR@10 — recomputed fresh from the TREC files and checked
  against the committed JSON reports within a `1e-6` floating-point
  tolerance (`assertMetricParity()`).
- **Paired bootstrap comparisons**: dense vs sparse, each hybrid vs dense,
  each hybrid vs sparse, and k=2 vs k=60 (when both exist) — reusing the
  MIRACL harness's own deterministic seeded bootstrap. A configuration is
  only ever called "better" when the 95% CI excludes zero. Every
  comparison is built as `pairedBootstrap(<baseline>, <comparison>)` so
  `meanDelta` always reads as "`<comparison>` minus `<baseline>`",
  matching the comparison's own key name (e.g. `comparisons.k2_vs_k60
  .meanDelta` is `k2 − k60`, not `k60 − k2` — argument order is checked
  directly by a dedicated sign-direction test suite in
  `analyze-fusion.test.mjs`).
- **Dense/sparse overlap**: mean top-10 and top-100 fractional overlap
  between the dense and sparse ranked lists.
- **Relevant-document overlap**: for every qrels-positive passage, whether
  it appears in dense's top-10, sparse's top-10, both, or neither —
  aggregated as `denseOnlyHits` / `sparseOnlyHits` / `bothHits` /
  `neitherHits` across the whole scope. **These counts are relevant
  document–query pairs, not query counts** — a query with 3 qrels-positive
  passages can contribute up to 3 to a scope's totals, so e.g. "1
  `sparseOnlyHits`" on a 100-query scope means 1 of that scope's total
  relevant document–query pairs (which can be in the hundreds), not "1 of
  100 queries."
- **Rescue/harm classification**: per query, per observed hybrid mode,
  whether hybrid's nDCG@10 exceeds dense's (`rescue`), falls short
  (`harm`), or ties — with the best-ranked relevant document's rank in
  both dense and hybrid, so a representative case shows real rank
  movement, never passage text.
- **Oracle max(dense, sparse) nDCG@10`**: an **upper-bound diagnostic
  only** — the query-by-query best of the two channels, which no real
  fusion policy can achieve without knowing in advance which channel will
  win per query. Never presented as an achievable target.

### A note on "sparse" across profiles

The **local** profile's sparse lane is BGE-M3's own learned lexical
weights (`src/core/onnx-embed.js`) — a neural term-importance model, not
classic BM25. The **cloud** profile's sparse lane is Qdrant's server-side
`qdrant/bm25` — genuine BM25 term-frequency scoring. Both are labeled
`sparse` in this analyzer's mode names for consistency with the original
benchmark harnesses' own terminology, but they are different algorithms
with different failure modes — the final report is careful to attribute
observations to the specific profile/algorithm they were measured on,
never to "sparse" or "BM25" generically across both.

## Running

```bash
# Requires the BEIR SciFact dataset cache, the BEIR local mini-set cache,
# and the MIRACL pooled-subset cache to already exist locally (produced by
# running the original benchmarks online at least once). No network call
# is made by this script itself.
node benchmarks/external/fusion/analyze-fusion.mjs

# Tests only, sequential (never parallel — this task's explicit
# constraint):
node --test --test-concurrency=1 benchmarks/external/fusion/analyze-fusion.test.mjs
```

## Report

`benchmarks/external/results/2026-07-22-cross-dataset-fusion-diagnosis.md`
answers, with FACT/HYPOTHESIS labeling throughout:

1. Why hybrid helped or remained useful on SciFact.
2. Why dense beat hybrid on MIRACL.
3. Whether `k=2` is consistently better than `k=60`.
4. Whether sparse should stay enabled by default.
5. What exact additional evidence is required before changing production
   fusion.

## Verdict vocabulary

This is a **descriptive diagnosis**, not an ACCEPT/REJECT gate for a
production default:

- `FUSION_COMPLEMENTARY` — every bootstrap-significant hybrid-vs-dense
  comparison across scopes favors hybrid.
- `FUSION_SPARSE_DEGRADES` — every bootstrap-significant comparison favors
  dense over hybrid.
- `FUSION_DATASET_DEPENDENT` — different scopes disagree in direction
  (this is the actually-observed pattern: SciFact favors hybrid, MIRACL
  favors dense).
- `FUSION_ANALYSIS_INCONCLUSIVE` — not enough bootstrap-significant
  evidence in either direction.

The verdict is computed from **both** aggregate rescue/harm counts and
paired bootstrap significance — never from raw deltas alone. **This task
does not recommend changing the production `RRF_K` default**; see the
report's final section for what additional evidence that would require.
