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
//   1. Replace any literal occurrence of `secret` (e.g. the raw QDRANT_KEY).
//   2. Strip URLs that contain credentials (user:pass@host) or query strings
//      that may embed bearer tokens, replacing them with their host-only form.
export function sanitiseErrorMessage(msg, secret) {
  if (!msg) return '';
  let out = String(msg);
  // 1. Literal key redaction
  if (secret) out = out.split(secret).join('[REDACTED]');
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
