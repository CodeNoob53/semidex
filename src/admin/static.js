// Static file serving for the built Admin UI shell. Deliberately separate from
// the API router: the router owns /api/*, this module owns everything else.
// UI source lives in src/admin/ui-src and is built by Vite into dist/admin-ui
// (repo-root-level, outside src/ entirely — see vite.config.js's build.outDir).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendError } from './http.js';

// Exported so tests can assert the server points at dist/admin-ui (not the
// old src/admin/ui build target) and so callers can override it (dependency
// injection) to simulate a missing build without touching the real filesystem.
export const UI_DIR = fileURLToPath(new URL('../../dist/admin-ui/', import.meta.url));

// Only the types the shell actually ships. Anything else 404s — the UI dir
// is not a general-purpose file server.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

/**
 * Resolve a URL pathname to an absolute file path inside uiDir, or null if
 * the path escapes the UI directory (traversal) or targets an unknown type.
 * Exported for direct unit testing of the traversal guard. `uiDir` defaults
 * to the real build output dir; tests may override it.
 */
export function resolveStaticPath(pathname, uiDir = UI_DIR) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = normalize(join(uiDir, relative));
  // Traversal guard: the normalized result must stay inside uiDir.
  if (!full.startsWith(uiDir.endsWith(sep) ? uiDir : uiDir + sep)) return null;
  if (!(extname(full) in CONTENT_TYPES)) return null;
  return full;
}

/**
 * Handle a non-/api request. GET/HEAD only; everything else is 405.
 * If dist/admin-ui hasn't been built yet (no index.html present), responds
 * with a 503 pointing at `npm run admin:build` instead of a confusing 404 —
 * the problem is "nothing has been built yet", not "this one file is missing".
 * Unknown paths, traversal attempts, and unknown extensions all 404 with the
 * standard JSON error envelope (consistent with the API).
 */
export async function handleStatic(req, res, pathname, uiDir = UI_DIR) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'method_not_allowed', `${req.method} is not allowed for static content`);
  }

  if (!existsSync(join(uiDir, 'index.html'))) {
    return sendError(res, 503, 'ui_not_built', 'Admin UI build not found. Run `npm run admin:build`.');
  }

  const filePath = resolveStaticPath(pathname, uiDir);
  if (!filePath) {
    return sendError(res, 404, 'not_found', `No static file for ${pathname}`);
  }

  let content;
  try {
    content = await readFile(filePath);
  } catch {
    return sendError(res, 404, 'not_found', `No static file for ${pathname}`);
  }

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(filePath)],
    'Content-Length': content.length,
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}
