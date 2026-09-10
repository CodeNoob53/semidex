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
// EMPTY-ROOTS POLICY (personal-use UX fix, 2026-09) — see
// docs/security/semidex-lite-public-api-audit-2026-08.md's "Indexing
// allowed roots" section for the updated design record. Failing closed on
// an empty INDEX_ALLOWED_ROOTS unconditionally was too much friction for
// the common case: a single operator running Semidex entirely on their own
// machine, Admin bound to loopback only, with no roots ever configured.
// checkTarget() now branches on the injected `deploymentPolicy.allowRemote`
// flag (see resolveDeploymentPolicy() in shared/admin/server.js — the ONE
// place ADMIN_ALLOW_REMOTE is resolved, reused here rather than read again
// from env/settings inside this module) when roots are empty:
//   - allowRemote === true (or the caller passed no deploymentPolicy at
//     all — see the default below): unchanged fail-closed behavior. A
//     remote/LAN/reverse-proxied deployment must never silently infer
//     "no roots configured" as "any path allowed".
//   - allowRemote === false: this Admin server is bound to loopback only,
//     so the one operator who can reach it at all is already the trusted
//     local user. An existing local file/directory is realpath-validated
//     exactly as a configured-roots target is (denied() stays the one
//     generic, existence-oracle-free rejection shape) but is not required
//     to fall under any configured root. This is a convenience for the
//     single-user local case, not a broadened authorization rule — it
//     never consults Host/Origin headers, and remote mode is untouched.
// This local-only convenience applies ONLY to a genuinely, intentionally
// empty INDEX_ALLOWED_ROOTS (nothing was ever configured). A NON-empty
// configured value whose every entry gets dropped during canonicalization
// (deleted/inaccessible/corrupt/malformed by something outside
// SettingsService) still resolves to zero usable roots, but is NEVER
// treated as the intentional empty-list case — it fails closed in every
// deployment mode, local-only included. See getCanonicalRoots()'s
// `rawIsEmpty` and checkTarget()'s fail-closed branch below for the
// distinction; conflating the two would let a misconfiguration (or an
// externally-corrupted settings.json) silently degrade "restricted to
// these roots" into "any local path allowed".
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
 *   deploymentPolicy?: { allowRemote: boolean },
 * }} opts
 *   deploymentPolicy (optional DI — construct via resolveDeploymentPolicy()
 *   in shared/admin/server.js, the one place ADMIN_ALLOW_REMOTE is
 *   resolved) governs ONLY the empty-INDEX_ALLOWED_ROOTS branch of
 *   checkTarget() below; see the module header comment. Defaults to
 *   `{ allowRemote: true }` — the fail-closed assumption — so any existing
 *   or test-constructed guard that does not explicitly pass a deployment
 *   policy keeps today's exact behavior (empty roots always denied) rather
 *   than silently becoming permissive.
 */
export function createAllowedRootsGuard({
  settingsService, fs = { realpathSync, statSync }, path = nodePath, platform = process.platform,
  log = (msg) => console.warn(msg), deploymentPolicy = { allowRemote: true },
} = {}) {
  if (!settingsService) {
    throw new TypeError('createAllowedRootsGuard: settingsService is required.');
  }
  const caseInsensitive = isCaseInsensitivePlatform(platform);

  // Re-resolved on every call (not cached across requests) — a PATCH to
  // INDEX_ALLOWED_ROOTS must take effect for the very next indexing
  // request, with no restart and no guard-recreation required (matches the
  // setting's own appliesAt: 'immediate' contract).
  //
  // rawIsEmpty distinguishes "operator never configured anything" (a
  // genuinely empty array — the ONLY shape checkTarget() may treat as the
  // intentional local-only convenience) from "something was configured but
  // every entry was dropped" (a non-empty array, or a malformed non-array
  // value from an externally-edited settings.json) — the latter must always
  // fail closed, in every deployment mode, per the module header comment.
  function getCanonicalRoots() {
    const raw = settingsService.getActiveValue('INDEX_ALLOWED_ROOTS') ?? [];
    const { roots, dropped } = resolveAllowedRoots(raw, { fs, platform });
    for (const { raw: rawRoot, reason } of dropped) {
      log(`[allowed-roots] configured root "${rawRoot}" was ignored: ${reason}`);
    }
    const rawIsEmpty = Array.isArray(raw) && raw.length === 0;
    return { roots, rawIsEmpty };
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
   * @returns {{ ok: true, canonicalPath: string, mode: 'allowed_root' | 'local_unrestricted' } | { ok: false, status: number, code: string, message: string }}
   */
  function checkTarget(rawTarget) {
    if (typeof rawTarget !== 'string' || rawTarget.trim() === '') {
      return { ok: false, status: 400, code: 'bad_request', message: 'Body field "path" must be a non-empty string.' };
    }
    if (rawTarget.includes(NUL_CHAR)) {
      return { ok: false, status: 400, code: 'bad_request', message: 'Body field "path" must not contain NUL characters.' };
    }

    const { roots, rawIsEmpty } = getCanonicalRoots();

    // Fail closed BEFORE any filesystem work on the caller-supplied path
    // (a denial that never depended on the target's real filesystem state
    // should never pay for, or leak timing about, resolving one) whenever
    // roots resolved to nothing AND either:
    //   - something WAS configured but none of it survived canonicalization
    //     (deleted/inaccessible/corrupt/malformed — !rawIsEmpty). This must
    //     NEVER be mistaken for the intentional empty-list local
    //     convenience, in ANY deployment mode — a misconfiguration that
    //     silently degrades to "any path allowed" would be far worse than
    //     one that degrades to "indexing disabled".
    //   - roots are genuinely, intentionally empty AND this deployment
    //     allows remote/non-loopback access — remote/LAN/reverse-proxied
    //     deployments must never infer "no roots configured" as "any path
    //     allowed".
    if (roots.length === 0 && (!rawIsEmpty || deploymentPolicy.allowRemote)) {
      return {
        ok: false, status: 403, code: 'allowed_roots_not_configured',
        message: rawIsEmpty
          ? 'Indexing via this API is disabled: no allowed indexing roots are configured, and this deployment allows remote/non-loopback access. An operator must configure at least one allowed root in Settings before indexing can be started from this API.'
          : 'Indexing via this API is disabled: the configured allowed indexing roots could not be resolved (every configured entry was dropped — deleted, inaccessible, or invalid). An operator must fix the configured roots in Settings before indexing can be started from this API.',
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

    if (roots.length === 0) {
      // The fail-closed branch above already returned for every other
      // combination — reaching here means rawIsEmpty is true (nothing was
      // ever configured, not "configured but all dropped") AND
      // deploymentPolicy.allowRemote is false: strictly loopback-only
      // Admin, no roots configured: personal-use convenience, not a
      // containment check. The realpath/stat validation above still
      // applies in full; only the "must fall under a configured root"
      // requirement is skipped.
      return { ok: true, canonicalPath, mode: 'local_unrestricted' };
    }

    const contained = roots.some((root) => isPathContained(root, canonicalPath, { path, caseInsensitive }));
    if (!contained) {
      return denied();
    }

    return { ok: true, canonicalPath, mode: 'allowed_root' };
  }

  return { checkTarget, getCanonicalRoots };
}
