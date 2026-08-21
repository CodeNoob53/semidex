// Lowest-level settings.json file I/O — the only module that touches the
// settings.json path directly. SettingsService (service.js) is the only
// caller; every other module (production or UI) goes through the service,
// never this file.
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, chmodSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// settings.json holds QDRANT_KEY/GEMINI_API_KEY whenever they were set
// through the Settings API rather than .env (docs/security/
// semidex-lite-public-api-audit-2026-08.md finding P2-2). Same secret class,
// same target mode (0o600) as core/auth/key-store.js's own
// restrictive-permissions handling — but this module's pre-rename chmod is
// fail-closed on POSIX (see writeSettingsFileAtomic()'s doc comment), which
// key-store.js's own best-effort chmod is not; the two are related, not
// identical.
const SETTINGS_FILE_MODE = 0o600;

// SEMIDEX_SETTINGS_PATH redirects settings.json to a writable application
// home (e.g. Semidex Lite's SEMIDEX_HOME/settings.json) instead of the
// package-relative default — a globally-installed npm package must never
// write into its own node_modules directory. Backward compatible: when the
// env var is unset it resolves to the exact package-relative location full
// Semidex has always used, so a checked-out repo is unchanged. Read fresh
// at import; a caller that needs to redirect it sets the env var before
// this module is first imported.
export const DEFAULT_SETTINGS_PATH = process.env.SEMIDEX_SETTINGS_PATH
  ? resolve(process.env.SEMIDEX_SETTINGS_PATH)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../../settings.json');

export function readSettingsFile(path = DEFAULT_SETTINGS_PATH) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Atomic write: tmp file + rename, mirroring core/config.js's saveConfig()
 * exactly — never leaves a partially-written settings.json on disk even if
 * the process is killed mid-write.
 *
 * File-mode hardening (audit finding P2-2): the tmp file is created with
 * mode 0o600 and explicitly chmod'd to 0o600 BEFORE the rename. The chmod is
 * not redundant with `writeFileSync`'s own `mode` option: that option is
 * only applied by the OS when `open()` actually CREATES the file (i.e. when
 * the tmp path did not already exist). If a previous write crashed after
 * creating `${path}.tmp` but before renaming it into place, that stale tmp
 * file already has whatever mode it was originally created with — `mode`
 * plays no part when `writeFileSync` merely truncates and rewrites an
 * EXISTING file. The explicit `chmodSync` is what actually forces 0o600 on
 * that inode regardless of its prior mode. (This is not about umask
 * "widening" 0o600 — umask can only ever CLEAR bits from a requested mode,
 * never add them, so a freshly-created tmp file can never come out more
 * permissive than requested. The stale-pre-existing-tmp case above is the
 * real reason this call matters, plus it functions as an explicit,
 * verifiable guarantee rather than an implicit one.)
 *
 * FAIL-CLOSED on POSIX: if `chmodSync(tmp, 0o600)` throws, the rename is
 * skipped entirely — a pre-rename chmod failure means this process cannot
 * prove the tmp file (possibly a stale, more-permissive inode from an
 * earlier crash) is actually 0o600, so renaming it over settings.json would
 * silently ship exactly the exposure this fix exists to close, while still
 * reporting success. The tmp file is removed best-effort and the original
 * chmod error is re-thrown unchanged (see the outer catch below).
 *
 * BEST-EFFORT on Windows: `chmodSync` there only toggles the read-only
 * attribute — it cannot express POSIX group/other bits and enforces no ACL,
 * so it never provided the guarantee the POSIX branch is fail-closed about.
 * Failing closed on a check that was never load-bearing there would only
 * turn an already-best-effort platform into "settings can't be saved at
 * all" for no real confidentiality gain. `platform` is injectable (defaults
 * to `process.platform`) so this branch is exercised deterministically in
 * tests without needing to actually run on Windows.
 *
 * The POST-rename chmod (on the final `path`) stays best-effort on every
 * platform: a tmp inode that passed the pre-rename chmod (or was freshly
 * created under a strict-enough umask) keeps its mode across a
 * same-filesystem rename — POSIX `rename()` never touches file permissions,
 * it only repoints a directory entry — so this second call is redundant
 * insurance against `rename()` implementations that do not hold that
 * guarantee, never the step actually enforcing the mode.
 *
 * Fail-safe on error: if any step throws (disk full, permission denied, a
 * cross-device rename, or the POSIX pre-rename chmod above), the tmp file
 * is removed before re-throwing so a failed write never leaves a stale
 * `.tmp` file or a partially-written settings.json behind.
 *
 * fs operations (and `platform`) are injectable (mirroring
 * core/auth/key-store.js) purely so unit tests can assert write order,
 * permission attempts, and platform-conditioned behavior deterministically
 * without touching a real filesystem or the host OS; production code never
 * overrides them.
 *
 * @param {object} data
 * @param {string} [path]
 * @param {{ writeFileSyncFn?: Function, renameSyncFn?: Function, chmodSyncFn?: Function, existsSyncFn?: Function, unlinkSyncFn?: Function, platform?: string }} [fsOps]
 */
export function writeSettingsFileAtomic(data, path = DEFAULT_SETTINGS_PATH, {
  writeFileSyncFn = writeFileSync,
  renameSyncFn = renameSync,
  chmodSyncFn = chmodSync,
  existsSyncFn = existsSync,
  unlinkSyncFn = unlinkSync,
  platform = process.platform,
} = {}) {
  const tmp = `${path}.tmp`;
  const isWindows = platform === 'win32';
  try {
    writeFileSyncFn(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: SETTINGS_FILE_MODE });
    try {
      chmodSyncFn(tmp, SETTINGS_FILE_MODE);
    } catch (err) {
      // POSIX: fail closed — do not rename an inode this process could not
      // verify/force to 0o600. Windows: best-effort — chmod never provided
      // a real guarantee there, so its failure isn't fatal. See doc comment.
      if (!isWindows) throw err;
    }
    renameSyncFn(tmp, path);
    try {
      chmodSyncFn(path, SETTINGS_FILE_MODE);
    } catch {
      // Always best-effort post-rename — see doc comment: rename() does not
      // change permissions, so this is insurance, not the enforcement step.
    }
  } catch (err) {
    try {
      if (existsSyncFn(tmp)) unlinkSyncFn(tmp);
    } catch {
      // Best-effort cleanup only — the original error is what matters.
    }
    throw err;
  }
}

export function statMtime(path = DEFAULT_SETTINGS_PATH) {
  if (!existsSync(path)) return null;
  return statSync(path).mtimeMs;
}
