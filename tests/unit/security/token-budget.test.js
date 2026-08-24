// Per-key aggregate TOKEN-SPEND tracker — src/core/auth/token-budget.js.
// Pure, no HTTP: a controlled fake clock only, mirroring
// rate-limiter.test.js's own structure and conventions exactly (this
// module is rate-limiter.js's variable-cost generalization — see its own
// header comment). All burstTokens values below stay >= MIN_TOKEN_BUDGET_
// BURST_TOKENS (1000) — this module's own explicit "no accidental
// unbounded key" minimum.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTokenBudgetTracker, isValidTokenBudgetValue,
  DEFAULT_TOKEN_BUDGET_PER_HOUR, DEFAULT_TOKEN_BUDGET_BURST_TOKENS,
  MIN_TOKEN_BUDGET_PER_HOUR, MAX_TOKEN_BUDGET_PER_HOUR, MIN_TOKEN_BUDGET_BURST_TOKENS, MAX_TOKEN_BUDGET_BURST_TOKENS,
} from '../../../src/core/auth/token-budget.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  return now;
}

describe('createTokenBudgetTracker — construction validation', () => {
  it('accepts the documented defaults', () => {
    assert.doesNotThrow(() => createTokenBudgetTracker());
  });

  it('rejects an out-of-range or non-integer tokensPerHour/burstTokens', () => {
    for (const tokensPerHour of [0, -1, 0.5, MAX_TOKEN_BUDGET_PER_HOUR + 1, NaN, 'lots']) {
      assert.throws(() => createTokenBudgetTracker({ tokensPerHour }), /tokensPerHour/);
    }
    for (const burstTokens of [0, -1, 0.5, MAX_TOKEN_BUDGET_BURST_TOKENS + 1, NaN, 'lots']) {
      assert.throws(() => createTokenBudgetTracker({ burstTokens }), /burstTokens/);
    }
  });

  it('accepts the exact min/max boundary values', () => {
    assert.doesNotThrow(() => createTokenBudgetTracker({ tokensPerHour: MIN_TOKEN_BUDGET_PER_HOUR, burstTokens: MIN_TOKEN_BUDGET_BURST_TOKENS }));
    assert.doesNotThrow(() => createTokenBudgetTracker({ tokensPerHour: MAX_TOKEN_BUDGET_PER_HOUR, burstTokens: MAX_TOKEN_BUDGET_BURST_TOKENS }));
  });
});

describe('isValidTokenBudgetValue', () => {
  it('validates integer range membership only', () => {
    assert.equal(isValidTokenBudgetValue(1000, 1000, 50000), true);
    assert.equal(isValidTokenBudgetValue(999, 1000, 50000), false);
    assert.equal(isValidTokenBudgetValue(50001, 1000, 50000), false);
    assert.equal(isValidTokenBudgetValue(1000.5, 1000, 50000), false);
    assert.equal(isValidTokenBudgetValue('1000', 1000, 50000), false);
    assert.equal(isValidTokenBudgetValue(NaN, 1000, 50000), false);
    assert.equal(isValidTokenBudgetValue(null, 1000, 50000), false);
    assert.equal(isValidTokenBudgetValue(undefined, 1000, 50000), false);
  });
});

describe('reserve() — burst capacity', () => {
  it('reserves down to zero remaining and denies a reservation that would go negative', () => {
    const now = fakeClock();
    const tracker = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1000, now });
    const a = tracker.reserve('k1', 600);
    assert.equal(a.allowed, true);
    assert.equal(a.remaining, 400);
    const b = tracker.reserve('k1', 500);
    assert.equal(b.allowed, false);
    assert.equal(b.exceedsCapacity, false);
    assert.ok(b.retryAfterMs > 0);
  });

  it('a single reservation larger than the key\'s own capacity is a PERMANENT denial (exceedsCapacity), not a wait', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const r = tracker.reserve('k1', 1001);
    assert.equal(r.allowed, false);
    assert.equal(r.exceedsCapacity, true);
    assert.equal(r.retryAfterMs, null);
  });
});

describe('reserve() — continuous refill at tokensPerHour/3_600_000 tokens/ms', () => {
  it('exact refill timing', () => {
    const now = fakeClock();
    // 3_600_000 tok/hour -> 1 tok/ms.
    const tracker = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1000, now });
    assert.equal(tracker.reserve('k', 1000).allowed, true);
    assert.equal(tracker.reserve('k', 1).allowed, false, 'bucket is empty immediately after');

    now.advance(1000); // +1000 tokens at 1 tok/ms
    const r = tracker.reserve('k', 1000);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 0);
  });

  it('refill never exceeds the configured burst capacity (no unbounded accrual while idle)', () => {
    const now = fakeClock();
    const tracker = createTokenBudgetTracker({ tokensPerHour: 3_600_000_0, burstTokens: 5000, now }); // huge rate
    now.advance(1_000_000); // would be far more than 5000 tokens without a cap
    const r = tracker.reserve('k', 5000);
    assert.equal(r.allowed, true, 'capped at capacity, still enough for exactly one 5000 reservation');
    assert.equal(tracker.reserve('k', 1).allowed, false, 'and nothing more — capped, not unbounded');
  });
});

describe('release() — refunds unused reservation back into the bucket, capped at capacity', () => {
  it('refunds are visible to a subsequent reserve()', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    assert.equal(tracker.reserve('k', 900).allowed, true);
    assert.equal(tracker.reserve('k', 200).allowed, false, 'only 100 remains');
    tracker.release('k', 300); // refund part of the original 900
    const r = tracker.reserve('k', 200);
    assert.equal(r.allowed, true, '100 + 300 refunded = 400 available, enough for 200');
  });

  it('never refunds beyond the key\'s own capacity', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    tracker.reserve('k', 100);
    tracker.release('k', 5000); // wildly over-refund
    // Still capped at 1000 total capacity, not 1000-100+5000.
    assert.equal(tracker.reserve('k', 1000).allowed, true);
    assert.equal(tracker.reserve('k', 1).allowed, false);
  });

  it('is a safe no-op for a key with no active bucket (never creates free headroom)', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    assert.doesNotThrow(() => tracker.release('never-reserved', 500));
    assert.equal(tracker.size(), 0, 'release() alone must never create a bucket');
  });

  it('ignores a non-finite or non-positive amount', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    tracker.reserve('k', 100);
    tracker.release('k', 0);
    tracker.release('k', -50);
    tracker.release('k', NaN);
    assert.equal(tracker.reserve('k', 900).allowed, true, 'still exactly 900 remaining — no phantom refund applied');
  });
});

describe('Per-key isolation — one key\'s consumption never affects another (task requirement #5, part 1)', () => {
  it('two keys in the same tracker have fully independent buckets', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    assert.equal(tracker.reserve('a', 1000).allowed, true);
    assert.equal(tracker.reserve('a', 1).allowed, false, 'a is now empty');
    assert.equal(tracker.reserve('b', 1000).allowed, true, 'b is unaffected by a\'s consumption');
  });
});

describe('Two tracker instances are fully independent (task requirement #5, part 2 — two composition roots)', () => {
  it('a tracker constructed for one app never observes another tracker\'s buckets, even for the SAME keyId', () => {
    const t1 = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const t2 = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    assert.equal(t1.reserve('same-key', 1000).allowed, true);
    assert.equal(t1.reserve('same-key', 1).allowed, false, 't1 is exhausted for this key');
    assert.equal(t2.reserve('same-key', 1000).allowed, true, 't2 has its own untouched bucket for the identical keyId');
  });
});

describe('Concurrent-reservation atomicity (task requirement #4) — two "requests" racing for the same remaining budget', () => {
  it('sequential synchronous reserve() calls (the only ordering possible in JS) never let two callers both get the last remaining tokens', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    // Simulates two concurrent request handlers both calling reserve() for
    // the same key before either has a chance to observe the other's
    // result — reserve() is fully synchronous (no `await` inside it), so
    // JS's single-threaded event loop makes this check-and-decrement
    // atomic by construction, exactly like rate-limiter.js's consume().
    const requestA = tracker.reserve('shared-key', 600);
    const requestB = tracker.reserve('shared-key', 600);
    const results = [requestA, requestB];
    const allowedCount = results.filter((r) => r.allowed).length;
    assert.equal(allowedCount, 1, 'only one of the two 600-token reservations can succeed against a 1000-token bucket');
    assert.equal(requestA.allowed, true, 'the first call to actually run wins — no interleaving is possible');
    assert.equal(requestB.allowed, false);
  });
});

describe('Per-key configured limits override the tracker default', () => {
  it('a key with a higher configured burst gets more headroom than the default', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1500, now: fakeClock() });
    const r = tracker.reserve('vip', 2000, { tokensPerHour: 1_000_000, burstTokens: 2000 });
    assert.equal(r.allowed, true, 'the per-key override (burst 2000) applies, not the tracker default (1500)');
  });

  it('an absent (undefined) per-key override falls back to the tracker default', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1300, now: fakeClock() });
    assert.equal(tracker.reserve('x', 1300, {}).allowed, true);
    assert.equal(tracker.reserve('x', 1, {}).allowed, false, 'falls back to the configured default burst of 1300');
  });

  it('a PRESENT but invalid per-key override throws rather than silently falling back (fail closed — legacy/malformed policy)', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1300, now: fakeClock() });
    assert.throws(() => tracker.reserve('bad', 10, { burstTokens: -1 }), /burstTokens/);
    assert.throws(() => tracker.reserve('bad', 10, { burstTokens: 0.5 }), /burstTokens/);
    assert.throws(() => tracker.reserve('bad', 10, { burstTokens: null }), /burstTokens/);
    assert.throws(() => tracker.reserve('bad', 10, { tokensPerHour: 'lots' }), /tokensPerHour/);
    assert.equal(tracker.size(), 0, 'a rejected reserve() must never create a bucket');
  });
});

describe('reserve()/release() input validation', () => {
  it('reserve() requires a non-empty string key', () => {
    const tracker = createTokenBudgetTracker({ now: fakeClock() });
    for (const bad of ['', null, undefined, 42, {}]) {
      assert.throws(() => tracker.reserve(bad, 10), TypeError);
    }
  });

  it('reserve() requires a finite, non-negative amount', () => {
    const tracker = createTokenBudgetTracker({ now: fakeClock() });
    for (const bad of [-1, NaN, Infinity, 'ten']) {
      assert.throws(() => tracker.reserve('k', bad), TypeError);
    }
  });

  it('reserve() accepts amount:0 (a call with zero estimated cost, e.g. an empty prompt with no output allowance)', () => {
    const tracker = createTokenBudgetTracker({ now: fakeClock() });
    assert.equal(tracker.reserve('k', 0).allowed, true);
  });
});

describe('Lazy stale cleanup — no timers, piggybacked on real reserve() calls', () => {
  it('an idle bucket is swept away once fully-refilled-and-idle, without ever registering a timer', () => {
    const now = fakeClock();
    const tracker = createTokenBudgetTracker({ tokensPerHour: 3_600_000, burstTokens: 1000, now, sweepIntervalMs: 1000 });
    tracker.reserve('a', 1000);
    assert.equal(tracker.size(), 1);
    now.advance(5000);
    tracker.reserve('b', 1);
    assert.equal(tracker.size(), 1, 'the idle "a" bucket was swept; only the just-created "b" bucket remains');
  });
});

describe('Clock — real monotonic performance.now() by default; non-finite injected clocks fail closed', () => {
  it('an injected clock returning NaN or +/-Infinity throws rather than corrupting bucket state', () => {
    for (const badValue of [NaN, Infinity, -Infinity]) {
      assert.throws(
        () => createTokenBudgetTracker({ now: () => badValue }),
        TypeError,
        `now() returning ${badValue} must fail closed`,
      );
    }
  });
});

describe('Legacy/absent per-key limits (task requirement #6) — mirrors rate-limiter.js\'s own documented policy', () => {
  it('undefined limits mean "use the tracker default", never "unlimited"', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 50_000, burstTokens: 1200, now: fakeClock() });
    // A legacy key with neither tokenBudgetPerHour nor tokenBudgetBurst
    // stored resolves (in key-store.js's buildPrincipal) to the DEFAULT
    // numeric values before ever reaching this tracker — this test proves
    // the tracker's OWN half of that contract: an absent override is a
    // real, finite, protective default, not an unbounded pass-through.
    const r = tracker.reserve('legacy', 1200, {});
    assert.equal(r.allowed, true);
    assert.equal(tracker.reserve('legacy', 1, {}).allowed, false, 'the default ceiling (1200) is real and enforced, not infinite');
  });
});
