import { performance } from 'node:perf_hooks';

// Instance-scoped per-key token-bucket rate limiter for the Integration API.
//
// Zero HTTP knowledge: this module tracks buckets keyed by an opaque string
// (the caller passes principal.keyId) and answers "may this key consume one
// more request right now?". The stage that WIRES it into the request path
// lives in src/core/auth/integration-policy.js (checkRateLimit); the router
// seam that invokes that stage lives in src/shared/admin/router.js. See
// docs/security/integration-api-auth-design-note.md for the full contract.
//
// ALGORITHM — token bucket, O(1) per consume() call
// --------------------------------------------------
// Each key gets a bucket holding up to `burst` tokens, refilling continuously
// at `requestsPerMinute / 60000` tokens per millisecond. consume() refills
// the bucket for the elapsed time since its last touch (simple arithmetic,
// no per-millisecond ticking), then takes one token if available. This is
// the standard continuous token-bucket formulation — no timers, no
// setInterval, no per-request O(n) scan of other keys' buckets.
//
// CLOCK INJECTION
// ----------------
// `now` is a monotonic-ms clock, injectable so tests can control elapsed
// time exactly (real burst/refill/rounding assertions) without sleeping.
// Production passes no override, which defaults to node:perf_hooks'
// performance.now() — a genuine monotonic clock immune to wall-clock jumps
// (NTP steps, manual clock changes, DST), unlike Date.now(). This matters
// here specifically: a backward wall-clock jump can postpone refill until
// wall time catches up, while a forward jump can refill a bucket too early.
// A monotonic source avoids both distortions.
//
// LAZY STALE CLEANUP — no timers
// --------------------------------
// A bucket for a key that stops sending requests would otherwise live in
// the Map forever. Rather than a setInterval sweep (a background timer this
// module deliberately avoids — see the design note's own "no timers"
// requirement, which keeps this primitive safe to construct in a test
// without leaking a handle that keeps the process alive), cleanup piggy-
// backs on real consume() calls: every call checks whether the configured
// sweep interval has elapsed since the last sweep, and if so, removes every
// bucket that has been idle long enough to be guaranteed fully refilled
// (idle time >= its own time-to-fill-from-empty). Removing a bucket in that
// state and recreating it fresh on the next request is behaviorally
// IDENTICAL to leaving it in place — a fully-refilled idle bucket and a
// freshly-created one both start at `capacity` tokens — so no accuracy is
// lost, only memory.
export const DEFAULT_REQUESTS_PER_MINUTE = 30;
export const DEFAULT_BURST = 5;

// Conservative explicit maxima for the `key add --requests-per-minute/--burst`
// CLI flags (see key-cli.js). These exist so an operator's typo (an extra
// zero, a swapped flag value) cannot silently hand a single key an
// effectively unbounded rate — the "unrestricted must always be explicit,
// never accidental" principle already applied to key scopes
// (key-store.js's collections/operations validation) extends here. 6000/min
// (100 req/s) and a burst of 1000 are generous enough for any legitimate
// single-backend integration while still being a real, finite ceiling.
export const MAX_REQUESTS_PER_MINUTE = 6000;
export const MAX_BURST = 1000;
export const MIN_REQUESTS_PER_MINUTE = 1;
export const MIN_BURST = 1;

/** Sweep runs at most once per this many milliseconds of elapsed wall time. */
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * True when `value` is a valid requestsPerMinute/burst value: a finite
 * integer within [min, max]. Shared by key-store.js (persisted record
 * validation) and key-cli.js (flag validation) so the two never drift.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 */
export function isValidLimitValue(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Resolves a single per-key override field (`limits.burst` or
 * `limits.requestsPerMinute`) against this limiter's own default.
 *
 * `undefined` means "the caller didn't supply an override" — a legacy key
 * with no configured limit — and falls back to `fallback` silently. Any
 * OTHER invalid value (wrong type, non-integer, out of range — including
 * `null`) means malformed metadata reached this call, and the fail-closed
 * contract requires throwing rather than quietly substituting a default the
 * operator never configured.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {string} label
 */
function resolvePerKeyLimit(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!isValidLimitValue(value, min, max)) {
    throw new TypeError(`rate limiter consume() received an invalid per-key ${label} (must be an integer in [${min}, ${max}]).`);
  }
  return value;
}

/**
 * Creates an instance-scoped rate limiter. No module-level mutable state —
 * two composition roots (or two servers in one process) each construct
 * their own limiter and never observe each other's buckets, mirroring
 * key-store.js's own instance-scoping contract.
 *
 * @param {{
 *   requestsPerMinute?: number, burst?: number,
 *   now?: () => number,
 *   sweepIntervalMs?: number,
 * }} [opts]
 */
export function createRateLimiter({
  requestsPerMinute = DEFAULT_REQUESTS_PER_MINUTE,
  burst = DEFAULT_BURST,
  now = () => performance.now(),
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
} = {}) {
  if (!isValidLimitValue(requestsPerMinute, MIN_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_MINUTE)) {
    throw new TypeError(`createRateLimiter requestsPerMinute must be an integer in [${MIN_REQUESTS_PER_MINUTE}, ${MAX_REQUESTS_PER_MINUTE}].`);
  }
  if (!isValidLimitValue(burst, MIN_BURST, MAX_BURST)) {
    throw new TypeError(`createRateLimiter burst must be an integer in [${MIN_BURST}, ${MAX_BURST}].`);
  }

  // Wraps every read of the injected clock: a clock that returns a
  // non-finite value (NaN, +/-Infinity — a broken fake in a test, or a
  // production clock source going wrong) would corrupt bucket arithmetic
  // and produce invalid retry timing. Reject it before any bucket state is
  // created or changed so the policy fails closed with a controlled error.
  function readNow() {
    const t = now();
    if (!Number.isFinite(t)) {
      throw new TypeError('rate limiter clock (`now`) must return a finite number of milliseconds.');
    }
    return t;
  }

  /** @type {Map<string, { tokens: number, capacity: number, refillPerMs: number, lastRefillMs: number, lastAccessMs: number, idleThresholdMs: number }>} */
  const buckets = new Map();
  let lastSweepMs = readNow();

  function sweep(nowMs) {
    for (const [key, bucket] of buckets) {
      if (nowMs - bucket.lastAccessMs >= bucket.idleThresholdMs) buckets.delete(key);
    }
  }

  function bucketFor(key, capacity, refillPerMs, nowMs) {
    let bucket = buckets.get(key);
    if (bucket) return bucket;
    // Time to go from empty to full at this bucket's own refill rate — once
    // a bucket has been idle at least this long it is guaranteed fully
    // refilled, so dropping it and recreating fresh on the next request is
    // indistinguishable from keeping it around.
    const idleThresholdMs = Math.ceil(capacity / refillPerMs);
    bucket = { tokens: capacity, capacity, refillPerMs, lastRefillMs: nowMs, lastAccessMs: nowMs, idleThresholdMs };
    buckets.set(key, bucket);
    return bucket;
  }

  return {
    /**
     * Attempts to consume one token for `key`. `limits`, when given,
     * overrides this limiter's default requestsPerMinute/burst for THIS
     * key only (a per-key configured limit from the key store) — applied
     * only the first time a bucket for this key is created; a key's limits
     * are fixed for the life of the key (there is no `key edit` command),
     * so this never needs to reconcile a changed limit against an
     * in-flight bucket.
     *
     * @param {string} key opaque identity — principal.keyId in production
     * @param {{ requestsPerMinute?: number, burst?: number }} [limits]
     * @returns {{ allowed: true, remaining: number } | { allowed: false, retryAfterMs: number }}
     */
    consume(key, limits = {}) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('rate limiter consume() requires a non-empty string key.');
      }
      // Absent (undefined) per-key limits fall back to this limiter's own
      // defaults — that is the documented "legacy key" behavior. A PRESENT
      // but invalid value (out of range, wrong type, non-integer) is
      // different: it means the caller's metadata is malformed, and the
      // fail-closed contract requires that to throw rather than silently
      // substitute a default the operator never configured.
      const capacity = resolvePerKeyLimit(limits.burst, burst, MIN_BURST, MAX_BURST, 'burst');
      const rpm = resolvePerKeyLimit(limits.requestsPerMinute, requestsPerMinute, MIN_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_MINUTE, 'requestsPerMinute');
      const refillPerMs = rpm / 60_000;

      const nowMs = readNow();
      const bucket = bucketFor(key, capacity, refillPerMs, nowMs);

      const elapsed = nowMs - bucket.lastRefillMs;
      if (elapsed > 0) {
        bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
        bucket.lastRefillMs = nowMs;
      }
      bucket.lastAccessMs = nowMs;

      // Lazy sweep: piggybacks on a real call, never a background timer.
      if (nowMs - lastSweepMs >= sweepIntervalMs) {
        lastSweepMs = nowMs;
        sweep(nowMs);
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, remaining: bucket.tokens };
      }
      const deficit = 1 - bucket.tokens;
      return { allowed: false, retryAfterMs: deficit / bucket.refillPerMs };
    },

    /** Test/diagnostic hook: number of buckets currently tracked. */
    size() {
      return buckets.size;
    },

    /** Test/diagnostic hook: force a sweep now, bypassing the interval gate. */
    sweepNow() {
      sweep(readNow());
    },
  };
}

/**
 * Builds the { ok: false, ... } decision shape for a denied request, with an
 * integer, rounded-UP Retry-After (a client that waits exactly this long is
 * guaranteed at least one token, never almost-enough). Exported so the
 * router seam and tests share one rounding rule rather than each computing
 * it independently.
 * @param {number} retryAfterMs
 */
export function rateLimitedDecision(retryAfterMs) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return {
    ok: false,
    status: 429,
    code: 'rate_limited',
    message: 'Too many requests. Slow down and retry after the indicated delay.',
    retryAfterSeconds,
  };
}
