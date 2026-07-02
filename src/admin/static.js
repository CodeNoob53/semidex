// Static file serving for the Admin UI shell. Deliberately separate from the
// API router: the router owns /api/*, this module owns everything else.
// node:fs/node:path only — no framework, no build step (design doc §3).
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendError } from './http.js';

const UI_DIR = fileURLToPath(new URL('./ui/', import.meta.url));

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
 * Resolve a URL pathname to an absolute file path inside UI_DIR, or null if
 * the path escapes the UI directory (traversal) or targets an unknown type.
 * Exported for direct unit testing of the traversal guard.
 */
export function resolveStaticPath(pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = normalize(join(UI_DIR, relative));
  // Traversal guard: the normalized result must stay inside UI_DIR.
  if (!full.startsWith(UI_DIR.endsWith(sep) ? UI_DIR : UI_DIR + sep)) return null;
  if (!(extname(full) in CONTENT_TYPES)) return null;
  return full;
}

/**
 * Handle a non-/api request. GET/HEAD only; everything else is 405.
 * Unknown paths, traversal attempts, and unknown extensions all 404 with the
 * standard JSON error envelope (consistent with the API).
 */
export async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'method_not_allowed', `${req.method} is not allowed for static content`);
  }

  const filePath = resolveStaticPath(pathname);
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
