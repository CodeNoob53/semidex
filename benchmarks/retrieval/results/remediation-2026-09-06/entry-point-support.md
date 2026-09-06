# Retrieval benchmark entry points — support classification (2026-09-06)

Produced for Stage A of the audit remediation. "Supported" means: has a
maintained CLI, goes through the real production retrieval path
(`runHybridSearch()` / real indexer CLI), composes the current embedding
capabilities, and fails a non-COMPLETE run with a nonzero exit. Being
imported by another script does **not** make a script supported.

## Supported

| Entry point | Command | Path | Notes |
|---|---|---|---|
| production-path: structural | `node benchmarks/external/production-path/run-structural-prodpath.mjs [--smoke\|--resume\|--restart]` | real indexer CLI + `runHybridSearch()` | Internal plumbing/structural fixture. Local + Cloud. Nonzero exit on non-COMPLETE (Stage A). |
| production-path: SciFact | `node benchmarks/external/production-path/run-scifact-prodpath.mjs [--smoke\|--pilot\|--resume\|--restart]` | real indexer CLI + `runHybridSearch()` | BEIR SciFact through the production path. `--pilot` = 150 docs / 25 queries. |
| production-path: MIRACL-ru | `node benchmarks/external/production-path/run-miracl-ru-prodpath.mjs [--smoke\|--resume\|--restart]` | real indexer CLI + `runHybridSearch()` | Russian subset. |
| production-path: Slavic (Belebele) | `node benchmarks/external/production-path/run-slavic-prodpath.mjs [--smoke\|--lang=<code>\|--resume\|--restart]` | real indexer CLI + `runHybridSearch()` | 7 languages; carries `SLAVIC_CAVEAT`. |
| production-path: all four | `node benchmarks/external/production-path/run-all.mjs [--smoke\|--resume\|--restart]` | as above | Approval-gated full run. Nonzero exit if any suite is non-COMPLETE. |
| production-path: live structural smoke | `node benchmarks/external/production-path/run-structural-smoke.mjs` | as above + dedicated entity_raw / retrievability probe + orphan sweep | The one live-network entry point in that directory. |
| custom-50 quality | `npm run bench:custom50` (`node benchmarks/retrieval/custom-50/run-v3.js`) | low-level `hybridSearch()` on `bench-retrieval-custom-50` | **Regression/tuning set, not a held-out quality baseline.** qrels are under semantic review in Stage B — its numbers are not valid-for-quality until then. Runtime fixed in Stage A (was dead on `BENCH_SKIP_INDEX=1`). |

## Historical / raw-client (kept, not the production path)

These build vectors themselves (`embedOnnxBatch` / a raw Qdrant client) and
do **not** exercise `runHybridSearch()`. Valid as provider/fusion
diagnostics; never cite them as production-path quality.

| Entry point | Command |
|---|---|
| BEIR SciFact (raw client, dense/sparse/hybrid lanes) | `node benchmarks/external/beir/run-scifact.mjs` |
| BEIR RRF mini | `node benchmarks/external/beir/run-rrf-mini.mjs` |
| MIRACL (raw client) | `node benchmarks/external/miracl/run-miracl.mjs` |
| Fusion RRF sweep / weighted-RRF | `node benchmarks/external/fusion/run-rrf-sweep.mjs`, `run-weighted-rrf-live.mjs` |
| Slavic (raw client) | `node benchmarks/external/slavic/run-slavic-benchmark.mjs`, `run-slavic-weighted-rrf.mjs` |
| 21-query regression | `npm run bench:retrieval` (`benchmarks/retrieval/run.js`) |
| custom-50 analysis/tuning scripts | `bench:custom50:failures`, `:tune`, `:compare`, `:rank1`, `:diagnostics`, `:sweep`, … — all spawn `run-v3.js` and parse its JSON; unaffected by the internal wiring |

## Was broken before Stage A — now fixed

| Entry point | Failure (audit 2026-09-06) | Fix |
|---|---|---|
| `custom-50/run-v3.js` (`BENCH_SKIP_INDEX=1`) | exit 1 on c01: `no onnxEmbed capability available` — called `embedForSearch(PROFILE, query)` with no capabilities | Composes `createBenchmarkQueryEmbedder()` in `main()`; `embedQuery`/`getClientCapabilities()` thread the real ONNX capability; `shutdown()` in `finally`. |
| `production-path` suites (all) | every Local query → `embedding_failed` (no `onnxEmbed`); every Cloud query → `embedding_failed` (no `cloudEmbed`); verdict INCOMPLETE but CLI exit 0 | `run-suite.mjs` builds one `createBenchmarkQueryEmbedder()` per run and threads `embedQuery`/`cloudEmbed` into every `queryOne()`; `shutdown()` in a top-level `finally`. `queryOne()` forwards both to `runHybridSearch()`. All runner `main()`s now set `process.exitCode` from `exitCodeForSuiteState()` — nonzero on non-COMPLETE. |
| `isCompletedProfileRun()` | returned `true` for a block with `queriesWithInsufficientDepth: 3`; also never required `mapAt100` finite | Now gates on `queriesWithInsufficientDepth === 0` (and rejects the field's total absence), a finite `mapAt100`, and — for the final verdict and resume-skip — an exact `queryCount` match. |
| resume/checkpoint | a stored "complete" profile passed a resume-skip even after the query set changed (self-referential `queryCount` check) | `validateResumeCheckpoint()` takes the current `{ queryCount }`; the runner passes `queries.size`, so a changed dataset size forces a full profile rerun rather than a skip. |

## Not restored

`applyEmbeddingCapabilities()` process-wide singleton is **not** used as a
benchmark shim. Every runner composes per-instance capabilities and shuts
them down in a `finally`. No model download or generation happens at
import time — the ONNX capability is constructed only on the first
`bge-m3-onnx` query/index call.
