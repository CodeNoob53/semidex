# ONNX Runtime CUDA Provider for Node.js — Research Summary (2026-05-17)

**Source:** Deep Research report, 2026-05-17
**Scope:** Provider support policy for semidex — docs and code behavior audit only.
No production runtime changes in this task.

---

## Platform Support Matrix

| Platform | Provider | Status |
|----------|----------|--------|
| Any OS | `cpu` | Default, safe, no extra setup |
| Windows (any GPU vendor) | `dml` | Recommended GPU path — bundled in `onnxruntime-node` |
| Linux x64 + NVIDIA | `cuda` | Opt-in, advanced/experimental — see setup below |
| Windows + NVIDIA CUDA | — | **Not supported** via prebuilt npm; requires custom ORT source build |

---

## Linux x64 + NVIDIA CUDA — Viable but Advanced

Official `onnxruntime-node` 1.26.x includes a Linux x64 postinstall manifest
(`cuda12`) that downloads `libonnxruntime_providers_cuda.so` and related provider
libraries from NuGet. This makes Linux CUDA the **only officially supported CUDA
path** for the standard npm package.

> **Note:** semidex currently pins `onnxruntime-node` 1.24.3 (see `package.json`).
> The 1.26.x CUDA postinstall path described here requires a dependency upgrade.
> Linux CUDA support is therefore documented as a forward-looking policy target,
> not a currently-tested configuration. Upgrade planning is a separate task.

**Target stack:** CUDA 12.x + cuDNN 9 + `onnxruntime-node` 1.26.x (upgrade required)

**Required setup (user responsibility):**

1. Install NVIDIA driver, CUDA 12.x toolkit, cuDNN 9.
2. Add CUDA `lib64` and cuDNN `lib` directories to `LD_LIBRARY_PATH`.
3. Confirm `nvcc` is in `PATH` and `CUDA_HOME` / `CUDNN_HOME` are set.
4. Install the npm package — postinstall will download the CUDA provider libraries.
5. Set `ONNX_EXECUTION_PROVIDER=cuda` and verify with a startup probe (see below).

**Status:** Advanced/experimental — upstream packaging is in transition.
The official Node.js binding docs still reference CUDA 11.8, while the 1.26.x
release scripts already enforce CUDA 12. Treat ORT minor releases cautiously.
semidex currently pins 1.24.3; this path requires upgrading to 1.26.x first.

---

## Windows CUDA — Not Supported

No official prebuilt Node.js binding exists for CUDA on Windows via `onnxruntime-node`.
Getting CUDA on Windows requires a full custom source build:

```
.\build.bat --config Release --parallel --use_cuda --build_nodejs \
  --cuda_home <...> --cudnn_home <...>
```

This requires Visual Studio/MSVC, Python, Node 20+, CUDA 12.x, cuDNN 9, and
consuming the locally-built binding via `npm install <onnxruntime_repo_root>/js/node/`.

**Semidex does not support this path.** On Windows — including NVIDIA GPUs — the
recommended GPU provider is `dml`.

There is also a third-party `onnxruntime-node-gpu` npm package, but it is frozen at
1.14.0 and unmaintained. Semidex must not depend on it.

---

## Startup Probe — Correct CUDA Verification

`resolveOnnxExecutionProviders('cuda')` already returns `['cuda']` (no `cpu` in list),
which would cause `InferenceSession.create()` to throw immediately if CUDA is
unavailable — the correct fail-fast behavior.

However, the current `load()` in `src/core/onnx-embed.js` **catches that failure and
silently retries with `['cpu']`**. This means a user who sets
`ONNX_EXECUTION_PROVIDER=cuda` on a system without CUDA will:
- see a single warning line
- get CPU inference silently
- have no runtime error

This is the current behavior gap. A future patch should:
- add an opt-in `ONNX_CUDA_STRICT=1` flag that converts the silent retry into a
  hard failure when the user explicitly requested CUDA
- or remove the silent CPU retry for `cuda` entirely and require the user to use
  `ONNX_EXECUTION_PROVIDER=cpu` explicitly as fallback

**The fallback-to-CPU behavior must not be treated as evidence that CUDA works.**
Correct validation is a startup probe with `executionProviders: ['cuda']` that
throws on failure:

```js
// Correct fail-fast probe (do not add 'cpu' to the list):
await ort.InferenceSession.create(modelPath, { executionProviders: ['cuda'] });
```

`['cuda', 'cpu']` is acceptable only when fallback is intentionally allowed — e.g.
benchmark experiments where you want CUDA if available and CPU otherwise.

---

## Two Types of Fallback — Important Distinction

**Provider-selection fallback:** ONNX Runtime iterates the `executionProviders` list,
initialises available ones, and uses the first that works. If `cuda` is not available
and `cpu` is in the list, it silently uses CPU. If `cuda` is the only entry and it
fails, `InferenceSession.create()` throws `no available backend found`.

**Operator-level fallback (within session):** Even when a CUDA session is created
successfully, some graph operators may be placed on CPU by the partitioner. This can
negate GPU throughput gains. Use verbose logging to verify full GPU placement:

```js
await ort.InferenceSession.create(modelPath, {
  executionProviders: ['cuda'],
  logSeverityLevel: 0,  // verbose — shows operator placement
});
```

---

## Performance Expectations

- **DML on Windows:** confirmed 3.19× length-bucketed speedup vs DML sequential,
  4.61× vs CPU sequential on the semidex fixture corpus (2026-05-17 benchmark).
- **CUDA on Linux:** likely beneficial for BGE-M3 encoder batching (same class of
  transformer workload), but no semidex-specific benchmark exists yet.
- **CUDA vs DML (same NVIDIA GPU):** CUDA is a more specialised path and a likely
  candidate for higher throughput ceiling, but no authoritative same-hardware
  Node.js comparison for BGE-M3 has been found. Measure locally before claiming
  specific speedup numbers.
- **TF32 on Ampere+:** CUDA EP enables TF32 by default on Ampere and later GPUs.
  The Node.js `CudaExecutionProviderOption` API exposes only `deviceId` — there is
  no public JS surface to disable `use_tf32`. Minor FP differences vs CPU/DML are
  expected.

---

## ONNX Runtime Install Note (Linux CPU-Only)

`onnxruntime-node` 1.26.x on Linux x64 may pull CUDA provider libraries during
postinstall even when only CPU is needed (semidex currently pins 1.24.3; verify
this behavior after upgrading). To skip GPU bits on a CPU-only Linux server:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm install
```

Verify correct behavior with `ONNX_EMBED=1` after manual model placement.

---

## Artifacts

- Research source: `C:\Users\Aorus\Downloads\deep-research-report (7).md`
- Provider code: `src/core/onnx-embed.js` — `resolveOnnxExecutionProviders()`
- Configuration docs: `docs/en/configuration.md` — `ONNX_EXECUTION_PROVIDER` section
- Operations docs: `docs/en/operations.md` — provider troubleshooting table
- Strict probe design: `benchmarks/retrieval/results/2026-05-17-onnx-cuda-strict-probe-design.md`
