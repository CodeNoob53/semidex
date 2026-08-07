// Shared plumbing between run-scifact.mjs (full benchmark) and
// run-rrf-mini.mjs (local RRF k sensitivity mini-check): client
// construction, redaction, bounded retry, percentile, and the
// BEIR-string-ID <-> Qdrant-point-ID mapping. Extracted so the two runners
// cannot silently drift on retry/backoff/redaction/ID-mapping behavior —
// previously each runner carried its own copy of all of this.
//
// No production code imported here beyond sanitiseErrorMessage (the same
// redaction helper the full benchmark already depended on).
import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'node:crypto';

import { sanitiseErrorMessage } from '../../../src/shared/core/doctor-checks.js';

export const MAX_RETRIES = 5;
export const BASE_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 8000;

/** Redacts secrets, auth headers, and this machine's local repo path from
 * error text. `repoRoot` is passed in (not hardcoded) so this module has no
 * assumption about where it itself lives on disk. */
export function makeRedactor(secret, repoRoot) {
  const authHeaderRe = /("?(?:authorization|api[-_]?key|x-api-key)"?\s*[:=]\s*)("?)([^"\s,}]+)(\2)/gi;
  return (value) => {
    let text = value instanceof Error ? (value.stack || value.message || String(value)) : String(value ?? '');
    text = sanitiseErrorMessage(text, secret);
    text = text.replace(authHeaderRe, (_m, pre, q) => `${pre}${q}[REDACTED]${q}`);
    if (repoRoot) {
      text = text.replace(new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<repo>');
    }
    return text;
  };
}

/** Describes a Qdrant endpoint URL for reporting without ever exposing the
 * cluster ID (the part of a Qdrant Cloud hostname that is effectively a
 * bearer-adjacent secret alongside the API key). */
export function describeEndpoint(raw) {
  if (!raw) return { configured: false };
  let host;
  try { host = new URL(raw).host; } catch { return { configured: true, scheme: null, provider: null, region: null, maskedHost: '(invalid URL)' }; }
  const bare = host.split(':')[0];
  const labels = bare.split('.');
  const isQdrantCloud = bare.endsWith('.cloud.qdrant.io') && labels.length >= 5;
  let provider = null; let region = null;
  if (isQdrantCloud) { region = labels[1] ?? null; provider = labels[2] ?? null; }
  const maskedHost = labels.length > 1 ? ['<cluster-id>', ...labels.slice(1)].join('.') : '<cluster-id>';
  let scheme = null;
  try { scheme = new URL(raw).protocol.replace(':', ''); } catch { /* leave null */ }
  return { configured: true, scheme, provider, region, maskedHost };
}

export function buildClient() {
  const url = process.env.QDRANT_URL;
  if (!url) throw new Error('QDRANT_URL is not set.');
  const apiKey = process.env.QDRANT_KEY || undefined;
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : null;
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  const prefix = trimmedPath !== '' ? trimmedPath : undefined;
  parsed.pathname = '/';
  const strippedUrl = parsed.toString().replace(/\/$/, '') || parsed.toString();
  return new QdrantClient({ url: strippedUrl, apiKey, port, prefix, timeout: 60000, checkCompatibility: false });
}

export async function timed(fn) {
  const start = process.hrtime.bigint();
  try {
    const value = await fn();
    return { ok: true, value, ms: Number((process.hrtime.bigint() - start) / 1000000n) };
  } catch (err) {
    return { ok: false, err, ms: Number((process.hrtime.bigint() - start) / 1000000n) };
  }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Bounded retry with Retry-After / exponential backoff. Retries only on
 * likely-transient failures (429, 5xx, network); never retries a 4xx that
 * isn't 429. */
export async function withBoundedRetry(fn, { onRetry } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= MAX_RETRIES) {
    const r = await timed(fn);
    if (r.ok) return { ...r, attempts: attempt + 1 };
    lastErr = r.err;
    const status = lastErr?.status ?? lastErr?.response?.status ?? null;
    const retryable = status === 429 || (status >= 500 && status < 600) || status === null;
    if (!retryable || attempt === MAX_RETRIES) return { ...r, attempts: attempt + 1 };
    const retryAfterHeader = lastErr?.response?.headers?.get?.('retry-after');
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
    const backoff = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    onRetry?.({ attempt: attempt + 1, status, backoffMs: backoff });
    await sleep(backoff);
    attempt += 1;
  }
  return { ok: false, err: lastErr, ms: 0, attempts: attempt + 1 };
}

export function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.floor(p * (sortedArr.length - 1));
  return sortedArr[idx];
}

// ── deterministic collision-checked BEIR ID -> Qdrant point ID mapping ─────
// Qdrant point IDs must be an unsigned integer or a UUID — BEIR doc/query
// IDs are arbitrary strings, so they cannot be used directly.
export function stringIdToPointId(namespace, stringId) {
  const hash = createHash('sha1').update(`${namespace}:${stringId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export function buildIdMapping(stringIds, namespace) {
  const toPoint = new Map();
  const toString = new Map();
  const collisions = [];
  for (const id of stringIds) {
    const pointId = stringIdToPointId(namespace, id);
    if (toString.has(pointId) && toString.get(pointId) !== id) {
      collisions.push({ pointId, first: toString.get(pointId), second: id });
      continue;
    }
    toPoint.set(id, pointId);
    toString.set(pointId, id);
  }
  return { toPoint, toString, collisions };
}
