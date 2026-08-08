#Requires -Version 5.1
<#
    Behavioral regression tests for
    scripts/install-onnxruntime-cuda-windows.lib.psm1's own
    Invoke-VerifierSafely() — the P1 review finding this file exists to
    close: a verifier crash/nonzero-exit/invalid-JSON output used to
    escape as an uncaught PowerShell exception, bypassing the
    transactional-swap rollback planner entirely. This is a REAL
    PowerShell test (imports the module and calls its exported functions
    against real, disposable fake "node" scripts) — not a source-text
    regex assertion. Not written against Pester (this machine only has
    the very old, incompatible Pester 3.4.0) — plain, dependency-free
    assert helpers instead, runnable via:

        powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\powershell\install-onnxruntime-cuda-windows.tests.ps1

    Exits 0 with "ALL PASSED" on success, non-zero with a failure list
    otherwise — the same pass/fail contract every other test runner in
    this repo uses, so it composes into a CI step identically.
#>

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Import-Module (Join-Path $RepoRoot 'scripts\install-onnxruntime-cuda-windows.lib.psm1') -Force

$script:failures = @()
$script:passCount = 0

function Assert-Equal {
    param([Parameter(Mandatory)][string]$TestName, $Expected, $Actual)
    if ($Expected -eq $Actual) {
        $script:passCount++
    } else {
        $script:failures += "FAIL: $TestName -- expected [$Expected], got [$Actual]"
    }
}

function Assert-Match {
    param([Parameter(Mandatory)][string]$TestName, [Parameter(Mandatory)][string]$Pattern, [string]$Actual)
    if ($Actual -match $Pattern) {
        $script:passCount++
    } else {
        $script:failures += "FAIL: $TestName -- expected [$Actual] to match /$Pattern/"
    }
}

function New-FakeNodeScript {
    param([Parameter(Mandatory)][string]$Body)
    $tmp = New-TemporaryFile
    $jsPath = "$($tmp.FullName).js"
    Rename-Item -Path $tmp.FullName -NewName (Split-Path -Leaf $jsPath) -Force
    Set-Content -Path $jsPath -Value $Body -Encoding utf8
    return $jsPath
}

# ── Invoke-VerifierSafely(): the actual P1 fix under test ──────────────────

Write-Host '--- Invoke-VerifierSafely() ---'

# 1. A real, well-formed success result passes through unchanged.
$successScript = New-FakeNodeScript -Body 'console.log(JSON.stringify({ ok: true, effectiveProvider: "cuda", message: "CUDA session created successfully" }));'
try {
    $r = Invoke-VerifierSafely -RuntimeDir 'C:\some\runtime' -VerifyScript $successScript
    Assert-Equal 'success: ok is true' $true $r.ok
    Assert-Equal 'success: effectiveProvider' 'cuda' $r.effectiveProvider
} finally { Remove-Item $successScript -Force -ErrorAction SilentlyContinue }

# 2. A real, well-formed failure result (ok:false with a reason) passes through unchanged.
$failScript = New-FakeNodeScript -Body 'console.log(JSON.stringify({ ok: false, reason: "cannot read manifest" }));'
try {
    $r = Invoke-VerifierSafely -RuntimeDir 'C:\some\runtime' -VerifyScript $failScript
    Assert-Equal 'real failure: ok is false' $false $r.ok
    Assert-Equal 'real failure: reason passed through' 'cannot read manifest' $r.reason
} finally { Remove-Item $failScript -Force -ErrorAction SilentlyContinue }

# 3. THE CRASH CASE (the actual P1 bug): a node script that exits non-zero
#    with no valid JSON on stdout must be normalized into an ordinary
#    { ok: false; reason } result, NEVER an uncaught PowerShell exception
#    that would propagate past the caller's own rollback-planning step.
#    Deliberately writes to stdout only (not stderr) here — PowerShell's
#    own 2>&1 stderr-redirection semantics wrap each stderr line as a
#    terminating ErrorRecord under $ErrorActionPreference='Stop' (a
#    separate, real PowerShell quirk, not this function's own bug), which
#    this test covers on its own below rather than conflating the two.
$crashScript = New-FakeNodeScript -Body 'console.log("partial output, no valid result"); process.exit(1);'
try {
    $threw = $false
    $r = $null
    try {
        $r = Invoke-VerifierSafely -RuntimeDir 'C:\some\runtime' -VerifyScript $crashScript
    } catch {
        $threw = $true
    }
    Assert-Equal 'crash: does not throw' $false $threw
    Assert-Equal 'crash: ok is false' $false $r.ok
    Assert-Match 'crash: reason mentions the exit code' 'exited with code 1' $r.reason
} finally { Remove-Item $crashScript -Force -ErrorAction SilentlyContinue }

# 3b. A node script that writes to STDERR alongside a real success on
#     stdout is a real PowerShell quirk worth its own regression test:
#     2>&1 CAN wrap stderr lines as ErrorRecords in some configurations,
#     which risks either throwing prematurely or corrupting the captured
#     output before the real JSON result is ever parsed. Confirmed here:
#     the real success result still comes through correctly, never
#     downgraded to a false failure just because the child also logged a
#     warning to stderr — and, either way, this must never escape as an
#     uncaught exception regardless of how PowerShell's own stderr
#     capture behaves in a given environment.
$stderrScript = New-FakeNodeScript -Body 'process.stderr.write("a warning on stderr\n"); console.log(JSON.stringify({ ok: true, effectiveProvider: "cuda" }));'
try {
    $threw = $false
    $r = $null
    try {
        $r = Invoke-VerifierSafely -RuntimeDir 'C:\some\runtime' -VerifyScript $stderrScript
    } catch {
        $threw = $true
    }
    Assert-Equal 'stderr output: does not throw' $false $threw
    Assert-Equal 'stderr output: a real success is not corrupted by a stderr warning' $true $r.ok
} finally { Remove-Item $stderrScript -Force -ErrorAction SilentlyContinue }

# 4. Invalid JSON on stdout (exit 0, but garbage output) — also normalized,
#    never an uncaught ConvertFrom-Json exception.
$garbageScript = New-FakeNodeScript -Body 'console.log("this is not json");'
try {
    $threw = $false
    $r = $null
    try {
        $r = Invoke-VerifierSafely -RuntimeDir 'C:\some\runtime' -VerifyScript $garbageScript
    } catch {
        $threw = $true
    }
    Assert-Equal 'invalid JSON: does not throw' $false $threw
    Assert-Equal 'invalid JSON: ok is false' $false $r.ok
    Assert-Match 'invalid JSON: reason mentions invalid JSON' 'invalid JSON' $r.reason
} finally { Remove-Item $garbageScript -Force -ErrorAction SilentlyContinue }

# 5. No output at all (exit 0, empty stdout) — also normalized.
$emptyScript = New-FakeNodeScript -Body '// writes nothing'
try {
    $threw = $false
    $r = $null
    try {
        $r = Invoke-VerifierSafely -RuntimeDir 'C:\some\runtime' -VerifyScript $emptyScript
    } catch {
        $threw = $true
    }
    Assert-Equal 'no output: does not throw' $false $threw
    Assert-Equal 'no output: ok is false' $false $r.ok
    Assert-Match 'no output: reason mentions no output' 'no output' $r.reason
} finally { Remove-Item $emptyScript -Force -ErrorAction SilentlyContinue }

# 6. A genuinely nonexistent node command (simulates node itself being
#    unavailable/misconfigured, not just the target script failing) must
#    ALSO be normalized, not thrown — Invoke-VerifierSafely's own
#    try/catch wraps the entire external-command invocation.
try {
    $threw = $false
    $r = $null
    try {
        $r = Invoke-VerifierSafely -RuntimeDir 'C:\some\runtime' -VerifyScript 'irrelevant.js' -NodeCommand 'this-command-does-not-exist-anywhere'
    } catch {
        $threw = $true
    }
    Assert-Equal 'missing node command: does not throw' $false $threw
    Assert-Equal 'missing node command: ok is false' $false $r.ok
} catch {
    $script:failures += "FAIL: missing node command test itself threw: $_"
}

# Windows PowerShell 5.1 writes a BOM for `Set-Content -Encoding utf8`.
# The installer manifest is consumed by Node's JSON.parse(), which does not
# strip that marker, so exercise the real cross-runtime file boundary here.
Write-Host '--- Write-Utf8NoBom() ---'

$jsonPath = [System.IO.Path]::ChangeExtension((New-TemporaryFile).FullName, '.json')
try {
    Write-Utf8NoBom -Path $jsonPath -Content '{"ok":true}'
    $bytes = [System.IO.File]::ReadAllBytes($jsonPath)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    Assert-Equal 'UTF-8 JSON has no BOM' $false $hasBom

    $nodeResult = node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); console.log('ok')" $jsonPath
    Assert-Equal 'Node JSON.parse accepts the written file' 0 $LASTEXITCODE
    Assert-Equal 'Node parse sentinel' 'ok' $nodeResult
} finally {
    Remove-Item $jsonPath -Force -ErrorAction SilentlyContinue
}

# The installed directory is passed directly to Node's require(), so staging
# must create the package shape expected by onnxruntime-node's dist/binding.js.
Write-Host '--- managed runtime package staging contract ---'
$installerSource = Get-Content -Raw -Path (Join-Path $RepoRoot 'scripts\install-onnxruntime-cuda-windows.ps1')
Assert-Match 'stages onnxruntime-node dist' "Copy-Item.+NodeBindingDir 'dist'" $installerSource
Assert-Match 'stages onnxruntime-common runtime API' "js\\common\\dist" $installerSource
Assert-Match 'stages native binding under canonical package directory' "bin\\napi-v6\\win32\\x64" $installerSource
Assert-Match 'writes managed package entry point' "main = 'dist/index.js'" $installerSource

# ── Summary ──────────────────────────────────────────────────────────────

Write-Host ''
if ($script:failures.Count -eq 0) {
    Write-Host "ALL PASSED ($script:passCount assertions)" -ForegroundColor Green
    exit 0
} else {
    Write-Host "$($script:failures.Count) FAILURE(S) ($script:passCount passed):" -ForegroundColor Red
    foreach ($f in $script:failures) { Write-Host "  $f" -ForegroundColor Red }
    exit 1
}
