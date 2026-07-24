# Windows Node CUDA feasibility

Date: 2026-07-24

## Question

Can semidex run its existing BGE-M3 ONNX embedder through the native NVIDIA
CUDA Execution Provider from Node.js on Windows?

## Verdict

**Feasible and verified with the official ONNX Runtime 1.26.0 CUDA 13 native
package plus a locally compiled Node binding.**

Installing the NVIDIA driver or CUDA Toolkit does not add CUDA support to the
standard Windows `onnxruntime-node` package. The binding itself must be built
with CUDA enabled, and the matching CUDA and cuDNN runtime libraries must be
available.

The original full-source build approach was unnecessary. Microsoft publishes
the CUDA-enabled Windows native runtime, so only the small Node addon needs to
be compiled locally. No production default should change until output
equivalence and provider performance benchmarks pass.

## Evidence

### Official package support

The ONNX Runtime Node.js support matrix lists:

- Windows x64: CPU, DirectML, and WebGPU prebuilt providers;
- Linux x64: CUDA prebuilt provider;
- Windows x64 CUDA: no prebuilt Node binding.

Source:
https://onnxruntime.ai/docs/get-started/with-javascript/node.html

### Installed npm package

semidex pins `onnxruntime-node@1.24.3`.

The installed Windows package contains:

- `onnxruntime_binding.node`;
- `onnxruntime.dll`;
- DirectML runtime DLLs;
- no CUDA provider DLL.

The zero-model registration probe produced:

```text
cuda: no available backend found. ERR: [cuda] backend not found.
dml:  model file does not exist
cpu:  model file does not exist
```

This is significant because the probe uses a deliberately missing model. DML
and CPU accept the provider option and then fail while opening the model. CUDA
fails earlier because the binding has no CUDA backend.

Run the reproducible probe with:

```powershell
npm run probe:onnx-cuda
```

Use `node benchmarks/onnx-cuda-registration-probe.mjs --require-cuda` in CI or
a custom-runtime verification step when CUDA registration is mandatory.

Set `ONNXRUNTIME_NODE_PATH` to probe a custom binding without replacing the
project dependency:

```powershell
$env:ONNXRUNTIME_NODE_PATH = '<onnxruntime-source>\js\node'
node benchmarks/onnx-cuda-registration-probe.mjs --require-cuda
```

The same variable is honored by semidex's production ONNX embedder. Combine it
with strict CUDA selection to prevent an unnoticed CPU fallback:

```powershell
$env:ONNXRUNTIME_NODE_PATH = '<onnxruntime-source>\js\node'
$env:ONNX_EXECUTION_PROVIDER = 'cuda'
$env:ONNX_CUDA_STRICT = '1'
```

### Correct Windows build path

Microsoft publishes
`onnxruntime-win-x64-gpu_cuda13-1.26.0.zip`. It contains:

```text
onnxruntime.dll
onnxruntime.lib
onnxruntime_providers_cuda.dll
onnxruntime_providers_shared.dll
```

The Node binding is a thin addon linked to `onnxruntime.dll`. Its CMake build
accepts an existing native runtime through `ONNXRUNTIME_BUILD_DIR`, and CUDA
registration is enabled by `USE_CUDA`. The successful path was:

1. Use ONNX Runtime source tag `v1.26.0`.
2. Download the matching official Windows CUDA 13 archive.
3. Place its runtime/import libraries in `<native-stage>\Release`.
4. Build only `js/node` with:

```powershell
npm run build -- --config=Release `
  --onnxruntime-build-dir="<native-stage>" `
  --use_cuda `
  --dll_deps="<native-stage>\Release\onnxruntime_providers_shared.dll;<native-stage>\Release\onnxruntime_providers_cuda.dll"
```

This binding build completed in seconds. The abandoned full-source build spent
most of its time compiling CUDA attention kernels and is not the recommended
Semidex setup path.

Sources:

- https://github.com/microsoft/onnxruntime/releases/tag/v1.26.0
- https://github.com/microsoft/onnxruntime/blob/v1.26.0/js/node/CMakeLists.txt
- https://github.com/microsoft/onnxruntime/blob/v1.26.0/js/node/script/build.ts

## Machine audit

Observed environment:

| Component | Observed | CUDA build readiness |
|---|---|---|
| GPU | NVIDIA GeForce RTX 3080, 10 GB | suitable |
| NVIDIA driver | 610.47 | suitable |
| CUDA Toolkit | 13.3 installed | verified |
| CUDA runtime path | supplied explicitly to the probe process | verified |
| cuDNN | 9.25 installed | verified |
| Visual Studio C++ tools | installed | suitable |
| CMake / Ninja | bundled with Visual Studio, not in global `PATH` | suitable with explicit paths |
| Node.js | 25.2.1 | binding compiled and loaded successfully |

Global environment variables are not required for the spike. The binding and
probe can receive CUDA and cuDNN directories through their child-process
`PATH`.

## Live verification

Strict session creation used only `executionProviders: ['cuda']`, with no CPU
fallback:

```text
onnxruntime-node: 1.26.0
CUDA-only BGE-M3 session creation: 5618 ms
first CUDA inference: 290 ms
dense output: [1, 1024]
sparse output: [1, 3, 1]
```

ONNX Runtime warned that shape-related nodes were assigned to CPU. This is
expected provider partitioning and does not mean the embedding graph fell back
to CPU.

## Provider benchmark

The benchmark uses 20 fixed English, Ukrainian, mixed-language, and
configuration-token texts. Tokenization is prepared once in a separate
process, so timed runs measure ONNX inference rather than tokenizer overhead.
Each provider is strict (one provider only, no CPU fallback), requests only
`dense_vecs` and `sparse_vecs`, and uses the production-like length-bucketed
workload with batches of at most four texts.

| Runtime | Provider | Init | Mean 20-text pass | Mean per text | Relative result |
|---|---|---:|---:|---:|---:|
| ORT 1.26.0 custom | CPU | 1212 ms | 1409.1 ms | 70.5 ms | baseline |
| ORT 1.26.0 custom | CUDA | 1689 ms | 73.8 ms | 3.7 ms | **19.10x faster than CPU 1.26** |
| ORT 1.24.3 project | CPU | 1424 ms | 1397.7 ms | 69.9 ms | baseline |
| ORT 1.24.3 project | DirectML | 2148 ms | 637.5 ms | 31.9 ms | **2.19x faster than CPU 1.24** |

The earlier sequential result (`DirectML 1559.2 ms`, `CPU 1348.5 ms`) was a
real measurement of the wrong workload, not evidence that DirectML is slower
than CPU. It submitted 20 separate batch-1 tensors whose sequence length
changed almost every call (7-76 tokens). BGE-M3 exposes dynamic
`batch_size` and `sequence_length` dimensions. DirectML is particularly
sensitive to changing input shapes because graph work and GPU dispatch costs
cannot be amortized effectively.

The same 20 prepared inputs demonstrate the effect:

| Workload | CPU | DirectML | DirectML vs CPU |
|---|---:|---:|---:|
| Variable shape, 20 sequential calls | 1806.4 ms | 2094.4 ms | 0.86x |
| Production length buckets, max batch 4 | 1320.0 ms | 654.2 ms | **2.02x** |
| One padded batch, shape `[20, 76]` | 2943.1 ms | 105.1 ms | **28.00x** |

The one-batch row is a capacity diagnostic, not a recommended CPU workload:
padding every short input to the longest sequence wastes CPU work. It proves
that DirectML itself is healthy and that shape churn, not GPU execution, caused
the misleading result.

Shape-controlled measurements confirm the same pattern:

| Shape | CPU | DirectML | DirectML vs CPU |
|---|---:|---:|---:|
| `[1, 32]` | 71.5 ms | 12.6 ms | 5.67x |
| `[1, 128]` | 254.0 ms | 17.1 ms | 14.85x |
| `[1, 256]` | 511.3 ms | 25.9 ms | 19.74x |
| `[1, 512]` | 1116.1 ms | 46.2 ms | 24.16x |
| `[4, 256]` | 2021.2 ms | 75.2 ms | 26.88x |
| `[8, 256]` | 3721.2 ms | 138.5 ms | 26.87x |

Explicit `freeDimensionOverrides` improved DirectML only slightly for repeated
fixed shapes (`25.9 -> 25.0 ms` at `[1, 256]`; `75.2 -> 73.9 ms` at
`[4, 256]`). The important correction is batching and reducing shape churn,
not hard-coding one global tensor shape.

The model uses ONNX opset 17, below DirectML's documented opset-20 ceiling.
Sessions now explicitly use sequential execution and disable memory patterns,
as required by the DirectML Execution Provider documentation:
https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html

CUDA and DirectML cannot currently be loaded from the same Windows Node
runtime artifact: the project package provides CPU + DirectML, while the
custom 1.26 binding provides CPU + CUDA. CPU/CUDA performance and equivalence
are therefore compared within ORT 1.26; CPU/DirectML within ORT 1.24.3. CPU
performance is effectively the same between those versions. On the same
bucketed fixture, CUDA is approximately 8.64x faster than DirectML.

### Output equivalence

CPU 1.26 vs CUDA 1.26:

| Output | Minimum cosine | Maximum absolute delta | Maximum mean absolute delta |
|---|---:|---:|---:|
| dense | 0.9999995994 | 0.00011336 | 0.00002248 |
| sparse | 0.9999999122 | 0.00018803 | 0.00005902 |

CPU 1.24.3 vs DirectML 1.24.3:

| Output | Minimum cosine | Maximum absolute delta | Maximum mean absolute delta |
|---|---:|---:|---:|
| dense | 0.999999999994 | 0.000000380 | 0.000000084 |
| sparse | 0.999999999998 | 0.000000648 | 0.000000178 |

These differences are floating-point execution differences, not a meaningful
embedding change. Provider switching does not require reindexing based on
this fixture.

### Bounded process stability

Three additional CUDA processes each created a fresh session, performed one
warmup plus three measured passes, released the session, and exited:

| Run | Init | Mean 20-text pass | Process RSS | VRAM before/after exit |
|---|---:|---:|---:|---:|
| 1 | 1541 ms | 163.6 ms | 650.3 MiB | 1091 / 1088 MiB |
| 2 | 1457 ms | 140.3 ms | 650.2 MiB | 1088 / 1088 MiB |
| 3 | 1428 ms | 149.6 ms | 650.2 MiB | 1088 / 1092 MiB |

No process remained after the runs and post-exit VRAM stayed within 4 MiB of
the observed baseline. This passes a bounded smoke check, not a multi-hour
soak test.

Reproduce:

```powershell
node benchmarks/onnx-provider-bench.js --prepare-inputs

$env:ONNX_BENCH_MODEL_DIR = '<repo>\models\bge-m3-onnx'
$env:PROVIDERS = 'cpu'
$env:ONNX_BENCH_WORKLOAD = 'bucketed'
$env:ONNX_BENCH_BATCH_SIZE = '4'
$env:WARMUP_RUNS = '2'
$env:BENCH_RUNS = '10'
$env:BENCH_JSON_OUT = '.tmp\provider-results\cpu.json'
node benchmarks/onnx-provider-bench.js

$env:ONNXRUNTIME_NODE_PATH = '<onnxruntime-source>\js\node'
$env:PROVIDERS = 'cuda'
$env:BENCH_JSON_OUT = '.tmp\provider-results\cuda.json'
node benchmarks/onnx-provider-bench.js

node benchmarks/compare-onnx-provider-results.mjs `
  .tmp\provider-results\cpu.json `
  .tmp\provider-results\cuda.json
```

## Acceptance gate

CUDA support is accepted only when all of the following pass:

1. Custom-runtime probe reports CUDA as registered. **Passed.**
2. Strict BGE-M3 session creation succeeds with CUDA only. **Passed.**
3. A real dense+sparse inference succeeds. **Passed.**
4. Dense and sparse outputs remain numerically equivalent to CPU. **Passed.**
5. Provider benchmark reports actual CUDA, not `cpu (fallback)`. **Passed.**
6. DirectML beats CPU on the production-like bucketed workload. **Passed.**
7. CUDA beats DirectML on the same bucketed input fixture. **Passed**, with
   the runtime-version caveat documented above.
8. Repeated runs do not leak RAM or VRAM. **Bounded smoke passed; long soak
   remains pending.**

## Product decision

The technical path is proven, but the official npm package still does not ship
Windows CUDA. Semidex should not ask end users to install Visual Studio and
compile the addon manually. If benchmarks justify CUDA, package the matching
binding and official runtime DLLs as a versioned optional Semidex artifact or
provide an automated setup command with checksum verification.

The measured CUDA and DirectML speedups are specific to this BGE-M3 graph and
machine. DirectML should remain the portable Windows GPU path, while CUDA is
the NVIDIA performance path. Before promoting either provider broadly, test
real chunk distributions and tune bucket boundaries/batch size; query-time
single-text inference also needs fixed-shape or padded buckets to avoid the
same DirectML shape-churn penalty.

Before making CUDA a production option, add a versioned optional runtime
artifact, checksum verification, provider diagnostics, and a larger
batch/long-document benchmark.
