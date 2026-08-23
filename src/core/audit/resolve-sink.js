// Resolves the default audit sink for a composition root or CLI entry
// point — mirrors src/core/auth/resolve-policy.js's own pattern exactly
// (same SEMIDEX_HOME resolution, same "instance-scoped, fresh per call,
// no module-level mutable state" contract), so this needs no Lite-specific
// wrapper: it lives under src/core/ and is staged into the Lite package
// build unmodified, exactly like resolve-policy.js already is.
//
// Design record: docs/security/audit-logging-design-2026-08.md §4/§7.
import { join } from 'node:path';
import { createNoopAuditSink, withEditionTag } from './sink.js';
import { createJsonlAuditSink, createSyncJsonlAuditSink, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } from './jsonl-sink.js';

const EDITION_VALUES = new Set(['full', 'lite']);

/**
 * Resolves where the audit log should live, or `null` when no location is
 * configured at all.
 *
 * Deliberately DOES NOT fall back to `process.cwd()` the way
 * resolveKeyStorePath() (resolve-policy.js) falls back for the key store —
 * that fallback is safe there because a constructed-but-idle key store only
 * ever READS (existsSync/readFileSync) unless a `key add`/`key revoke` call
 * explicitly asks it to write, so an ad-hoc `createApp()`/`createLiteApp()`
 * call with no SEMIDEX_HOME configured (every test in this codebase that
 * doesn't override it, and there are hundreds) never touches disk through
 * it. The audit sink is the opposite shape: `record()` writes on every
 * call, driven by ordinary request handling (a Host check, a 404, a
 * successful auth) — not an explicit operator action. Falling back to
 * `process.cwd()` here was tried and reverted after it was found to
 * silently create a real `audit/audit.log` in the repository root during
 * `npm test`, because dozens of existing tests construct `createApp()`/
 * `createLiteApp()` (which resolve this by default) without ever knowing
 * this new parameter exists. Returning `null` here makes
 * `resolveAuditSink()` fall back to a no-op sink instead (see below) —
 * exactly the same "no configuration ⇒ disabled, not a guessed location"
 * shape `allowed-roots-guard.js` already uses for `INDEX_ALLOWED_ROOTS`.
 * Real production processes are unaffected: `admin/bootstrap.js` (Full) and
 * `packages/lite/bin/semidex-lite.js` (Lite) both call their own
 * `applySemidexHomeEnv()` before constructing the composition root, so
 * `SEMIDEX_HOME` is always set by the time this function runs there.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function resolveAuditLogDir(env = process.env) {
  if (env.SEMIDEX_AUDIT_LOG_DIR) return env.SEMIDEX_AUDIT_LOG_DIR;
  if (env.SEMIDEX_HOME) return join(env.SEMIDEX_HOME, 'audit');
  return null;
}

/**
 * Parses a positive-integer env override, falling back to `fallback` (with
 * a console warning, never a thrown error) for anything unset, non-numeric,
 * or out of range — a malformed tuning knob for a secondary logging
 * subsystem must never prevent the server itself from starting, unlike the
 * fail-closed ADMIN_ALLOWED_HOSTS contract in request-security.js (a real
 * access-control policy, not the case here).
 */
function parsePositiveIntEnv(raw, fallback, label) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.warn(`[semidex] ${label}="${raw}" is not a positive integer; using the default (${fallback}).`);
    return fallback;
  }
  return n;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   edition?: 'full' | 'lite' | null,
 *   sync?: boolean,
 *   dir?: string,
 *   logger?: { warn: Function, error: Function },
 * }} [opts]
 *   `edition`, when given, is applied to EVERY event recorded through the
 *   returned sink (see sink.js's withEditionTag()) — this is what makes
 *   `createApp()`/`createLiteApp()`'s own `resolveAuditSink({ edition:
 *   'full'|'lite' })` calls actually tag events, rather than every event
 *   defaulting to `edition: null` regardless of which composition root
 *   emitted it. Passing `null` (the default) preserves the previous
 *   behavior exactly — no wrapping, `edition` stays whatever
 *   buildAuditEvent() defaulted it to.
 * @returns {import('./sink.js').AuditSink}
 */
export function resolveAuditSink({ env = process.env, edition = null, sync = false, dir, logger = console } = {}) {
  if (edition !== null && !EDITION_VALUES.has(edition)) {
    throw new TypeError(`resolveAuditSink: edition must be 'full', 'lite', or null (received ${JSON.stringify(edition)}).`);
  }

  let sink;
  if (env.SEMIDEX_AUDIT_LOG_DISABLED === '1') {
    sink = createNoopAuditSink();
  } else {
    const resolvedDir = dir ?? resolveAuditLogDir(env);
    // No SEMIDEX_HOME and no explicit override: see resolveAuditLogDir()'s
    // own comment for why this is a no-op rather than a cwd-relative guess.
    if (!resolvedDir) {
      sink = createNoopAuditSink();
    } else {
      const maxBytes = parsePositiveIntEnv(env.SEMIDEX_AUDIT_LOG_MAX_BYTES, DEFAULT_MAX_BYTES, 'SEMIDEX_AUDIT_LOG_MAX_BYTES');
      const maxFiles = parsePositiveIntEnv(env.SEMIDEX_AUDIT_LOG_MAX_FILES, DEFAULT_MAX_FILES, 'SEMIDEX_AUDIT_LOG_MAX_FILES');
      const onWarn = (msg) => logger.error(msg);
      sink = sync
        ? createSyncJsonlAuditSink({ dir: resolvedDir, maxBytes, maxFiles, onWarn })
        : createJsonlAuditSink({ dir: resolvedDir, maxBytes, maxFiles, onWarn });
    }
  }

  return edition !== null ? withEditionTag(sink, edition) : sink;
}
