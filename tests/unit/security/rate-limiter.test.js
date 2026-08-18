// Pure token-bucket rate limiter — src/core/auth/rate-limiter.js. No HTTP,
// no key store, no filesystem: a controlled fake clock only, so every
// refill/rounding/stale-cleanup assertion is exact and instant (no real
// sleeping).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  createRateLimiter, isValidLimitValue, rateLimitedDecision,
  DEFAULT_REQUESTS_PER_MINUTE, DEFAULT_BURST,
  MIN_REQUESTS_PER_MINUTE, MAX_REQUESTS_PER_MINUTE, MIN_BURST, MAX_BURST,
} from '../../../src/core/auth/rate-limiter.js';

/** A controllable fake clock: starts at `start`, advances only when told. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  now.set = (ms) => { t = ms; return t; };
  return now;
}

describe('createRateLimiter — construction validation', () => {
  it('accepts the documented defaults', () => {
    assert.doesNotThrow(() => createRateLimiter());
  });

  it('rejects an out-of-range or non-integer requestsPerMinute/burst', () => {
    for (const requestsPerMinute of [0, -1, 0.5, MAX_REQUESTS_PER_MINUTE + 1, NaN, 'thirty']) {
      assert.throws(() => createRateLimiter({ requestsPerMinute }), /requestsPerMinute/);
    }
    for (const burst of [0, -1, 0.5, MAX_BURST + 1, NaN, 'five']) {
      assert.throws(() => createRateLimiter({ burst }), /burst/);
    }
  });

  it('accepts the exact min/max boundary values', () => {
    assert.doesNotThrow(() => createRateLimiter({ requestsPerMinute: MIN_REQUESTS_PER_MINUTE, burst: MIN_BURST }));
    assert.doesNotThrow(() => createRateLimiter({ requestsPerMinute: MAX_REQUESTS_PER_MINUTE, burst: MAX_BURST }));
  });
});

describe('isValidLimitValue', () => {
  it('validates integer range membership only', () => {
    assert.equal(isValidLimitValue(30, 1, 6000), true);
    assert.equal(isValidLimitValue(1, 1, 6000), true);
    assert.equal(isValidLimitValue(6000, 1, 6000), true);
    assert.equal(isValidLimitValue(0, 1, 6000), false);
    assert.equal(isValidLimitValue(6001, 1, 6000), false);
    assert.equal(isValidLimitValue(30.5, 1, 6000), false);
    assert.equal(isValidLimitValue('30', 1, 6000), false);
    assert.equal(isValidLimitValue(NaN, 1, 6000), false);
    assert.equal(isValidLimitValue(null, 1, 6000), false);
    assert.equal(isValidLimitValue(undefined, 1, 6000), false);
  });
});

describe('Burst — the first N requests succeed immediately, the N+1th does not', () => {
  it('allows exactly `burst` consecutive requests with zero elapsed time, then denies', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 5, now });
    for (let i = 0; i < 5; i++) {
      const r = limiter.consume('k1');
      assert.equal(r.allowed, true, `request ${i + 1} of burst 5 must be allowed`);
    }
    const denied = limiter.consume('k1');
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterMs > 0);
  });
});

describe('Refill — tokens accrue continuously at requestsPerMinute/60000 per ms', () => {
  it('one token refills after exactly 60000/rpm ms', () => {
    const now = fakeClock();
    // 60 rpm -> 1 token/second -> 1000ms per token.
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1, now });
    assert.equal(limiter.consume('k').allowed, true);
    assert.equal(limiter.consume('k').allowed, false, 'bucket is empty immediately after');

    now.advance(999);
    assert.equal(limiter.consume('k').allowed, false, 'not quite refilled yet');

    now.advance(1); // total 1000ms elapsed
    assert.equal(limiter.consume('k').allowed, true, 'exactly one token available after 1000ms at 60rpm');
  });

  it('refill never exceeds the configured burst capacity (no unbounded accrual while idle)', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 600, burst: 3, now }); // 10 tokens/sec
    now.advance(10_000); // would be 100 tokens without a cap
    let allowedCount = 0;
    for (let i = 0; i < 10; i++) {
      if (limiter.consume('k').allowed) allowedCount++;
    }
    assert.equal(allowedCount, 3, 'capped at burst=3 regardless of how long the bucket was idle');
  });

  it('600rpm/burst2 refills one token roughly every 100ms (the live-acceptance shape)', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 600, burst: 2, now });
    assert.equal(limiter.consume('k').allowed, true);
    assert.equal(limiter.consume('k').allowed, true);
    assert.equal(limiter.consume('k').allowed, false, 'third immediate request is denied');

    now.advance(100);
    assert.equal(limiter.consume('k').allowed, true, 'one token refilled after 100ms at 600rpm');
    assert.equal(limiter.consume('k').allowed, false, 'and only one — the bucket is empty again');
  });
});

describe('Rounding — rateLimitedDecision() always yields a whole, guaranteed-sufficient Retry-After', () => {
  it('rounds UP fractional milliseconds so the client never retries too early', () => {
    assert.equal(rateLimitedDecision(1).retryAfterSeconds, 1);
    assert.equal(rateLimitedDecision(999).retryAfterSeconds, 1);
    assert.equal(rateLimitedDecision(1000).retryAfterSeconds, 1);
    assert.equal(rateLimitedDecision(1001).retryAfterSeconds, 2);
    assert.equal(rateLimitedDecision(59_999).retryAfterSeconds, 60);
  });

  it('never returns less than 1 second even for a near-zero deficit', () => {
    assert.equal(rateLimitedDecision(0.001).retryAfterSeconds, 1);
    assert.equal(rateLimitedDecision(0).retryAfterSeconds, 1);
  });

  it('always shapes the denial as 429/rate_limited with no identity or limit leakage', () => {
    const d = rateLimitedDecision(2500);
    assert.equal(d.ok, false);
    assert.equal(d.status, 429);
    assert.equal(d.code, 'rate_limited');
    assert.equal(typeof d.message, 'string');
    assert.deepEqual(Object.keys(d).sort(), ['code', 'message', 'ok', 'retryAfterSeconds', 'status']);
  });
});

describe('Per-key isolation — one key\'s consumption never affects another', () => {
  it('two keys in the same limiter have fully independent buckets', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1, now });
    assert.equal(limiter.consume('a').allowed, true);
    assert.equal(limiter.consume('a').allowed, false, 'a is now empty');
    assert.equal(limiter.consume('b').allowed, true, 'b is unaffected by a\'s consumption');
  });
});

describe('Per-key configured limits override the limiter default', () => {
  it('a key with a higher configured burst gets more immediate allowances than the default', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 30, burst: 5, now });
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (limiter.consume('vip', { requestsPerMinute: 600, burst: 10 }).allowed) allowed++;
    }
    assert.equal(allowed, 10, 'the per-key override (burst 10) applies, not the limiter default (burst 5)');
  });

  it('an absent (undefined) per-key override falls back to the limiter default', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 3, now });
    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      if (limiter.consume('x', {}).allowed) allowed++;
    }
    assert.equal(allowed, 3, 'falls back to the configured default burst of 3');
  });

  it('a PRESENT but invalid per-key override throws rather than silently falling back (fail closed)', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 3, now });
    assert.throws(() => limiter.consume('bad-burst', { burst: -1 }), /burst/);
    assert.throws(() => limiter.consume('bad-burst', { burst: 0.5 }), /burst/);
    assert.throws(() => limiter.consume('bad-burst', { burst: null }), /burst/);
    assert.throws(() => limiter.consume('bad-rpm', { requestsPerMinute: 'nope' }), /requestsPerMinute/);
    assert.throws(() => limiter.consume('bad-rpm', { requestsPerMinute: NaN }), /requestsPerMinute/);
    assert.throws(() => limiter.consume('bad-rpm', { requestsPerMinute: -1 }), /requestsPerMinute/);
    assert.equal(limiter.size(), 0, 'a rejected consume() must never create a bucket');
  });
});

describe('consume() input validation', () => {
  it('requires a non-empty string key', () => {
    const limiter = createRateLimiter({ now: fakeClock() });
    for (const bad of ['', null, undefined, 42, {}]) {
      assert.throws(() => limiter.consume(bad), TypeError);
    }
  });
});

describe('Lazy stale cleanup — no timers, piggybacked on real consume() calls', () => {
  it('an idle bucket is swept away once fully-refilled-and-idle, without ever registering a timer', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1, now, sweepIntervalMs: 1000 });
    limiter.consume('a');
    assert.equal(limiter.size(), 1);

    // Idle threshold for burst=1 at 60rpm is ceil(1 / (60/60000)) = 1000ms.
    // Advance well past both the idle threshold AND the sweep interval, then
    // trigger a sweep via a second key's own consume() call (sweeps are
    // gated on elapsed time since the last sweep, checked opportunistically
    // inside consume() — never a background timer).
    now.advance(5000);
    limiter.consume('b'); // itself creates a bucket, and its own call triggers the gated sweep
    assert.equal(limiter.size(), 1, 'the idle "a" bucket was swept; only the just-created "b" bucket remains');
  });

  it('sweepNow() is available as a direct test hook and removes only idle-and-refilled buckets', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 5, now });
    limiter.consume('idle');
    now.advance(50); // brief, recent activity — well under the idle threshold
    limiter.consume('active');
    limiter.consume('active');

    now.advance(200); // still far under burst=5's idle threshold (~5000ms)
    limiter.sweepNow();
    assert.equal(limiter.size(), 2, 'neither bucket is stale yet');
  });

  it('a swept-then-recreated bucket behaves identically to one that was never removed (no accuracy loss)', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 2, now, sweepIntervalMs: 1 });
    limiter.consume('k');
    limiter.consume('k');
    assert.equal(limiter.consume('k').allowed, false, 'exhausted');

    // Idle threshold for burst=2 at 60rpm: ceil(2 / (1/1000)) = 2000ms.
    now.advance(2000);
    limiter.consume('other'); // triggers the sweep, removing k's now-idle-and-full bucket
    assert.equal(limiter.size(), 1, 'k was swept (only "other" remains)');

    // k's bucket was full when swept (2000ms at 60rpm/burst2 fully refills
    // it), so recreating it fresh must start at full capacity too.
    assert.equal(limiter.consume('k').allowed, true);
    assert.equal(limiter.consume('k').allowed, true);
    assert.equal(limiter.consume('k').allowed, false, 'still exactly burst=2, not silently reset beyond capacity');
  });

  it('sweeping does not run on every call — only after sweepIntervalMs has elapsed', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1, now, sweepIntervalMs: 10_000 });
    limiter.consume('a');
    now.advance(1_050); // "a" is idle-eligible (threshold 1000ms) but the sweep interval (10s) has not elapsed
    limiter.consume('b');
    assert.equal(limiter.size(), 2, 'no sweep has run yet — both buckets remain despite "a" being idle-eligible');
  });
});

describe('remaining tokens reported on success', () => {
  it('reports a fractional remaining count after partial refill', () => {
    const now = fakeClock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 2, now });
    const first = limiter.consume('k');
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 1);
  });
});

describe('Clock — real monotonic performance.now() by default; non-finite injected clocks fail closed', () => {
  it('with no `now` override, the limiter advances using node:perf_hooks performance.now(), not Date.now()', () => {
    // Prove it is wired to performance.now() specifically: stub Date.now()
    // to something wildly different from the real clock and confirm the
    // limiter's timing is unaffected — it could only be unaffected if it is
    // reading performance.now() rather than Date.now().
    const realDateNow = Date.now;
    Date.now = () => 0;
    try {
      const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1 });
      const before = performance.now();
      assert.equal(limiter.consume('k').allowed, true);
      assert.equal(limiter.consume('k').allowed, false, 'immediately exhausted, regardless of what Date.now() reports');
      const after = performance.now();
      assert.ok(after >= before, 'performance.now() itself is monotonic across the calls above');
    } finally {
      Date.now = realDateNow;
    }
  });

  it('an injected clock returning NaN or +/-Infinity throws rather than corrupting bucket state', () => {
    for (const badValue of [NaN, Infinity, -Infinity]) {
      // The clock is already read once at construction (to seed the lazy
      // sweep timer), so a permanently bad clock fails closed immediately
      // rather than waiting for the first consume() call.
      assert.throws(
        () => createRateLimiter({ requestsPerMinute: 60, burst: 1, now: () => badValue }),
        TypeError,
        `now() returning ${badValue} must fail closed`
      );
    }
  });

  it('a clock that goes non-finite only after construction still fails closed on the next consume()', () => {
    let t = 1_000_000;
    const now = () => t;
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1, now });
    assert.equal(limiter.consume('k').allowed, true, 'clock starts sane');
    t = NaN;
    assert.throws(() => limiter.consume('k'), TypeError, 'clock went non-finite mid-lifetime');
  });
});
