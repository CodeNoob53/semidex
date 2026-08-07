# Windows: managed CUDA runtime installer

Semidex has run BGE-M3 embeddings via CUDA on Windows before, but for a long
time the only working build lived in a local, gitignored directory with no
documented, reproducible way to recreate it. This installer replaces that
with a versioned, cryptographically-anchored, one-command build that installs
into a real per-user application-data directory outside the repo, without
touching CPU/DirectML behavior or committing any binaries to git.

See [`configuration.md`'s Platform comparison: CUDA support](./configuration.md#platform-comparison-cuda-support)
for how this differs from Linux, where the plain npm package already ships a
CUDA path upstream.

## Prerequisites

The installer checks most of these itself and reports what's missing; get
each item genuinely working before running it, not just installed:

- **Windows 10/11, 64-bit.**
- **Node.js and npm** — the same version semidex itself requires.
- **CMake** and **Visual Studio C++ Build Tools** (the `onnxruntime-node`
  binding is CMake-based, not `node-gyp`) — on PATH as `cmake`, with a real
  MSVC toolchain installed.
- **`git`** — on PATH.
- **An NVIDIA GPU with a working driver.** The installer runs `nvidia-smi`
  as part of its prerequisite check; `npm run doctor`'s "GPU-stack
  prerequisites (informational)" line surfaces the same check independent
  of the installer.
- **CUDA Toolkit**, matching the CUDA major version you're building for
  (13 for the default locked combination).
- **cuDNN**, installed under the CUDA Toolkit directory (NVIDIA's own
  installer places it at `C:\Program Files\NVIDIA\CUDNN\v<version>\bin\<cuda-major.minor>\x64\`
  by default) — the installer locates the `cudnn64_*.dll` itself and records
  the exact directory it found into the runtime's own manifest; it does not
  guess or hardcode this path anywhere else.

Run `npm run doctor` first — its GPU-stack prerequisites line reports real
driver/toolkit/cuDNN presence before you invest time in a build that can't
succeed.

## Install command

From the repo root, in PowerShell:

```powershell
.\scripts\install-onnxruntime-cuda-windows.ps1
```

With no arguments, this installs the **default locked combination** — ONNX
Runtime 1.26.0, CUDA 13 — using the exact source commit and release-asset
checksum recorded in the committed `scripts/onnxruntime-cuda-lock.json`
(not a movable tag, not a runtime-computed guess). It:

1. Checks prerequisites (Windows x64, Node/npm/CMake/git, NVIDIA driver,
   CUDA Toolkit, cuDNN).
2. Checks out `microsoft/onnxruntime` at the locked commit and verifies
   `git rev-parse HEAD` matches it exactly before building anything.
3. Downloads the official Microsoft release asset for the CUDA runtime DLLs
   and verifies its SHA-256 against the locked value.
4. Runs `npm ci` + `npm run build -- --use_cuda` inside `js/node/` to
   compile the Node.js binding (`onnxruntime_binding.node`) against your
   local CUDA Toolkit.
5. Stages the four runtime artifacts (`onnxruntime.dll`,
   `onnxruntime_binding.node`, `onnxruntime_providers_cuda.dll`,
   `onnxruntime_providers_shared.dll`) plus a `manifest.json` recording
   full provenance and per-file SHA-256 checksums.
6. Performs a **transactional install**: stages into a same-volume
   `install-stage-<timestamp>` directory, then atomically swaps it into
   place. If a prior version is already installed, it's backed up first
   and only deleted after the new build proves itself (step 7) — a failed
   rebuild never leaves you without a previously-working runtime.
7. Runs a **real strict CUDA session probe** against the newly-installed
   runtime — never assumes success from "the files copied". On failure,
   the broken build is kept on disk (renamed aside, not deleted) for
   inspection, and any prior working runtime is restored.
8. Prints the exact `ONNXRUNTIME_NODE_PATH` you'd use if you ever choose
   manual configuration instead of the managed selection (see below).

Re-running the same command is **idempotent**: if an identical, intact
runtime is already installed, it skips the rebuild and just re-runs the
probe (unless `-Force`).

### Installing a different ORT/CUDA combination

Any combination not in the committed lock file requires you to supply real
trust anchors yourself — the installer never resolves a tag to a commit and
trusts that resolution on your behalf:

```powershell
.\scripts\install-onnxruntime-cuda-windows.ps1 `
  -OrtVersion 1.27.0 -CudaMajor 13 `
  -ExpectedSourceCommit <40-hex-char-git-commit-sha> `
  -ExpectedSha256 <64-hex-char-release-asset-sha256>
```

- `-ExpectedSourceCommit` is **always required** for a non-locked
  combination — no flag combination bypasses this.
- For the release-asset checksum specifically, either supply
  `-ExpectedSha256`, or pass `-AllowUnverifiedDownload` to proceed without
  a pre-known hash (this governs only the checksum gap, never the source
  commit). Without `-NonInteractive`, `-AllowUnverifiedDownload` prompts
  once before downloading.

### Other flags

| Flag | Effect |
|---|---|
| `-SemidexHome <path>` | Overrides the install root. Defaults to `$env:SEMIDEX_HOME`, or `%LOCALAPPDATA%\semidex` if unset. |
| `-Force` | Skips the idempotent-skip check and always rebuilds. |
| `-SkipProbe` | Installs without running the end-of-run CUDA probe — the manifest's `verification.status` stays `'unverified'` until a probe runs later (Admin UI "Test CUDA configuration", or re-running without `-SkipProbe`). |
| `-WorkDir <path>` | Build/staging working directory (source checkout + native build output). May be on a different drive than `-SemidexHome`. Defaults to `%TEMP%\semidex-ort-build-<version>`. |
| `-NonInteractive` | Suppresses the `-AllowUnverifiedDownload` confirmation prompt. |

## Runtime install location

```
%LOCALAPPDATA%\semidex\runtimes\onnxruntime-node-cuda\<ortVersion>-cuda<cudaMajor>\
  onnxruntime.dll
  onnxruntime_binding.node
  onnxruntime_providers_cuda.dll
  onnxruntime_providers_shared.dll
  manifest.json
```

`manifest.json` records the exact source commit, release-asset URL/checksum,
per-artifact SHA-256, the cuDNN bin directory the installer found and
verified, and a `verification` block — see [Verification and `verification.status`](#verification-and-verificationstatus)
below.

This is a real per-user Windows application-data directory
(`%LOCALAPPDATA%`), the same convention semidex's own config/settings
already use — outside the repo, never touched by `git clean`, and
independent of where the ONNX model cache (`<repo>/models/`) lives (that
location is unrelated and unaffected by this installer).

## Configuring semidex to use it

Two independent ways to select a runtime — never mixed at the storage
layer, but resolved with a clear precedence at load time (explicit path
always wins over a managed selection, which always wins over the default
npm package):

**Managed selection (recommended)** — Admin UI → Global Settings →
Embeddings & hardware → "Managed CUDA runtime" (visible once
`ONNX_EXECUTION_PROVIDER=cuda` is selected). Lists every installed,
intact runtime with its verification status. Selecting one sets
`ONNX_MANAGED_RUNTIME` to the runtime's own validated id
(`<ortVersion>-cuda<cudaMajor>`) — re-validated (format + on-disk
integrity) on every use, not just at selection time. This dropdown is
disabled whenever a custom runtime path (below) is also set, since an
explicit path always overrides a managed selection.

**Manual path** — set `ONNXRUNTIME_NODE_PATH` to the exact directory the
installer printed, either in `.env`/the OS environment or the Admin UI's
"Custom ONNX Runtime module path (CUDA)" field. This is the same setting
used for a hand-built or third-party custom runtime — the managed
installer is one way to produce a value for it, not a separate mechanism.

Either way, semidex applies the required cuDNN bin directory to this
**process's own PATH only**, once, right before the ONNX Runtime binding
is actually loaded — it never modifies your system or user PATH. If the
recorded cuDNN directory has moved or been deleted since install, semidex
reports a clear diagnostic rather than silently falling back to CPU; re-run
the installer to repair the managed runtime.

Both settings take effect on the next restart (`appliesAt: next_restart`)
and never trigger a reindex — selecting a runtime only changes inference
speed, never the embedding model or vector schema.

## Verification and `verification.status`

A managed runtime's manifest carries its own `verification` block,
completely separate from the artifact-checksum integrity check:

- **`artifacts` + checksum verification** answers "are the files on disk
  intact and unmodified since install" — checkable without ever loading
  ONNX Runtime.
- **`verification.status`** answers "did CUDA actually work, the last time
  anyone tested it" — set to `'verified'` or `'failed'` **only** by a real
  CUDA `InferenceSession` creation attempt, never inferred from the files
  being present or the manifest parsing correctly. It's `'unverified'`
  immediately after a `-SkipProbe` install, until a real probe runs.

Every real probe against a managed runtime — the installer's own
end-of-run probe, and every manual "Test CUDA configuration" click in the
Admin UI against a managed selection — writes the real outcome back into
this same block, so it always reflects the most recent real test, not a
stale install-time snapshot.

Run the probe any time via the Admin UI, or:

```bash
npm run doctor
```

## Uninstall / cleanup

Delete the versioned runtime directory:

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\semidex\runtimes\onnxruntime-node-cuda\<ortVersion>-cuda<cudaMajor>"
```

If `ONNX_MANAGED_RUNTIME` was pointing at the deleted version, semidex falls
back to the default npm package (CPU/DirectML) on the next restart, with a
clear warning rather than a silent failure — re-select or clear the setting
in the Admin UI once you've removed the runtime it referenced.

## Compatibility warning

CUDA support in semidex has been validated end-to-end on a specific
Windows version / NVIDIA driver / CUDA Toolkit / cuDNN combination — not a
general guarantee that any Windows machine with any NVIDIA GPU will
succeed with this installer. Treat it as an advanced, opt-in path and
verify with a real probe on your own machine (never assume success from a
clean install alone) before relying on it for production indexing.

## See also

- [`configuration.md`'s `ONNXRUNTIME_NODE_PATH` section](./configuration.md#onnxruntime_node_path--a-custom-runtime-for-cuda-on-windows) — the manual/custom-build path this installer's own output plugs into.
- [Official ONNX Runtime install docs](https://onnxruntime.ai/docs/install/) and [CUDA Execution Provider docs](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html) — upstream packaging and requirements can change release to release; treat this guide as semidex's own integration layer on top of those, not a replacement for them.
