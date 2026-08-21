// Pure, no-I/O path containment check. Used by
// shared/admin/jobs/allowed-roots-guard.js to decide whether an already-
// CANONICALIZED target path (realpath-resolved by the caller — this module
// never touches the filesystem itself) lives inside an already-canonicalized
// root directory. Kept separate from the filesystem-touching guard so this
// specific logic — the part that has to get Windows drive letters, UNC
// roots, sibling-prefix directories, and ".." exactly right — can be tested
// deterministically on any CI platform via an injectable `path` module
// (pass node:path's own `path.win32`/`path.posix` explicitly to exercise
// one platform's semantics regardless of which OS the test runner is on;
// see Node's own path-module docs on the platform-specific submodules:
// https://nodejs.org/api/path.html#windows-vs-posix).
//
// Deliberately NOT a string-prefix check (`target.startsWith(root)`) —
// that classic mistake accepts "/allowed-root-evil" as contained in
// "/allowed-root" (a sibling-prefix escape). path.relative() plus the
// ".." / isAbsolute checks below is the documented-correct approach: see
// OWASP's Path Traversal guidance
// (https://owasp.org/www-community/attacks/Path_Traversal) on validating
// the resolved path stays under the intended base directory, and Node's
// own path.relative() docs
// (https://nodejs.org/api/path.html#pathrelativefrom-to) for the exact
// return-value shape this function depends on:
//   - '' when `from` and `to` resolve to the same path (exact-root match),
//   - a string starting with '..' when `to` is an ancestor of/outside `from`,
//   - on win32, the unmodified (still-absolute) `to` when the two paths
//     have no common root at all (different drive letter or different UNC
//     host/share) — which is why the isAbsolute(relative) check below is
//     required, not redundant with the '..' check.
import nodePath from 'node:path';

/**
 * @param {string} root - canonical absolute root directory path.
 * @param {string} target - canonical absolute target path (file or directory).
 * @param {{ path?: import('node:path').PlatformPath, caseInsensitive?: boolean }} [opts]
 *   `path` defaults to the real, host-platform node:path. `caseInsensitive`
 *   folds both inputs to lowercase before comparing — callers pass `true`
 *   for Windows/macOS-shaped roots (see isCaseInsensitivePlatform below),
 *   `false` for POSIX/Linux, where a case difference is a genuinely
 *   different path.
 * @returns {boolean} true iff `target` is `root` itself or strictly inside it.
 */
export function isPathContained(root, target, { path = nodePath, caseInsensitive = false } = {}) {
  const fold = (p) => (caseInsensitive ? p.toLowerCase() : p);
  const relative = path.relative(fold(root), fold(target));
  if (relative === '') return true; // exact-root match
  if (relative === '..' || relative.startsWith('..' + path.sep)) return false; // outside root (incl. sibling-prefix dirs)
  if (path.isAbsolute(relative)) return false; // no common ancestor at all (different drive/UNC root)
  return true;
}

// Windows path comparison is case-insensitive for the normal Semidex
// deployment. Do not infer the same from `darwin`: APFS can be formatted
// case-sensitive, and lowercasing there could turn two distinct paths into
// an apparent containment match. A future volume-aware implementation may
// override `caseInsensitive` explicitly after proving the filesystem mode.
export const CASE_INSENSITIVE_PLATFORMS = Object.freeze(new Set(['win32']));

export function isCaseInsensitivePlatform(platform) {
  return CASE_INSENSITIVE_PLATFORMS.has(platform);
}
