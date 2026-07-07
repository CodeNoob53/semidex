// ── route parsing (pure) ─────────────────────────────────────────────────
// Split out of router.js so sidebar.js/jobs-view.js can read the current
// route without importing router.js itself (router.js imports from both of
// them), avoiding a circular import.
export function currentRoute(hash = location.hash || '#/') {
  let m = hash.match(/^#\/c\/([^/]+)\/settings$/);
  if (m) return { view: 'settings', name: decodeURIComponent(m[1]) };
  m = hash.match(/^#\/c\/([^/]+)\/f\/(.+)$/);
  if (m) return { view: 'collection', name: decodeURIComponent(m[1]), openFile: decodeURIComponent(m[2]) };
  m = hash.match(/^#\/c\/([^/]+)\/n\/(.+)$/);
  if (m) return { view: 'collection', name: decodeURIComponent(m[1]), openNodePath: decodeURIComponent(m[2]) };
  m = hash.match(/^#\/c\/(.+)$/);
  if (m) return { view: 'collection', name: decodeURIComponent(m[1]) };
  if (hash === '#/index') return { view: 'index' };
  return { view: 'overview' };
}
