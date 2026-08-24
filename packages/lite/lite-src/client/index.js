// semidex-lite/client — a zero-dependency ESM client for the Semidex
// Integration API (POST /api/v1/search, POST /api/v1/ask, POST /api/v2/ask).
//
// Zero dependency by design: this file imports nothing beyond its own two
// siblings (errors.js, sse.js) and Node/browser globals (fetch,
// AbortController, ReadableStream, TextDecoder) — no HTTP library, no
// EventSource polyfill. Works on Node.js 20.16+ and any modern runtime with
// native fetch/ReadableStream/AbortSignal.
//
// This module is intentionally NOT staged from the repo's own src/ tree by
// packages/lite/build.mjs (see that script's own header comment) — it lives
// directly under packages/lite/lite-src/, shipped as-is, the same way
// doctor-lite.js/serve-lite.js already are. It has no import into src/ at
// all, so it trivially satisfies the Lite package's closure rules.
import { SemidexApiError, errorFromBody, errorFromPayload } from './errors.js';
import { parseSseStream } from './sse.js';

export { SemidexApiError };

const SEARCH_PATH = '/api/v1/search';
const ASK_V1_PATH = '/api/v1/ask';
const ASK_V2_PATH = '/api/v2/ask';

const DEFAULT_TIMEOUT_MS = 60_000;

// ── Constructor input validation ────────────────────────────────────────────

/**
 * Rejects a baseUrl/apiKey combination that looks like the caller pasted a
 * credential into a URL by mistake — the "reject credentials in query
 * strings" requirement. A baseUrl is expected to be a bare origin (+
 * optional path prefix), never carrying a query string or fragment: a
 * `?token=...`/`?apiKey=...`-shaped baseUrl is exactly the accidental-paste
 * pattern this guards against, and rejecting ANY query string on baseUrl
 * (not just ones that happen to look like a credential) closes the whole
 * class rather than pattern-matching specific parameter names.
 * @param {string} rawBaseUrl
 * @returns {URL}
 */
function validateAndParseBaseUrl(rawBaseUrl) {
  if (typeof rawBaseUrl !== 'string' || rawBaseUrl.trim() === '') {
    throw new TypeError('createSemidexClient({ baseUrl }) is required and must be a non-empty string, e.g. "http://127.0.0.1:8642".');
  }
  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new TypeError(`createSemidexClient({ baseUrl: ${JSON.stringify(rawBaseUrl)} }) is not a valid absolute URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`createSemidexClient({ baseUrl }) must use http: or https:, got "${url.protocol}".`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError(
      'createSemidexClient({ baseUrl }) must not contain a query string or fragment ' +
      '(e.g. never paste a URL with "?apiKey=..." or "?token=..." attached — the ' +
      'client sends the API key via the Authorization header, never a query string).'
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('createSemidexClient({ baseUrl }) must not contain userinfo (user:pass@host) — credentials belong in { apiKey }, never in the URL.');
  }
  return url;
}

// A bearer token must never contain whitespace/control characters (header
// injection defense) or look like it was pasted as a query string
// (`?`/`&`/`=` — the same accidental-credential-in-a-URL mistake baseUrl's
// own validation guards against, from the other direction: an apiKey value
// that itself contains "?" or "=" is far more likely a copy-pasted URL
// fragment than a real bearer token).
const APIKEY_FORBIDDEN_RE = /[\s?&=]|:\/\//;

function validateApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('createSemidexClient({ apiKey }) is required and must be a non-empty string — an Integration API bearer token from `semidex-lite key add`.');
  }
  if (APIKEY_FORBIDDEN_RE.test(apiKey)) {
    throw new TypeError(
      'createSemidexClient({ apiKey }) looks malformed — it must be a bare bearer token with no ' +
      'whitespace and no URL/query-string characters ("?", "&", "=", "://"). ' +
      'If you copy-pasted a full request URL or curl command, pass only the token itself.'
    );
  }
  if (apiKey.length > 512) {
    throw new TypeError('createSemidexClient({ apiKey }) is implausibly long for a bearer token.');
  }
}

function validateTimeoutMs(timeoutMs, label) {
  if (timeoutMs === undefined) return;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`${label} must be a positive number of milliseconds when provided, got ${JSON.stringify(timeoutMs)}.`);
  }
}

// ── Immutability ─────────────────────────────────────────────────────────────
// OWNERSHIP RULE: every value this client hands back to a caller (search()'s
// return value; every event object an askV1()/askV2() iterator yields) is a
// freshly built plain object/array from a freshly parsed JSON payload, and
// this function recursively freezes it before handing it over. A caller may
// read every field freely but may never mutate a returned value — attempting
// to do so throws in strict mode / silently no-ops otherwise, exactly like
// any other frozen object. Nothing internal to this client ever holds a
// reference to a value after returning it, so even without the freeze there
// would be no cross-call state to corrupt — the freeze exists to make that
// guarantee a loud, testable contract rather than an implementation detail a
// future refactor could quietly break.
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

// ── Shared request plumbing ──────────────────────────────────────────────────

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function retryAfterFromHeaders(response) {
  const raw = response.headers.get('retry-after');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function requestIdFromHeaders(response) {
  return response.headers.get('x-request-id') ?? null;
}

/**
 * Composes the caller's own AbortSignal (if any) with an internal
 * timeout-driven abort — mirrors packages/lite/examples/ask-v2-sse-client.mjs's
 * proven composition pattern. Returns { controller, cleanup } — cleanup MUST
 * run in a `finally` block so the timer never outlives the call (no leaked
 * timer, no leaked 'abort' listener) whether the call succeeds, fails, or the
 * caller abandons an async-generator mid-iteration.
 */
function composeAbort(callerSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  return {
    controller,
    cleanup() {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

function timeoutOrAbortError(timeoutMs) {
  return new SemidexApiError(`Request aborted or timed out after ${timeoutMs}ms.`, { code: 'client_timeout_or_abort', retryable: true });
}

function networkError(err) {
  return new SemidexApiError(err?.message ?? String(err), { code: 'client_request_failed', retryable: true });
}

/**
 * @param {{ baseUrl: string, apiKey: string, timeoutMs?: number }} opts
 * @returns {{
 *   search: (args: Object) => Promise<Object>,
 *   askV1: (args: Object) => AsyncGenerator<Object>,
 *   askV2: (args: Object) => AsyncGenerator<Object>,
 * }}
 */
export function createSemidexClient({ baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const parsedBaseUrl = validateAndParseBaseUrl(baseUrl);
  validateApiKey(apiKey);
  validateTimeoutMs(timeoutMs, 'createSemidexClient({ timeoutMs })');

  // Pinned once, at construction — every request this client ever sends is
  // built by STRING CONCATENATION of this origin+pathname with a FIXED,
  // literal API path (never a caller-supplied path or an absolute URL), so
  // there is no `new URL(userInput, base)` call anywhere in this module for
  // a caller-controlled value to redirect via a protocol-relative
  // ("//evil.example") or absolute specifier. The bearer credential can
  // therefore never be sent anywhere other than this exact origin — and,
  // since the SERVER at that origin could itself reply with a 3xx (a
  // compromised/misconfigured origin, or a caller pointing baseUrl at
  // something that redirects), both fetch() calls below also pass
  // `redirect: 'error'`: a 3xx response is rejected outright rather than
  // silently followed, so the Authorization header and request body can
  // never be resent to whatever second, uncontrolled location Location:
  // points at. See tests/unit/lite/client/http.test.js's "redirect" suite
  // for the local-server proof that a redirected endpoint receives neither.
  const origin = parsedBaseUrl.origin;
  const pathPrefix = parsedBaseUrl.pathname.replace(/\/+$/, '');
  const base = origin + pathPrefix;

  function buildUrl(path) {
    return base + path;
  }

  /**
   * @param {{ collection: string, query: string, top?: number, window?: number, windowFormat?: 'compact'|'full', sourceFile?: string, tags?: string[], signal?: AbortSignal, timeoutMs?: number }} args
   * @returns {Promise<Object>} the parsed, deep-frozen /api/v1/search response body
   * @throws {SemidexApiError}
   */
  async function search({
    collection, query, top, window, windowFormat, sourceFile, tags, signal: callerSignal, timeoutMs: perCallTimeoutMs,
  } = {}) {
    validateTimeoutMs(perCallTimeoutMs, 'search({ timeoutMs })');
    const effectiveTimeoutMs = perCallTimeoutMs ?? timeoutMs;
    const { controller, cleanup } = composeAbort(callerSignal, effectiveTimeoutMs);
    try {
      const response = await fetch(buildUrl(SEARCH_PATH), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          collection, query,
          ...(top !== undefined ? { top } : {}),
          ...(window !== undefined ? { window } : {}),
          ...(windowFormat !== undefined ? { windowFormat } : {}),
          ...(sourceFile !== undefined ? { sourceFile } : {}),
          ...(tags !== undefined ? { tags } : {}),
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      const body = await safeReadJson(response);
      if (!response.ok) {
        throw errorFromBody(body, {
          status: response.status,
          requestId: requestIdFromHeaders(response),
          retryAfterSeconds: retryAfterFromHeaders(response),
        });
      }
      return deepFreeze(body ?? {});
    } catch (err) {
      if (err instanceof SemidexApiError) throw err;
      if (controller.signal.aborted) throw timeoutOrAbortError(effectiveTimeoutMs);
      throw networkError(err);
    } finally {
      cleanup();
    }
  }

  /**
   * Shared SSE-streaming implementation for askV1()/askV2() — both endpoints
   * share identical transport/framing/error-projection semantics; only the
   * path and request body shape differ between them.
   * @param {string} path
   * @param {Object} requestBody
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} callOpts
   */
  async function* streamAsk(path, requestBody, { signal: callerSignal, timeoutMs: perCallTimeoutMs } = {}) {
    const effectiveTimeoutMs = perCallTimeoutMs ?? timeoutMs;
    const { controller, cleanup } = composeAbort(callerSignal, effectiveTimeoutMs);
    try {
      const response = await fetch(buildUrl(path), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        redirect: 'error',
      });

      // A pre-stream failure (validation, 401/403/404/429/503) is a plain
      // JSON body, never an SSE stream — distinguished by Content-Type, the
      // same rule packages/lite/examples/ask-v2-sse-client.mjs already
      // established, since a successful request can ALSO end in a
      // JSON-shaped error via a terminal SSE `error` event instead.
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        const body = await safeReadJson(response);
        throw errorFromBody(body, {
          status: response.status,
          requestId: requestIdFromHeaders(response),
          retryAfterSeconds: retryAfterFromHeaders(response),
        });
      }

      for await (const frame of parseSseStream(response.body, controller.signal)) {
        if (frame.event === '__parse_error__') {
          throw new SemidexApiError('Received a malformed SSE data payload from the server.', {
            status: response.status, code: 'client_parse_error', retryable: false,
          });
        }
        // A terminal `error` event is a typed failure, never a yielded
        // event — the caller must not have to check `event.type === 'error'`
        // itself to find out a request failed; a thrown, typed error is the
        // one and only failure signal, and no successful terminal event is
        // ever yielded alongside it.
        if (frame.event === 'error') {
          throw errorFromPayload(frame.data, { status: response.status, requestId: requestIdFromHeaders(response) });
        }
        // Every other event name (today: sources, answer_delta, done — and
        // any future event name this client doesn't recognize yet) is
        // yielded as-is: { type, ...data }. Unknown future fields on a
        // known event, or an entirely unknown event type, are passed
        // through rather than stripped or rejected — forward compatible by
        // construction, since this client does not allow-list event
        // shapes, only special-cases the two it must (error, parse error).
        yield deepFreeze({ type: frame.event, ...frame.data });
      }
    } catch (err) {
      if (err instanceof SemidexApiError) throw err;
      if (controller.signal.aborted) throw timeoutOrAbortError(effectiveTimeoutMs);
      throw networkError(err);
    } finally {
      cleanup();
    }
  }

  /**
   * @param {{ collection: string, question: string, scope?: { sourceFile?: string }, signal?: AbortSignal, timeoutMs?: number }} args
   * @returns {AsyncGenerator<Object>} yields { type: 'sources'|'answer_delta'|'done', ... }; throws SemidexApiError on any failure (including a terminal SSE `error` event)
   */
  function askV1({ collection, question, scope, signal, timeoutMs: perCallTimeoutMs } = {}) {
    return streamAsk(ASK_V1_PATH, {
      collection, question, ...(scope !== undefined ? { scope } : {}),
    }, { signal, timeoutMs: perCallTimeoutMs });
  }

  /**
   * @param {{ collection: string, question: string, conversation?: { conversationId?: string, summary?: string, recentMessages?: Array<{role:'user'|'assistant', content:string}> }, signal?: AbortSignal, timeoutMs?: number }} args
   * @returns {AsyncGenerator<Object>} yields { type, ... }; the caller persists updatedSummary/history from the `done` event's own `conversation` field — see the README's Ask v2 section for the ownership contract
   */
  function askV2({ collection, question, conversation, signal, timeoutMs: perCallTimeoutMs } = {}) {
    // The wire contract's `conversation.id` maps from this client's own
    // `conversation.conversationId` — matching the pseudo-code in the task
    // spec's own public surface (`conversationId`) while still sending
    // exactly what src/core/ask-api/v2/request.js's parseAskRequestV2()
    // expects on the wire ({ id, summary, recentMessages }).
    const wireConversation = conversation
      ? {
        ...(conversation.conversationId !== undefined ? { id: conversation.conversationId } : {}),
        ...(conversation.summary !== undefined ? { summary: conversation.summary } : {}),
        ...(conversation.recentMessages !== undefined ? { recentMessages: conversation.recentMessages } : {}),
      }
      : undefined;
    return streamAsk(ASK_V2_PATH, {
      collection, question, ...(wireConversation !== undefined ? { conversation: wireConversation } : {}),
    }, { signal, timeoutMs: perCallTimeoutMs });
  }

  return { search, askV1, askV2 };
}
