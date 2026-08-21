// Fail-closed containment guard for POST /api/jobs/index — the HTTP-only
// boundary between an operator-configured allowed-roots setting and
// registry.startIndexJob()/spawnIndexer(). See
// docs/security/semidex-lite-public-api-audit-2026-08.md, Finding P1-3.
//
// Deliberately NOT wired into src/shared/admin/jobs/registry.js or either
// spawn-indexer-{full,lite}.js: those are shared with the direct CLI
// indexing entry points (`semidex-lite index <path>` / Full's equivalent),
// which run as a trusted local operator with no HTTP boundary at all and
// must keep working exactly as before. This guard is invoked ONLY from
// src/shared/admin/api/jobs.js's registerJobsRoutes(), before
// registry.startIndexJob() is ever called.
//
// Instance-scoped: createAllowedRootsGuard() returns a fresh closure over
// whatever settingsService it is given — no module-level mutable state, so
// a Full and a Lite composition root constructed in the same process each
// get their own independent guard, and neither can observe or affect the
// other's configured roots.
//
// RESIDUAL LIMITATION (TOCTOU) — read before assuming this is a perfect
// sandbox. checkTarget() below resolves the target to a real, canonical
// filesystem path via fs.realpathSync() (which follows symlinks/Windows
// junctions to their real target — see
// https://nodejs.org/api/fs.html#fsrealpathsyncpath-options) and checks
// THAT resolved path against the canonical allowed roots. This closes
// ordinary traversal and symlink/junction escape AT CHECK TIME. It does
// not, and structurally cannot, guarantee the indexer subprocess spawned
// immediately afterward still sees the same filesystem object when it
// later opens each file under that path — an attacker with write access to
// the target directory between this check and the moment the indexer
// actually reads a given file could swap a real subdirectory for a symlink
// pointing outside the allowed root (classic check-then-use race). Node's
// fs module has no cross-process "open by already-resolved-handle and
// recursively walk a directory tree" primitive that would close this the
// way O_NOFOLLOW closes it for a single open() call, and the indexer runs
// as a separate child process, not in-process. This guard is a strong,
// correct check against misconfiguration and ordinary/symlink/junction
// traversal — not a hardened filesystem sandbox against a co-resident
// attacker who can race the indexer's own file reads. Documented rather
// than silently assumed away; see the audit doc's "Indexing allowed roots"
// section for the same statement in the security design record.
import { realpathSync, statSync } from 'node:fs';
import nodePath from 'node:path';
import { resolveAllowedRoots } from '../../../core/security/allowed-roots.js';
import { isPathContained, isCaseInsensitivePlatform } from '../../../core/security/path-containment.js';

// Built via fromCharCode rather than a literal escape sequence in source,
// which some text pipelines can mis-transcribe into an actual NUL byte.
const NUL_CHAR = String.fromCharCode(0);

/**
 * @param {{
 *   settingsService: ReturnType<typeof import('../../../core/settings/service.js').createSettingsService>,
 *   fs?: { realpathSync: Function, statSync: Function },
 *   path?: import('node:path').PlatformPath,
 *   platform?: string,
 *   log?: (message: string) => void,
 * }} opts
 */
export function createAllowedRootsGuard({
  settingsService, fs = { realpathSync, statSync }, path = nodePath, platform = process.platform,
  log = (msg) => console.warn(msg),
} = {}) {
  if (!settingsService) {
    throw new TypeError('createAllowedRootsGuard: settingsService is required.');
  }
  const caseInsensitive = isCaseInsensitivePlatform(platform);

  // Re-resolved on every call (not cached across requests) — a PATCH to
  // INDEX_ALLOWED_ROOTS must take effect for the very next indexing
  // request, with no restart and no guard-recreation required (matches the
  // setting's own appliesAt: 'immediate' contract).
  function getCanonicalRoots() {
    const raw = settingsService.getActiveValue('INDEX_ALLOWED_ROOTS') ?? [];
    const { roots, dropped } = resolveAllowedRoots(raw, { fs, platform });
    for (const { raw: rawRoot, reason } of dropped) {
      log(`[allowed-roots] configured root "${rawRoot}" was ignored: ${reason}`);
    }
    return roots;
  }

  // ONE generic denial shape for every post-configuration rejection —
  // nonexistent target, broken symlink, inaccessible, wrong object type,
  // and "exists but outside every configured root" are all
  // indistinguishable from outside. No existence oracle that would let a
  // remote caller enumerate the local filesystem by observing which error
  // a given path produces.
  function denied() {
    return {
      ok: false, status: 403, code: 'path_not_allowed',
      message: 'This path cannot be indexed: it does not exist, is not a file or directory, or is outside the configured allowed indexing roots.',
    };
  }

  /**
   * @param {string} rawTarget
   * @returns {{ ok: true, canonicalPath: string } | { ok: false, status: number, code: string, message: string }}
   */
  function checkTarget(rawTarget) {
    if (typeof rawTarget !== 'string' || rawTarget.trim() === '') {
      return { ok: false, status: 400, code: 'bad_request', message: 'Body field "path" must be a non-empty string.' };
    }
    if (rawTarget.includes(NUL_CHAR)) {
      return { ok: false, status: 400, code: 'bad_request', message: 'Body field "path" must not contain NUL characters.' };
    }

    const roots = getCanonicalRoots();
    if (roots.length === 0) {
      return {
        ok: false, status: 403, code: 'allowed_roots_not_configured',
        message: 'Indexing via this API is disabled: no allowed indexing roots are configured. An operator must configure at least one allowed root in Settings before indexing can be started from this API.',
      };
    }

    // Relative targets resolve against this process's own cwd — the same
    // resolution the spawned indexer child applies on its own (it inherits
    // this process's cwd by default), so a request accepted here resolves
    // to the same file the indexer would actually read.
    const absoluteTarget = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(process.cwd(), rawTarget);

    let canonicalPath;
    try {
      canonicalPath = fs.realpathSync(absoluteTarget);
    } catch {
      return denied();
    }
    let stat;
    try {
      stat = fs.statSync(canonicalPath);
    } catch {
      return denied();
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      return denied(); // FIFO, socket, block/character device, etc. — not a supported indexing target
    }

    const contained = roots.some((root) => isPathContained(root, canonicalPath, { path, caseInsensitive }));
    if (!contained) {
      return denied();
    }

    return { ok: true, canonicalPath };
  }

  return { checkTarget, getCanonicalRoots };
}
