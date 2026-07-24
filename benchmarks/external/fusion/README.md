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

## Live RRF-k sweep (`rrf-sweep-config.mjs` / `run-rrf-sweep.mjs`)

`analyze-fusion.mjs` above is strictly offline and only ever analyzes
`hybrid_k*` TREC files that some earlier live benchmark already produced —
it has no `hybrid_k1`/`hybrid_k5`/`hybrid_k10`/`hybrid_k30` data to analyze
because no prior benchmark ran Qdrant at those k values.

`run-rrf-sweep.mjs` is the **live** counterpart that closes that gap: it
issues real Qdrant hybrid queries (prefetch=200/lane, final limit 100) at
k = `[1, 2, 5, 10, 30, 60]` across four strictly separate scopes —
`scifact-local`, `scifact-cloud`, `miracl-local`, `miracl-cloud` — each
using the same locked 100-query/1000-document subsets the earlier BEIR/
MIRACL benchmarks used (`loadCachedMiniSet()` / `loadCachedMiraclSubset()`,
never fetched or rebuilt — throws an actionable error if the required cache
is missing).

Per scope: **one** collection, **one** indexing pass, then per query one
dense-only query, one sparse-only query, and **six** hybrid queries (one
per sweep k) sharing the exact same prefetch specification — never one
collection per k. Scopes run strictly sequentially, never concurrently.

```bash
# Tests only, sequential (required — never run npm test in unbounded
# parallel mode for this module):
node --test --test-concurrency=1 benchmarks/external/fusion/run-rrf-sweep.test.mjs

# Tiny plumbing smoke (1 scope, 2 queries, 8 docs, still all 6 k values;
# writes to a separate .rrf-sweep-smoke-report.json, never the real report):
node benchmarks/external/fusion/run-rrf-sweep.mjs --smoke

# Full 4-scope sweep (requires QDRANT_URL/QDRANT_KEY; not started
# automatically by any task in this repo — run explicitly after reviewing
# the smoke result):
node benchmarks/external/fusion/run-rrf-sweep.mjs

# Resume an interrupted run / restart from scratch / check resume state
# without running anything / run a subset of scopes:
node benchmarks/external/fusion/run-rrf-sweep.mjs --resume
node benchmarks/external/fusion/run-rrf-sweep.mjs --restart
node benchmarks/external/fusion/run-rrf-sweep.mjs --resume-check
node benchmarks/external/fusion/run-rrf-sweep.mjs --scopes=scifact-local,miracl-cloud
```

Output: `benchmarks/external/results/2026-07-23-rrf-k-sweep.json` (full
checkpoint/report) and `.md` (rendered report), plus per-scope TREC runs
under `benchmarks/external/fusion/.runs/`. The report also compares the new
run's k=2/k=60 rows against the previously committed BEIR/MIRACL
provider-comparison reports (exact deltas, never overwriting the prior
files) — local drift should be investigated, cloud drift may reflect
hosted-model/service changes on Qdrant's side and is reported as a fact,
not silently treated as equivalent to the prior run.

This exploratory sweep does not by itself justify changing the production
`RRF_K` default or disabling sparse globally, and no single k should be
called a universal winner merely because it has the largest aggregate
average on one or two scopes.

## Offline weighted-RRF candidate analysis (`analyze-weighted-rrf.mjs`)

Narrows weighted-RRF configurations using ONLY already-completed TREC runs
from the BEIR SciFact, MIRACL Russian, and Slavic Belebele benchmarks —
**strictly offline**: no Qdrant queries, no ONNX models, no collections
created or deleted. This is the step before any new live Qdrant benchmark,
not a substitute for one.

### Qdrant's real weighted-RRF formula

Qdrant 1.17+ (this project: server 1.17.1, `@qdrant/js-client-rest`
1.18.0) computes a document's per-lane weighted-RRF contribution as:

```
contribution(rank, weight, k) = 1 / (k + (rank + 1) / weight - 1)
```

with `rank` ZERO-BASED, passed via `query: { rrf: { k, weights:
[denseWeight, sparseWeight] } }` — **never** `prefetch.weight` (no such
field exists) and never approximated with `FormulaQuery` (which sees raw
prefetch scores, not prefetch ranks — not a substitute for rank fusion).
The naive `weight / (k + rank)` formula is explicitly wrong and is never
used here.

Because `k` dominates the denominator at large k, a raw weight change
barely moves the top-rank contribution at k=60 while the same raw weight
change is dramatic at k=2 — see `weightedRrfContribution()`'s own doc
comment for the exact reasoning. This is why configurations are
parametrized by a **target rank-1 contribution ratio `rho`** (sparse vs
dense contribution at the very first rank), converted to the actual
per-k Qdrant weight via `sparseWeightFromRho()`, rather than sweeping raw
weight values that would mean incomparable things at different k.

### Scope and required evaluation scopes

`scifact_local` (SciFact full 300-query test split), `miracl_local`
(MIRACL Russian 100-query pooled subset — already inspected in prior
tasks, treated as diagnostic/validation evidence, never a blind holdout),
and 7 `belebele_{lang}` scopes (`ukr_Cyrl`, `rus_Cyrl`, `bul_Cyrl`,
`pol_Latn`, `ces_Latn`, `slk_Latn`, `eng_Latn`). Only local BGE-M3 TREC
runs are read — Qdrant Cloud E5/BM25 runs are never mixed in.

### Parity validation — read this before trusting the numbers

Before evaluating weighted configurations, the analyzer reconstructs equal
RRF (`weights=[1,1]`) offline and compares it against the REAL Qdrant
hybrid TREC run for the same scope/k, where one exists. **In the run that
produced the committed report, EVERY available parity check failed the
faithfulness threshold** — 15-30% of queries showed a different top-10
ranking than the real Qdrant run, even though aggregate nDCG@10 differed
by only ~0.001-0.02. The most likely cause: saved dense/sparse TREC lanes
are capped at top-100 per query, while real Qdrant hybrid queries use
prefetch limit 200 per lane. This means the offline weighted-RRF numbers
in the report are **directional evidence for narrowing candidates, not a
precise prediction** of what a live Qdrant weighted-RRF query will score —
this analyzer never claims exact simulation, and the report says so
explicitly in its own "Limitations" section, computed from the actual
measured parity result, not hardcoded.

### Candidate selection

Rule-based, never subjective. **`selectCandidates()` requires
`scopeResults` to cover the EXACT required scope set** (`scifact_local`,
`miracl_local`, all 7 `belebele_*` — no more, no fewer); a partial or
extended scope set can never demonstrate "no significant regression
anywhere" for scopes it never saw, so it always returns
`NO_WEIGHTED_RRF_CANDIDATE` rather than silently evaluating "safe
everywhere" over whatever subset happened to be passed in. Both candidate
slots additionally require a config to be **confirmed safe on every one of
those scopes** — a scope/config pair with no bootstrap result at all is
treated as NOT confirmed safe, never as passing by default:

- **dense-heavy**: among the safe-everywhere configs with a positive
  SciFact benefit, picks the **smallest rho** (least sparse influence) —
  "dense-heavy" means minimal sparse contribution, not merely "happened to
  avoid harm."
- **balanced/quality**: among the same safe-everywhere set, picks the
  config with the best cross-dataset macro nDCG@10 — requiring a **finite
  nDCG@10 in every required scope**, never a partial average over
  whichever scopes happened to have data (a config missing a metric for
  even one scope is disqualified from this slot entirely, not silently
  scored on fewer scopes).
- **dense-heavy and balanced are never the same config.** If the single
  best balanced/quality pick is identical to dense-heavy, the analyzer
  falls through to the next-best DISTINCT eligible config; if none exists,
  `balancedCandidate` is `null` and the report explains why, rather than
  printing the same `query.rrf.weights` payload twice under two headings
  — a live benchmark must never be asked to run the identical
  configuration twice.
- **equal RRF** is always included as a control (never a recommendation).

If no weighted configuration satisfies either rule (or the scope set is
incomplete), the verdict is `NO_WEIGHTED_RRF_CANDIDATE` — a winner is
never forced.

Two things a prior version of this rule got wrong, both fixed:

1. It only checked Belebele for the dense-heavy slot, which let a config
   with a confirmed statistically significant MIRACL regression
   (`k2_rho0.75`, meanΔ≈-0.033 nDCG@10, CI excludes zero) be selected and
   labeled "dense-heavy." MIRACL is now included in the eligibility gate
   for both slots.
2. It evaluated `safeEverywhere()` only over whatever `scopeResults` was
   actually passed in, with no check that the full required scope set was
   present — a caller bug or future refactor could have silently produced
   a candidate that was never checked against MIRACL or Belebele at all.
   Fixed with the exact-scope-set requirement described above. In the
   current committed report, this rule set means only `k2_rho0.10` is
   confirmed safe across all 9 scopes; `denseHeavyCandidate` is
   `k2_rho0.10` and `balancedCandidate` is `null` (it would have collided
   with dense-heavy, and no distinct alternative was eligible).

Two further things a later version got wrong, both also fixed:

3. `balancedCollidedWithDenseHeavy` was computed by checking whether
   `denseHeavy` appeared **anywhere** in the macro-quality-sorted eligible
   list for the balanced slot, not only at rank 0. Since dense-heavy is
   chosen by a completely different rule (smallest safe rho, not best
   macro nDCG@10), it can legitimately be "safe everywhere" — and thus
   present in that list — without ever being the actual top-ranked
   balanced pick. That made the flag (and the report text built from it)
   falsely claim a collision in cases where the real best balanced
   candidate never involved dense-heavy at all. Fixed to check only
   `balancedEligible[0]?.configId === denseHeavy` — whether the single
   best balanced pick, specifically, was dense-heavy.
4. The exact-scope-set check compared only the deduplicated ID `Set`
   sizes/membership, so a `scopeResults` array containing a duplicated
   scope entry (e.g. `scifact_local` listed twice — 10 entries but only 9
   unique ids) passed validation and silently double-weighted that scope
   in `macroQuality()`'s average. Fixed by also requiring
   `scopeResults.length === SCOPE_IDS.length`.

In the current committed report, neither fix changes the printed
candidates: the real `denseHeavy`/`balanced` collision genuinely does
happen at rank 0 (`k2_rho0.10` is both the dense-heavy pick and the top of
`balancedEligible`), and the real `main()` run never supplies a duplicated
scope entry.

### A known limitation: no held-out validation split

The same SciFact/MIRACL/Belebele scopes used to SELECT these candidate
weights are also used to EVALUATE them — there is no train/validation
split. A future live Qdrant run on these scopes will confirm whether the
offline reconstruction matches real Qdrant behavior, but it will **not**
confirm that the selected weights generalize beyond this exact eval set.
Per Qdrant's own tuning guidance, weights should ideally be tuned on one
part of an eval set and confirmed on a separate, untouched holdout before
being treated as validated — this analyzer does not yet do that.

### Running

```bash
# Tests only, sequential (required):
node --test --test-concurrency=1 benchmarks/external/fusion/analyze-weighted-rrf.test.mjs

# Run the analyzer (strictly offline; no flags needed, though --expose-gc
# helps keep peak RSS well under the ~512 MiB target across all 9 scopes —
# see the report's own peak-RSS figure for the exact number of that run):
node benchmarks/external/fusion/analyze-weighted-rrf.mjs
```

Output: `benchmarks/external/results/2026-07-23-weighted-rrf-offline-analysis.json`
and `.md`.

> This offline analysis narrows candidates only. Final acceptance requires
> real Qdrant 1.17+ weighted-RRF queries using `query.rrf.weights`.

## Live weighted-RRF validation (`weighted-rrf-live-config.mjs` / `run-weighted-rrf-live.mjs`)

The offline analyzer above reconstructs fusion from saved top-100 lane
files; real Qdrant hybrid requests use prefetch=200/lane. Its output is
candidate selection only, never validation. `run-weighted-rrf-live.mjs` is
the live counterpart that validates the offline analyzer's selected
primary candidate (`k2_rho0.10`, k=2, `weights=[1.0, 0.05263157894736842]`)
against **real** Qdrant 1.17+ weighted-RRF queries — the exact
`query: { rrf: { k, weights: [dense, sparse] } }` contract, never
`prefetch.weight`, never a local rank reconstruction.

This is not another RRF-k sweep (see `run-rrf-sweep.mjs` above) and not
another offline reconstruction — it answers four questions with real
execution: does the primary candidate remove/reduce the MIRACL regression
the completed CUDA k-sweep observed under equal-weight hybrid; does it
preserve useful sparse contribution where sparse helps; does it preserve
SciFact quality vs dense-only and equal hybrid; and do the offline
weighted-RRF conclusions agree with real Qdrant execution.

Reuses the exact same four scopes and cached 100-query/1000-document
subsets as the completed live RRF-k sweep (`scifact-local`,
`scifact-cloud`, `miracl-local`, `miracl-cloud` —
`loadCachedMiniSet()` / `loadCachedMiraclSubset()`, never fetched or
rebuilt). Every scope runs all six fusion modes, in this fixed order:
`dense`, `sparse`, `equal_k2` (k=2, weights=[1,1] — Qdrant's own default
weights), `equal_k60` (k=60, weights=[1,1] — Semidex's own production RRF
k), `k2_rho0.10` (the offline primary dense-heavy candidate), and
`k2_rho0.25` (a diagnostic neighbor — never promoted to primary merely for
winning one scope).

Per scope: **one** collection, **one** indexing pass, then per query dense
and sparse query vectors are computed **once** and reused for all six
modes — the four hybrid modes share the identical prefetch spec (same
vectors, prefetch=200/lane), differing only in `query.rrf.k`/`weights`.
Scopes run strictly sequentially, never concurrently.

### Strict CUDA for local scopes

Local scopes (`scifact-local`, `miracl-local`) in a full benchmark must run under strict CUDA
(`ONNX_EXECUTION_PROVIDER=cuda ONNX_CUDA_STRICT=1` in the environment —
the harness reads this, it never sets it itself, and never hardcodes a
user-specific ONNX Runtime path). `core/onnx-embed.js` now exports
`getOnnxProviderState()`, which records the requested vs. **effective**
execution provider from the most recent session load — the harness reads
this after the first local embedding call and rejects the scope
(`cudaVerification.ok: false`, which also fails the harness verdict) if
CUDA was requested but the effective provider was not CUDA (e.g. a silent
CPU fallback). This closes a real gap: the earlier CUDA k-sweep report
(`2026-07-24-rrf-k-sweep-cuda.md`) recorded only the *requested* provider
(`onnxExecutionProviderRequested`), with no verification that CUDA was
actually what ran. Cloud scopes report ONNX provenance as `null`/not
applicable — Qdrant Cloud Inference embeds server-side.

Smoke mode is provider-agnostic plumbing only: it may run on CPU and never
produces a scientific candidate verdict or CUDA performance evidence.

### Decision rules

`computeVerdict()` is harness-integrity only (did every scope run to
completion with valid metrics, clean cleanup, and — for local scopes —
verified CUDA provenance). `computeCandidateVerdict()` is the separate
scientific question, applied only once the harness itself is technically
sound:

- **`WEIGHTED_RRF_ACCEPT`** requires ALL of: no statistically significant
  nDCG@10 regression vs dense on either MIRACL scope; a **material**
  reduction of the equal-RRF MIRACL regression (the candidate's meanΔ vs
  dense must be at least 0.02 nDCG@10 better than the better
  (less-regressed) of the two equal-RRF controls' own meanΔ vs dense, on
  every MIRACL scope); no
  statistically significant regression vs dense on SciFact; and the
  harness verdict itself is an ACCEPT.
- **`WEIGHTED_RRF_MIXED`** when the harness passed but the candidate's own
  evidence is inconclusive: the regression-reduction margin isn't met,
  local/cloud diverge in direction on the same dataset, or only one
  dataset type is present in the scopes run.
- **`WEIGHTED_RRF_REJECT`** when the candidate is statistically
  significantly worse than dense on MIRACL or SciFact, or when the harness
  itself did not complete cleanly (live results cannot validate an offline
  candidate if the harness didn't actually finish).

MIRACL already influenced the offline candidate selection this run
validates — an ACCEPT verdict is validation/diagnostic evidence, never a
blind confirmatory holdout, and the primary candidate is never called
globally optimal or used to justify a production default change on the
strength of this report alone.

```bash
# Tests only, sequential (required):
node --test --test-concurrency=1 benchmarks/external/fusion/run-weighted-rrf-live.test.mjs

# Tiny plumbing smoke (1 scope, 2 queries, 8 docs, still all 6 fusion
# modes; writes to a separate .weighted-rrf-live-smoke-report.json, never
# the real report):
node benchmarks/external/fusion/run-weighted-rrf-live.mjs --smoke

# Full 4-scope validation (requires QDRANT_URL/QDRANT_KEY; for local
# scopes, set ONNX_EXECUTION_PROVIDER=cuda and ONNX_CUDA_STRICT=1 in the
# environment first — the harness rejects a local scope that silently
# fell back to CPU. Not started automatically by any task in this repo —
# run explicitly after reviewing the smoke result):
node benchmarks/external/fusion/run-weighted-rrf-live.mjs

# Resume an interrupted run / restart from scratch / check resume state
# without running anything / run a subset of scopes:
node benchmarks/external/fusion/run-weighted-rrf-live.mjs --resume
node benchmarks/external/fusion/run-weighted-rrf-live.mjs --restart
node benchmarks/external/fusion/run-weighted-rrf-live.mjs --resume-check
node benchmarks/external/fusion/run-weighted-rrf-live.mjs --scopes=scifact-local,miracl-cloud
```

Output: `benchmarks/external/results/2026-07-24-weighted-rrf-live.json`
(full checkpoint/report) and `.md` (rendered report), plus per-scope TREC
runs under `benchmarks/external/fusion/.runs-weighted-rrf-live/`.

> This live validation is the required real-Qdrant confirmation step for
> the offline analyzer's selected candidate. It does not by itself
> establish the candidate as a production default — see "Decision rules"
> above for exactly what an ACCEPT verdict does and does not claim.
