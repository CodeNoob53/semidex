import { performance } from 'node:perf_hooks';

// Instance-scoped per-key ROLLING TOKEN-SPEND tracker for the Integration
// API — the aggregate half of Ask's spend/token ceiling. Structurally a
// direct mirror of rate-limiter.js's own continuous token bucket (same
// clock-injection contract, same lazy no-timer sweep, same
// undefined-means-default/present-but-invalid-means-throw per-key override
// rule) with ONE deliberate generalization: rate-limiter.js always consumes
// exactly 1 unit per request (a REQUEST-COUNT ceiling); this tracker
// consumes a caller-supplied VARIABLE amount per reservation (a TOKEN-SPEND
// ceiling) and additionally supports release() — refunding tokens back into
// a key's bucket when a completed call's real usage turned out lower than
// its conservative worst-case reservation (see src/core/ask/budget-ledger.js,
// the per-REQUEST ledger that calls reserve()/release() on this tracker once
// per generation call).
//
// This module answers exactly one question: "does key K have `amount` tokens
// of headroom left in its rolling window right now?" It has no concept of an
// HTTP request, a provider, a generation call, or a multi-call Ask request —
// those live one layer up, in budget-ledger.js. Zero HTTP knowledge, exactly
// like rate-limiter.js.
//
// WINDOW SEMANTICS — explicit, since this is process-local state (see this
// module's own header note on MVP scope): a continuous token bucket with
// capacity `burstTokens` (the maximum a key may have reserved at once, i.e.
// the largest single burst of Ask activity a key can do with zero prior
// idle time) refilling continuously at `tokensPerHour / 3_600_000` tokens
// per millisecond (a smooth ROLLING window, not a fixed calendar-hour
// bucket that resets on the hour — a key that has been fully idle for one
// hour has exactly `min(capacity, tokensPerHour)` tokens available, same as
// rate-limiter.js's own rpm/burst model, just denominated in tokens and
// over an hour instead of a minute).
//
// PROCESS-LOCAL, NOT DURABLE (MVP scope — see docs/security/
// ask-spend-token-budget-design-2026-08.md "MVP limitations"): this state
// lives in an in-memory Map, exactly like rate-limiter.js's own buckets. It
// resets to full capacity on every process restart and is never shared
// across replicas/processes. This is a local-process guard against runaway
// per-key spend within one running instance, not a durable account quota or
// a billing system — do not present it as either.
export const DEFAULT_TOKEN_BUDGET_PER_HOUR = 200_000;
export const DEFAULT_TOKEN_BUDGET_BURST_TOKENS = 40_000;

// Conservative explicit maxima/minima, same "an operator's typo cannot hand
// a key an effectively unbounded ceiling" reasoning as
// rate-limiter.js's MIN/MAX_REQUESTS_PER_MINUTE/MIN/MAX_BURST.
export const MIN_TOKEN_BUDGET_PER_HOUR = 1_000;
export const MAX_TOKEN_BUDGET_PER_HOUR = 50_000_000;
export const MIN_TOKEN_BUDGET_BURST_TOKENS = 1_000;
export const MAX_TOKEN_BUDGET_BURST_TOKENS = 5_000_000;

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * True when `value` is a valid tokensPerHour/burstTokens value: a finite
 * integer within [min, max]. Mirrors rate-limiter.js's isValidLimitValue()
 * exactly (kept as a separate function, not a re-export, so this module has
 * zero import-time coupling to rate-limiter.js — the two ceilings are
 * conceptually independent and must remain independently constructible).
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 */
export function isValidTokenBudgetValue(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Resolves a single per-key override field against this tracker's own
 * default. `undefined` means "the caller/key didn't configure an override" —
 * falls back to `fallback` silently. Any OTHER invalid value (wrong type,
 * non-integer, out of range, including `null`) means malformed metadata
 * reached this call, and the fail-closed contract requires throwing rather
 * than quietly substituting a default the operator never configured — same
 * rule as rate-limiter.js's resolvePerKeyLimit(), and for the same reason:
 * key-store.js already resolves a stored `null` to a concrete default
 * before it ever reaches a principal (see key-store.js's buildPrincipal()),
 * so by the time a real request reaches this tracker, `limits.*` is either
 * a real validated number or genuinely absent.
 */
function resolvePerKeyLimit(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!isValidTokenBudgetValue(value, min, max)) {
    throw new TypeError(`token budget tracker reserve() received an invalid per-key ${label} (must be an integer in [${min}, ${max}]).`);
  }
  return value;
}

/**
 * Creates an instance-scoped token-budget tracker. No module-level mutable
 * state — two composition roots (or two servers in one process, e.g. two
 * tests) each construct their own tracker and never observe each other's
 * buckets, mirroring rate-limiter.js's/key-store.js's own instance-scoping
 * contract.
 *
 * @param {{
 *   tokensPerHour?: number, burstTokens?: number,
 *   now?: () => number,
 *   sweepIntervalMs?: number,
 * }} [opts]
 */
export function createTokenBudgetTracker({
  tokensPerHour = DEFAULT_TOKEN_BUDGET_PER_HOUR,
  burstTokens = DEFAULT_TOKEN_BUDGET_BURST_TOKENS,
  now = () => performance.now(),
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
} = {}) {
  if (!isValidTokenBudgetValue(tokensPerHour, MIN_TOKEN_BUDGET_PER_HOUR, MAX_TOKEN_BUDGET_PER_HOUR)) {
    throw new TypeError(`createTokenBudgetTracker tokensPerHour must be an integer in [${MIN_TOKEN_BUDGET_PER_HOUR}, ${MAX_TOKEN_BUDGET_PER_HOUR}].`);
  }
  if (!isValidTokenBudgetValue(burstTokens, MIN_TOKEN_BUDGET_BURST_TOKENS, MAX_TOKEN_BUDGET_BURST_TOKENS)) {
    throw new TypeError(`createTokenBudgetTracker burstTokens must be an integer in [${MIN_TOKEN_BUDGET_BURST_TOKENS}, ${MAX_TOKEN_BUDGET_BURST_TOKENS}].`);
  }

  function readNow() {
    const t = now();
    if (!Number.isFinite(t)) {
      throw new TypeError('token budget tracker clock (`now`) must return a finite number of milliseconds.');
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
    const idleThresholdMs = Math.ceil(capacity / refillPerMs);
    bucket = { tokens: capacity, capacity, refillPerMs, lastRefillMs: nowMs, lastAccessMs: nowMs, idleThresholdMs };
    buckets.set(key, bucket);
    return bucket;
  }

  function refill(bucket, nowMs) {
    const elapsed = nowMs - bucket.lastRefillMs;
    if (elapsed > 0) {
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
      bucket.lastRefillMs = nowMs;
    }
    bucket.lastAccessMs = nowMs;
  }

  function maybeSweep(nowMs) {
    if (nowMs - lastSweepMs >= sweepIntervalMs) {
      lastSweepMs = nowMs;
      sweep(nowMs);
    }
  }

  return {
    /**
     * Attempts to reserve `amount` tokens for `key`. `limits`, when given,
     * overrides this tracker's default tokensPerHour/burstTokens for THIS
     * key only — applied only the first time a bucket for this key is
     * created, exactly like rate-limiter.js's own per-key override
     * contract (a key's limits are fixed for its lifetime; there is no
     * `key edit` command).
     *
     * @param {string} key opaque identity — principal.keyId in production
     * @param {number} amount tokens to reserve (a conservative worst-case
     *   estimate: estimated input + the call's allowed max output — see
     *   budget-ledger.js)
     * @param {{ tokensPerHour?: number, burstTokens?: number }} [limits]
     * @returns {
     *   | { allowed: true, remaining: number }
     *   | { allowed: false, retryAfterMs: number, exceedsCapacity: false }
     *   | { allowed: false, retryAfterMs: null, exceedsCapacity: true }
     * }
     *   `exceedsCapacity: true` means `amount` alone is larger than this
     *   key's own configured burst ceiling — no amount of waiting would
     *   ever satisfy it (a PERMANENT denial for this reservation shape, not
     *   a transient one), reported distinctly so a caller never offers a
     *   misleading "try again in Ns" for a request that can never fit.
     */
    reserve(key, amount, limits = {}) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new TypeError('token budget tracker reserve() requires a non-empty string key.');
      }
      if (!Number.isFinite(amount) || amount < 0) {
        throw new TypeError('token budget tracker reserve() requires a finite, non-negative amount.');
      }

      const capacity = resolvePerKeyLimit(limits.burstTokens, burstTokens, MIN_TOKEN_BUDGET_BURST_TOKENS, MAX_TOKEN_BUDGET_BURST_TOKENS, 'burstTokens');
      const perHour = resolvePerKeyLimit(limits.tokensPerHour, tokensPerHour, MIN_TOKEN_BUDGET_PER_HOUR, MAX_TOKEN_BUDGET_PER_HOUR, 'tokensPerHour');
      const refillPerMs = perHour / 3_600_000;

      const nowMs = readNow();
      const bucket = bucketFor(key, capacity, refillPerMs, nowMs);
      refill(bucket, nowMs);
      maybeSweep(nowMs);

      if (amount > bucket.capacity) {
        return { allowed: false, retryAfterMs: null, exceedsCapacity: true };
      }
      if (bucket.tokens >= amount) {
        bucket.tokens -= amount;
        return { allowed: true, remaining: bucket.tokens };
      }
      const deficit = amount - bucket.tokens;
      return { allowed: false, retryAfterMs: deficit / bucket.refillPerMs, exceedsCapacity: false };
    },

    /**
     * Refunds `amount` tokens back into `key`'s bucket, capped at its own
     * capacity (never grants MORE headroom than the key's configured
     * ceiling, even if the refund would otherwise overflow it). A no-op for
     * a key with no active bucket (nothing was ever reserved for it, or its
     * bucket was already swept as idle) — there is nothing to refund into,
     * and creating a fresh full bucket here would be indistinguishable from
     * granting free, unearned headroom.
     * @param {string} key
     * @param {number} amount
     */
    release(key, amount) {
      if (typeof key !== 'string' || key.length === 0) return;
      if (!Number.isFinite(amount) || amount <= 0) return;
      const bucket = buckets.get(key);
      if (!bucket) return;
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + amount);
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
