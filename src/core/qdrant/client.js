// Lazy Qdrant SDK client creation and env handling.
//
// This is the ONLY module in semidex that constructs a QdrantClient. All
// network operations live in store.js and go through getQdrantClient().
// Nothing here runs at import time except loading .env — no env validation,
// no client construction, no network probes.
import 'dotenv/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { emitTelemetry } from '../bench-telemetry.js';

// Timeouts preserve the pre-SDK wrapper's behavior: 30 s reads, 60 s writes.
// The SDK supports one timeout per client instance, hence two cached clients.
const READ_TIMEOUT_MS  = 30_000;
const WRITE_TIMEOUT_MS = 60_000;

// Cached by url + apiKey so tests (and long-lived processes) get a fresh
// client when env changes.
let cached = null;

export function getQdrantClient({ write = false } = {}) {
  const url = process.env.QDRANT_URL;
  if (!url) throw new Error('QDRANT_URL is not set. Add it to your .env file.');
  const apiKey = process.env.QDRANT_KEY || undefined;

  const cacheKey = `${url} ${apiKey ?? ''}`;
  if (!cached || cached.key !== cacheKey) {
    // Preserve raw-fetch port semantics: explicit port wins; otherwise the
    // protocol default (443/80). Without this, the SDK would default to :6333
    // and break QDRANT_URLs that relied on the implicit protocol port.
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : null;
    // The SDK never reads pathname off `url` — it only builds the REST URI
    // from host + port + `prefix`. Strip the path from `url` and forward it
    // as `prefix` so QDRANT_URLs like https://host/qdrant keep working
    // (the SDK also throws if both `url`'s pathname and `prefix` are set).
    const trimmedPathname = parsed.pathname.replace(/\/+$/, '');
    const prefix = trimmedPathname !== '' ? trimmedPathname : undefined;
    parsed.pathname = '/';
    const strippedUrl = parsed.toString().replace(/\/$/, '') || parsed.toString();
    const make = (timeout) => new QdrantClient({
      url: strippedUrl, apiKey, port, prefix, timeout,
      // The compatibility probe fires a network request at construction time
      // and console.warns when Qdrant is unreachable — unacceptable for
      // offline test imports. Doctor covers version diagnostics instead.
      checkCompatibility: false,
    });
    cached = { key: cacheKey, read: make(READ_TIMEOUT_MS), write: make(WRITE_TIMEOUT_MS) };
  }
  return write ? cached.write : cached.read;
}

/** Drop cached client instances. Intended for tests. */
export function resetQdrantClientCache() {
  cached = null;
}

// ── Error normalisation ───────────────────────────────────────────────────────
// SDK errors (ApiError from openapi-typescript-fetch, QdrantClientTimeoutError)
// carry the Qdrant error JSON in `.data`. Flatten to actionable text and keep
// the pre-migration message prefixes that docs and troubleshooting refer to.
export function errText(err) {
  const data = err?.data;
  if (data !== undefined && data !== null) {
    try {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      return `${err.message ?? 'request failed'}: ${detail}`;
    } catch { /* fall through */ }
  }
  return String(err?.message ?? err);
}

export async function qdrantCall(label, fn) {
  // Opt-in benchmark telemetry (no-op unless SEMIDEX_BENCH_TELEMETRY_PATH
  // is set — see src/core/bench-telemetry.js). One 'qdrant_sdk_op' event
  // per logical SDK method invocation passed through this wrapper — this
  // is SDK-call granularity, not a raw HTTP transport count, since the
  // SDK may itself batch/retry/keep-alive beneath what qdrantCall sees.
  const t0 = Date.now();
  try {
    const result = await fn();
    emitTelemetry({ kind: 'qdrant_sdk_op', label, ms: Date.now() - t0, ok: true });
    return result;
  } catch (err) {
    emitTelemetry({ kind: 'qdrant_sdk_op', label, ms: Date.now() - t0, ok: false });
    throw new Error(`${label}: ${errText(err)}`);
  }
}
