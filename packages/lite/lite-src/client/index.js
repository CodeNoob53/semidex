// semidex-lite/client — a zero-dependency ESM client for the Semidex
// Integration API (POST /api/v1/search, POST /api/v1/ask, POST /api/v2/ask).
//
// Zero dependency by design: this file imports nothing beyond its own three
// siblings (errors.js, sse.js, retry.js) and Node/browser globals (fetch,
// AbortController, ReadableStream, TextDecoder) — no HTTP library, no
// EventSource polyfill. Works on Node.js 20.16+ and any modern runtime with
// native fetch/ReadableStream/AbortSignal.
//
// The platform fetch is the DEFAULT, not a hard requirement: a caller may
// pass its own implementation via createSemidexClient({ fetch }) for a
// proxy/mTLS agent, tracing, or a test double. That stays zero-dependency —
// it is one injected function, not a plugin system — and it changes only who
// performs the HTTP call, never the redirect/abort/timeout policy this
// client wraps around it.
//
// This module is intentionally NOT staged from the repo's own src/ tree by
// packages/lite/build.mjs (see that script's own header comment) — it lives
// directly under packages/lite/lite-src/, shipped as-is, the same way
// doctor-lite.js/serve-lite.js already are. It has no import into src/ at
// all, so it trivially satisfies the Lite package's closure rules.
import { SemidexApiError, errorFromBody, errorFromPayload } from './errors.js';
import { parseSseStream } from './sse.js';
import {
  DEFAULT_RETRY, normalizeRetryOptions, isRetryablePreStreamSearch, isRetryablePreStreamAsk, computeDelayMs, sleepUnlessAborted,
} from './retry.js';

export { SemidexApiError };
export { DEFAULT_RETRY };

// The three SSE event names both askV1() and askV2() ever yield with a
// statically documented shape (see index.d.ts's KnownAskEventV1/V2) — every
// other `type` is an AskUnknownEvent, forwarded as-is by streamAsk() below
// but not one this allow-list recognizes.
const KNOWN_ASK_EVENT_TYPES = new Set(['sources', 'answer_delta', 'done']);

/**
 * Runtime allow-list check shared by both `isKnownAskV1Event()` and
 * `isKnownAskV2Event()` — it never reads `apiVersion`, so the same check is
 * correct for either version; only the exported names' STATIC (TypeScript)
 * return type differs, per index.d.ts.
 * @param {{ type: string }} event
 * @returns {boolean}
 */
function isKnownAskEventType(event) {
  return KNOWN_ASK_EVENT_TYPES.has(event?.type);
}

/** Runtime counterpart of index.d.ts's `isKnownAskV1Event()` type guard. */
export const isKnownAskV1Event = isKnownAskEventType;
/** Runtime counterpart of index.d.ts's `isKnownAskV2Event()` type guard. */
export const isKnownAskV2Event = isKnownAskEventType;

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

/**
 * Resolves the fetch implementation this client will use for every request.
 *
 * WHY INJECTION: the client is zero-dependency and calls the platform
 * `fetch` by default, which is right for production but leaves a consumer
 * no seam for a corporate HTTP proxy/mTLS agent, a test double, a
 * request-logging or tracing wrapper, or a runtime whose `fetch` lives
 * somewhere other than `globalThis`. Injecting one function covers all of
 * those without adding a dependency or a plugin system.
 *
 * WHAT IS NOT DELEGATED: injection changes only WHO performs the HTTP call,
 * never the security posture around it. Every request this client builds
 * still carries `redirect: 'error'` and the composed `AbortSignal`, and the
 * URL is still built by concatenation from the pinned origin. An injected
 * fetch that ignores those options weakens only itself — the client neither
 * re-implements nor relaxes them, and never falls back to global fetch once
 * an implementation has been resolved.
 *
 * The default is captured as a REFERENCE at construction time, not looked
 * up per call, so a client built while a sane `fetch` existed keeps working
 * even if something later reassigns `globalThis.fetch`.
 * @param {unknown} injected
 * @returns {(input: any, init?: any) => Promise<Response>}
 */
function resolveFetch(injected) {
  if (injected === undefined) {
    if (typeof globalThis.fetch !== 'function') {
      throw new TypeError(
        'createSemidexClient() requires a global fetch() (Node.js 20.16+ or any modern runtime). '
        + 'This runtime has none — pass your own via createSemidexClient({ fetch }).',
      );
    }
    // Bound to globalThis: an unbound reference to the platform fetch throws
    // "Illegal invocation" in browsers when called as a bare function.
    return globalThis.fetch.bind(globalThis);
  }
  if (typeof injected !== 'function') {
    throw new TypeError(`createSemidexClient({ fetch }) must be a function when provided, got ${JSON.stringify(injected)}.`);
  }
  // Deliberately NOT bound to globalThis: an injected function keeps
  // whatever `this` its own definition implies (a bound method, an arrow
  // closing over a proxy agent, a class instance's own method).
  return injected;
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
 * Runs `attempt` under the bounded retry policy, retrying ONLY pre-stream
 * failures (see retry.js's header for why a started stream is never retried)
 * that `isRetryable` itself calls retryable — search() and streamAsk() each
 * pass a DIFFERENT predicate (`isRetryablePreStreamSearch`/
 * `isRetryablePreStreamAsk`, both in retry.js) rather than this function
 * branching internally on which operation is calling: Ask is not idempotent
 * and Search is, so the eligibility rule is a property of the call site, not
 * something this generic loop should have to know about by name.
 *
 * `attempt` is called with the attempt index and must either return a value
 * or throw a SemidexApiError. It signals "past the point of no return" by
 * calling the `markCommitted` callback it is handed — once called, no
 * failure from that attempt is ever retried, even a retryable-looking one.
 * streamAsk() calls it the instant a response is confirmed to be a real
 * `text/event-stream`, which is the boundary between "no bytes received
 * yet" and "tokens are already on the wire" — NOT proof the server hadn't
 * already started generating before that point (see retry.js's header on
 * why `isRetryablePreStreamAsk` never trusts an ambiguous network failure).
 *
 * Observability: every retry is reported through the optional `onRetry`
 * callback with a SAFE, secret-free record ({ attempt, delayMs, status,
 * code, retryAfterSeconds, reason }) — the same fields SemidexApiError
 * already exposes, never a header, a body, or the bearer token. The final
 * attempt count is surfaced separately by each caller (search() attaches it
 * to the frozen result via `retries`; streamAsk() attaches it to the thrown
 * error), so a caller can observe retry activity without a callback too.
 *
 * @template T
 * @param {(attemptIndex: number, markCommitted: () => void) => Promise<T>} attempt
 * @param {Readonly<{attempts:number, initialDelayMs:number, maxDelayMs:number, backoffFactor:number, jitter:boolean, onRetry?: Function}>} retryOpts
 * @param {AbortSignal} signal — the COMPOSED signal (caller abort + call timeout)
 * @param {number} effectiveTimeoutMs — only used to shape the abort error
 * @param {(err: unknown) => boolean} isRetryable — the operation-specific eligibility predicate
 * @returns {Promise<{ value: T, retries: number }>}
 */
async function runWithRetry(attempt, retryOpts, signal, effectiveTimeoutMs, isRetryable) {
  let lastError = null;
  for (let attemptIndex = 0; attemptIndex < retryOpts.attempts; attemptIndex += 1) {
    let committed = false;
    const markCommitted = () => { committed = true; };
    try {
      const value = await attempt(attemptIndex, markCommitted);
      return { value, retries: attemptIndex };
    } catch (err) {
      lastError = err;
      // Past the point of no return (an SSE stream has begun): never retry,
      // regardless of what the failure looks like.
      if (committed) throw tagRetries(err, attemptIndex);
      const isLastAttempt = attemptIndex === retryOpts.attempts - 1;
      if (isLastAttempt || !isRetryable(err)) throw tagRetries(err, attemptIndex);
      // A caller abort / timeout must end the call, never trigger a retry.
      if (signal.aborted) throw tagRetries(timeoutOrAbortError(effectiveTimeoutMs), attemptIndex);

      const { delayMs, exceedsMaxDelay, source } = computeDelayMs(
        attemptIndex, err.retryAfterSeconds ?? null, retryOpts,
      );
      // The server asked for longer than this client is willing to hold a
      // call open: respect it by NOT retrying (surface the original error)
      // rather than by sleeping a clamped amount and re-hitting the same
      // limit. The caller can reschedule with err.retryAfterSeconds in hand.
      if (exceedsMaxDelay) throw tagRetries(err, attemptIndex);

      if (retryOpts.onRetry) {
        // A throwing/rejecting onRetry must never corrupt the retry loop or
        // replace the real API error with an observer's bug.
        try {
          retryOpts.onRetry(Object.freeze({
            attempt: attemptIndex + 1,
            nextAttempt: attemptIndex + 2,
            delayMs,
            delaySource: source,
            status: err.status ?? null,
            code: err.code ?? null,
            retryAfterSeconds: err.retryAfterSeconds ?? null,
            reason: err.message,
          }));
        } catch { /* observer errors are swallowed by design */ }
      }

      const outcome = await sleepUnlessAborted(delayMs, signal);
      // AbortSignal/timeout DURING backoff ends the call with the same
      // typed error an abort during the HTTP leg produces — not a distinct
      // third shape the caller would have to special-case.
      if (outcome === 'aborted') throw tagRetries(timeoutOrAbortError(effectiveTimeoutMs), attemptIndex + 1);
    }
  }
  /* c8 ignore next */
  throw lastError;
}

/**
 * Records how many retries were spent before a failure, as a stable,
 * secret-free field on the thrown SemidexApiError. Non-enumerable for the
 * same reason search()'s own `retries` is: the error's serialized shape
 * (and every existing assertion against it) stays exactly as it was, while
 * `err.retries` reads back for a caller that wants it. Only ever set once —
 * an error that already carries the field (rethrown through a nested layer)
 * keeps its original count.
 */
function tagRetries(err, retries) {
  if (!(err instanceof SemidexApiError)) return err;
  if (Object.prototype.hasOwnProperty.call(err, 'retries')) return err;
  Object.defineProperty(err, 'retries', {
    value: retries, enumerable: false, writable: false, configurable: false,
  });
  return err;
}

/**
 * @param {{ baseUrl: string, apiKey: string, timeoutMs?: number, retry?: Object, fetch?: Function }} opts
 * @returns {{
 *   search: (args: Object) => Promise<Object>,
 *   askV1: (args: Object) => AsyncGenerator<Object>,
 *   askV2: (args: Object) => AsyncGenerator<Object>,
 *   askText: (args: Object) => Promise<Object>,
 * }}
 */
export function createSemidexClient({
  baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, retry, fetch: injectedFetch,
} = {}) {
  const parsedBaseUrl = validateAndParseBaseUrl(baseUrl);
  validateApiKey(apiKey);
  validateTimeoutMs(timeoutMs, 'createSemidexClient({ timeoutMs })');
  // Resolved ONCE, at construction, and closed over privately. Every request
  // below calls `doFetch`, never the global `fetch` — so a client built with
  // an injected implementation can never silently fall back to the platform
  // one, and a later reassignment of `globalThis.fetch` cannot hijack an
  // already-constructed client. See tests/unit/lite/client/fetch-injection
  // .test.js, which proves both by deleting the global entirely.
  const doFetch = resolveFetch(injectedFetch);
  // Client-level retry defaults; a per-call `retry` layers ONTO these rather
  // than replacing them wholesale, so a call can raise just `attempts`
  // without restating the whole backoff schedule.
  const clientRetry = normalizeRetryOptions(retry, 'createSemidexClient({ retry })');

  // Pinned once, at construction — every request this client ever sends is
  // built by STRING CONCATENATION of this origin+pathname with a FIXED,
  // literal API path (never a caller-supplied path or an absolute URL), so
  // there is no `new URL(userInput, base)` call anywhere in this module for
  // a caller-controlled value to redirect via a protocol-relative
  // ("//evil.example") or absolute specifier. The bearer credential can
  // therefore never be sent anywhere other than this exact origin — and,
  // since the SERVER at that origin could itself reply with a 3xx (a
  // compromised/misconfigured origin, or a caller pointing baseUrl at
  // something that redirects), both request calls below also pass
  // `redirect: 'error'`: a 3xx response is rejected outright rather than
  // silently followed, so the Authorization header and request body can
  // never be resent to whatever second, uncontrolled location Location:
  // points at. See tests/unit/lite/client/http.test.js's "redirect" suite
  // for the local-server proof that a redirected endpoint receives neither.
  // An INJECTED fetch receives these same options on every call — the client
  // never drops or relaxes them for a custom implementation.
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
    collection, query, top, window, windowFormat, sourceFile, tags,
    signal: callerSignal, timeoutMs: perCallTimeoutMs, retry: perCallRetry,
  } = {}) {
    validateTimeoutMs(perCallTimeoutMs, 'search({ timeoutMs })');
    const retryOpts = normalizeRetryOptions(perCallRetry, 'search({ retry })', clientRetry);
    const effectiveTimeoutMs = perCallTimeoutMs ?? timeoutMs;
    // ONE composed abort for the WHOLE call, retries included: `timeoutMs` is
    // a total wall-clock budget across every attempt and every backoff sleep,
    // never a per-attempt one. Opting into retries can therefore never make a
    // call outlive the deadline its caller set.
    const { controller, cleanup } = composeAbort(callerSignal, effectiveTimeoutMs);
    try {
      const { value, retries } = await runWithRetry(async () => {
        try {
          const response = await doFetch(buildUrl(SEARCH_PATH), {
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
          return body ?? {};
        } catch (err) {
          if (err instanceof SemidexApiError) throw err;
          if (controller.signal.aborted) throw timeoutOrAbortError(effectiveTimeoutMs);
          throw networkError(err);
        }
      }, retryOpts, controller.signal, effectiveTimeoutMs, isRetryablePreStreamSearch);

      // `retries` is a stable, secret-free observability field — 0 when the
      // first attempt succeeded. Attached NON-ENUMERABLY so the Search
      // response contract is byte-for-byte preserved: JSON.stringify(),
      // Object.keys(), and deepEqual against a server payload all behave
      // exactly as they did before retries existed, while `result.retries`
      // still reads back for a caller that wants it.
      return deepFreeze(Object.defineProperty(value, 'retries', {
        value: retries, enumerable: false, writable: false, configurable: false,
      }));
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
  async function* streamAsk(path, requestBody, {
    signal: callerSignal, timeoutMs: perCallTimeoutMs, retry: perCallRetry,
  } = {}) {
    const retryOpts = normalizeRetryOptions(perCallRetry, 'ask({ retry })', clientRetry);
    const effectiveTimeoutMs = perCallTimeoutMs ?? timeoutMs;
    // As in search(): ONE composed abort covers every attempt AND every
    // backoff sleep, so `timeoutMs` stays a total budget for the whole call.
    const { controller, cleanup } = composeAbort(callerSignal, effectiveTimeoutMs);
    try {
      // ONLY the pre-stream leg is inside the retry loop, and — unlike
      // search() above — a bare network failure in that leg is NEVER
      // eligible for a retry: `isRetryablePreStreamAsk` (retry.js) only
      // trusts a genuinely RECEIVED JSON error body that explicitly says
      // `retryable: true`, because Ask is not idempotent and a lost
      // connection before headers cannot be told apart from "the server
      // already started generating". Once this returns, the response's
      // Content-Type has already been confirmed to be a real SSE stream;
      // by then `markCommitted()` has been called, so nothing that happens
      // while consuming the body below can re-enter the loop and re-run a
      // generation. See retry.js's header for why.
      const { value: response, retries } = await runWithRetry(async (_attemptIndex, markCommitted) => {
        try {
          const res = await doFetch(buildUrl(path), {
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
          // JSON body, never an SSE stream — distinguished by Content-Type,
          // the same rule packages/lite/examples/ask-v2-sse-client.mjs
          // already established, since a successful request can ALSO end in
          // a JSON-shaped error via a terminal SSE `error` event instead.
          const contentType = res.headers.get('content-type') ?? '';
          if (!contentType.includes('text/event-stream')) {
            const body = await safeReadJson(res);
            throw errorFromBody(body, {
              status: res.status,
              requestId: requestIdFromHeaders(res),
              retryAfterSeconds: retryAfterFromHeaders(res),
            });
          }
          // THE POINT OF NO RETURN. From here on the server is streaming a
          // generation: never retried, at any cost.
          markCommitted();
          return res;
        } catch (err) {
          if (err instanceof SemidexApiError) throw err;
          if (controller.signal.aborted) throw timeoutOrAbortError(effectiveTimeoutMs);
          throw networkError(err);
        }
      }, retryOpts, controller.signal, effectiveTimeoutMs, isRetryablePreStreamAsk);

      // Retry observability for a streaming call: `retries` rides on the
      // FIRST yielded event (and, below, on any error thrown once streaming
      // began), non-enumerably so the wire event shape is unchanged.
      let firstEvent = true;

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
        const event = { type: frame.event, ...frame.data };
        if (firstEvent) {
          firstEvent = false;
          Object.defineProperty(event, 'retries', {
            value: retries, enumerable: false, writable: false, configurable: false,
          });
        }
        yield deepFreeze(event);
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
  function askV1({
    collection, question, scope, signal, timeoutMs: perCallTimeoutMs, retry: perCallRetry,
  } = {}) {
    return streamAsk(ASK_V1_PATH, {
      collection, question, ...(scope !== undefined ? { scope } : {}),
    }, { signal, timeoutMs: perCallTimeoutMs, retry: perCallRetry });
  }

  /**
   * @param {{ collection: string, question: string, conversation?: { conversationId?: string, summary?: string, recentMessages?: Array<{role:'user'|'assistant', content:string}> }, signal?: AbortSignal, timeoutMs?: number }} args
   * @returns {AsyncGenerator<Object>} yields { type, ... }; the caller persists updatedSummary/history from the `done` event's own `conversation` field — see the README's Ask v2 section for the ownership contract
   */
  function askV2({
    collection, question, conversation, signal, timeoutMs: perCallTimeoutMs, retry: perCallRetry,
  } = {}) {
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
    }, { signal, timeoutMs: perCallTimeoutMs, retry: perCallRetry });
  }

  /**
   * Convenience wrapper: consumes an askV1()/askV2() SSE stream to
   * completion and resolves with ONE structured result instead of making
   * the caller run a `for await` loop and accumulate deltas by hand.
   *
   * This is a pure consumer of the streaming methods — askV1()/askV2() are
   * unchanged and remain the right choice whenever you want token-by-token
   * output (a chat UI, a proxied SSE endpoint). askText() is for the case
   * where you only want the finished answer (a batch job, a tool call, a
   * non-streaming HTTP handler), where hand-rolling the accumulation is
   * just an opportunity to get it subtly wrong.
   *
   * Error contract is IDENTICAL to the streaming methods: a terminal SSE
   * `error` event, a pre-stream failure, a timeout, an abort, or a
   * malformed frame all reject with the same SemidexApiError the `for
   * await` loop would have thrown. Nothing is swallowed and no partial
   * answer is returned in place of an error — a failed generation rejects,
   * even if some `answer_delta` text had already arrived.
   *
   * @param {{ version?: 'v1'|'v2', collection: string, question: string, scope?: Object, conversation?: Object, signal?: AbortSignal, timeoutMs?: number, retry?: Object }} args
   * @returns {Promise<{ answer: string, sources: Array<Object>, citations: number[], done: Object, conversation: Object|null }>}
   */
  async function askText({ version = 'v1', ...args } = {}) {
    if (version !== 'v1' && version !== 'v2') {
      throw new TypeError(`askText({ version }) must be "v1" or "v2" when provided, got ${JSON.stringify(version)}.`);
    }
    const stream = version === 'v2' ? askV2(args) : askV1(args);

    let sources = [];
    let doneEvent = null;
    // Accumulated from answer_delta as a fallback ONLY. The `done` event
    // carries the authoritative, complete answer (it is what the server
    // itself considers final), so that wins whenever it is a string — the
    // delta concatenation is what answers the case of a server that streams
    // deltas but sends no `answer` on `done`.
    const deltas = [];

    for await (const event of stream) {
      if (event.type === 'sources') sources = event.sources ?? [];
      else if (event.type === 'answer_delta') { if (typeof event.text === 'string') deltas.push(event.text); }
      else if (event.type === 'done') doneEvent = event;
      // Any other/unknown event type is ignored here rather than rejected —
      // same forward-compatibility rule streamAsk() applies when yielding.
    }

    if (doneEvent === null) {
      // The stream ended cleanly but never delivered its terminal event: a
      // truncated response, not a successful one. Surfaced as the same typed
      // error class as every other failure, never as a silent partial result.
      throw new SemidexApiError('The Ask stream ended without a terminal `done` event.', {
        code: 'client_incomplete_stream', retryable: true,
      });
    }

    return deepFreeze({
      answer: typeof doneEvent.answer === 'string' ? doneEvent.answer : deltas.join(''),
      sources,
      citations: doneEvent.citations ?? [],
      done: doneEvent,
      // Ask v1 has no conversation concept at all; v2 returns whatever the
      // `done` event carried (null when the request sent no `conversation`).
      // Note this is Semidex's CONFIRMATION of the turn, not storage: the
      // caller still owns persisting summary/recentMessages itself.
      conversation: doneEvent.conversation ?? null,
    });
  }

  return { search, askV1, askV2, askText };
}
