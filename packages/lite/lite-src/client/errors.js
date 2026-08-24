// The ONE typed error class this client ever throws for a request-level
// failure — a non-2xx JSON response (Search or a pre-stream Ask error body)
// or a terminal SSE `error` event (Ask). Carries only safe, serializable
// fields; NEVER the API key, a raw header, or the request body — the
// constructor here has no access to the key at all (createSemidexClient()
// closes over it privately and never passes it into an error object).
export class SemidexApiError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   status?: number|null,
   *   code?: string|null,
   *   retryable?: boolean,
   *   retryAfterSeconds?: number|null,
   *   requestId?: string|null,
   *   apiVersion?: string|null,
   * }} [details]
   */
  constructor(message, {
    status = null, code = null, retryable = false, retryAfterSeconds = null, requestId = null, apiVersion = null,
  } = {}) {
    super(message);
    this.name = 'SemidexApiError';
    this.status = status;
    this.code = code;
    this.retryable = Boolean(retryable);
    this.retryAfterSeconds = retryAfterSeconds;
    this.requestId = requestId;
    this.apiVersion = apiVersion;
  }
}

/**
 * Shared projection from a raw error PAYLOAD (already unwrapped — the shape
 * an SSE `error` event's `data:` line carries directly) to a SemidexApiError.
 * errorFromBody() (below) is the pre-stream-JSON-response variant, which
 * unwraps `{ error: {...} }` first and delegates here.
 * @param {unknown} payload
 * @param {{ status?: number|null, requestId?: string|null, retryAfterSeconds?: number|null }} [meta]
 */
export function errorFromPayload(payload, { status = null, requestId = null, retryAfterSeconds = null } = {}) {
  const err = (payload && typeof payload === 'object') ? payload : null;
  const message = (err && typeof err.message === 'string' && err.message.length > 0)
    ? err.message
    : `Request failed${status !== null ? ` with HTTP ${status}` : ''}.`;
  return new SemidexApiError(message, {
    status,
    code: (err && typeof err.code === 'string') ? err.code : null,
    retryable: Boolean(err?.retryable),
    retryAfterSeconds: Number.isFinite(err?.retryAfterSeconds) ? err.retryAfterSeconds : retryAfterSeconds,
    requestId: (typeof err?.requestId === 'string') ? err.requestId : requestId,
    apiVersion: (err && typeof err.apiVersion === 'string') ? err.apiVersion : null,
  });
}

/**
 * Builds a SemidexApiError from a parsed `{ error: {...} }` response body
 * (the shape both /api/v1/search and /api/v1/ask, /api/v2/ask use for a
 * pre-stream JSON failure and a terminal SSE `error` event alike). Never
 * throws itself — a malformed/missing error body still produces a usable
 * typed error rather than crashing during error handling.
 *
 * `retryAfterSeconds`/`requestId` are accepted as fallbacks from the
 * caller (typically read from the `Retry-After`/`X-Request-Id` response
 * HEADERS) because today's server puts Retry-After on the HTTP header, not
 * in the JSON body — the body-level fields are read FIRST only so a future
 * server version that starts including them in the body is honored without
 * a client change.
 * @param {unknown} body
 * @param {{ status?: number|null, requestId?: string|null, retryAfterSeconds?: number|null }} [meta]
 */
export function errorFromBody(body, { status = null, requestId = null, retryAfterSeconds = null } = {}) {
  const err = (body && typeof body === 'object' && body.error && typeof body.error === 'object') ? body.error : null;
  const message = (err && typeof err.message === 'string' && err.message.length > 0)
    ? err.message
    : `Request failed${status !== null ? ` with HTTP ${status}` : ''}.`;
  return new SemidexApiError(message, {
    status,
    code: (err && typeof err.code === 'string') ? err.code : null,
    retryable: Boolean(err?.retryable),
    retryAfterSeconds: Number.isFinite(err?.retryAfterSeconds) ? err.retryAfterSeconds : retryAfterSeconds,
    requestId: (typeof err?.requestId === 'string') ? err.requestId : requestId,
    apiVersion: (err && typeof err.apiVersion === 'string') ? err.apiVersion : null,
  });
}
