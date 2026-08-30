// ── route parsing (pure) ─────────────────────────────────────────────────
// Split out of router.js so sidebar.js/jobs-view.js can read the current
// route without importing router.js itself (router.js imports from both of
// them), avoiding a circular import.

// Parses the "?q=...&top=...&window=...&format=...&file=..." query string a
// collection route may carry (the search-permalink state, Phase 3B) — kept
// separate from currentRoute() itself so path-matching never has to worry
// about a query string leaking into a capture group (e.g. f/(.+) would
// otherwise swallow a trailing "?q=..." into the sourceFile match).
function parseSearchQuery(queryString) {
  if (!queryString) return undefined;
  const params = new URLSearchParams(queryString);
  const search = {};
  if (params.has('q')) search.q = params.get('q');
  if (params.has('top')) search.top = Number(params.get('top'));
  if (params.has('window')) search.window = Number(params.get('window'));
  if (params.has('format')) search.format = params.get('format');
  if (params.has('file')) search.sourceFile = params.get('file');
  return Object.keys(search).length ? search : undefined;
}

export function currentRoute(hash = location.hash || '#/') {
  const queryIndex = hash.indexOf('?');
  const path = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
  const search = queryIndex === -1 ? undefined : parseSearchQuery(hash.slice(queryIndex + 1));

  let m = path.match(/^#\/c\/([^/]+)\/settings$/);
  if (m) return { view: 'settings', name: decodeURIComponent(m[1]) };
  m = path.match(/^#\/c\/([^/]+)\/f\/(.+)$/);
  if (m) return { view: 'collection', name: decodeURIComponent(m[1]), openFile: decodeURIComponent(m[2]), ...(search && { search }) };
  m = path.match(/^#\/c\/([^/]+)\/n\/(.+)$/);
  if (m) return { view: 'collection', name: decodeURIComponent(m[1]), openNodePath: decodeURIComponent(m[2]), ...(search && { search }) };
  // Bare collection route only (S1-style Collection Home, design plan
  // §5.3, §13) — a distinct `view` value from the f/n sub-routes above, so
  // router.js can route it to the lifecycle-owned features/collection-home
  // controller while #/c/:name/f/... and #/c/:name/n/... keep resolving to
  // 'collection' (collection-view.js/file-view.js, unchanged).
  m = path.match(/^#\/c\/(.+)$/);
  if (m) return { view: 'collection-home', name: decodeURIComponent(m[1]), ...(search && { search }) };
  if (path === '#/index') return { view: 'index' };
  // Phase 4A.5b: the global runtime-settings screen — distinct `view` value
  // ('global-settings') from collection settings ('settings' above), so
  // router.js/sidebar.js's active-state logic never conflates the two.
  // Phase 4A.5c: category-scoped sub-routes. category is left as the raw
  // string here — it is resolved against the real category list from
  // GET /api/settings inside global-settings-view.js, never hardcoded in
  // this routing layer (constraint: routes.js stays free of registry
  // knowledge). category: null on the bare route signals "use whatever
  // category the API returns first."
  m = path.match(/^#\/settings\/([a-z0-9-]+)$/);
  if (m) return { view: 'global-settings', category: m[1] };
  if (path === '#/settings') return { view: 'global-settings', category: null };
  return { view: 'overview' };
}
