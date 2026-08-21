// Resolves a raw, already-syntactically-valid INDEX_ALLOWED_ROOTS array
// (src/core/settings/definitions.js's own validate()/parseExternal() only
// check shape — non-empty absolute strings, no NUL, no syntactic duplicate —
// since that module is documented pure/no-I/O) against the REAL filesystem:
// each entry is realpath-resolved (so a configured root that is itself a
// symlink/junction is pinned to what it actually points at, not its own
// spelling) and must exist and be a real directory; entries that resolve to
// the same real directory as an earlier one are treated as duplicates and
// dropped.
//
// Used from two call sites with two different failure policies, which is
// why this module returns a `{ roots, dropped }` report instead of
// throwing:
//   - src/core/settings/service.js's setMany() — STRICT: any non-empty
//     `dropped` list fails the whole PATCH with invalid_value, so an
//     operator gets immediate feedback instead of silently persisting a
//     smaller effective root set than they typed.
//   - src/shared/admin/jobs/allowed-roots-guard.js — LENIENT: dropped
//     entries are logged (server-side only — never echoed to an HTTP
//     caller) and the remaining valid roots are still used; a single
//     transient/misconfigured root must not take indexing down entirely
//     while other configured roots are still good. This is the resolution
//     that decides real HTTP requests, so it must never throw.
//
// Sources consulted for the realpath-then-compare approach (recorded here,
// not copied verbatim): Node.js fs.realpathSync docs
// (https://nodejs.org/api/fs.html#fsrealpathsyncpath-options) — resolves
// '.'/'..'/symbolic links to the actual on-disk path, which is exactly the
// TOCTOU-resistant-AT-CHECK-TIME primitive this needs (see
// allowed-roots-guard.js's own header comment for the residual race this
// does NOT close); OWASP Path Traversal guidance
// (https://owasp.org/www-community/attacks/Path_Traversal) on canonicalizing
// before comparing, never comparing raw/unresolved strings.
import { realpathSync, statSync } from 'node:fs';
import nodePath from 'node:path';
import { isPathContained, isCaseInsensitivePlatform } from './path-containment.js';

/**
 * @param {string} rawRoot
 * @param {{ fs?: { realpathSync: Function, statSync: Function } }} [opts]
 * @returns {{ ok: true, canonicalPath: string } | { ok: false, reason: string }}
 */
export function canonicalizeRoot(rawRoot, { fs = { realpathSync, statSync } } = {}) {
  let canonicalPath;
  try {
    canonicalPath = fs.realpathSync(rawRoot);
  } catch (err) {
    return { ok: false, reason: `does not exist or is not accessible (${err.code ?? err.message})` };
  }
  let stat;
  try {
    stat = fs.statSync(canonicalPath);
  } catch (err) {
    return { ok: false, reason: `does not exist or is not accessible (${err.code ?? err.message})` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: 'is not a directory' };
  }
  return { ok: true, canonicalPath };
}

/**
 * @param {string[]} rawRoots
 * @param {{ fs?: object, platform?: string }} [opts]
 * @returns {{ roots: string[], dropped: { raw: string, reason: string }[] }}
 */
export function resolveAllowedRoots(rawRoots, { fs = { realpathSync, statSync }, platform = process.platform } = {}) {
  const caseInsensitive = isCaseInsensitivePlatform(platform);
  const roots = [];
  const dropped = [];
  // Persisted settings can be edited or corrupted outside SettingsService.
  // Treat any non-array value as wholly invalid; iterating a string here
  // could otherwise reinterpret each character as a filesystem root.
  if (!Array.isArray(rawRoots)) {
    return {
      roots,
      dropped: [{ raw: '<invalid>', reason: 'must be an array of absolute directory paths' }],
    };
  }
  for (const raw of rawRoots) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      dropped.push({ raw: '<invalid>', reason: 'must be a non-empty path string' });
      continue;
    }
    if (!nodePath.isAbsolute(raw) || raw.includes(String.fromCharCode(0))) {
      dropped.push({ raw: '<invalid>', reason: 'must be an absolute NUL-free path' });
      continue;
    }
    const result = canonicalizeRoot(raw, { fs });
    if (!result.ok) {
      dropped.push({ raw, reason: result.reason });
      continue;
    }
    const isDuplicate = roots.some((existing) => isPathContained(existing, result.canonicalPath, { caseInsensitive })
      && isPathContained(result.canonicalPath, existing, { caseInsensitive }));
    if (isDuplicate) {
      dropped.push({ raw, reason: 'resolves to the same real directory as another configured root' });
      continue;
    }
    roots.push(result.canonicalPath);
  }
  return { roots, dropped };
}
