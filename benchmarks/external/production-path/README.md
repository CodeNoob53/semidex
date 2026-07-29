# Production-path benchmark: Local Semidex vs Semidex Lite

Compares two Semidex collection profiles **through the real production
code path** — the actual indexer (`src/indexer/index.js`, spawned as a
subprocess, same entry point `npm run index` uses), the actual storage
adapter, and the actual `runHybridSearch()` retrieval function:

- **Local** — BGE-M3 ONNX dense + learned sparse (`DENSE_PROVIDER=bge-m3-onnx`,
  `SPARSE_PROVIDER=bge-m3-onnx`). CUDA is an optional execution
  accelerator only — never a quality claim.
- **Semidex Lite** — Qdrant Cloud Inference (`DENSE_PROVIDER=qdrant-cloud`,
  dense `intfloat/multilingual-e5-small`, sparse `qdrant/bm25`).

## Scope: complements, does not replace, the existing raw-client suites

Four other suites already exist under `benchmarks/external/` (`beir/`,
`miracl/`, `slavic/`, `fusion/`) — they measure raw embedding-provider
quality by hand-building one Qdrant point per document (no chunking, no
production indexer). This suite measures something different: the actual
Semidex indexing pipeline (chunking, skeleton parsing, entity-split for
oversized structural entities) end to end. `runHybridSearch()` has no
dense-only/sparse-only mode, so this suite reports **hybrid only** — for
a dense/sparse lane breakdown on the same SciFact corpus, see the
existing `benchmarks/external/beir/run-scifact.mjs` raw-client results
(non-production-path context, not part of this harness's own
measurement).

## Suites

1. **SciFact** (`run-scifact-prodpath.mjs`) — English baseline, reuses
   `benchmarks/external/beir/fetch-scifact.mjs` verbatim.
2. **MIRACL Russian** (`run-miracl-ru-prodpath.mjs`) — reuses the
   existing deterministic pooled subset (100 queries / 1000 passages,
   `benchmarks/external/miracl/build-miracl-subset.mjs`) — **never** the
   full multi-million-document corpus.
3. **Slavic** (`run-slavic-prodpath.mjs`) — 7 languages (ukr_Cyrl,
   rus_Cyrl, bul_Cyrl, pol_Latn, ces_Latn, slk_Latn, eng_Latn control),
   Belebele-derived. **Caveat**: comparative multilingual retrieval
   signal only, not a natural-document RAG benchmark — Belebele/FLORES
   passages are short, synthetic MRC excerpts with exactly one relevant
   document per query.
4. **Structural fixture** (`run-structural-prodpath.mjs`) — internal
   only, not an external benchmark. Verifies Qdrant Cloud's 512-token
   window and the entity_raw/fragment topology preserve retrievability
   for an oversized table, fenced code block (with one >2000-char
   minified line), and checklist.

## Isolation mechanisms

- **`SEMIDEX_CONFIG_PATH`** (additive production change,
  `src/core/config.js`) — every indexer spawn gets its own isolated
  `config.json` copy under `.cache/config/`. The real repo `config.json`
  is never touched by any benchmark run.
- **`SEMIDEX_BENCH_TELEMETRY_PATH`** (additive production change,
  `src/core/bench-telemetry.js` + hooks in `src/core/qdrant/client.js`,
  `src/core/qdrant/store.js`, `src/core/embeddings.js`,
  `src/core/retrieval/search.js`) — opt-in, no-op unless set. Gives the
  harness EXACT (not estimated) counts of real Qdrant SDK operations and
  real Cloud Inference descriptors (dense/sparse item counts + char
  lengths, split by indexing-phase vs. query-phase), since the harness
  cannot otherwise see inside the spawned indexer subprocess or observe
  that Semidex's real embed input is `context + text` with silent
  context-trimming under budget pressure.
- **`DETERMINISTIC_INDEXING_ENV_BASE`** (`core/profiles.mjs`) — every
  indexing-relevant env var is pinned explicitly for both profiles
  (`TAG_GEN=0`, `SKELETON_SUMMARY=deterministic`, `PIPELINE_MODE=0`,
  chunk sizing, `HYBRID_PREFETCH_LIMIT=2`, `RRF_K=60`, `PRUNE_STALE=0`,
  `COMBINED_LLM=0`, `FORCE_REINDEX=0`, `ONNX_EXECUTION_PROVIDER=cpu`
  unless `--cuda`) — never relies on ambient `.env`/OS env, which could
  otherwise silently vary between runs.
- **`semidex-prodpath-bench-` collection prefix** — every collection this
  harness creates carries this exact prefix. Cleanup (`core/cleanup.mjs`)
  only ever deletes prefix-matching collections; a "not found" delete
  response is treated as a successfully clean state, not an error.
  Cleanup runs unconditionally in `finally` for every profile run,
  regardless of which step failed. A prefix-scoped orphan sweep
  (`cleanupAllOwnedCollections`) also runs unconditionally at the start
  of every suite invocation — the real safety net for a prior run that
  was hard-killed (a `finally` block cannot run after `SIGKILL`).

## Commands

### Smoke (tiny plumbing check, both profiles, real Qdrant)

```
node benchmarks/external/production-path/run-structural-prodpath.mjs --smoke
node benchmarks/external/production-path/run-scifact-prodpath.mjs --smoke
node benchmarks/external/production-path/run-miracl-ru-prodpath.mjs --smoke
node benchmarks/external/production-path/run-slavic-prodpath.mjs --smoke   # defaults to eng_Latn only
```

### Live smoke + entity_raw/retrievability probe (structural suite, standalone script)

```
node benchmarks/external/production-path/run-structural-smoke.mjs
```

Requires real `QDRANT_URL`/`QDRANT_KEY`. This is the **one live-network
entry point** in this directory — it is deliberately not named
`*.test.mjs` and is never run by the offline test suite.

### Pilot (representative runtime/request-volume estimate — SciFact only)

```
node benchmarks/external/production-path/run-scifact-prodpath.mjs --pilot
```

A real, deterministic, qrels-validated 25-query/150-document subset
(`core/pilot-subset.mjs`) — never an ad hoc "just take the first N"
slice. Used to extrapolate a runtime/request-volume estimate for the
full run; the 5-document structural smoke is too small to extrapolate
from credibly.

### Full run (NOT yet approved — proposed command, requires explicit sign-off)

```
node benchmarks/external/production-path/run-all.mjs
```

Or per-suite:

```
node benchmarks/external/production-path/run-scifact-prodpath.mjs
node benchmarks/external/production-path/run-miracl-ru-prodpath.mjs
node benchmarks/external/production-path/run-slavic-prodpath.mjs
node benchmarks/external/production-path/run-structural-prodpath.mjs
```

### Resume / restart

```
--resume         # continue a checkpointed run, skipping already-complete profiles
--resume-check    # report checkpoint status without running anything
--restart         # discard an existing checkpoint and start fresh
```

An invalid/incomplete profile run is always retried as a FULL rerun on
`--resume` (never a partial "retry only the errored query IDs" resume) —
cleanup deletes the collection unconditionally regardless of outcome, so
there is no partial indexed state to resume against.

### CUDA (local profile only, opt-in)

```
--cuda
```

Runs a real preflight (`probeOnnxProvider('cuda')`) before indexing —
if CUDA is unavailable or the probe falls back to CPU, the local
profile's run for that suite aborts with a typed `cuda_unavailable`
error rather than silently continuing on CPU and mislabeling the run as
GPU-accelerated. The cloud profile is entirely unaffected by this flag.

### Cleanup verification (standalone)

```js
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { cleanupAllOwnedCollections } from './core/cleanup.mjs';
const result = await cleanupAllOwnedCollections(createStorageAdapter());
console.log(result); // { scanned, owned, results }
```

### Tests (offline, bounded memory)

```
node --test --test-concurrency=1 benchmarks/external/production-path/*.test.mjs
```

Every `*.test.mjs` file is fully offline — no network, no real Qdrant.
Offline-ness is enforced structurally: `runSuiteAcrossProfiles()`
requires `adapter`/`runIndexer`/`queryOne` as explicit parameters (never
constructed internally), so every offline test passes throw-on-call
stubs for whichever dependency it isn't specifically exercising. This is
never inferred from source-text inspection.

Production-code test coverage for the two additive changes lives under
`tests/unit/core/` (not here), matching the repo's existing convention:
`tests/unit/core/config-path-override.test.js`,
`tests/unit/core/bench-telemetry.test.js`,
`tests/unit/core/qdrant-client-telemetry.test.js`,
`tests/unit/core/qdrant-store-hybrid-search-telemetry.test.js`, and
telemetry assertions folded into the existing `embeddings.test.js` /
`retrieval/search.test.js`.

## Metrics

nDCG@10, MAP@100, Recall@10, Recall@100, MRR@10 — computed via
`benchmarks/external/beir/metrics.mjs`'s `computeMetrics()`, reused
verbatim. Retrieval depth: `CHUNK_CANDIDATE_LIMIT=400` chunk candidates
requested per query, collapsed to a deduplicated document ranking and
scored at `DOCUMENT_METRIC_DEPTH=100`. Chunk-to-document collapse uses
MAX score across a document's chunks (`collapseStrategy: 'max'`,
`core/collapse.mjs`) — an explicit, logged fairness parameter, never
silently varied between profiles. A query whose collapsed ranking falls
short of full depth is still scored, and counted in
`queriesWithInsufficientDepth`.

Indexing wall time, query latency p50/p95, indexed doc/chunk/entity_raw
counts, and EXACT (not estimated) Cloud Inference request/token volume
(via the opt-in telemetry mechanism above) are all recorded per profile
run in the checkpoint JSON under `.runs/<suite>-checkpoint.json`.

For the main local-hybrid vs. cloud-hybrid comparison (SciFact and
MIRACL Russian), paired per-query deltas and a bootstrap confidence
interval are computed via
`benchmarks/external/miracl/bootstrap.mjs`'s `pairedBootstrapByQuery()`
(reused — suite-agnostic despite living under `miracl/`).

## Directory layout

```
core/            shared logic (profiles, indexing, querying, collapse,
                 materialize, checkpoint, cleanup, telemetry, pilot subset,
                 orchestration)
fixtures/        the internal structural retrieval fixture
run-*.mjs        one thin entry script per suite + run-all.mjs
*.test.mjs       offline tests
.cache/          gitignored — materialized fixture files, isolated
                 config.json copies, telemetry JSONL, pilot subset cache
.runs/           gitignored — checkpoints + .trec run files
```
