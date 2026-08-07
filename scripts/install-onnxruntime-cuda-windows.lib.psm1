#Requires -Version 5.1
<#
    Shared helper functions for scripts/install-onnxruntime-cuda-windows.ps1,
    pulled into their own module SPECIFICALLY so they can be imported and
    exercised by a real PowerShell test (tests/powershell/
    install-onnxruntime-cuda-windows.tests.ps1) without running the main
    .ps1 script's own param()/platform-gate/install flow at all — the main
    script is a parameterized top-level script, not a function library, so
    dot-sourcing it directly would execute the whole installer.

    Every function here takes $RepoRoot (and any other real dependency) as
    an explicit parameter rather than reading a script-scope variable, so a
    test can call these functions in complete isolation with fake/injected
    values — the same "no hidden module-scope state" discipline this
    codebase's own Node.js modules already follow throughout.
#>

function Write-Step {
    param([string]$Message)
    Write-Host "[install-onnxruntime-cuda] $Message" -ForegroundColor Cyan
}

function Write-Warn2 {
    param([string]$Message)
    Write-Warning "[install-onnxruntime-cuda] $Message"
}

function Invoke-NodeDecision {
    <#
        Calls src/local/core/onnx-cuda-installer-logic.js's CLI dispatch
        for one pure decision: `node <script> <decision>`, with $InputObject
        (a hashtable/PSObject) piped in as JSON on stdin, and the single
        JSON line on stdout parsed back into a PSCustomObject. This is the
        ONE place PowerShell crosses into the tested Node decision logic —
        never re-implements trust-gate/idempotent-skip/transactional-swap
        decisions itself.
    #>
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Decision,
        [Parameter(Mandatory)]$InputObject
    )
    $json = $InputObject | ConvertTo-Json -Depth 10 -Compress
    $scriptPath = Join-Path $RepoRoot 'src\local\core\onnx-cuda-installer-logic.js'
    $result = $json | node $scriptPath $Decision
    if ($LASTEXITCODE -ne 0) {
        throw "internal decision '$Decision' failed: $result"
    }
    return $result | ConvertFrom-Json
}

function Invoke-NodePrereqCheck {
    param([Parameter(Mandatory)][string]$RepoRoot)
    $scriptPath = Join-Path $RepoRoot 'src\local\core\onnx-cuda-prereq-check.js'
    $result = node $scriptPath
    if ($LASTEXITCODE -ne 0) {
        throw "prerequisite check script failed: $result"
    }
    return $result | ConvertFrom-Json
}

function Invoke-VerifierSafely {
    <#
        Runs a verifier script (src/local/core/onnx-cuda-installer-verify.js
        in production; a fake/broken node stand-in in tests) and ALWAYS
        returns a well-formed { ok; effectiveProvider; message | reason }
        object — never throws, never lets a crash escape to the caller.

        Review finding (P1): the previous code called `node $verifyScript
        | ConvertFrom-Json` directly at both call sites, with no
        try/catch. A node crash, a non-zero exit with no valid JSON on
        stdout, or a pipe failure would make ConvertFrom-Json itself
        throw — an exception that was NOT caught locally, so it
        propagated straight out of the enclosing `if (-not $SkipProbe)`
        block, skipping the after_probe rollback-planning step entirely.
        The outer script-level `finally` only removes the installer lock
        file; it does not restore a backed-up prior runtime. A crashed
        verifier could therefore leave the just-swapped-in (unverified,
        possibly broken) target in place with its own backup never
        restored — exactly the silent-rollback-bypass this function
        exists to close.

        Any failure here (non-zero exit, no output, invalid JSON) is
        normalized into `{ ok = $false; reason = <diagnostic> }`, the
        SAME shape the verifier's own real failure response uses, so
        every caller can keep treating this as an ordinary probeOk=false
        result and route it through the existing planTransactionalSwapStep
        rollback planner — never a special, less-safe path.

        `NodeCommand` (default: 'node') is injectable so a test can point
        this at a fake executable/script that crashes, exits non-zero, or
        prints garbage — never a real onnxruntime-node/CUDA session in a
        unit test.
    #>
    param(
        [Parameter(Mandatory)][string]$RuntimeDir,
        [Parameter(Mandatory)][string]$VerifyScript,
        [string]$NodeCommand = 'node'
    )
    # Bug found while writing this function's own regression test (P1
    # fix, second pass): the original implementation used `2>&1` to merge
    # the child's stderr into $rawOutput. Under Windows PowerShell,
    # `2>&1` on a NATIVE executable wraps each stderr line as a
    # terminating ErrorRecord — and if the CALLER's own
    # $ErrorActionPreference is 'Stop' (exactly what this script's own
    # top level sets, and what a real installer run always has active),
    # that ErrorRecord throws immediately, mid-assignment, before
    # $LASTEXITCODE is ever checked. The verifier could exit 0 with a
    # perfectly valid CUDA-success JSON result on stdout and STILL get
    # reported as a failure here, only because it also happened to log
    # something harmless to stderr — confirmed by direct reproduction:
    # identical inputs returned ok:true when $ErrorActionPreference was
    # 'Continue' in the calling scope and ok:false (misreported) when it
    # was 'Stop'. A verifier's own true/false result must never depend on
    # the CALLER's own unrelated preference variable.
    #
    # Fixed two ways, together: (1) stderr is redirected to $null instead
    # of merged into the captured output — this function only ever needs
    # stdout's single JSON line, never stderr text, so there is nothing
    # useful lost; (2) $ErrorActionPreference is pinned to 'Continue' for
    # the duration of the native-command call specifically, restored
    # afterward, so this function's own behavior can never again depend
    # on whatever the caller happened to set.
    $previousEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        try {
            $rawOutput = (@{ runtimeDir = $RuntimeDir } | ConvertTo-Json -Compress) | & $NodeCommand $VerifyScript 2>$null
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousEap
        }
        if ($exitCode -ne 0) {
            return [PSCustomObject]@{ ok = $false; effectiveProvider = $null; reason = "verifier exited with code $exitCode`: $rawOutput" }
        }
        if (-not $rawOutput) {
            return [PSCustomObject]@{ ok = $false; effectiveProvider = $null; reason = 'verifier produced no output' }
        }
        # $rawOutput can be a string[] when the child wrote multiple
        # stdout lines — only the LAST line is ever the real single JSON
        # result line, matching onnx-cuda-installer-verify.js's own
        # "exactly one JSON line to stdout" contract.
        $lastLine = if ($rawOutput -is [array]) { $rawOutput[-1] } else { $rawOutput }
        try {
            $parsed = $lastLine | ConvertFrom-Json
        } catch {
            return [PSCustomObject]@{ ok = $false; effectiveProvider = $null; reason = "verifier produced invalid JSON: $lastLine" }
        }
        return $parsed
    } catch {
        return [PSCustomObject]@{ ok = $false; effectiveProvider = $null; reason = "verifier crashed: $_" }
    }
}

function Get-FileSha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

Export-ModuleMember -Function Write-Step, Write-Warn2, Invoke-NodeDecision, Invoke-NodePrereqCheck, Invoke-VerifierSafely, Get-FileSha256
