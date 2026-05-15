# Cross-Encoder Reranking Integration Design

**Status:** Proposal — benchmark gate passed, production integration pending  
**Date:** 2026-05-15  
**Model evaluated:** `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`

---

## Background

The current retrieval pipeline (`src/core/rerank.js`) is:

```
hybridSearch(prefetch N) → Qdrant dense+sparse RRF
rerankResults()          → deterministic token-hit boosting, diversity penalty, top-1 protection
                         → returns top-K to MCP
```

A standalone CE benchmark (`benchmarks/retrieval/custom-50/cross-encoder-bench.js`) was run and passed all promotion gates on 2026-05-15.

**Model:** `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` (multilingual 12-layer, ~120 MB)  
**Input mode:** `CE_INPUT=text+meta` — passage = `[source_file § section] text`

**Quality results (custom-50, ONNX provider):**

| Metric | hybrid-true | det-rerank | CE text+meta |
|--------|-------------|------------|--------------|
| MRR@10 | 0.665 | 0.663 | **0.760** (+0.095) |
| chunkRecall@5 | 87.8% | 89.8% | **95.9%** |
| rank1 exact | 25 | 24 | **29** |
| negativePass | 100% | 100% | **100%** |
| p50 latency | 49 ms | 51 ms | **3 497 ms** |

**Constraint:** CPU latency (~3 500 ms p50 for 40 candidates on a single core) makes CE unsuitable as a default interactive MCP behavior. Promotion to production requires GPU latency measurement.

---

## 1. Runtime Modes

Three modes are determined entirely by environment variables at process startup. No code path changes between modes once the process is running.

### Mode A — Default interactive

**Env:** `RERANK_CE_ENABLED` unset or `0`

Existing production behavior, unchanged. CE is never loaded or invoked. `hybridSearch` fetches `top × RERANK_PREFETCH_MULT` candidates when `RERANK_ENABLED=1`, or exactly `top` otherwise. The deterministic `rerankResults()` runs if `RERANK_ENABLED=1`.

**Expected p50:** ~49 ms (hybrid only) or ~52 ms (hybrid + det-rerank).

### Mode B — CE opt-in interactive

**Env:** `RERANK_CE_ENABLED=1`

CE reranking activates after the existing pipeline stages. The HF model is loaded lazily on the first qualifying query, or eagerly on startup if `RERANK_CE_WARMUP=1`. CE scores the candidate pool and replaces the final ranked list. The deterministic reranker (`RERANK_ENABLED`) remains independently configurable and runs before CE when both are enabled.

**Expected p50:** ~3 500 ms on CPU; target < 200 ms on GPU (DML or CUDA).

**Intended use:** Offline batch search, agent pipelines, quality-sensitive non-interactive retrieval. Not suitable for interactive MCP use at CPU speed. Operators enabling this in an interactive context must have confirmed GPU acceleration.

### Mode C — Offline / agent-quality

**Env:** `RERANK_CE_ENABLED=1 RERANK_CE_WARMUP=1 RERANK_CE_DEVICE=dml` (or `cuda`)

Identical to Mode B but the CE model is preloaded at server startup before the first MCP connection is accepted. A single no-op inference pass during startup eliminates first-query JIT/ONNX graph initialization latency. GPU device is set explicitly.

**Expected p50 (GPU):** Target < 200 ms (DML/CUDA, 40 candidates). CPU fallback remains ~3 500 ms; a startup warning is logged if `RERANK_CE_DEVICE` targets a GPU provider but falls back to CPU.

---

## 2. Env/Config Proposal

All new env vars follow the `envFloat` / `envInt` pattern from `src/core/rerank.js`: parse, bounds-check, warn to stderr on invalid value, fall back to default. The `RERANK_CE_` prefix groups CE settings adjacent to existing `RERANK_*` vars in the configuration table.

| Name | Default | Valid range / values | Description |
|------|---------|----------------------|-------------|
| `RERANK_CE_ENABLED` | `0` | `0`, `1` | Enable cross-encoder reranking. `0` = CE never loaded; `1` = CE runs after hybrid (and optional det-rerank). Preserves existing behavior unconditionally when unset. |
| `RERANK_CE_MODEL` | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` | Any HF model ID or absolute local path | HuggingFace model identifier for `AutoModelForSequenceClassification`. The multilingual 12-layer mmarco model is the only benchmark-validated choice. A different model ID restarts the gate requirement. |
| `RERANK_CE_INPUT` | `text+meta` | `text`, `text+section`, `text+meta` | Passage construction mode. `text` = raw chunk text. `text+section` = `[section] text`. `text+meta` = `[source_file § section] text` (benchmark-optimal). Invalid value: warn and use `text+meta`. |
| `RERANK_CE_TOP_N` | `40` | `1`–`500` | Candidates from the RRF pool passed to CE. Hard upper bound on inference cost. Candidates beyond `TOP_N` are discarded before scoring. Must be >= `top`; if not, warn and clamp to `top`. |
| `RERANK_CE_TIMEOUT_MS` | `10000` | `100`–`120000` | Wall-clock deadline (ms) for CE inference on a single query. On expiry, fallback to pre-CE candidates. |
| `RERANK_CE_DEVICE` | `cpu` | `cpu`, `dml`, `cuda` | Execution provider for CE ONNX session. Passed as the provider string to `AutoModelForSequenceClassification.from_pretrained`. Exact fallback-chain semantics (e.g. whether `dml` silently falls back to CPU on failure) depend on the `@huggingface/transformers` device API and must be confirmed by a spike test before documenting. Invalid values warn and fall back to `cpu`. |
| `RERANK_CE_CACHE_DIR` | `./models` | Any writable path | HF model cache directory. Mirrors `hfEnv.cacheDir` from `src/core/onnx-embed.js`. Created with `mkdirSync` if absent. No re-download when model is already cached. |
| `RERANK_CE_WARMUP` | `0` | `0`, `1` | When `1`, load and run one no-op CE inference pass at process startup before accepting MCP connections. Only meaningful when `RERANK_CE_ENABLED=1`. |
| `RERANK_CE_BATCH_SIZE` | `16` | `1`–`256` | `(query, passage)` pairs per tokenizer + model call. Matches `CE_BATCH_SIZE` default from the benchmark. |
| `RERANK_CE_DEBUG` | `0` | `0`, `1` | When `1`, log per-candidate CE scores to stderr with `[ce-rerank]` prefix, mirroring `RERANK_DEBUG`. |

**Note on device parity:** `RERANK_CE_DEVICE` is deliberately separate from `ONNX_EXECUTION_PROVIDER` so the CE model can run on a different device than the BGE-M3 embedder (e.g., embedder on DML, CE on CPU during evaluation). The exact provider resolution path (single string vs list vs fallback chain) must be confirmed by a spike test against the `@huggingface/transformers` v4.2 device API before implementation; do not assume it matches `onnxruntime-node`'s `executionProviders` array semantics.

---

## 3. Integration Point

**Decision: create `src/core/ce-rerank.js` as a new module.**

**Rationale:** `src/core/rerank.js` is pure and synchronous with no async I/O, no side effects at module scope beyond `envFloat`/`envInt` reads, and no external dependencies beyond `dotenv` and `graph.js`. Embedding the HF model lifecycle into that file would make it async-at-module-scope, would impose an unconditional `@huggingface/transformers` import on every code path that imports `rerankResults`, and would make CE-specific testing harder to isolate.

A separate module is cleaner because:
1. CE is opt-in and must not affect the hot path even at import time.
2. The module-level singleton pattern for `_ceTokenizer`, `_ceModel`, `_ceNumLabels` is already proven in the benchmark file and can be ported directly.
3. Smoke tests for CE can import `src/core/ce-rerank.js` independently, inject a stub model, and never touch `rerank.js`.

**Exports from `src/core/ce-rerank.js`:**

```js
// Score and reorder candidates using cross-encoder logits.
// Returns candidates sliced to finalLimit, sorted by CE score descending.
// Never throws: model load failure is caught internally, _ceModelFailed is set,
// and the input candidates are returned unchanged. Timeout is handled by the
// caller via Promise.race — ceRerank itself has no internal deadline.
export async function ceRerank(candidates, query, { finalLimit } = {})

// Idempotent: returns immediately if model is already loaded or _ceModelFailed is set.
// Throws on unsupported numLabels, corrupt model, or no-cache network failure.
// ceRerank() calls this internally and catches its errors; external callers
// (warmup path) must handle the throw themselves.
export async function loadCEModel()
```

**Lazy load pattern:** `_ceTokenizer` and `_ceModel` are `null` at module scope. `loadCEModel()` is called inside `ceRerank()` on every invocation but returns immediately after the first successful load, identical to the `load()` guard in `src/core/onnx-embed.js`. No top-level `await`; the module can be imported without triggering a download.

**Call site in `src/mcp/tools/search.js`:** After the existing `RERANK_ENABLED` block, a conditional block imports `ceRerank` and wraps the call in `Promise.race` against a timeout sentinel. When both `RERANK_ENABLED=1` and `RERANK_CE_ENABLED=1`, det-rerank runs first on the full pool (see Section 4), and CE then re-scores the det-rerank output.

---

## 4. Pipeline

### Full candidate flow

```
hybridSearch(prefetch N)
  N = max(top × RERANK_PREFETCH_MULT, top + 5)
  → N candidates, sorted by RRF score descending

[Stage 1 — optional det-rerank]
  runs if RERANK_ENABLED=1
  input:  N candidates
  output: N candidates re-scored by rerankResults()
  note:   finalLimit = N (full pool), not `top`
          CE needs the full ordered pool to work with

[Stage 2 — optional CE rerank]
  runs if RERANK_CE_ENABLED=1
  input:  min(N, RERANK_CE_TOP_N) candidates
          (Stage 1 output if det-rerank ran; raw RRF output otherwise)
  output: up to RERANK_CE_TOP_N candidates, sorted by CE logit score
          ceRerank(candidates.slice(0, RERANK_CE_TOP_N), query, { finalLimit: top })

[Stage 3 — slice]
  results.slice(0, top) → return to MCP caller
```

### Does CE rerank the raw RRF pool or det-rerank output?

CE reranks the **det-rerank output** when `RERANK_ENABLED=1 RERANK_CE_ENABLED=1`. Det-rerank applies cheap but meaningful signals (token hits, backlinks, intro-chunk penalty) consistently yielding zero regressions. Running CE on det-rerank output rather than the raw RRF pool means CE's inference budget is spent after clearly relevant candidates have been lifted into the TOP_N window. Critically, `finalLimit` passed to `rerankResults()` in combined mode is `N` (the full pool), not `top`, so CE receives the full ordering, not a pre-sliced top-K.

When `RERANK_ENABLED=0 RERANK_CE_ENABLED=1`, CE runs directly on the raw RRF pool up to `RERANK_CE_TOP_N`.

### Default N for CE candidates

`RERANK_CE_TOP_N` defaults to `40`. The benchmark was run over `TOP_K × RERANK_PREFETCH_MULT = 10 × 4 = 40` candidates and achieved the gate results at that number. On CPU, each additional candidate pair adds ~87 ms at p50. Going lower risks excluding the correct chunk when it falls outside the TOP_N window. 40 is the validated safe default and should not be raised without re-running the custom-50 gate and measuring latency.

---

## 5. Safety Guards

### `RERANK_CE_TIMEOUT_MS` exceeded

**Trigger:** `Promise.race` between `ceRerank(...)` and a `setTimeout(RERANK_CE_TIMEOUT_MS)` sentinel resolves on the timeout side.

**Fallback:** Discard the partial CE result. Return the input candidate list as-is (det-rerank output if `RERANK_ENABLED=1`, raw RRF output otherwise), sliced to `top`.

**Log:** `[ce-rerank] timeout after ${ms}ms — returning pre-CE results (${n} candidates)`. Always emitted; not gated on `RERANK_CE_DEBUG`.

**Compute cancellation caveat:** `Promise.race` is a response-fallback only. ONNX/HF inference that was already dispatched continues executing on the CPU/GPU after the timeout fires — JavaScript has no mechanism to cancel an in-flight synchronous native call. On CPU with `RERANK_CE_TOP_N=40` this means up to ~3 500 ms of CPU burn may continue in the background after the MCP response is returned. Callers must account for this when deciding queue depth and concurrency:

- **Serialize CE calls** (one in-flight at a time) to prevent CPU saturation from queued timeouts. This is the recommended default: do not allow a second `ceRerank` call to start while one is already in flight.
- **Busy flag:** a module-level `_ceInFlight` boolean guards entry to CE inference. If `_ceInFlight` is true when a new query arrives and `RERANK_CE_ENABLED=1`, skip CE and return det-rerank results immediately, logging `[ce-rerank] busy — skipping CE for this query`.
- **Queue limit:** reject or skip CE if more than one query is already waiting. No unbounded queue.
- **Worker thread (future):** running CE in a `worker_threads` Worker would allow the Worker to be terminated on timeout, achieving true cancellation. This is deferred — the busy-flag approach is sufficient for the initial implementation where CE is expected to be used in low-concurrency offline/agent contexts.

---

### Model load failure

**Trigger:** `loadCEModel()` throws for any reason: HF hub unreachable and no cache, corrupted ONNX file, or `_ceNumLabels` not in `{1, 2}`.

**Fallback:** Log the error, set module-level `_ceModelFailed = true`. Return the pre-CE candidate list for the current query and all subsequent queries in this process session. The module never retries loading after a hard failure.

**Log:**
- Network/corrupt: `[ce-rerank] model load failed: ${err.message} — CE disabled for this session`
- Unsupported numLabels: `[ce-rerank] unsupported numLabels=${n} for "${RERANK_CE_MODEL}" — expected 1 or 2. CE disabled for this session`

The production path sets `_ceModelFailed = true` instead of calling `process.exit()` (unlike the benchmark's fail-fast). The process stays alive and serves requests using the pre-CE path.

---

### Provider / schema mismatch

CE is downstream of `hybridSearch`. A provider mismatch causes `hybridSearch` to fail or silently degrade before CE is invoked. The existing `embedForSearch` runtime guard throws `'Unsupported provider combination'` and surfaces as an MCP error. No additional CE-specific guard is needed.

---

### Negative query (empty result set)

**Trigger:** `hybridSearch` returns 0 results (e.g., `"semidex підключення до PostgreSQL"` against a corpus with no PostgreSQL content).

**Fallback:** `ceRerank` checks `candidates.length === 0` at entry and returns `[]` immediately without attempting model load or inference. Preserves `negativePass = 100%`.

**Log:** No warning for empty input — expected behavior. If `RERANK_CE_DEBUG=1`: `[ce-rerank] empty candidate pool — skipping CE inference`.

---

### CE pool too small (fewer candidates than TOP_K)

**Trigger:** `candidates.slice(0, RERANK_CE_TOP_N)` produces a pool smaller than `top` (sparse corpus).

**Fallback:** CE scores all available candidates and returns them. The caller's `results.slice(0, top)` naturally returns fewer than `top` results — existing behavior for sparse corpora. No error raised.

**Log:** If `RERANK_CE_DEBUG=1`: `[ce-rerank] pool size ${n} < top=${top} — returning all scored candidates`.

---

### CE pool too large (unbounded latency)

**Trigger:** `RERANK_CE_TOP_N` set very high or `RERANK_PREFETCH_MULT` very high, producing hundreds of candidates.

**Fallback:** `envInt('RERANK_CE_TOP_N', 40, 1, 500)` enforces a hard ceiling of 500. Candidates beyond `RERANK_CE_TOP_N` are silently truncated before inference. `RERANK_CE_TIMEOUT_MS` provides a second backstop regardless of pool size.

**Log:** If `RERANK_CE_DEBUG=1` and truncation occurred: `[ce-rerank] truncated pool from ${fullN} to ${RERANK_CE_TOP_N} candidates (RERANK_CE_TOP_N cap)`.

---

## 6. Latency Strategy

### CPU vs GPU expected p50

| Device | `RERANK_CE_DEVICE` | Expected p50 (40 candidates) | Notes |
|--------|-------------------|------------------------------|-------|
| CPU (single core) | `cpu` | ~3 500 ms | Measured in benchmark: p50 3 497 ms |
| DirectML (Windows GPU) | `dml` | ~150–400 ms | Not yet measured; depends on GPU model and DML backend for cross-encoder ops |
| NVIDIA CUDA | `cuda` | ~80–200 ms | Not yet measured; requires CUDA-capable `onnxruntime-node` build |

GPU targets are estimates. The production acceptance gate (Section 8) defines the binding threshold.

### Lazy load vs startup preload

**Default (lazy):** `loadCEModel()` fires inside `ceRerank()` on the first query. Model load takes 3–10 seconds depending on disk speed and model cache state. Acceptable for batch and agent pipelines; unacceptable for interactive use.

**Preload (`RERANK_CE_WARMUP=1`):** `loadCEModel()` called from `src/mcp/server.js` before `await server.connect(transport)`. A single no-op inference pair forces ONNX graph initialization. Adds 3–10 seconds to server startup but eliminates first-query latency spike. Recommended for Mode C deployments.

No `--warmup` CLI flag is needed in the initial design; `RERANK_CE_WARMUP=1` is the sole trigger.

### Memory footprint

| Precision | Disk | RAM at inference |
|-----------|------|-----------------|
| fp32 (benchmark default) | ~120 MB | ~150–180 MB |
| fp16 (not yet validated) | ~60 MB | ~80–100 MB |

The BGE-M3 ONNX embedder uses ~2.27 GB disk and ~2.5 GB RAM at inference. Both models coexist on systems with ≥ 4 GB free RAM. On tight systems, keep `RERANK_CE_WARMUP=0` to defer CE memory until the first CE-enabled query.

`fp16` is a future optimization. Do not change `dtype: 'fp32'` without re-running the custom-50 gate — numeric differences between precisions may affect gate results.

### Cache behavior

`hfEnv.cacheDir` is set to `RERANK_CE_CACHE_DIR` at `ce-rerank.js` module scope, mirroring `onnx-embed.js`. The HF library's own cache-hit check prevents re-downloading. `~120 MB` downloads atomically in reasonable time; no custom resume logic is needed (unlike BGE-M3's 2.27 GB data file).

### Max candidates cap

`RERANK_CE_TOP_N=500` is the hard ceiling. `RERANK_CE_TOP_N=40` (default) is the validated value for the benchmark configuration. Operators increasing this must re-run the custom-50 gate and re-measure latency.

---

## 7. Test Plan

### Smoke test: CE path without model download

**File:** `src/smoke/sections/20-ce-rerank-stub.js`

**Coverage:** Verify `ceRerank` with an injected stub (returns deterministic logit tensors for a batch of 2 candidates) returns candidates sorted by mocked scores. Verify `text+meta` passage construction produces the expected `[source_file § section] text` format.

**Pass condition:** `result[0].payload.source_file === expectedTopChunk` — stub assigns score 0.9 to the second candidate and 0.1 to the first; CE sort must flip the order. No network call occurs.

**Implementation note:** Export `_resetForTest()` from `ce-rerank.js` to reset `_ceModel`, `_ceModelFailed` between test assertions.

---

### Unit test: timeout fallback

**File:** `src/smoke/sections/20-ce-rerank-stub.js`

**Coverage:** Inject a stub model that waits 20 000 ms before returning. Set `process.env.RERANK_CE_TIMEOUT_MS = '100'`. Call `ceRerank`. Verify the call resolves within ~500 ms wall time and returns the input candidates unchanged (by chunk ID).

**Pass condition:** Elapsed < 1 000 ms. Return value equals input candidates.

---

### Unit test: model load failure fallback

**File:** `src/smoke/sections/20-ce-rerank-stub.js`

**Coverage:** Inject a `loadCEModel` stub that throws `'network unavailable and model not cached'`. Call `ceRerank` twice. Verify both calls return pre-CE candidates without throwing. Verify `_ceModelFailed` is true and stderr contains `[ce-rerank] model load failed:` exactly once (no retry on the second call).

---

### Unit test: numLabels fail-fast

**File:** `src/smoke/sections/20-ce-rerank-stub.js`

**Coverage:** Inject a model stub whose probe inference returns `logits.dims = [1, 3]` (numLabels = 3). Call `loadCEModel`.

**Pass condition:** `_ceModelFailed` is true after the call. Stderr contains `unsupported numLabels=3`. Process did not exit. Subsequent `ceRerank` call returns pre-CE candidates.

---

### Benchmark regression gate: custom-50 with CE enabled

**File:** `benchmarks/retrieval/custom-50/cross-encoder-bench.js` (existing)

**Command:**
```bash
BENCH_SKIP_INDEX=1 CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 CE_INPUT=text+meta npm run bench:custom50:ce
```

**Pass conditions (all four must be green):**

| Criterion | Threshold | Last confirmed |
|-----------|-----------|---------------|
| MRR@10 (CE) ≥ MRR@10 (hybrid-true) + 0.030 | ≥ 0.695 | 0.760 |
| chunkRecall@5 (CE) ≥ chunkRecall@5 (hybrid-true) | ≥ 87.8% | 95.9% |
| negativePass (CE) | = 100% | 100% |
| zero regressions (rel≥3, rank ≤3 → >3) | 0 | 0 |

Must be re-run after any change to `ce-rerank.js`, `RERANK_CE_INPUT` default, passage construction, or batch size.

---

### Per-query regression assertions for historically problematic queries

Add explicit per-query assertions after the main metrics block in the benchmark runner.

| Query ID | Query (abbreviated) | Required chunk | Pass threshold |
|----------|---------------------|----------------|---------------|
| c03 | `"як увімкнути bge-m3-onnx без Ollama"` | `providers.md#2` | rank ≤ 3 |
| c16 | `"чому фінальний чанк може губитись..."` | `chunking.md#5` | rank ≤ 3 |
| c23 | `"коли потрібно запускати sync після апгрейду"` | `sync.md#3` | rank ≤ 3 |
| c36 | `"chunkFile splitSentences parseMarkdown location in source"` | `project-structure.md#7` or `#1` | rank ≤ 3 (either rel=3 chunk) |
| c46 | `"що таке SOURCE_ROOT і навіщо він потрібен"` | `config-env.md#4` | rank ≤ 3 |

c03, c16, c23, c46 are the Ukrainian paraphrase queries that the English-only `ms-marco-MiniLM-L-6-v2` failed catastrophically on. These must remain green after any model or configuration change. c36 requires either rel=3 chunk (`project-structure.md#7` or `#1`) at rank ≤ 3; after the qrel correction the confirmed CE result has `project-structure.md#1` at rank #2, so rank ≤ 3 is achievable and consistent with the gate criterion.

---

## 8. Production Acceptance Gate

All items must be green before `RERANK_CE_ENABLED=1` is documented as a supported opt-in in `docs/en/configuration.md` and `docs/en/retrieval.md`. Individual items cannot be waived.

### custom-50 benchmark gate

```bash
BENCH_SKIP_INDEX=1 CE_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 CE_INPUT=text+meta npm run bench:custom50:ce
```

- [ ] MRR@10 (CE) ≥ 0.695 (hybrid-true baseline + 0.030; current baseline 0.665)
- [ ] chunkRecall@5 (CE) ≥ 87.8% (no regression from hybrid-true baseline)
- [ ] negativePass (CE) = 100%
- [ ] zero regressions (rel≥3, rank ≤3 in hybrid-true → rank >3 in CE)

### GPU p50 target

- [ ] p50 latency for CE inference over 40 candidates on the production GPU device (DML or CUDA) is **< 200 ms**. Measurement must be taken on the hardware class that will run the MCP server. If no GPU is available, the deployment is restricted to Mode B (CPU) with an explicit documented latency warning; the 200 ms target does not apply, and the operator accepts ~3 500 ms p50 in writing in the deployment notes.

### Exact-token regression check

All five queries from Section 7 must pass their rank thresholds:

- [ ] c03: `providers.md#2` at rank ≤ 3
- [ ] c16: `chunking.md#5` at rank ≤ 3
- [ ] c23: `sync.md#3` at rank ≤ 3
- [ ] c36: `project-structure.md#7` or `project-structure.md#1` at rank ≤ 3
- [ ] c46: `config-env.md#4` at rank ≤ 3

### Documentation

- [ ] All env vars from Section 2 added to the Reranking table in `docs/en/configuration.md` with correct defaults, valid ranges, and descriptions.
- [ ] `docs/en/retrieval.md` "Cross-Encoder Reranking" section updated: remove the "benchmark-only" status, add production opt-in instructions, GPU latency caveat, and `RERANK_CE_TIMEOUT_MS` fallback explanation.
- [ ] `docs/en/retrieval.md` "Production status" subsection updated to reflect `RERANK_CE_ENABLED=1` as a supported opt-in with documented latency caveats.

### Smoke test coverage

- [ ] `src/smoke/sections/20-ce-rerank-stub.js` passes all four assertions: stub path, timeout fallback, model-load failure fallback, numLabels fail-fast.
- [ ] `npm run smoke` exits 0 with section 20 included.
- [ ] No existing smoke section (01–19) regresses.

### Safe fallback verified end-to-end

- [ ] MCP server started with `RERANK_CE_ENABLED=1 RERANK_CE_TIMEOUT_MS=500`. Query sent that takes longer than 500 ms (achievable on CPU with `RERANK_CE_TOP_N=40`). Server returns a result (pre-CE list) without hanging or erroring. Stderr contains `[ce-rerank] timeout after 500ms`.
- [ ] MCP server started with `RERANK_CE_ENABLED=1 RERANK_CE_MODEL=/tmp/nonexistent`. Any query sent. Server returns a result (pre-CE list) without crashing. Stderr contains `[ce-rerank] model load failed:`.
- [ ] Query c50 (`"semidex підключення до PostgreSQL бази даних"`) sent with CE enabled against a clean corpus. Top-1 result does not contain any token from `['postgres', 'postgresql', 'connection', 'pool']`. Server does not crash on empty result set.
