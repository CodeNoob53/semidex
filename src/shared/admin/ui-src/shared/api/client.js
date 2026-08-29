// Validated admin API client (design plan §8.2, §15 item 2). Wraps the same
// request shape ../api.js already sends (same admin header rule, same
// same-origin JSON endpoints) but normalizes every failure into one
// ApiError type instead of a bare Error, and adds a per-request timeout
// composed with a caller-supplied AbortSignal.
//
// No runtime function construction anywhere in this file (CSP: script-src
// 'self', no unsafe-eval — design plan §8.2/§11.4) and no new dependency;
// everything here is `fetch`/`AbortController`/`setTimeout`.

// Sent on every non-safe (state-changing) request — identical rule and
// identical rationale to ../api.js's own ADMIN_REQUEST_HEADERS: not a
// secret, not authentication, just a CORS-preflight tripwire behind the
// router's Origin/Sec-Fetch-Site check.
const ADMIN_REQUEST_HEADERS = { 'X-Semidex-Request': 'admin' };
const SAFE_METHODS = new Set(['GET', 'HEAD']);

// Provisional — no measured value exists yet for the admin surface (design
// plan §11.6 treats every unmeasured bound as provisional until profiled on
// real collections/hardware). 15s comfortably covers a local Qdrant/Ollama
// round trip without leaving a hung request/spinner indefinitely.
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Normalized failure shape every client call throws instead of a bare Error
 * (design plan §8.2):
 *   kind: 'validation'|'not_found'|'conflict'|'forbidden'|'unavailable'
 *       | 'rate_limited'|'server'|'network'|'timeout'|'aborted'|'contract'
 *   status: number|null           — HTTP status, null for network/timeout/aborted
 *   code: string|null             — server's machine-readable code, verbatim
 *   message: string
 *   retryAfterSeconds: number|null
 */
export class ApiError extends Error {
  constructor({ kind, status = null, code = null, message, retryAfterSeconds = null }) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Maps an HTTP response's status code to an ApiError.kind for a response
// whose body WAS valid JSON (a non-JSON body is always 'contract' — see
// readJsonSafely()/request() below, never routed through this function).
function kindForStatus(status) {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 501 || status === 503) return 'unavailable';
  if (status >= 500) return 'server';
  // 400, 415, 422 and any other unmapped 4xx: a request/input problem.
  return 'validation';
}

/**
 * Parses a `Retry-After` header value per RFC 7231 §7.1.3: either a
 * non-negative integer number of seconds, or an HTTP-date. Never throws —
 * a garbled or absent header simply yields null, so a caller never has to
 * special-case a malformed value from a misbehaving proxy.
 */
export function parseRetryAfterSeconds(headerValue) {
  if (headerValue === null || headerValue === undefined) return null;
  const trimmed = String(headerValue).trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const deltaSeconds = Math.ceil((dateMs - Date.now()) / 1000);
  return Math.max(0, deltaSeconds);
}

// Reads a Response body as JSON only when the server actually declared it
// as JSON — never attempts to interpret an HTML error page (a proxy/502
// page, for instance) as a redirect-following text blob, and never returns
// raw non-JSON text to a caller (design plan §15 item 2: "parse JSON
// without exposing raw HTML/non-JSON bodies").
async function readJsonSafely(res) {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, value: undefined };
  }
  const text = await res.text();
  if (text === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: undefined };
  }
}

/**
 * Core request function. `path` is a same-origin admin API path (with query
 * string already applied by the caller, same convention as ../api.js).
 *
 * Options:
 *   method       - default 'GET'
 *   body         - JSON-serializable request body (POST/PATCH)
 *   signal       - caller's AbortSignal; aborting it produces kind:'aborted'
 *   timeoutMs    - per-request timeout; exceeding it produces kind:'timeout'
 *   fetchImpl    - injectable fetch, defaults to the global — test seam only,
 *                  never used to swap in anything at runtime
 */
export async function request(path, {
  method = 'GET',
  body,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (signal?.aborted) {
    throw new ApiError({ kind: 'aborted', message: 'Request aborted before it started' });
  }

  // timeoutController.signal is the ONE signal ever handed to fetchImpl, and
  // it stays live for the entire request lifetime — headers AND full body
  // consumption — not just until fetch() itself resolves. A Response
  // promise resolving only means headers have arrived; res.text()/.json()
  // can still hang or fail well after that, and a real fetch's body read
  // aborts (rejects with AbortError) the same way an in-flight fetch()
  // call does when its signal fires mid-read. Cleanup (clearing the timer,
  // detaching the caller-abort listener) happens exactly once, in `finally`,
  // only after that full lifetime ends — never right after headers arrive.
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutId = (Number.isFinite(timeoutMs) && timeoutMs > 0)
    ? setTimeout(() => { timedOut = true; timeoutController.abort(); }, timeoutMs)
    : null;

  const onCallerAbort = () => timeoutController.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const headers = SAFE_METHODS.has(method) ? {} : { ...ADMIN_REQUEST_HEADERS };
    const init = { method, signal: timeoutController.signal, headers };
    if (body !== undefined) {
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
      try {
        init.body = JSON.stringify(body);
      } catch (err) {
        // Not a network/timeout/abort/contract-response failure — the
        // request itself could never be formed (e.g. a circular reference
        // or a BigInt in the body). Closest existing kind: this is a
        // problem with the request the caller is trying to send, the same
        // class of failure a 400 from the server would represent.
        throw new ApiError({ kind: 'validation', message: `Request body could not be serialized: ${err?.message || 'unknown error'}` });
      }
    }

    const res = await fetchImpl(path, init);
    const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get('retry-after'));
    const parsed = await readJsonSafely(res); // body consumption — still covered by timeoutController.signal above

    if (!parsed.ok) {
      throw new ApiError({
        kind: 'contract',
        status: res.status,
        message: 'Response was not valid JSON',
        retryAfterSeconds,
      });
    }

    if (!res.ok) {
      const errorBody = (parsed.value && typeof parsed.value === 'object') ? parsed.value.error ?? {} : {};
      throw new ApiError({
        kind: kindForStatus(res.status),
        status: res.status,
        code: errorBody.code ?? null,
        message: errorBody.message ?? `HTTP ${res.status}`,
        retryAfterSeconds,
      });
    }

    return parsed.value;
  } catch (err) {
    if (err instanceof ApiError) throw err; // already classified above (serialization/contract/HTTP-status) — pass through unchanged
    if (err?.name === 'AbortError') {
      if (timedOut) throw new ApiError({ kind: 'timeout', message: `Request timed out after ${timeoutMs}ms` });
      throw new ApiError({ kind: 'aborted', message: 'Request aborted' });
    }
    // Any other failure — fetch() itself rejecting (connection refused, DNS
    // failure) or the body stream rejecting mid-read (connection reset) —
    // is normalized the same way, never left as a raw, unclassified error.
    throw new ApiError({ kind: 'network', message: err?.message || 'Network request failed' });
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

export function apiGet(path, opts) {
  return request(path, { ...opts, method: 'GET' });
}

export function apiPost(path, body, opts) {
  return request(path, { ...opts, method: 'POST', body });
}

export function apiPatch(path, body, opts) {
  return request(path, { ...opts, method: 'PATCH', body });
}

export function apiDelete(path, opts) {
  return request(path, { ...opts, method: 'DELETE' });
}
