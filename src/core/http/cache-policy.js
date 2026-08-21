// The ONE Cache-Control policy for every response this process sends — API
// JSON and the static Admin UI shell alike. Split out of request-security.js
// (which owns Origin/Host/CSP/etc.) because this is a genuinely different
// axis: those headers are the same for every response, this one branches on
// API vs static vs fingerprinted-asset, and keeping that branching in ONE
// place is the whole point (see docs/security/
// semidex-lite-public-api-audit-2026-08.md — "Cache-Control: no-store" was
// tracked there as open until this module closed it).
//
// Zero dependencies, same constraints as request-security.js: no pathname
// string-matching is meant to live in route handlers or the static file
// reader — it lives here, once, and both call sites (core/http router,
// shared/admin/static.js) just report which bucket a response falls into.

/**
 * Every /api/** response — success, error, 404, and any pre-dispatch
 * rejection alike. Unconditional `no-store`: these responses can carry
 * per-request state (job status, search results, security-rejection
 * detail) and nothing here is safe for a shared or browser cache to reuse
 * across requests, so there is no weaker directive (`no-cache`,
 * `private`) worth adding — `no-store` alone is both correct and simplest.
 */
const API_CACHE_CONTROL = 'no-store';

/**
 * The static Admin UI's default: the HTML navigation shell, any
 * non-fingerprinted static file, and every static error response
 * (404/405/503). `no-store` rather than `no-cache`/`must-revalidate`
 * because this server emits no ETag/Last-Modified — see static.js's
 * response — so there is nothing for a cache to revalidate AGAINST. A
 * `no-cache` directive with no validator either forces the browser to
 * treat the response as effectively uncacheable anyway, or (worse, on a
 * validator-less implementation) invites it to reuse the response on a
 * heuristic. `no-store` says exactly what is true: never keep a copy. This
 * also keeps the security/config-sensitive UI shell from being served
 * stale out of a back-forward cache or disk cache after ADMIN_ALLOWED_HOSTS
 * or the bundle itself changes.
 */
const STATIC_CONSERVATIVE_CACHE_CONTROL = 'no-store';

/**
 * Fingerprinted build assets ONLY (see isFingerprintedAssetPath below). The
 * filename itself changes whenever the content does, so "cache this exact
 * URL forever" is safe by construction — this is the one case where a
 * static response is allowed to outlive the process.
 */
const STATIC_IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Matches ONLY the asset-naming convention this build actually emits:
 * `/assets/<name>-<hash>.js` or `.css`, Vite's default
 * `assetFileNames`/`chunkFileNames`/`entryFileNames` output (neither
 * vite.config.js nor vite.config.lite.js overrides those options or
 * `hashCharacters`, and both build into an `assets/` subdirectory — see
 * `build.outDir`/default `assetsDir`). The 8+ char class covers Vite's
 * default 8-character hash without hard-coding an exact length that would
 * break the moment the default changes upstream.
 *
 * Deliberately restricted to `.js`/`.css`: those are the only fingerprinted
 * bundle types either build currently produces. `.svg`/`.ico` are also
 * servable (see static.js's CONTENT_TYPES) but, if ever shipped, would be
 * copied from a `public/` source directory verbatim — unhashed — so this
 * pattern intentionally does NOT extend immutable caching to them; a static
 * file that merely LOOKS like it could be hashed is not "demonstrably"
 * content-addressed.
 *
 * This regex is the FIRST of two gates, not the only one — the caller
 * (static.js) only ever applies the immutable directive after it has
 * already read a real file from disk at that exact path. A pathname that
 * matches this shape but names no real file still 404s with the
 * conservative (no-store) policy above; it never reaches this branch.
 */
const FINGERPRINTED_ASSET_PATTERN = /^\/assets\/[\w.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/;

/**
 * @param {string} pathname URL pathname, as matched against the static file
 *   tree (e.g. "/assets/index-D2suSSsW.js").
 * @returns {boolean}
 */
export function isFingerprintedAssetPath(pathname) {
  return typeof pathname === 'string' && FINGERPRINTED_ASSET_PATTERN.test(pathname);
}

/**
 * Applies the API Cache-Control policy. Call this as early as possible in
 * the API request path — before route matching, before the pre-dispatch
 * security verdict — so a rejected or errored request carries the same
 * `no-store` guarantee as a successful one; nothing here depends on which
 * branch produced the response.
 */
export function applyApiCacheHeaders(res) {
  if (typeof res?.setHeader !== 'function' || res.headersSent) return;
  res.setHeader('Cache-Control', API_CACHE_CONTROL);
}

/**
 * Applies the static Admin UI Cache-Control policy. Defaults to the
 * conservative (`no-store`) directive — the caller opts into the immutable
 * directive explicitly, and only once it has confirmed (by successfully
 * reading the file) that the request names a real, fingerprinted asset.
 * `res.setHeader` (not `writeHead`) so a caller may call this once up front
 * with the conservative default and, later in the same request, call it
 * again with `{ immutable: true }` once it knows better — the later call
 * wins as long as headers have not been flushed yet.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ immutable?: boolean }} [opts]
 */
export function applyStaticCacheHeaders(res, { immutable = false } = {}) {
  if (typeof res?.setHeader !== 'function' || res.headersSent) return;
  res.setHeader('Cache-Control', immutable ? STATIC_IMMUTABLE_CACHE_CONTROL : STATIC_CONSERVATIVE_CACHE_CONTROL);
}
