// Small JSON-response helpers shared by the router and handlers. No
// framework, no dependencies — node:http primitives only.

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

/**
 * Read and JSON-parse a request body, capped to avoid unbounded memory use
 * from a misbehaving client. Returns {} for an empty body (POST endpoints in
 * this API take no body yet, but this keeps handlers uniform if that changes).
 */
export function readJsonBody(req, { maxBytes = 1_000_000 } = {}) {
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
