# ONNX CUDA Strict Probe — Design Report (2026-05-17)

**Scope:** Stage 1 implemented (2026-05-17). Stage 2 (`ONNX_CUDA_STRICT=1`) implemented (2026-05-17).
**Context:** Companion to `2026-05-17-onnx-cuda-node-provider-research.md`.

---

## 1. Current Behavior When `ONNX_EXECUTION_PROVIDER=cuda` Fails

### Code path (`src/core/onnx-embed.js`)

```
load()
  resolveOnnxExecutionProviders('cuda')  → ['cuda']
  ort.InferenceSession.create(modelPath, { executionProviders: ['cuda'], ... })
    → throws  "no available backend found" (or similar ORT error)
  catch (err):
    if (providers[0] === 'cuda'):
      stderr.write("[onnx] CUDA provider unavailable (...) — retrying with cpu")
      ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], ... })
      stderr.write("[onnx] session created with cpu fallback")
      ← returns silently; session is now CPU
    else:
      throw err  ← only non-CUDA errors propagate
```

### Where CPU fallback is introduced

`src/core/onnx-embed.js`, `load()`, lines 132–143.

The catch block unconditionally retries with `['cpu']` when `providers[0] === 'cuda'`. No mechanism exists to suppress this retry. The user must inspect stderr manually and look for the phrase `retrying with cpu`.

### What the user sees

1. `[onnx] creating inference session (providers: cuda)...`
2. `[onnx] CUDA provider unavailable (...) — retrying with cpu`
3. `[onnx] session created with cpu fallback`
4. `[onnx] ready. outputs: ...`

Indexing proceeds on CPU. No error is thrown. No exit code change.

### Two failure modes that are NOT distinguished today

| Failure mode | Symptom | Current behavior |
|---|---|---|
| CUDA EP missing (libraries not installed) | ORT throws at `create()` | Silent CPU retry |
| CUDA session created, but some ops fall back to CPU (operator-level fallback) | No error | Not detected at all |

The current warning text does not distinguish these two cases and gives no guidance on what to do.

---

## 2. What Strict Mode Should Do

Strict mode converts the silent CPU retry into a hard failure. When the user has explicitly requested `cuda`, a failure to load CUDA should:

1. Print an **actionable error message** — what went wrong, platform context, and how to fix it.
2. **Exit with code 1** — the process must not proceed with CPU when the user expected GPU.
3. Not attempt CPU retry.

The key invariant: **if CUDA was requested and CUDA is unavailable, the user must be told explicitly.**

---

## 3. Opt-in vs Default

### Recommendation: opt-in via `ONNX_CUDA_STRICT=1`, with a path to making it default for `cuda`

Rationale:

- Making strict mode **default immediately** is a breaking change for any user who already has `ONNX_EXECUTION_PROVIDER=cuda` in `.env` on a system where CUDA is misconfigured. They would get a hard failure instead of working (CPU) indexing.
- However, the current silent fallback is genuinely misleading — users think CUDA is running when it is not.
- The staged approach (opt-in → default) respects existing users while moving toward the correct behavior.
- `ONNX_CUDA_STRICT` (provider-specific) is preferred over `ONNX_PROVIDER_STRICT` (generic) because the only provider with a semidex-level silent retry is `cuda`. DML does not use the semidex catch/retry block — `resolveOnnxExecutionProviders('dml')` returns `['dml', 'cpu']`, so ORT's own provider-selection logic handles the DML→CPU fallback transparently. There is no semidex catch block that intercepts a DML failure. Making a generic flag would conflate these two different fallback mechanisms.

### Preferred env name: `ONNX_CUDA_STRICT=1`

---

## 4. Staged Plan

### Stage 1 — docs + doctor probe only (no indexing behavior change) ✅ implemented

**Goal:** give users a way to verify CUDA before trusting it, without changing any indexing path.

Changes:
- Add a new doctor check in `[F] ONNX / GPU` (new section, after `[E] Local files`):
  - If `ONNX_EMBED=1` and `ONNX_EXECUTION_PROVIDER=cuda`:
    - Attempt `ort.InferenceSession.create(modelPath, { executionProviders: ['cuda'] })`.
    - On success: `PASS — CUDA session created`.
    - On failure: `WARN — CUDA unavailable` with actionable detail (see §5).
    - Note: doctor is read-only — do not run inference; just probe session creation.
  - If `ONNX_EXECUTION_PROVIDER=dml`: report the provider but no probe (DML probe requires Windows).
  - If CPU: `SKIP — CUDA probe not applicable`.
- Update `docs/en/configuration.md` and `docs/en/operations.md` to mention the doctor probe.
- No indexing behavior change.

**Model path — resolved:** Stage 1 extracted two side-effect-free modules: `src/core/onnx-paths.js` (exports `ONNX_CACHE_DIR`, `ONNX_MODEL_DIR`, `getOnnxModelPath()` — no `ort` import, no `mkdirSync`) and `src/core/onnx-provider-probe.js` (exports `probeOnnxProvider(providers, modelPath)` — attempts session creation without CPU retry). `src/doctor.js` imports from these modules directly, leaving `onnx-embed.js` free of doctor-triggered side effects.

### Stage 2 — `ONNX_CUDA_STRICT=1` flag ✅ implemented

**Goal:** make CUDA failures hard-fail during indexing when the user explicitly opts in.

Changes in `src/core/onnx-embed.js`, `load()`:
```js
const strict = process.env.ONNX_CUDA_STRICT === '1';

try {
  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: providers,
    graphOptimizationLevel: 'all',
  });
} catch (err) {
  if (providers[0] === 'cuda') {
    const msg = buildCudaErrorMessage(err, strict);
    process.stderr.write(msg);
    if (strict) throw new Error('CUDA session creation failed (ONNX_CUDA_STRICT=1)');
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    process.stderr.write('[onnx] session created with cpu fallback\n');
  } else {
    throw err;
  }
}
```

`buildCudaErrorMessage(err, strict)` (see §5) returns platform-aware error text. It lives in `onnx-embed.js` or a new `src/core/onnx-provider-errors.js` for testability.

### Stage 3 — make strict the default for `cuda` (future)

**Prerequisite:** Linux CUDA path has been tested in CI or a real deployment, confirmed reliable.

Changes:
- `ONNX_CUDA_STRICT` default becomes `1` when `ONNX_EXECUTION_PROVIDER=cuda`.
- Introduce `ONNX_CUDA_STRICT=0` as an explicit opt-out for users who want the legacy silent fallback.
- Update docs.

**Do not implement Stage 3 until Linux CUDA has been validated end-to-end on at least one real setup.**

---

## 5. Error Message Design

### Design requirements

- Actionable — tell the user exactly what to do.
- No raw ORT stack traces by default (the underlying `err.message` may be included in a one-line detail).
- Points to `docs/en/configuration.md`.
- Mentions `ONNX_EXECUTION_PROVIDER=cpu` as the explicit fallback option.
- Platform-aware: Windows and Linux get different instructions.
- Does not need to be i18n'd (developer-facing error).

### Platform detection

```js
const isWindows = process.platform === 'win32';
```

### Draft error text

**A. CUDA EP unavailable on Windows (most common case):**

```
[onnx] CUDA provider unavailable on Windows via prebuilt npm.
       CUDA is not supported via onnxruntime-node on Windows — use dml for GPU acceleration instead:
         ONNX_EXECUTION_PROVIDER=dml

       To suppress this error and use CPU:
         ONNX_EXECUTION_PROVIDER=cpu

       See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER
```

**B. CUDA EP unavailable on Linux (libraries missing or wrong CUDA/cuDNN version):**

```
[onnx] CUDA provider unavailable: <err.message (one line)>
       CUDA on Linux requires CUDA 12.x + cuDNN 9 + LD_LIBRARY_PATH pointing to their lib dirs.
       Setup steps:
         1. Verify NVIDIA driver: nvidia-smi
         2. Verify CUDA: nvcc --version  (must be 12.x)
         3. Set LD_LIBRARY_PATH to include CUDA lib64 and cuDNN lib
         4. Re-run indexing

       To suppress this error and use CPU:
         ONNX_EXECUTION_PROVIDER=cpu

       See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER
```

**C. CPU fallback occurred (non-strict mode, existing behavior — improved text):**

```
[onnx] CUDA provider unavailable — falling back to CPU.
       Set ONNX_CUDA_STRICT=1 to fail on CUDA load errors instead of retrying.
       See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER
```

**D. Strict mode triggered (Stage 2+):**

The strict-mode error is thrown as a `new Error(...)` that surfaces to the caller. The message:

```
CUDA session creation failed — ONNX_EXECUTION_PROVIDER=cuda was set but CUDA is unavailable.
See docs/en/configuration.md — ONNX_EXECUTION_PROVIDER for platform requirements.
```

This becomes the thrown error's message; the indexer or CLI entry point will print it via the existing error handler.

---

## 6. Doctor Integration Plan (Stage 1)

### New check section: `[F] ONNX / GPU`

Location in `src/doctor.js`: after the existing `[E] Local files` block.

**Condition:** only runs when `ONNX_EMBED=1` (or `DENSE_PROVIDER=bge-m3-onnx`).

**Checks:**

| Check | Condition | Result |
|---|---|---|
| Execution provider reported | always (when ONNX active) | PASS — informational |
| CUDA probe | `ONNX_EXECUTION_PROVIDER=cuda` and model cache present | PASS / WARN |
| CUDA probe skipped | `ONNX_EXECUTION_PROVIDER=cuda` but model not cached | SKIP — model not downloaded yet |
| DML note | `ONNX_EXECUTION_PROVIDER=dml` | PASS — informational (no probe needed) |
| CPU note | `ONNX_EXECUTION_PROVIDER=cpu` or unset | PASS — informational |

**CUDA probe logic (pseudo-code):**

```js
import * as ort from 'onnxruntime-node';
import { MODEL_PATH } from './core/onnx-embed.js'; // must be exported in Stage 1

if (ep === 'cuda') {
  if (!existsSync(MODEL_PATH)) {
    report('F', makeResult(STATUS.SKIP, 'CUDA probe', 'model not cached — download first'));
  } else {
    try {
      const sess = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['cuda'],
      });
      await sess.release();
      report('F', makeResult(STATUS.PASS, 'CUDA session probe — CUDA is available'));
    } catch (err) {
      report('F', makeResult(STATUS.WARN,
        'CUDA session probe failed — CUDA provider unavailable',
        buildCudaDetailLine(err)));
    }
  }
}
```

**Detail line** (`buildCudaDetailLine`): one-line platform summary + the ORT error message truncated to ~120 chars.

### What doctor does NOT do

- Does not run inference (no tokenizer load, no real tensors).
- Does not download the model.
- Does not modify `.env` or any config.
- Does not probe operator-level fallback (that requires a real inference run with verbose logging — too expensive for doctor).

---

## 7. Operator-Level Fallback — Scope Note

Provider-selection fallback (CUDA → CPU at session creation) is what Stage 1–2 address.

Operator-level fallback is different: CUDA session creates successfully, but ORT's graph partitioner places some ops on CPU because they lack CUDA kernels. This is silent by design in ORT and cannot be detected without verbose logging (`logSeverityLevel: 0`). Symptoms: CUDA session active but inference is slower than expected.

**This task does not design a fix for operator-level fallback.** The research report already documents the verbose logging probe. A future benchmark task can validate full-GPU placement on a real Linux CUDA setup.

---

## 8. Windows CUDA — Confirmed Not Supported

This design does not change the Windows CUDA stance:

- On Windows, `ONNX_EXECUTION_PROVIDER=cuda` is an unsupported configuration.
- The error messages in §5 explicitly route Windows users to `dml`.
- No Windows CUDA support is planned in semidex until there is an official prebuilt `onnxruntime-node` path for CUDA on Windows.

---

## 9. Linux CUDA — Remains Opt-In / Experimental

- `ONNX_EXECUTION_PROVIDER=cuda` remains opt-in and advanced.
- Linux CUDA is the only officially supported CUDA path via `onnxruntime-node` 1.26.x (semidex currently pins 1.24.3 — upgrade is a prerequisite for this path).
- Strict mode (Stage 2) does not change the supported-platform set — it only makes failures visible.
- Stage 3 (strict-by-default) requires real Linux CUDA validation before being considered.

---

## 10. Files Changed

| File | Stage | Change | Status |
|---|---|---|---|
| `src/core/onnx-paths.js` | 1 | New: side-effect-free path constants + `getOnnxModelPath()` | ✅ |
| `src/core/onnx-provider-probe.js` | 1 | New: `probeOnnxProvider(providers, modelPath)` | ✅ |
| `src/core/onnx-embed.js` | 1 | Import paths from `onnx-paths.js`; move `mkdirSync` into `load()` | ✅ |
| `src/core/doctor-checks.js` | 1 | Add `cudaProbeGuidance()`, `formatCudaProbeFailure()` | ✅ |
| `src/doctor.js` | 1 | Add `[F] ONNX / GPU` section with CUDA probe | ✅ |
| `src/smoke/sections/19-doctor-checks.js` | 1 | Add assertions 19k–19l for new pure helpers | ✅ |
| `src/core/onnx-embed.js` | 2 | Add `ONNX_CUDA_STRICT` gate in `load()` | ✅ |
| `src/core/doctor-checks.js` | 2 | Add `isCudaStrict()`, `buildCudaStrictError()` | ✅ |
| `src/smoke/sections/19-doctor-checks.js` | 2 | Add assertions 19m–19n | ✅ |
| `docs/en/configuration.md` | 1–2 | Doctor probe documented; strict mode section added | ✅ |
| `docs/en/operations.md` | 1–2 | Troubleshooting row updated for doctor probe and strict flag | ✅ |

---

## 11. Artifacts

- Research background: `benchmarks/retrieval/results/2026-05-17-onnx-cuda-node-provider-research.md`
- Current code: `src/core/onnx-embed.js` — `load()` lines 115–147
- Doctor runner: `src/doctor.js` — section [E] ends at line 351
- Doctor checks module: `src/core/doctor-checks.js`
- Configuration docs: `docs/en/configuration.md` — `ONNX_EXECUTION_PROVIDER` section (line 70+)
- Operations docs: `docs/en/operations.md` — troubleshooting table (CUDA row)
