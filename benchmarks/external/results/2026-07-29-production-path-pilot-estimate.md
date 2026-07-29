# Production-path benchmark — pilot results and full-run estimate

Date: 2026-07-29
Harness: `benchmarks/external/production-path/` (Task B)
Pilot: `node benchmarks/external/production-path/run-scifact-prodpath.mjs --pilot --restart`

## Context

This pilot re-run follows the profile-aware token-budget chunking fix
(Task C). The prior pilot run (pre-fix) crashed the Cloud profile with
`EmbeddingInputTooLongError`: a SciFact document's prose chunk passed the
chunker's heuristic `MAX_CHUNK_TOKENS=512` check but the real E5 tokenizer
counted it at 599 tokens. The fix threads the active embedding profile's
real tokenizer through all retrieval chunking (not just structural
entities), with a hard per-chunk invariant, a `Math.min(configured,
model window)` ceiling, and a new `INDEXING_SCHEMA_VERSION_PROFILE_BUDGET
= 6` schema bump so previously-indexed cloud collections are detected as
stale and reindexed.

**This pilot uses the exact unchanged 150-document/25-query SciFact
subset that triggered the original crash** — same seed
(`semidex-prodpath-scifact-pilot-v1`), same corpus, same queries, same
qrels. Run from a fresh collection (`--restart`), since the schema-version
bump means this is not a resume of the pre-fix crashed run.

## Pilot result: COMPLETE (both profiles)

| | Local (BGE-M3 ONNX) | Semidex Lite (Qdrant Cloud, E5-small) |
|---|---|---|
| Verdict | COMPLETE | COMPLETE |
| Documents indexed | 150 / 150 | 150 / 150 |
| Indexing errors | 0 | 0 (previously crashed here — now 0) |
| Indexing exit code | 0 | 0 |
| Unmapped hits | 0 | 0 |
| Query errors | 0 | 0 |
| Cleanup | deleted | deleted |
| Indexing time | 158.5 s (150 docs) | 114.2 s (150 docs) |
| Query latency (p50 / p95) | 431.6 ms / 508.4 ms | 523.1 ms / 699.1 ms |
| nDCG@10 | 0.9368 | 0.9252 |
| Recall@10 / @100 | 1.0 / 1.0 | 1.0 / 1.0 |

**The document that previously crashed the Cloud profile now indexes
successfully** — its oversized prose chunk is split into multiple
budget-fitting fragments by the fix, content preserved, no truncation.

Bootstrap comparison (Local vs Cloud, paired by query, 2000 iterations):
nDCG@10 and MAP@100 deltas are small and statistically **inconclusive/
mixed** (CI includes zero) at this pilot's n=25 — expected at this sample
size; the full run's n=300 queries will narrow this.

Retrieval-quality metrics (nDCG/MAP/Recall/MRR) are essentially
unaffected by the chunking fix itself — Local's numbers are unchanged
(budget=null path is byte-identical to before), and Cloud's numbers now
reflect a *complete* run instead of a crash, which is the entire point.

## Real Cloud Inference volume (from opt-in telemetry, not estimated)

Measured directly via `SEMIDEX_BENCH_TELEMETRY_PATH` on this pilot run:

| | Indexing (150 docs) | Query (25 queries) |
|---|---|---|
| Dense inference items | 474 | 25 |
| Sparse inference items | 474 | 25 |
| Dense chars | 270,670 | (not itemized above) |
| Sparse chars | 270,670 | |

→ **3.16 dense + 3.16 sparse inference items per document** (this ratio
now includes the fix's prose splitting — a document containing dense/
technical prose can require more than 1 chunk-pair, exactly the class of
document that used to crash), **1 dense + 1 sparse item per query**
(unchanged — one hybrid query still issues exactly one dense + one sparse
descriptor).

Qdrant SDK operations: 764 total for 150 docs + 25 queries (≈5.09 ops/doc,
dominated by scroll/upsert/deleteTrailingChunks — indexing-phase
operations, not cloud-inference-billed).

## Full-run estimate (extrapolated from this pilot's measured rates)

Linear extrapolation from real measured per-document indexing time and
real per-document/per-query Cloud Inference item counts. Local's ONNX
model-load overhead is a one-time fixed cost already amortized across the
pilot's 150 docs, so this is a conservative (slightly high) estimate for
Local at full scale.

| Suite | Docs | Queries | Local indexing (est.) | Cloud indexing (est.) | Cloud dense items (indexing) | Cloud dense items (query) |
|---|---|---|---|---|---|---|
| SciFact (full) | 5,183 | 300 | ~91 min | ~66 min | ~16,378 | 300 |
| MIRACL Russian (pooled subset) | 1,000 | 100 | ~18 min | ~13 min | ~3,160 | 100 |
| Slavic (7 languages) | 3,416 | 6,300 | ~60 min | ~43 min | ~10,795 | 6,300 |
| Structural fixture | 4 | 3 | <1 min | <1 min | ~13 | 3 |
| **Total** | **9,603** | **6,703** | **~170 min (~2.8 h)** | **~123 min (~2.1 h)** | **~30,346** | **~6,703** |

Sparse inference items mirror the dense counts (1:1 ratio observed
throughout). `qdrantSdkOps` scales roughly linearly with document/query
count at ~5.09 ops/doc + ~1 op/query (both profiles pay this — it's
Qdrant SDK traffic, not cloud-billed inference).

**Total wall time estimate (both profiles, sequential per suite, four
suites): ~5 hours.** This is indexing time only; query time is small by
comparison (hundreds of ms × ~6,700 queries ≈ tens of minutes total,
already reflected in "Cloud indexing" being end-to-end suite time in the
table above — indexing dominates).

## Proposed full-run command (NOT executed — requires explicit approval)

```
node benchmarks/external/production-path/run-all.mjs
```

This runs all four suites sequentially (SciFact → MIRACL Russian →
Slavic → Structural), each suite running Local then Cloud, with the
orphan-collection sweep at the start of each suite invocation and
unconditional per-profile cleanup. Estimated total wall time: **~5
hours**. Estimated Cloud Inference volume: **~30,346 dense + ~30,346
sparse indexing items, ~6,703 dense + ~6,703 sparse query items** (real
descriptor counts, billed by Qdrant Cloud per its own inference pricing —
this harness does not compute a dollar cost, only descriptor/item
counts).

Per-suite alternative (if a partial/staged run is preferred):

```
node benchmarks/external/production-path/run-scifact-prodpath.mjs      # ~157 min total (both profiles)
node benchmarks/external/production-path/run-miracl-ru-prodpath.mjs    # ~31 min total
node benchmarks/external/production-path/run-slavic-prodpath.mjs       # ~103 min total
node benchmarks/external/production-path/run-structural-prodpath.mjs   # <2 min total
```

Each supports `--resume`/`--resume-check`/`--restart`. No commit is
implied by running this — the harness's own collections are prefix-scoped
and disposable (`semidex-prodpath-bench-*`), cleaned up unconditionally
after each profile run, with an orphan sweep at the start of every suite
invocation as the safety net for a hard-killed prior run.
