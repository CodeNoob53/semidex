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

## Why Windows needs a managed runtime

This complexity is primarily an upstream distribution gap, not a requirement
invented by semidex and not a limitation of CUDA inference from Node.js. The
standard Windows `onnxruntime-node` npm installation does not include a ready
CUDA Execution Provider. A CUDA-capable Node binding can be built and works,
but the native artifacts and their CUDA/cuDNN dependencies must form one
compatible set.

The relevant upstream history is public:

- [microsoft/onnxruntime#14127](https://github.com/microsoft/onnxruntime/issues/14127)
  tracks GPU execution from Node.js on Windows. An ONNX Runtime maintainer
  identified release-CI work for publishing the shared GPU libraries needed by
  the Node binding; the issue remains open.
- [microsoft/onnxruntime#22877](https://github.com/microsoft/onnxruntime/issues/22877)
  documents why CUDA binaries are not bundled inside the main npm package:
  the package would exceed npm's size limit. It also records how changes to
  the release assets broke the separate CUDA download path.
- [microsoft/onnxruntime#17537](https://github.com/microsoft/onnxruntime/issues/17537)
  explains that ONNX Runtime does not redistribute NVIDIA CUDA/cuDNN
  dependencies because of licensing, security, and provenance concerns.
  Those compatible NVIDIA libraries must therefore be installed separately.
- [microsoft/onnxruntime#16050](https://github.com/microsoft/onnxruntime/pull/16050)
  added CUDA and DirectML provider support to the Node binding itself. The
  remaining problem is obtaining and loading the correct native distribution,
  not an absent JavaScript API.

Semidex's installer exists to make that upstream gap as small as practical for
users. Instead of asking users to clone ONNX Runtime, discover a compatible
commit, locate release DLLs, build the N-API addon, copy files by hand, edit a
global `PATH`, and guess whether CUDA actually loaded, it automates that work:

- pins and verifies the ONNX Runtime source commit and Microsoft release asset;
- checks the Windows compiler, CMake, NVIDIA driver, CUDA Toolkit, and cuDNN;
- bootstraps ONNX Runtime's shared JavaScript toolchain and builds only the
  Node binding required by semidex;
- installs the result transactionally under `SEMIDEX_HOME`, without changing
  the user's persistent system or user `PATH`;
- records provenance and checksums in a manifest;
- creates a real CUDA inference session before reporting success.

This is still a native build and can take time and disk space. The installer
reduces manual configuration and catches known failure modes, but it cannot
remove NVIDIA's toolchain requirements or guarantee compatibility for every
driver/GPU combination.

### Dependency audit policy

The locked ONNX Runtime 1.26.0 source currently resolves known advisories in
its `js/node` build dependencies (`adm-zip`, `protobufjs` and transitive
`tar`). Semidex does not accept those versions merely because they come from
the pinned upstream commit. During the temporary checkout the installer:

1. pins the reviewed compatible versions `adm-zip@0.6.0`,
   `protobufjs@8.7.1`, and `tar@7.5.22`;
2. regenerates that checkout's lockfile and performs a clean `npm ci`;
3. requires `npm audit --audit-level=moderate` to pass before compilation.

These pins were verified against the locked ORT source by compiling its
TypeScript projects. They modify only the disposable build checkout, not the
Semidex dependency graph or Microsoft's repository.

The shared upstream `js/` tree contains the TypeScript build toolchain and
test-only packages. Its production dependency graph must pass
`npm audit --omit=dev --audit-level=moderate`. Upstream development-tool
advisories are not bundled into the installed managed runtime, so they are
reported separately rather than weakening the production gate or using
unreviewed `npm audit fix --force` upgrades.

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
- **cuDNN** for the same CUDA major series. NVIDIA's Windows installer
  normally keeps it separate from the Toolkit at
  `C:\Program Files\NVIDIA\CUDNN\v<version>\bin\<cuda-major.minor>\x64\`;
  a manual installation may instead place it in the Toolkit's `bin`
  directory. Semidex supports both layouts, selects only the matching CUDA
  major series, and records the exact directory in the runtime manifest.

Run `npm run doctor` first — its GPU-stack prerequisites line reports real
driver/toolkit/cuDNN presence before you invest time in a build that can't
succeed.

### Install the Windows build tools

The managed runtime is compiled on your machine. CUDA Toolkit and cuDNN are
not enough by themselves: the build also needs CMake and Microsoft's native
C++ toolchain.

Install CMake from a regular PowerShell terminal:

```powershell
winget install --id Kitware.CMake --source winget
```

Install either Visual Studio Community or the standalone Visual Studio Build
Tools. In the Visual Studio Installer, select the **Desktop development with
C++** workload. The workload must include an x64 MSVC toolset and a Windows
SDK. The Visual Studio IDE itself is not required.

Microsoft also documents a non-interactive Community installation command:

```powershell
winget install --id Microsoft.VisualStudio.Community --source winget `
  --override "--add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended --passive --wait"
```

After installing or modifying CMake, Visual Studio Build Tools, CUDA Toolkit,
or cuDNN, close every existing terminal and open a new PowerShell window.
Processes inherit their environment when they start, so an already-open
terminal may not see the newly installed tools or updated `PATH`.

Verify the toolchain before running the Semidex installer:

```powershell
node --version
npm --version
git --version
cmake --version
nvidia-smi
```

`cmake --version` must succeed in the same terminal that will run the
installer. The installer locates Visual Studio through `vswhere.exe`; `cl.exe`
does not have to be visible in an ordinary PowerShell session. If native build
discovery still fails, open **Developer PowerShell for Visual Studio** and run
the installer there. Microsoft recommends a developer shell for direct use of
the MSVC command-line toolchain because it initializes the required compiler,
SDK, library, and header paths.

Then run Semidex's own read-only prerequisite report:

```powershell
npm run doctor
```

Do not start the long build while CMake, the NVIDIA driver, CUDA Toolkit, or
cuDNN is reported missing.

## Install command

From the repo root, in PowerShell:

```powershell
.\scripts\install-onnxruntime-cuda-windows.ps1
```

If PowerShell blocks local scripts under your current execution policy, run
this process-scoped command first (it does not change the machine-wide policy):

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
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
4. Installs the shared ONNX Runtime JavaScript build toolchain from `js/`
   with lifecycle scripts disabled, then runs `npm ci` and
   `npm run build -- --use_cuda` inside `js/node/` to compile the Node.js
   binding (`onnxruntime_binding.node`) against your local CUDA Toolkit.
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

After selecting the managed runtime or setting the manual path, stop the
Semidex Admin server/indexer completely and start it again. A Node process that
has already loaded the default npm ONNX Runtime cannot replace that native
binding in place.

In the Admin UI, open **Global Settings → Embeddings & hardware** and confirm:

1. `ONNX execution provider` is `cuda`.
2. `Managed CUDA runtime` contains the installed runtime, or the custom path
   points to the directory printed by the installer.
3. Save and restart Semidex.
4. Click **Test CUDA configuration**.

A successful result must report `Requested provider: cuda`, `Active provider:
cuda`, and the managed/custom runtime as the runtime source. Merely selecting
`cuda` is not proof that CUDA loaded. If `Active provider` remains `cpu` and
the runtime source is `npm`, Semidex is still using the standard CPU/DirectML
package rather than the managed build.

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

## Common setup failures

### `Required tool 'cmake' was not found on PATH`

Install CMake with the command above, close the current terminal, open a new
PowerShell window, and confirm `cmake --version` succeeds before retrying. An
installed CMake executable is not usable by the installer until the current
process can resolve it through `PATH`.

### Visual Studio C++ Build Tools cannot be found

Open Visual Studio Installer, modify the installed Visual Studio/Build Tools
instance, and select **Desktop development with C++**. Retry from Developer
PowerShell for Visual Studio if a regular shell cannot initialize the MSVC
toolchain.

### CUDA Toolkit or cuDNN is reported missing

Confirm `nvidia-smi` works, `CUDA_PATH` points to the intended Toolkit, and
the matching cuDNN 9 DLLs are installed. Open a new terminal after changing
the installation. Do not point `ONNXRUNTIME_NODE_PATH` at a partial build or
manually create a managed-runtime manifest; let the installer complete its
transactional install and strict probe.

### `tsc` is not recognized during `npm ci`

This indicates an installer version from before the shared ONNX Runtime
JavaScript toolchain was bootstrapped explicitly. ONNX Runtime keeps
TypeScript in `js/package.json`, while the Node binding lives under
`js/node/`; installing only the latter can run `onnxruntime-common`'s build
before `tsc` exists. Update semidex and rerun the installer. The source
checkout is reused, so a retry does not clone the full repository again.

### `npm audit` stops the installer

The installer intentionally fails before compiling when the audited
`js/node` graph contains any moderate-or-higher advisory, or when the shared
`js/` production graph does. Update Semidex to obtain the current reviewed
security policy. Do not bypass the gate with `--force` or manually edit the
temporary lockfile: a changed dependency set must be compatibility-tested
and recorded in Semidex first.

### Admin UI still reports `Runtime source: npm`

Select the installed entry under **Managed CUDA runtime** (or set the exact
manual path printed by the installer), save, and fully restart the Admin
process. The standard npm package on Windows provides CPU/DirectML only.

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
