// Pure helpers for npm run doctor. No I/O, no network — all smoke-testable.

export const STATUS = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL', SKIP: 'SKIP' };

// ── Redaction ─────────────────────────────────────────────────────────────────

export function redactKey(value) {
  if (!value) return 'missing';
  return `present (${String(value).length} chars)`;
}

export function redactUrl(raw) {
  if (!raw) return '(not set)';
  try {
    const u = new URL(raw);
    // Keep protocol + host + port only; strip username, password, path, query, hash.
    return `${u.protocol}//${u.host}`;
  } catch {
    // Not a valid URL — return a fixed placeholder rather than the raw value.
    return '(invalid URL)';
  }
}

// Sanitise an error message before printing:
//   1. Replace any literal occurrence of each secret (e.g. QDRANT_KEY,
//      GEMINI_API_KEY — pass an array to redact more than one in one call).
//   2. Strip URLs that contain credentials (user:pass@host) or query strings
//      that may embed bearer tokens, replacing them with their host-only form.
export function sanitiseErrorMessage(msg, secret) {
  if (!msg) return '';
  let out = String(msg);
  // 1. Literal key redaction — secret may be a single string or an array of
  // strings; falsy entries (unset env vars) are skipped.
  const secrets = Array.isArray(secret) ? secret : [secret];
  for (const s of secrets) {
    if (s) out = out.split(s).join('[REDACTED]');
  }
  // 2. URL credential / query redaction: replace https?://...@host/path?q with host-only
  out = out.replace(/https?:\/\/[^\s"')]+/g, (match) => {
    try {
      const u = new URL(match);
      // Has credentials or query string → reduce to host only
      if (u.username || u.password || u.search || u.pathname !== '/') {
        return `${u.protocol}//${u.host}`;
      }
    } catch { /* not a valid URL — leave as-is */ }
    return match;
  });
  return out;
}

// ── Status helpers ────────────────────────────────────────────────────────────

export function makeResult(status, label, detail = '') {
  return { status, label, detail };
}

// Returns exit code: 0 if no FAIL, 1 if any FAIL.
export function aggregateExitCode(results) {
  return results.some(r => r.status === STATUS.FAIL) ? 1 : 0;
}

const ICON = { PASS: '✓', WARN: '⚠', FAIL: '✗', SKIP: '~' };

export function formatResult(r) {
  const icon = ICON[r.status] ?? '?';
  const detail = r.detail ? `\n             → ${r.detail}` : '';
  return `  ${icon} ${r.status.padEnd(4)}  ${r.label}${detail}`;
}

// ── Node version check ────────────────────────────────────────────────────────

export function checkNodeVersion(versionString) {
  // versionString e.g. "v25.2.1"
  const match = String(versionString).match(/^v?(\d+)/);
  const major = match ? parseInt(match[1], 10) : 0;
  if (major < 18) {
    return makeResult(STATUS.FAIL, `Node.js ${versionString}`, 'Node 18+ required (native fetch)');
  }
  if (major < 20) {
    return makeResult(STATUS.WARN, `Node.js ${versionString}`, 'Node 20+ recommended');
  }
  return makeResult(STATUS.PASS, `Node.js ${versionString}`);
}

// ── Vector schema classification ──────────────────────────────────────────────

// vectorsCfg = info.config?.params?.vectors ?? {}
// Returns 'flat' | 'named' | 'empty'
export function classifyVectorSchema(vectorsCfg) {
  if (!vectorsCfg || typeof vectorsCfg !== 'object') return 'empty';
  if (typeof vectorsCfg.size === 'number') return 'flat';
  if (typeof vectorsCfg.dense === 'object' && vectorsCfg.dense !== null) return 'named';
  return 'empty';
}

// ── Provider agreement check ──────────────────────────────────────────────────

// configEntry = { denseProvider, sparseProvider, ... } from config.json
// samplePayload = { dense_provider, sparse_provider, embedding_schema_version, ... } or null
// Returns a result object.
export function checkProviderAgreement(configEntry, samplePayload) {
  if (!samplePayload) {
    return makeResult(STATUS.SKIP, 'Provider agreement', 'empty collection — no sample point');
  }
  const cfgDense  = configEntry?.denseProvider ?? '?';
  const cfgSparse = configEntry?.sparseProvider ?? '?';
  const ptDense   = samplePayload.dense_provider ?? '?';
  const ptSparse  = samplePayload.sparse_provider ?? '?';
  if (cfgDense !== ptDense || cfgSparse !== ptSparse) {
    return makeResult(
      STATUS.WARN,
      `Provider mismatch: config says ${cfgDense}/${cfgSparse}, last point says ${ptDense}/${ptSparse}`,
      'Full reindex will be triggered on next npm run index',
    );
  }
  return makeResult(STATUS.PASS, `Provider agreement: ${cfgDense}/${cfgSparse}`);
}

// ── Schema version check ──────────────────────────────────────────────────────

export function checkSchemaVersion(samplePayload, currentVersion) {
  if (!samplePayload) {
    return makeResult(STATUS.SKIP, 'Schema version', 'empty collection');
  }
  const v = samplePayload.embedding_schema_version ?? null;
  if (v === null) {
    return makeResult(STATUS.WARN, 'Schema version: unknown (field missing in sample point)');
  }
  if (v < currentVersion) {
    return makeResult(
      STATUS.WARN,
      `Schema version: ${v} (current: ${currentVersion})`,
      `Full reindex will upgrade to v${currentVersion} on next npm run index`,
    );
  }
  return makeResult(STATUS.PASS, `Schema version: ${v}`);
}

// ── Ollama model pull command builder ─────────────────────────────────────────

// Returns array of unique "ollama pull <model>" lines for any missing models.
export function missingModelCommands(required, available) {
  const availSet = new Set(available);
  const missing = [...new Set(required)].filter(m => !availSet.has(m));
  return missing.map(m => `ollama pull ${m}`);
}

// ── CUDA strict-mode helpers ──────────────────────────────────────────────────

// Returns true when ONNX_CUDA_STRICT=1 is set in the given env map.
export function isCudaStrict(env = process.env) {
  return env.ONNX_CUDA_STRICT === '1';
}

// Builds the actionable error message thrown when strict CUDA fails.
// errMessage: one-line ORT error (already sanitised/truncated by caller).
// platform: process.platform value ('win32', 'linux', etc.).
// Returns a string — no trailing newline.
export function buildCudaStrictError(errMessage, platform) {
  const ortLine = errMessage ? `ONNX Runtime: ${errMessage}` : 'ONNX Runtime: no available backend found';
  const platformLines = platform === 'win32'
    ? [
        'Windows: the npm-installed onnxruntime-node prebuilt binding does not',
        '  include a CUDA execution provider (CPU/DirectML only). CUDA on Windows',
        '  requires a compatible custom onnxruntime-node build — set',
        '  ONNXRUNTIME_NODE_PATH to point at it. CUDA Toolkit/cuDNN themselves are',
        '  OS-level prerequisites semidex does not install or manage. If you do not',
        '  have a custom CUDA build, use ONNX_EXECUTION_PROVIDER=dml instead.',
      ]
    : [
        'Linux: CUDA requires CUDA 12.x + cuDNN 9 + LD_LIBRARY_PATH set to their lib dirs.',
        '  Verify: nvidia-smi  |  nvcc --version (must be 12.x)',
        '  Set LD_LIBRARY_PATH to include CUDA lib64 and cuDNN lib.',
      ];
  return [
    `[onnx] CUDA provider failed — ONNX_EXECUTION_PROVIDER=cuda ONNX_CUDA_STRICT=1`,
    `  ${ortLine}`,
    ...platformLines,
    '  To fall back to CPU: unset ONNX_CUDA_STRICT or set ONNX_EXECUTION_PROVIDER=cpu',
    '  See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER',
  ].join('\n');
}

// ── CUDA probe guidance helpers ───────────────────────────────────────────────

// Platform-specific guidance lines for a failed CUDA probe.
// platform: process.platform value ('win32', 'linux', etc.)
// Returns a string suitable for the `detail` field of a doctor result.
export function cudaProbeGuidance(platform) {
  if (platform === 'win32') {
    return [
      'The npm-installed onnxruntime-node prebuilt binding is CPU/DirectML',
      'only — it has no CUDA execution provider. Windows CUDA requires a',
      'compatible custom onnxruntime-node build: set ONNXRUNTIME_NODE_PATH to',
      'its path. CUDA Toolkit/cuDNN are OS-level prerequisites semidex does',
      'not install or manage. Without a custom build, use',
      'ONNX_EXECUTION_PROVIDER=dml for GPU acceleration, or',
      'ONNX_EXECUTION_PROVIDER=cpu.',
      'See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER',
    ].join('\n             ');
  }
  return [
    'CUDA on Linux requires CUDA 12.x + cuDNN 9 + LD_LIBRARY_PATH set to their lib dirs.',
    'Verify: nvidia-smi  |  nvcc --version (must be 12.x)  |  LD_LIBRARY_PATH includes CUDA lib64 + cuDNN lib',
    'To use CPU instead: ONNX_EXECUTION_PROVIDER=cpu',
    'See: docs/en/configuration.md — ONNX_EXECUTION_PROVIDER',
  ].join('\n             ');
}

// One-line detail string for a CUDA probe failure result.
// errMessage: the (already-truncated) error string from probeOnnxProvider.
// platform: process.platform value.
export function formatCudaProbeFailure(errMessage, platform) {
  const guidance = cudaProbeGuidance(platform);
  if (errMessage) return `${errMessage}\n             ${guidance}`;
  return guidance;
}

// ── COMBINED_LLM config helper ────────────────────────────────────────────────

const DEFAULT_CONTEXT_MODEL = 'gemma3:4b';

// Resolves combined LLM mode config from the environment.
// Returns { enabled, model, warning }.
//   enabled: true only when COMBINED_LLM=1
//   model:   CONTEXT_MODEL (or default) — the single model used for both context and tags
//   warning: non-empty string when TAG_MODEL is set to a different value than CONTEXT_MODEL
export function resolveCombinedLlmConfig(env = process.env) {
  const enabled = env.COMBINED_LLM === '1';
  const model   = env.CONTEXT_MODEL || DEFAULT_CONTEXT_MODEL;

  let warning = '';
  if (enabled && env.TAG_MODEL && env.TAG_MODEL !== model) {
    // Only warn when TAG_MODEL is explicitly set to a different value.
    // If TAG_MODEL is unset, there is no user confusion to surface.
    warning = `COMBINED_LLM=1 uses CONTEXT_MODEL for both context and tags; TAG_MODEL is ignored.`;
  }

  return { enabled, model, warning };
}
