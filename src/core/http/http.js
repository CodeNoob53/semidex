// Small JSON-response helpers shared by every HTTP route (admin API and the
// versioned application-facing Ask API alike). No framework, no
// dependencies — node:http primitives only. Provider/transport-neutral:
// nothing here knows about Qdrant, Ollama, Gemini, or the Admin UI.
import { checkJsonContentType } from './request-security.js';

/**
 * Write a JSON body with the given status code. Always sets
 * Content-Type: application/json; charset=utf-8. No CORS headers (§10 of
 * the design doc: same-origin only, UI is served by this same process).
 */
export function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Standard error envelope: { error: { message, code } }.
 * `code` is a short machine-readable string (e.g. "not_found"), not an HTTP
 * status — the status is set separately via `statusCode`.
 */
export function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { message, code } });
}

export class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function badRequest(message) {
  return new HttpError(400, 'bad_request', message);
}

export function notFound(message) {
  return new HttpError(404, 'not_found', message);
}

export function conflict(message) {
  return new HttpError(409, 'conflict', message);
}

export function dependencyUnavailable(message) {
  return new HttpError(503, 'dependency_unavailable', message);
}

export function tooManyRequests(message) {
  return new HttpError(429, 'busy', message);
}

export function unsupportedMediaType(message) {
  return new HttpError(415, 'unsupported_media_type', message);
}

/**
 * Read and JSON-parse a request body, capped to avoid unbounded memory use
 * from a misbehaving client. Returns {} for an empty body (several POST
 * endpoints here are genuinely body-less; this keeps handlers uniform).
 *
 * SECURITY (audit finding P1-1): this function used to parse the body as JSON
 * regardless of the declared Content-Type. That made every JSON route
 * reachable by a CORS-"simple" cross-origin request (`Content-Type:
 * text/plain` with a valid-JSON body sends no preflight), which was confirmed
 * live against POST /api/jobs/index — 202, and a real indexer spawned against
 * an arbitrary local path. Content-Type is now enforced BEFORE any bytes are
 * read, so a non-JSON declaration is a 415 and the request never becomes a
 * simple request that carries a working JSON payload.
 *
 * This is defense in depth, not the primary control: the router already
 * rejects cross-site requests before dispatch (core/http/request-security.js).
 * Both layers are kept because they fail differently — the Origin check
 * depends on browser-supplied headers, this one does not.
 *
 * Pass `{ enforceContentType: false }` ONLY for a caller that has its own
 * equivalent gate; no production call site does today.
 */
export function readJsonBody(req, { maxBytes = 1_000_000, enforceContentType = true } = {}) {
  if (enforceContentType) {
    const verdict = checkJsonContentType(req);
    if (!verdict.ok) return Promise.reject(unsupportedMediaType(verdict.message));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(badRequest('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(badRequest('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}
