#Requires -Version 5.1
<#
.SYNOPSIS
    Builds and installs a managed, CUDA-enabled onnxruntime-node Node.js
    binding for Semidex on Windows, replacing the previously undocumented,
    gitignored .tmp/cuda-worktree build with a reproducible, versioned,
    cryptographically-anchored installer.

.DESCRIPTION
    Orchestrates: prerequisite checks (Windows x64, Node/npm, CMake, VS
    Build Tools, NVIDIA driver, CUDA Toolkit, cuDNN) -> a trust-gated
    checkout of Microsoft's onnxruntime source at an exact, verified
    commit -> `npm ci` + `npm run build` of only the js/node binding with
    --use_cuda -> a transactional install into SEMIDEX_HOME (staging +
    atomic same-volume rename, never touching a working prior install
    until the new one is proven or the swap is rolled back) -> a REAL
    strict CUDA session probe against the newly-installed runtime -> a
    manifest.json recording full provenance, artifact checksums, and the
    real (not assumed) probe outcome.

    Every non-trivial decision (trust-gate resolution, idempotent-skip
    comparison, transactional-swap state machine) is delegated to
    src/local/core/onnx-cuda-installer-logic.js via a JSON-in/JSON-out CLI
    contract, so the exact same logic is unit-tested under `npm test`
    (tests/unit/local/core/onnx-cuda-installer-logic.test.js) rather than
    living un-testably inline in PowerShell.

    Never modifies system or user PATH/environment variables. Never
    silently falls back to CPU to "prove" success — the end-of-run probe
    either genuinely creates a CUDA InferenceSession or the install is
    reported (and, for a reinstall, rolled back) as failed.

.PARAMETER OrtVersion
    ONNX Runtime version to build. Default: 1.26.0 (the locked, reference-
    verified combination in scripts/onnxruntime-cuda-lock.json).

.PARAMETER CudaMajor
    CUDA major version the ONNX Runtime CUDA execution provider targets.
    Default: 13.

.PARAMETER ExpectedSourceCommit
    40-hex-char git commit SHA to check out and verify. ALWAYS required
    for any {OrtVersion, CudaMajor} combination not present in
    scripts/onnxruntime-cuda-lock.json — no flag combination bypasses
    this, ever. Ignored (with a warning if it conflicts) for a locked
    combination, where the lock file's own commit always wins.

.PARAMETER ExpectedSha256
    Expected SHA-256 of the official Microsoft release asset zip. Required
    for a non-locked combination UNLESS -AllowUnverifiedDownload is also
    passed. Ignored (with a warning if it conflicts) for a locked
    combination.

.PARAMETER AllowUnverifiedDownload
    For a non-locked combination only: proceed without a pre-known release
    asset checksum. Never substitutes for -ExpectedSourceCommit, which is
    always required regardless. Without -NonInteractive, prompts once for
    confirmation before downloading.

.PARAMETER SemidexHome
    Overrides the SEMIDEX_HOME directory the managed runtime installs
    into. Defaults to $env:SEMIDEX_HOME, or
    $env:LOCALAPPDATA\semidex if unset.

.PARAMETER Force
    Skips the idempotent-skip check entirely and always rebuilds.

.PARAMETER SkipProbe
    Installs but does not run the end-of-run CUDA probe — the manifest's
    verification.status stays 'unverified'. The transactional swap still
    completes and any prior backup is still deleted (no probe ran, so
    there is nothing to roll back from).

.PARAMETER WorkDir
    Build/staging working directory (source checkout + native build
    output). May be on a different volume than SemidexHome — this
    directory is never the target of an "atomic" rename, only a `Copy-Item`
    source. Defaults to $env:TEMP\semidex-ort-build-<OrtVersion>.

.PARAMETER NonInteractive
    Suppresses the -AllowUnverifiedDownload confirmation prompt (the flag
    itself is treated as explicit, scripted consent for the asset-
    checksum gap only).

.EXAMPLE
    .\scripts\install-onnxruntime-cuda-windows.ps1
    Installs the default locked combination (ORT 1.26.0 / CUDA 13).

.EXAMPLE
    .\scripts\install-onnxruntime-cuda-windows.ps1 -OrtVersion 1.27.0 -CudaMajor 13 `
        -ExpectedSourceCommit <40-hex-sha> -ExpectedSha256 <64-hex-sha256>
    Installs a specific, non-locked combination with both trust anchors
    supplied explicitly.

.NOTES
    Nothing in this script modifies system/user PATH or any persistent
    environment variable. See docs/en/windows-cuda-onnxruntime-install.md
    for the full guide, including uninstall/cleanup.
#>
[CmdletBinding()]
param(
    [string]$OrtVersion = '1.26.0',
    [string]$CudaMajor = '13',
    [string]$ExpectedSourceCommit,
    [string]$ExpectedSha256,
    [switch]$AllowUnverifiedDownload,
    [string]$SemidexHome,
    [switch]$Force,
    [switch]$SkipProbe,
    [string]$WorkDir,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Platform = 'win32'
$Arch = 'x64'

# Write-Step/Write-Warn2/Invoke-NodeDecision/Invoke-NodePrereqCheck/
# Invoke-VerifierSafely/Get-FileSha256 live in the sibling .psm1 module —
# pulled out specifically so tests/powershell/install-onnxruntime-cuda-windows.tests.ps1
# can import and exercise them (in particular Invoke-VerifierSafely's own
# crash/nonzero-exit/invalid-JSON normalization — the review finding it
# exists to fix) without running this script's own param()/platform-gate/
# install flow at all. See that module's own header comment.
Import-Module (Join-Path $PSScriptRoot 'install-onnxruntime-cuda-windows.lib.psm1') -Force

# ── 0. Platform gate ────────────────────────────────────────────────────
if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) {
    Write-Error 'This installer only supports Windows.'
    exit 1
}
if ([System.Environment]::Is64BitOperatingSystem -eq $false) {
    Write-Error 'This installer only supports 64-bit Windows (x64).'
    exit 1
}

# ── 1. Resolve SemidexHome / runtimesDir / target directory ────────────
if (-not $SemidexHome) {
    $SemidexHome = if ($env:SEMIDEX_HOME) { $env:SEMIDEX_HOME } else { Join-Path $env:LOCALAPPDATA 'semidex' }
}
$RuntimesRoot = Join-Path $SemidexHome 'runtimes\onnxruntime-node-cuda'
$RuntimeId = "$OrtVersion-cuda$CudaMajor"
$TargetDir = Join-Path $RuntimesRoot $RuntimeId
New-Item -ItemType Directory -Force -Path $RuntimesRoot | Out-Null

Write-Step "SemidexHome: $SemidexHome"
Write-Step "Target runtime directory: $TargetDir"

# ── 2. Exclusive installer lock ─────────────────────────────────────────
# Atomic create-if-not-exists — a genuinely stuck lock is rare and
# manually resolvable; no PID-liveness/timeout auto-recovery in this
# first version (deliberately deferred, see the design plan's own note).
$LockPath = Join-Path $RuntimesRoot '.installer.lock'
try {
    $lockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    $lockWriter = New-Object System.IO.StreamWriter($lockStream)
    $lockWriter.WriteLine("pid=$PID")
    $lockWriter.WriteLine("startedAt=$(Get-Date -Format o)")
    $lockWriter.Flush()
} catch [System.IO.IOException] {
    $existing = if (Test-Path $LockPath) { Get-Content $LockPath -Raw } else { '(unreadable)' }
    Write-Error "Another install may already be running:`n$existing`nIf you're sure it's stale, remove '$LockPath' manually and re-run."
    exit 1
}

try {
    # ── 3. Prerequisite checks ──────────────────────────────────────────
    Write-Step 'Checking prerequisites...'
    foreach ($cmd in @('node', 'npm', 'cmake', 'git')) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            throw "Required tool '$cmd' was not found on PATH."
        }
    }
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vsWhere)) {
        Write-Warn2 'vswhere.exe not found — cannot confirm Visual Studio C++ Build Tools are installed. The native build step below will fail if they are missing.'
    }
    $prereqs = Invoke-NodePrereqCheck -RepoRoot $RepoRoot
    if (-not $prereqs.nvidiaDriver.available) {
        Write-Warn2 'nvidia-smi did not report an available NVIDIA driver — a CUDA build may still compile, but the end-of-run probe will fail.'
    } else {
        Write-Step "NVIDIA driver: $($prereqs.nvidiaDriver.driverVersion) ($($prereqs.nvidiaDriver.gpuName))"
    }
    if (-not $prereqs.cudaToolkit.found) {
        Write-Warn2 'CUDA Toolkit was not found via CUDA_PATH/standard install locations — the build step below will likely fail.'
    } else {
        Write-Step "CUDA Toolkit: $($prereqs.cudaToolkit.path)"
    }
    if ($prereqs.cudnn.found -ne $true) {
        Write-Warn2 'cuDNN was not found under the detected CUDA Toolkit directory — download and install it from NVIDIA before continuing, or the build/probe will fail.'
    }

    # ── 4. Trust gate ────────────────────────────────────────────────────
    Write-Step 'Resolving trust gate...'
    $lockFilePath = Join-Path $RepoRoot 'scripts\onnxruntime-cuda-lock.json'
    $lockFile = Get-Content $lockFilePath -Raw | ConvertFrom-Json
    $lockEntries = @($lockFile.entries | ForEach-Object {
        @{
            ortVersion = $_.ortVersion; cudaMajor = $_.cudaMajor; platform = $_.platform; arch = $_.arch
            sourceCommit = $_.sourceCommit; runtimeAssetUrl = $_.runtimeAssetUrl; runtimeAssetSha256 = $_.runtimeAssetSha256
        }
    })

    $trustInput = @{
        ortVersion = $OrtVersion; cudaMajor = $CudaMajor; platform = $Platform; arch = $Arch
        lockEntries = $lockEntries
        expectedSourceCommit = $ExpectedSourceCommit
        expectedSha256 = $ExpectedSha256
        allowUnverifiedDownload = [bool]$AllowUnverifiedDownload
        nonInteractive = [bool]$NonInteractive
    }
    $trust = Invoke-NodeDecision -RepoRoot $RepoRoot -Decision 'resolveTrustGate' -InputObject $trustInput
    if (-not $trust.ok) {
        Write-Error $trust.reason
        exit 1
    }
    Write-Step "Trust gate resolved: checksumTrust=$($trust.checksumTrust), sourceCommit=$($trust.sourceCommit)"

    if ($trust.requiresInteractiveConfirmation) {
        $answer = Read-Host "About to download an UNVERIFIED release asset (no pre-known checksum) for $OrtVersion-cuda$CudaMajor. Continue? [y/N]"
        if ($answer -notmatch '^[Yy]') {
            Write-Error 'Aborted by user (unverified download not confirmed).'
            exit 1
        }
    }

    # Resolve the runtime asset URL — locked entries carry it; a fully
    # custom (non-locked) combination has no known URL, and the caller is
    # expected to supply one via -RuntimeAssetUrl in a future revision if
    # ever needed. For now, only locked combinations are downloadable
    # out of the box; a non-locked combination requires the source to
    # already exist in $WorkDir\onnxruntime (git remote add / manual
    # placement) — documented in docs/en/windows-cuda-onnxruntime-install.md.
    $runtimeAssetUrl = $trust.runtimeAssetUrl

    # ── 5. Idempotent re-run check (unless -Force) ──────────────────────
    if (-not $Force) {
        Write-Step 'Checking whether an equivalent runtime is already installed...'
        $skipInput = @{
            requestedRuntimeDir = $TargetDir
            requested = @{
                ortVersion = $OrtVersion; cudaMajor = $CudaMajor; platform = $Platform; arch = $Arch
                sourceCommit = $trust.sourceCommit; runtimeAssetSha256 = $trust.runtimeAssetSha256
                installerVersion = '2'
            }
        }
        $skip = Invoke-NodeDecision -RepoRoot $RepoRoot -Decision 'shouldSkipRebuild' -InputObject $skipInput
        if ($skip.shouldSkip) {
            Write-Step "An identical, intact runtime is already installed at $TargetDir — skipping rebuild (use -Force to rebuild anyway)."
            if (-not $SkipProbe) {
                Write-Step 'Running the end-of-run probe against the existing install...'
                # Review finding (P1): a failed probe here used to only
                # print a warning and still exit 0 — a re-run of this
                # script against an existing, but now CUDA-broken,
                # install would report success even though strict CUDA
                # verification just failed. The installer's whole reason
                # to exist is proving CUDA actually works, not merely
                # that files are present, so this now exits 1 on a real
                # probe failure, exactly like the fresh-build path below
                # does on its own end-of-run probe failure.
                $verifyScript = Join-Path $RepoRoot 'src\local\core\onnx-cuda-installer-verify.js'
                $verifyResult = Invoke-VerifierSafely -RuntimeDir $TargetDir -VerifyScript $verifyScript
                if ($verifyResult.ok) {
                    Write-Host "[install-onnxruntime-cuda] CUDA probe succeeded — effectiveProvider=$($verifyResult.effectiveProvider)" -ForegroundColor Green
                    Write-Host "`nONNXRUNTIME_NODE_PATH=$TargetDir" -ForegroundColor Green
                    exit 0
                } else {
                    $probeIssue = if ($verifyResult.message) { $verifyResult.message } else { $verifyResult.reason }
                    Write-Error "CUDA probe against the existing install at $TargetDir did not succeed: $probeIssue"
                    exit 1
                }
            }
            Write-Host "`nONNXRUNTIME_NODE_PATH=$TargetDir" -ForegroundColor Green
            exit 0
        }
        Write-Step "Rebuild needed: $($skip.reason)"
    }

    # ── 6. Build workspace ───────────────────────────────────────────────
    if (-not $WorkDir) {
        $WorkDir = Join-Path $env:TEMP "semidex-ort-build-$OrtVersion"
    }
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    $SourceDir = Join-Path $WorkDir 'onnxruntime'

    Write-Step "Preparing source checkout at $SourceDir ..."
    if (-not (Test-Path (Join-Path $SourceDir '.git'))) {
        git clone https://github.com/microsoft/onnxruntime.git $SourceDir
        if ($LASTEXITCODE -ne 0) { throw 'git clone failed.' }
    }
    Push-Location $SourceDir
    try {
        git fetch origin --tags
        if ($LASTEXITCODE -ne 0) { throw 'git fetch failed.' }
        git checkout $trust.sourceCommit
        if ($LASTEXITCODE -ne 0) { throw "git checkout $($trust.sourceCommit) failed." }
        $actualCommit = (git rev-parse HEAD).Trim()
        if ($actualCommit -ne $trust.sourceCommit) {
            throw "Checked-out HEAD ($actualCommit) does not match the resolved trust-gate commit ($($trust.sourceCommit)) — refusing to build from an unverified checkout."
        }
        Write-Step "Verified checkout at commit $actualCommit."
    } finally {
        Pop-Location
    }

    # ── 7. Download + verify the official CUDA runtime asset ───────────
    $AssetZipPath = Join-Path $WorkDir 'onnxruntime-runtime.zip'
    $AssetExtractDir = Join-Path $WorkDir 'onnxruntime-runtime'
    if ($runtimeAssetUrl) {
        Write-Step "Downloading runtime asset from $runtimeAssetUrl ..."
        Invoke-WebRequest -Uri $runtimeAssetUrl -OutFile $AssetZipPath -UseBasicParsing
        $actualAssetSha256 = Get-FileSha256 -Path $AssetZipPath
        if ($trust.runtimeAssetSha256) {
            if ($actualAssetSha256 -ne $trust.runtimeAssetSha256) {
                throw "Downloaded asset SHA-256 ($actualAssetSha256) does not match the expected checksum ($($trust.runtimeAssetSha256)) — refusing to use a corrupted or tampered download."
            }
            Write-Step 'Asset checksum verified against the expected value.'
        } else {
            Write-Warn2 "Proceeding with an UNVERIFIED asset checksum ($actualAssetSha256) — this was explicitly allowed via -AllowUnverifiedDownload."
        }
        if (Test-Path $AssetExtractDir) { Remove-Item -Recurse -Force $AssetExtractDir }
        Expand-Archive -Path $AssetZipPath -DestinationPath $AssetExtractDir -Force
    } else {
        Write-Warn2 'No known runtime asset URL for this combination — expecting a pre-extracted runtime under the extraction directory; see docs/en/windows-cuda-onnxruntime-install.md for the manual steps.'
    }
    # Locate the extracted release's own lib/ dir (contains the 3 non-
    # compiled artifacts: onnxruntime.dll, onnxruntime_providers_cuda.dll,
    # onnxruntime_providers_shared.dll).
    $ReleaseLibDir = Get-ChildItem -Path $AssetExtractDir -Recurse -Filter 'onnxruntime_providers_shared.dll' -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty DirectoryName
    if (-not $ReleaseLibDir) {
        throw "Could not locate onnxruntime_providers_shared.dll under $AssetExtractDir after extraction."
    }

    # ── 8. Build the js/node binding ────────────────────────────────────
    # ORT keeps the shared TypeScript toolchain (including `tsc`) in
    # js/package.json, not js/node/package.json. Install that toolchain
    # first without lifecycle scripts: otherwise js/node's file dependency
    # on ../common runs common's prepare script before `tsc` exists.
    $JsRootDir = Join-Path $SourceDir 'js'
    Push-Location $JsRootDir
    try {
        Write-Step 'npm ci (shared JS build toolchain, lifecycle scripts disabled)...'
        npm ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'Shared JS toolchain npm ci failed.' }

        Write-Step 'Auditing shared JS production dependencies...'
        npm audit --omit=dev --audit-level=moderate
        if ($LASTEXITCODE -ne 0) { throw 'Shared JS production dependency audit failed.' }

        $TypeScriptCommand = Join-Path $JsRootDir 'node_modules\.bin\tsc.cmd'
        if (-not (Test-Path $TypeScriptCommand)) {
            throw "ORT shared JS toolchain did not install TypeScript at $TypeScriptCommand."
        }
    } finally {
        Pop-Location
    }

    $NodeBindingDir = Join-Path $SourceDir 'js\node'
    Push-Location $NodeBindingDir
    try {
        # The locked ORT source currently declares vulnerable dependency
        # ranges. Apply the reviewed, tested pins only inside this temporary
        # checkout, regenerate its lockfile, then require a clean full audit.
        $NodePackagePath = Join-Path $NodeBindingDir 'package.json'
        $NodePackage = Get-Content -Raw -Path $NodePackagePath | ConvertFrom-Json
        $PatchedNodePackage = Invoke-NodeDecision -RepoRoot $RepoRoot -Decision 'applyOrtNodeSecurityPolicy' -InputObject @{
            manifest = $NodePackage
            ortVersion = $OrtVersion
            sourceCommit = $Trust.sourceCommit
        }
        $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText(
            $NodePackagePath,
            (($PatchedNodePackage | ConvertTo-Json -Depth 20) + [Environment]::NewLine),
            $Utf8NoBom
        )

        Write-Step 'Resolving audited js/node dependency policy...'
        npm install --package-lock-only --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'js/node audited lockfile resolution failed.' }

        Write-Step 'npm ci (js/node devDependencies)...'
        npm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

        Write-Step 'Auditing js/node dependencies...'
        npm audit --audit-level=moderate
        if ($LASTEXITCODE -ne 0) { throw 'js/node dependency audit failed.' }

        $NativeBuildDir = Join-Path $WorkDir 'native-build'
        $NativeReleaseDir = Join-Path $NativeBuildDir 'Release'
        New-Item -ItemType Directory -Force -Path $NativeReleaseDir | Out-Null
        Copy-Item -Path (Join-Path $ReleaseLibDir 'onnxruntime.dll') -Destination $NativeReleaseDir -Force
        Copy-Item -Path (Join-Path $ReleaseLibDir 'onnxruntime.lib') -Destination $NativeReleaseDir -Force
        $SharedDll = Join-Path $ReleaseLibDir 'onnxruntime_providers_shared.dll'
        $CudaDll = Join-Path $ReleaseLibDir 'onnxruntime_providers_cuda.dll'
        Write-Step 'npm run build (Release, --use_cuda)...'
        npm run build -- --config=Release `
            "--onnxruntime-build-dir=$NativeBuildDir" `
            --use_cuda `
            "--dll_deps=$SharedDll;$CudaDll"
        if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
    } finally {
        Pop-Location
    }

    $BindingOutDir = Join-Path $NodeBindingDir 'bin\napi-v6\win32\x64'
    $BuiltBindingNode = Join-Path $BindingOutDir 'onnxruntime_binding.node'
    if (-not (Test-Path $BuiltBindingNode)) {
        throw "Expected build output not found at $BuiltBindingNode."
    }

    # ── 9. Locate cuDNN bin directory (recorded into the manifest) ──────
    if ($prereqs.cudnn.found -ne $true -or -not $prereqs.cudaToolkit.path) {
        throw 'cuDNN was not found — cannot record dependencies.cudnnBinPath. Install cuDNN under the CUDA Toolkit directory and re-run.'
    }
    $CudnnBinPath = Get-ChildItem -Path $prereqs.cudaToolkit.path -Recurse -Filter 'cudnn64_*.dll' -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty DirectoryName
    if (-not $CudnnBinPath) {
        throw "Could not locate a cudnn64_*.dll under $($prereqs.cudaToolkit.path)."
    }
    Write-Step "cuDNN bin directory: $CudnnBinPath"

    # ── 10. Stage artifacts + manifest into installStage (same volume as target) ──
    $InstallStageDir = Join-Path $RuntimesRoot "install-stage-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    New-Item -ItemType Directory -Force -Path $InstallStageDir | Out-Null

    $installStageRoot = (Get-Item $InstallStageDir).PSDrive.Name
    $targetParent = Split-Path -Parent $TargetDir
    if (-not (Test-Path $targetParent)) { New-Item -ItemType Directory -Force -Path $targetParent | Out-Null }
    $targetRoot = (Get-Item $RuntimesRoot).PSDrive.Name
    $volumeCheck = Invoke-NodeDecision -RepoRoot $RepoRoot -Decision 'assertSameVolume' -InputObject @{ installStageVolumeRoot = $installStageRoot; targetVolumeRoot = $targetRoot }
    if (-not $volumeCheck.ok) {
        throw $volumeCheck.reason
    }

    $ArtifactFiles = @{
        'onnxruntime.dll' = (Join-Path $ReleaseLibDir 'onnxruntime.dll')
        'onnxruntime_binding.node' = $BuiltBindingNode
        'onnxruntime_providers_cuda.dll' = $CudaDll
        'onnxruntime_providers_shared.dll' = $SharedDll
    }
    $artifactsManifestFragment = @{}
    foreach ($name in $ArtifactFiles.Keys) {
        $src = $ArtifactFiles[$name]
        if (-not (Test-Path $src)) { throw "Expected artifact not found: $src" }
        $dest = Join-Path $InstallStageDir $name
        Copy-Item -Path $src -Destination $dest -Force
        $hash = Get-FileSha256 -Path $dest
        $bytes = (Get-Item $dest).Length
        $artifactsManifestFragment[$name] = @{ sha256 = $hash; bytes = $bytes }
    }

    $draftInput = @{
        ortVersion = $OrtVersion; cudaMajor = $CudaMajor; platform = $Platform; arch = $Arch
        sourceRepository = 'https://github.com/microsoft/onnxruntime.git'
        sourceTag = "v$OrtVersion"
        sourceCommit = $trust.sourceCommit
        runtimeAssetUrl = $runtimeAssetUrl
        runtimeAssetSha256 = if ($trust.runtimeAssetSha256) { $trust.runtimeAssetSha256 } else { $actualAssetSha256 }
        checksumTrust = $trust.checksumTrust
        artifacts = $artifactsManifestFragment
        cudnnBinPath = $CudnnBinPath
        builtAt = (Get-Date -Format o)
        nodeVersion = (node --version)
    }
    $manifestDraft = Invoke-NodeDecision -RepoRoot $RepoRoot -Decision 'buildManifestDraft' -InputObject $draftInput
    ($manifestDraft | ConvertTo-Json -Depth 10) | Set-Content -Path (Join-Path $InstallStageDir 'manifest.json') -Encoding utf8

    # ── 11. Transactional swap ──────────────────────────────────────────
    $hadExistingTarget = Test-Path $TargetDir
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $BackupDir = Join-Path $RuntimesRoot "$RuntimeId.backup-$timestamp"
    $FailedDir = Join-Path $RuntimesRoot "$RuntimeId.failed-$timestamp"

    $beforeSwap = Invoke-NodeDecision -RepoRoot $RepoRoot -Decision 'planTransactionalSwapStep' -InputObject @{ step = 'before_swap'; state = @{ hadExistingTarget = $hadExistingTarget } }
    try {
        foreach ($action in $beforeSwap.actions) {
            switch ($action) {
                'rename_target_to_backup' { Move-Item -Path $TargetDir -Destination $BackupDir -Force }
                'rename_install_stage_to_target' { Move-Item -Path $InstallStageDir -Destination $TargetDir -Force }
            }
        }
    } catch {
        Write-Warn2 "A rename step failed before the probe could run: $_"
        $renameFailure = Invoke-NodeDecision -RepoRoot $RepoRoot -Decision 'planTransactionalSwapStep' -InputObject @{ step = 'rename_failure'; state = @{ hadExistingTarget = $hadExistingTarget } }
        foreach ($action in $renameFailure.actions) {
            if ($action -eq 'rename_backup_to_target_if_present' -and (Test-Path $BackupDir) -and -not (Test-Path $TargetDir)) {
                Move-Item -Path $BackupDir -Destination $TargetDir -Force
            }
        }
        throw
    }

    # ── 12. End-of-run probe (unless -SkipProbe) — runs BEFORE any backup deletion ──
    # Review finding (P1): Invoke-VerifierSafely() (see its own header
    # comment) ensures any verifier crash/nonzero-exit/invalid-JSON is
    # normalized into an ordinary probeOk=false result instead of an
    # uncaught exception that would bypass the after_probe rollback
    # planner below entirely.
    $probeOk = $true
    $verifyResult = $null
    if (-not $SkipProbe) {
        Write-Step 'Running the end-of-run CUDA probe against the newly-installed runtime...'
        $verifyScript = Join-Path $RepoRoot 'src\local\core\onnx-cuda-installer-verify.js'
        $verifyResult = Invoke-VerifierSafely -RuntimeDir $TargetDir -VerifyScript $verifyScript
        $probeOk = [bool]$verifyResult.ok
    }

    $afterProbe = Invoke-NodeDecision -RepoRoot $RepoRoot -Decision 'planTransactionalSwapStep' -InputObject @{
        step = 'after_probe'
        state = @{ hadExistingTarget = $hadExistingTarget; probeOk = $probeOk; skipProbe = [bool]$SkipProbe }
    }
    foreach ($action in $afterProbe.actions) {
        switch ($action) {
            'delete_backup' { if (Test-Path $BackupDir) { Remove-Item -Recurse -Force $BackupDir } }
            'rename_target_to_failed' { Move-Item -Path $TargetDir -Destination $FailedDir -Force }
            'rename_backup_to_target' { Move-Item -Path $BackupDir -Destination $TargetDir -Force }
        }
    }

    if ($afterProbe.terminal -eq 'failure') {
        $reason = 'unknown'
        if ($verifyResult) {
            $reason = if ($verifyResult.message) { $verifyResult.message } else { $verifyResult.reason }
        }
        if ($hadExistingTarget) {
            Write-Error "CUDA probe failed ($reason) — the previously-working runtime at $TargetDir has been restored. The broken build was kept at $FailedDir for inspection."
        } else {
            Write-Error "CUDA probe failed ($reason) — no runtime is installed at $TargetDir. The broken build was kept at $FailedDir for inspection."
        }
        exit 1
    }

    if ($SkipProbe) {
        Write-Step "Installed (probe skipped via -SkipProbe) — verification.status is 'unverified' until a probe runs (Admin UI 'Test CUDA configuration', or re-run this script without -SkipProbe)."
    } else {
        Write-Host "[install-onnxruntime-cuda] CUDA probe succeeded — effectiveProvider=$($verifyResult.effectiveProvider)" -ForegroundColor Green
    }

    Write-Host "`nInstalled managed CUDA runtime: $RuntimeId" -ForegroundColor Green
    Write-Host "ONNXRUNTIME_NODE_PATH=$TargetDir" -ForegroundColor Green
    Write-Host "`nSelect this runtime in Semidex's Global Settings (Managed CUDA runtime), or set ONNXRUNTIME_NODE_PATH manually to the path above."
} finally {
    if ($lockWriter) { $lockWriter.Dispose() }
    if ($lockStream) { $lockStream.Dispose() }
    if (Test-Path $LockPath) { Remove-Item -Force $LockPath }
}
