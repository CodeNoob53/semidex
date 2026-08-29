// Bounded retry policy for semidex-lite/client — pre-stream failures only.
//
// Zero dependency, like the rest of this client: nothing here imports
// anything but its own sibling errors.js and platform globals.
//
// THE ONE INVARIANT THIS FILE EXISTS TO PROTECT: a generation is never
// retried once its SSE stream has started. Ask is not idempotent from the
// server's point of view — a second attempt re-runs retrieval AND
// re-generates tokens, spending budget again. Retrying a request that
// already produced bytes would also duplicate a partially delivered answer
// for the caller. So the retry loop wraps ONLY the pre-stream leg (connect
// + response headers + a non-SSE error body); the moment streamAsk()
// decides a response is a real `text/event-stream`, the loop is finished
// and no later failure — malformed frame, terminal `error` event, socket
// reset mid-answer — can re-enter it. See index.js's own `markCommitted()`
// handoff for the enforcement point.
//
// RECEIVING RESPONSE HEADERS IS NOT THE SAME THING AS "GENERATION HASN'T
// STARTED YET". `markCommitted()` marks the CLIENT-OBSERVED boundary between
// "no bytes received" and "bytes on the wire" — it says nothing about
// whether the SERVER had already accepted the POST body and begun retrieval
// or generation before those bytes (or even the response headers) reached
// this client. A fetch-level network failure BEFORE headers ever arrive is
// therefore genuinely ambiguous, not safe-by-default: the request may never
// have reached the server (safe to retry), or the server may have received
// it, started spending budget, and lost the connection before answering
// (retrying duplicates that spend). Search is read-only, so that ambiguity
// costs nothing and `isRetryablePreStreamSearch()` below retries a network
// failure the same way it retries a transient status. Ask is NOT read-only,
// so `isRetryablePreStreamAsk()` below resolves the SAME ambiguity the
// opposite way: a network failure is never retried, at any status, and the
// only thing it ever calls retryable is a genuinely RECEIVED JSON error body
// whose own payload says `retryable: true` — i.e. the server itself,
// already known to have replied without starting a stream, vouching that a
// retry is safe.
import { SemidexApiError } from './errors.js';

// ── Defaults ────────────────────────────────────────────────────────────────
//
// CONSERVATIVE BY DEFAULT, NOT OFF BY DEFAULT. `retry.attempts` defaults to
// 1 — a single attempt, i.e. exactly today's behavior — so upgrading the
// package can never silently turn one caller request into several, never
// silently multiply spend against a rate-limited/over-budget server, and
// never change the wall-clock profile of an existing integration. Retries
// are opt-in: pass `retry: { attempts: 3 }` (client-level or per-call).
// Every OTHER knob below is what you get once you opt in, chosen to be safe
// rather than aggressive.
export const DEFAULT_RETRY = Object.freeze({
  attempts: 1, // total attempts, not "extra" attempts. 1 = no retry.
  initialDelayMs: 250,
  maxDelayMs: 8_000, // also the hard ceiling applied to a server Retry-After
  backoffFactor: 2,
  jitter: true,
});

// The absolute ceiling on any single backoff sleep, including one derived
// from a server-sent Retry-After. A server (or a proxy in front of it) can
// answer `Retry-After: 3600`; honoring that literally would hang a caller
// request for an hour inside what looks like a normal call. Retry-After is
// RESPECTED (it wins over the computed exponential delay when it is larger
// and valid) but never beyond maxDelayMs — past that ceiling the client
// stops retrying and surfaces the error, letting the CALLER decide whether
// to wait an hour, which is a scheduling decision, not an HTTP one.
const RETRY_AFTER_MAX_SECONDS = 86_400; // beyond a day is malformed/hostile, ignored outright

// HTTP statuses that are safe for search() to retry BEFORE a response has
// begun. Deliberately narrow: transient capacity/availability signals only.
//   429 — rate limited (the server explicitly says "later")
//   502/503/504 — bad gateway / unavailable / gateway timeout
// Everything else is NOT retried, in particular:
//   400 validation, 401 unauthorized, 403 forbidden/scope, 404 unknown
//   collection — deterministic, caller-fixable failures where a retry only
//   burns rate-limit budget and delays the real error reaching the caller.
//   500 is also excluded: an unqualified server error is not known-transient.
// Search is read-only, so unlike Ask (see isRetryablePreStreamAsk() below)
// there is no non-idempotency hazard in trusting a status code alone here.
const RETRYABLE_STATUSES = Object.freeze(new Set([429, 502, 503, 504]));

/**
 * Normalizes and validates a retry option bag. Throws TypeError synchronously
 * for a malformed input — the same contract as this client's other validators
 * (never a rejected Promise, never a silently ignored bad value).
 * @param {unknown} input
 * @param {string} label — e.g. 'createSemidexClient({ retry })'
 * @param {Readonly<typeof DEFAULT_RETRY>} [base] — the defaults to layer onto
 */
export function normalizeRetryOptions(input, label, base = DEFAULT_RETRY) {
  if (input === undefined) return base;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object when provided, got ${JSON.stringify(input)}.`);
  }
  const merged = { ...base };
  if (input.attempts !== undefined) {
    if (!Number.isInteger(input.attempts) || input.attempts < 1 || input.attempts > 10) {
      throw new TypeError(`${label}.attempts must be an integer between 1 and 10 (1 = no retry), got ${JSON.stringify(input.attempts)}.`);
    }
    merged.attempts = input.attempts;
  }
  for (const key of ['initialDelayMs', 'maxDelayMs']) {
    if (input[key] === undefined) continue;
    if (!Number.isFinite(input[key]) || input[key] < 0) {
      throw new TypeError(`${label}.${key} must be a non-negative number of milliseconds when provided, got ${JSON.stringify(input[key])}.`);
    }
    merged[key] = input[key];
  }
  if (input.backoffFactor !== undefined) {
    if (!Number.isFinite(input.backoffFactor) || input.backoffFactor < 1) {
      throw new TypeError(`${label}.backoffFactor must be a number >= 1 when provided, got ${JSON.stringify(input.backoffFactor)}.`);
    }
    merged.backoffFactor = input.backoffFactor;
  }
  if (input.jitter !== undefined) {
    if (typeof input.jitter !== 'boolean') {
      throw new TypeError(`${label}.jitter must be a boolean when provided, got ${JSON.stringify(input.jitter)}.`);
    }
    merged.jitter = input.jitter;
  }
  if (input.onRetry !== undefined) {
    if (typeof input.onRetry !== 'function') {
      throw new TypeError(`${label}.onRetry must be a function when provided, got ${JSON.stringify(input.onRetry)}.`);
    }
    merged.onRetry = input.onRetry;
  }
  if (merged.maxDelayMs < merged.initialDelayMs) {
    throw new TypeError(`${label}.maxDelayMs (${merged.maxDelayMs}) must be >= initialDelayMs (${merged.initialDelayMs}).`);
  }
  return Object.freeze(merged);
}

/**
 * Is this SEARCH failure retryable BEFORE a response has begun? Search is
 * read-only, so a network failure before any response is unambiguously safe
 * to retry — there is no server-side spend a retry could duplicate.
 *
 * This deliberately does NOT trust `err.retryable` on its own. The server
 * sets that flag as advice about the nature of a failure, and this client
 * own transport errors set it too (a timeout is "retryable" in the sense
 * that trying again might work) — but the decision to actually spend
 * another request is this client's, made from the status code and the error
 * code, so a future server that starts marking some 400 `retryable: true`
 * cannot turn a validation bug into a retry storm.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryablePreStreamSearch(err) {
  if (!(err instanceof SemidexApiError)) return false;
  // A transport-level failure with no HTTP response at all: the request may
  // never have reached the server, so a retry is safe in the same sense a
  // connect-timeout retry is. `client_timeout_or_abort` is excluded on
  // purpose — an abort is either the caller explicit cancellation or the
  // call total deadline, and neither should be answered by trying again.
  if (err.status === null || err.status === undefined) {
    return err.code === 'client_request_failed';
  }
  return RETRYABLE_STATUSES.has(err.status);
}

/**
 * Is this ASK failure retryable BEFORE its SSE stream has begun? Ask is NOT
 * read-only — a second attempt re-runs retrieval and re-generates tokens,
 * spending budget again — so this answers a narrower, harder question than
 * `isRetryablePreStreamSearch()` above: not just "did a stream start" but
 * "is it SAFE to assume the server never started generating".
 *
 * A network-level failure (`status` null/undefined — connect refused, DNS
 * failure, socket reset before any response) is NEVER retryable here, no
 * matter what `err.code` says. Unlike search, a lost connection before
 * headers is genuinely ambiguous for Ask: the server may already have
 * accepted the POST and started spending generation budget before the
 * response — or even its headers — reached this client, and there is no way
 * to tell "never reached the server" apart from "reached it and then the
 * connection died". Retrying would risk exactly the duplicate-generation
 * harm the whole retry policy exists to prevent, so the ambiguous case is
 * resolved by never retrying it, full stop.
 *
 * The ONLY thing this calls retryable is a genuinely RECEIVED pre-stream
 * JSON error body (a real HTTP response — `err.status` is populated, so
 * this runs strictly before streamAsk() would ever call `markCommitted()`)
 * whose own payload identifies Ask API v1/v2 and explicitly sets
 * `retryable: true` (see errorFromBody()/
 * errorFromPayload() in errors.js — `retryable` is read from the parsed
 * body, defaulting to `false` for a missing/malformed one). Trusting the
 * flag here — the mirror image of search()'s policy above — is deliberate:
 * only Semidex itself, having already confirmed it replied without ever
 * starting a stream, is in a position to know a retry is safe, and a
 * generic reverse-proxy 502/504 does not qualify. Both the API version and
 * retryable flag are required, so a proxy's unrelated JSON error cannot be
 * mistaken for a Semidex Ask envelope.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryablePreStreamAsk(err) {
  if (!(err instanceof SemidexApiError)) return false;
  if (err.status === null || err.status === undefined) return false;
  if (err.apiVersion !== 'v1' && err.apiVersion !== 'v2') return false;
  return err.retryable === true;
}

/**
 * Computes the delay before the next attempt.
 *
 * Retry-After (when valid and larger) wins over the exponential schedule —
 * the server knows its own capacity window better than a client-side
 * formula does — but the result is ALWAYS clamped to maxDelayMs, and a
 * Retry-After demanding longer than maxDelayMs is reported as
 * `exceedsMaxDelay: true` so the caller stops retrying rather than sleeping
 * a clamped-but-still-useless amount and hitting the same 429 again.
 *
 * @param {number} attemptIndex — 0 for the delay after the first attempt
 * @param {number|null} retryAfterSeconds
 * @param {{ initialDelayMs: number, maxDelayMs: number, backoffFactor: number, jitter: boolean }} opts
 * @param {() => number} [random] — injectable for deterministic tests
 * @returns {{ delayMs: number, exceedsMaxDelay: boolean, source: 'retry-after'|'backoff' }}
 */
export function computeDelayMs(attemptIndex, retryAfterSeconds, opts, random = Math.random) {
  const exponential = Math.min(
    opts.initialDelayMs * Math.pow(opts.backoffFactor, attemptIndex),
    opts.maxDelayMs,
  );
  // Jitter over [exponential/2, exponential] — keeps a real floor (unlike
  // jitter over [0, exponential], which can retry almost instantly) while
  // still de-correlating a fleet of clients that all got 429'd by the same
  // capacity event and would otherwise re-converge on the same instant.
  const backoffMs = opts.jitter
    ? Math.round(exponential / 2 + random() * (exponential / 2))
    : Math.round(exponential);

  const hasRetryAfter = retryAfterSeconds !== null
    && Number.isFinite(retryAfterSeconds)
    && retryAfterSeconds >= 0
    && retryAfterSeconds <= RETRY_AFTER_MAX_SECONDS;
  if (!hasRetryAfter) {
    return { delayMs: backoffMs, exceedsMaxDelay: false, source: 'backoff' };
  }

  const retryAfterMs = retryAfterSeconds * 1000;
  if (retryAfterMs > opts.maxDelayMs) {
    // Respected, but out of budget: report it and let the caller surface the
    // original error instead of waiting.
    return { delayMs: opts.maxDelayMs, exceedsMaxDelay: true, source: 'retry-after' };
  }
  // Retry-After is a FLOOR the server asked for; never wait less than it,
  // but a longer jittered backoff is fine to keep.
  return {
    delayMs: Math.min(Math.max(retryAfterMs, backoffMs), opts.maxDelayMs),
    exceedsMaxDelay: false,
    source: retryAfterMs >= backoffMs ? 'retry-after' : 'backoff',
  };
}

/**
 * A sleep that an AbortSignal genuinely cancels — both the caller own
 * signal and the call timeout drive the SAME composed signal, so a timeout
 * that fires while the client is sitting in backoff ends the call
 * immediately instead of after the remaining delay. The timer is always
 * cleared and the listener always removed (no leaked timer, no leaked
 * listener) on every path.
 *
 * @param {number} delayMs
 * @param {AbortSignal} signal
 * @returns {Promise<'slept'|'aborted'>} — resolves rather than rejects, so
 *   the caller decides which error shape an abort-during-backoff becomes
 *   (it must be the same `client_timeout_or_abort` an abort during the HTTP
 *   leg produces, not a distinct third error type).
 */
export function sleepUnlessAborted(delayMs, signal) {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    let timer = null;
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer);
      resolve('aborted');
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve('slept');
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
