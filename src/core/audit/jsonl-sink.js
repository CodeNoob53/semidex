// Local JSONL audit sink — two implementations sharing the same on-disk
// format and rotation logic:
//
//   createJsonlAuditSink()     — non-blocking, queued, for the long-running
//                                 HTTP server process (Full/Lite). record()
//                                 never does synchronous disk I/O; a single
//                                 always-running async drain loop batches
//                                 writes. See "no synchronous disk I/O on
//                                 the hot path" in the design doc.
//   createSyncJsonlAuditSink() — record() writes and returns only once the
//                                 line is durable. Used ONLY by the
//                                 `key add`/`key revoke` CLI
//                                 (core/auth/key-cli.js), a one-shot,
//                                 short-lived process with no request path
//                                 to protect and no event loop to keep
//                                 alive after the write.
//
// Design record: docs/security/audit-logging-design-2026-08.md §4.
import { promises as fsp, mkdirSync, appendFileSync, chmodSync, statSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateAuditEvent } from './event.js';

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_MAX_FILES = 5; // active audit.log + up to 4 rotated copies
export const DEFAULT_MAX_QUEUE_SIZE = 10_000;
export const DEFAULT_FILE_NAME = 'audit.log';
const DEFAULT_WARN_THROTTLE_MS = 60_000;

// A write failure's err.message can embed the full, absolute path this sink
// was configured with (e.g. Node's own "ENOENT: no such file or directory,
// open 'C:\Users\<name>\...'") — exactly the "unrestricted local path" this
// entire module exists to keep out of any log. The operator warning below
// therefore never interpolates err.message, only a fixed string plus
// err.code, itself allow-listed against known Node fs error codes so an
// unrecognized/unexpected code string cannot smuggle anything else through
// either.
const KNOWN_FS_ERROR_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EMFILE',
  'ENFILE', 'ENOSPC', 'EROFS', 'EBUSY', 'EXDEV', 'ELOOP', 'ENAMETOOLONG',
]);
function safeErrorCode(err) {
  const code = err?.code;
  return (typeof code === 'string' && KNOWN_FS_ERROR_CODES.has(code)) ? code : 'unknown_error';
}

/** Deterministic, single-line JSON encoding — same event, same bytes, every time. */
export function serializeEvent(event) {
  const keys = Object.keys(event).sort();
  const ordered = {};
  for (const key of keys) ordered[key] = event[key];
  return `${JSON.stringify(ordered)}\n`;
}

function activePath(dir, fileName) {
  return join(dir, fileName);
}

function rotatedPath(dir, fileName, n) {
  return join(dir, `${fileName}.${n}`);
}

/** Builds a throttled warn(message) — at most one call through to onWarn per warnThrottleMs, regardless of call volume. */
function makeThrottledWarn(onWarn, warnThrottleMs, now) {
  let lastAt = -Infinity;
  return (message) => {
    const t = now();
    if (t - lastAt < warnThrottleMs) return;
    lastAt = t;
    onWarn(message);
  };
}

// ── synchronous variant (CLI only) ──────────────────────────────────────

function rotateSync(dir, fileName, maxFiles) {
  const overflow = rotatedPath(dir, fileName, maxFiles - 1);
  if (existsSync(overflow)) unlinkSync(overflow);
  for (let n = maxFiles - 2; n >= 1; n--) {
    const src = rotatedPath(dir, fileName, n);
    if (existsSync(src)) renameSync(src, rotatedPath(dir, fileName, n + 1));
  }
  const active = activePath(dir, fileName);
  if (!existsSync(active)) return;
  if (maxFiles > 1) renameSync(active, rotatedPath(dir, fileName, 1));
  else unlinkSync(active);
}

/**
 * @param {{ dir: string, fileName?: string, maxBytes?: number, maxFiles?: number, onWarn?: (msg: string) => void, warnThrottleMs?: number, now?: () => number }} opts
 * @returns {import('./sink.js').AuditSink}
 */
export function createSyncJsonlAuditSink({
  dir,
  fileName = DEFAULT_FILE_NAME,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  onWarn = (msg) => console.error(msg),
  warnThrottleMs = DEFAULT_WARN_THROTTLE_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new TypeError('createSyncJsonlAuditSink requires a dir.');
  }
  const warn = makeThrottledWarn(onWarn, warnThrottleMs, now);
  let dirReady = false;

  function ensureDir() {
    if (dirReady) return;
    mkdirSync(dir, { recursive: true });
    try { chmodSync(dir, 0o700); } catch { /* best-effort, e.g. Windows */ }
    dirReady = true;
  }

  return {
    record(event) {
      if (!validateAuditEvent(event)) {
        warn('[semidex] audit log: dropped a malformed event at the logging boundary (not written).');
        return;
      }
      try {
        ensureDir();
        const line = serializeEvent(event);
        const active = activePath(dir, fileName);
        let currentSize = 0;
        try { currentSize = statSync(active).size; } catch { currentSize = 0; }
        if (currentSize > 0 && currentSize + Buffer.byteLength(line) > maxBytes) {
          rotateSync(dir, fileName, maxFiles);
        }
        appendFileSync(active, line, { encoding: 'utf-8', mode: 0o600 });
        try { chmodSync(active, 0o600); } catch { /* best-effort */ }
      } catch (err) {
        warn(`[semidex] audit log write failed (${safeErrorCode(err)}) — event not written.`);
      }
    },
    async flush() {},
    async close() {},
  };
}

// ── async variant (server process) ──────────────────────────────────────

async function rotateAsync(dir, fileName, maxFiles) {
  const overflow = rotatedPath(dir, fileName, maxFiles - 1);
  await fsp.unlink(overflow).catch(() => {});
  for (let n = maxFiles - 2; n >= 1; n--) {
    await fsp.rename(rotatedPath(dir, fileName, n), rotatedPath(dir, fileName, n + 1)).catch(() => {});
  }
  const active = activePath(dir, fileName);
  if (maxFiles > 1) {
    await fsp.rename(active, rotatedPath(dir, fileName, 1)).catch(() => {});
  } else {
    await fsp.unlink(active).catch(() => {});
  }
}

/**
 * @param {{
 *   dir: string, fileName?: string, maxBytes?: number, maxFiles?: number,
 *   maxQueueSize?: number, onWarn?: (msg: string) => void,
 *   warnThrottleMs?: number, now?: () => number,
 * }} opts
 * @returns {import('./sink.js').AuditSink}
 */
export function createJsonlAuditSink({
  dir,
  fileName = DEFAULT_FILE_NAME,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  onWarn = (msg) => console.error(msg),
  warnThrottleMs = DEFAULT_WARN_THROTTLE_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new TypeError('createJsonlAuditSink requires a dir.');
  }
  const warn = makeThrottledWarn(onWarn, warnThrottleMs, now);

  /** @type {Readonly<Object>[]} */
  let queue = [];
  let draining = false;
  let closed = false;
  let dropped = 0;
  let dirReady = null;

  function ensureDir() {
    if (!dirReady) {
      dirReady = fsp.mkdir(dir, { recursive: true }).then(() => fsp.chmod(dir, 0o700).catch(() => {}));
    }
    return dirReady;
  }

  async function writeBatch(events) {
    await ensureDir();
    const lines = events.map(serializeEvent).join('');
    const active = activePath(dir, fileName);
    let currentSize = 0;
    try { currentSize = (await fsp.stat(active)).size; } catch { currentSize = 0; }
    if (currentSize > 0 && currentSize + Buffer.byteLength(lines) > maxBytes) {
      await rotateAsync(dir, fileName, maxFiles);
    }
    await fsp.appendFile(active, lines, { encoding: 'utf-8', mode: 0o600 });
    await fsp.chmod(active, 0o600).catch(() => {});
  }

  // No setInterval/setTimeout anywhere in this module (mirrors
  // core/auth/rate-limiter.js's own "no timers that keep the process
  // alive" rule): draining only ever runs in response to a real record()
  // call, and the loop below re-checks `queue` after every write so an
  // event pushed while a write was in flight is picked up in the same
  // drain pass rather than left stranded until the next record().
  async function drain() {
    draining = true;
    try {
      while (queue.length > 0) {
        const batch = queue;
        queue = [];
        try {
          await writeBatch(batch);
        } catch (err) {
          warn(`[semidex] audit log write failed (${safeErrorCode(err)}); ${batch.length} event(s) may be lost.`);
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    record(event) {
      if (closed) return;
      if (!validateAuditEvent(event)) {
        warn('[semidex] audit log: dropped a malformed event at the logging boundary (not written).');
        return;
      }
      if (queue.length >= maxQueueSize) {
        dropped++;
        if (dropped === 1 || dropped % 1000 === 0) {
          warn(`[semidex] audit log queue is full (${maxQueueSize} events); ${dropped} event(s) dropped so far.`);
        }
        return;
      }
      queue.push(event);
      if (!draining) drain(); // fire-and-forget by design — record() never awaits disk I/O
    },
    async flush() {
      // Polls with setImmediate rather than a fixed sleep so this resolves
      // as soon as the in-flight drain (if any) actually empties the
      // queue, never later. Bounded by real work, not a timer left running
      // in the background — nothing here survives past this call.
      while (draining || queue.length > 0) {
        await new Promise((resolve) => { setImmediate(resolve); });
      }
    },
    async close() {
      closed = true;
      await this.flush();
    },
  };
}
