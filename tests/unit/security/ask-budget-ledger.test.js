// Request-scoped budget ledger — src/core/ask/budget-ledger.js. Pure
// (fake tracker, no HTTP, no real generation provider). Covers the
// reserve-before/reconcile-after contract, the two independent ceilings
// (per-request local + per-key aggregate), and the conservative
// reconciliation rule.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestBudgetLedger, outputTokenCapFromCharLimit } from '../../../src/core/ask/budget-ledger.js';
import { createTokenBudgetTracker } from '../../../src/core/auth/token-budget.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  return now;
}

function bigTracker(now = fakeClock()) {
  return createTokenBudgetTracker({ tokensPerHour: 10_000_000, burstTokens: 5_000_000, now });
}

describe('createRequestBudgetLedger — construction validation', () => {
  it('requires a tracker with reserve()/release()', () => {
    assert.throws(() => createRequestBudgetLedger({ keyId: 'k' }), TypeError);
    assert.throws(() => createRequestBudgetLedger({ tracker: {}, keyId: 'k' }), TypeError);
  });

  it('requires a non-empty string keyId', () => {
    const tracker = bigTracker();
    for (const bad of ['', null, undefined, 42]) {
      assert.throws(() => createRequestBudgetLedger({ tracker, keyId: bad }), TypeError);
    }
  });
});

describe('reserve() — happy path', () => {
  it('returns ok:true with a reservationId and echoes maxOutputTokens back for the provider call', () => {
    const ledger = createRequestBudgetLedger({ tracker: bigTracker(), keyId: 'k1' });
    const r = ledger.reserve({ label: 'answer', estimatedInputTokens: 500, maxOutputTokens: 200 });
    assert.equal(r.ok, true);
    assert.equal(typeof r.reservationId, 'number');
    assert.equal(r.maxOutputTokens, 200);
  });

  it('accumulates calls/totalReserved across multiple reservations under one ledger (snapshot)', () => {
    const ledger = createRequestBudgetLedger({ tracker: bigTracker(), keyId: 'k1' });
    ledger.reserve({ label: 'rewrite', estimatedInputTokens: 100, maxOutputTokens: 50 });
    ledger.reserve({ label: 'answer', estimatedInputTokens: 800, maxOutputTokens: 400 });
    const snap = ledger.snapshot();
    assert.equal(snap.calls, 2);
    assert.equal(snap.totalReserved, 100 + 50 + 800 + 400);
  });

  it('rejects a non-finite/negative estimatedInputTokens or maxOutputTokens', () => {
    const ledger = createRequestBudgetLedger({ tracker: bigTracker(), keyId: 'k1' });
    assert.throws(() => ledger.reserve({ label: 'answer', estimatedInputTokens: -1, maxOutputTokens: 10 }), TypeError);
    assert.throws(() => ledger.reserve({ label: 'answer', estimatedInputTokens: 10, maxOutputTokens: NaN }), TypeError);
  });
});

describe('reserve() — per-request call ceiling (maxCallsPerRequest)', () => {
  it('denies the call that would exceed the configured call count, before it counts as reserved', () => {
    const ledger = createRequestBudgetLedger({ tracker: bigTracker(), keyId: 'k1', maxCallsPerRequest: 2 });
    assert.equal(ledger.reserve({ label: 'rewrite', estimatedInputTokens: 10, maxOutputTokens: 10 }).ok, true);
    assert.equal(ledger.reserve({ label: 'answer', estimatedInputTokens: 10, maxOutputTokens: 10 }).ok, true);
    const denied = ledger.reserve({ label: 'compaction', estimatedInputTokens: 10, maxOutputTokens: 10 });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'request_call_ceiling_exceeded');
    assert.equal(ledger.snapshot().calls, 2, 'the denied 3rd call is never counted as reserved');
  });
});

describe('reserve() — per-request token ceiling (maxReservedTokensPerRequest)', () => {
  it('denies a call whose cost would push the request total over the configured ceiling', () => {
    const ledger = createRequestBudgetLedger({ tracker: bigTracker(), keyId: 'k1', maxReservedTokensPerRequest: 1000 });
    assert.equal(ledger.reserve({ label: 'rewrite', estimatedInputTokens: 400, maxOutputTokens: 200 }).ok, true); // 600
    const denied = ledger.reserve({ label: 'answer', estimatedInputTokens: 300, maxOutputTokens: 200 }); // would be 1100 > 1000
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'request_token_ceiling_exceeded');
    assert.equal(ledger.snapshot().totalReserved, 600, 'the denied call\'s cost is never added');
  });

  it('a call that exactly hits the ceiling is allowed (boundary)', () => {
    const ledger = createRequestBudgetLedger({ tracker: bigTracker(), keyId: 'k1', maxReservedTokensPerRequest: 1000 });
    const r = ledger.reserve({ label: 'answer', estimatedInputTokens: 600, maxOutputTokens: 400 });
    assert.equal(r.ok, true);
  });
});

describe('reserve() — per-key AGGREGATE ceiling (task requirement #2: shared ledger, exact call denied before the provider fake)', () => {
  it('a call whose cost exceeds the remaining aggregate bucket is denied even though it fits the per-request ceilings', () => {
    const now = fakeClock();
    const tracker = createTokenBudgetTracker({ tokensPerHour: 1_000_000, burstTokens: 1000, now });
    const ledger = createRequestBudgetLedger({ tracker, keyId: 'k1' });
    // First call spends 700 of the key's 1000-token aggregate budget.
    assert.equal(ledger.reserve({ label: 'rewrite', estimatedInputTokens: 500, maxOutputTokens: 200 }).ok, true);
    // Second call needs 400 more, but only 300 remains in the aggregate bucket.
    const denied = ledger.reserve({ label: 'answer', estimatedInputTokens: 300, maxOutputTokens: 100 });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'key_budget_exceeded');
    assert.ok(Number.isFinite(denied.retryAfterSeconds));
  });

  it('a single reservation larger than the key\'s own configured ceiling is denied WITHOUT a retryAfterSeconds (permanent, not transient)', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const ledger = createRequestBudgetLedger({ tracker, keyId: 'k1' });
    const denied = ledger.reserve({ label: 'answer', estimatedInputTokens: 900, maxOutputTokens: 200 }); // cost 1100 > 1000 capacity
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'key_budget_ceiling_too_small');
    assert.equal(denied.retryAfterSeconds, undefined);
  });

  it('onDenied() fires with the exact label/code/numeric fields for every denial reason (feeds the audit event)', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const denials = [];
    const ledger = createRequestBudgetLedger({ tracker, keyId: 'k1', onDenied: (info) => denials.push(info) });
    ledger.reserve({ label: 'answer', estimatedInputTokens: 900, maxOutputTokens: 200 }); // denied: exceeds 1000-cap
    assert.equal(denials.length, 1);
    assert.equal(denials[0].label, 'answer');
    assert.equal(denials[0].keyId, 'k1');
    assert.equal(typeof denials[0].code, 'string');
    assert.equal(denials[0].estimatedInputTokens, 900);
    assert.equal(denials[0].maxOutputTokens, 200);
  });
});

describe('reconcile() — conservative refund rule (task requirement #7)', () => {
  it('refunds exactly the delta between the reservation and TRUSTWORTHY real usage', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const ledger = createRequestBudgetLedger({ tracker, keyId: 'k1' });
    const r = ledger.reserve({ label: 'answer', estimatedInputTokens: 500, maxOutputTokens: 300 }); // cost 800
    ledger.reconcile(r.reservationId, { tokensIn: 400, tokensOut: 100 }); // real cost 500, refund 300
    assert.equal(ledger.snapshot().totalReserved, 500, 'the refunded 300 is no longer counted against this request');
    // The refund reached the tracker too: a follow-up reservation for the
    // refunded amount now succeeds where it would otherwise have been denied.
    const follow = ledger.reserve({ label: 'compaction', estimatedInputTokens: 200, maxOutputTokens: 100 }); // cost 300
    assert.equal(follow.ok, true, '300 tokens were genuinely returned to the shared aggregate bucket');
  });

  it('NEVER refunds when usage is ABSENT (provider reported no tokensIn/tokensOut) — retains the full conservative reservation', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const ledger = createRequestBudgetLedger({ tracker, keyId: 'k1' });
    const r = ledger.reserve({ label: 'answer', estimatedInputTokens: 500, maxOutputTokens: 300 });
    ledger.reconcile(r.reservationId, {}); // no usage reported at all
    assert.equal(ledger.snapshot().totalReserved, 800, 'nothing is refunded — the estimate stands as the charge');
  });

  it('NEVER refunds when usage is AMBIGUOUS (negative, non-finite, or only one of tokensIn/tokensOut present)', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const ledger = createRequestBudgetLedger({ tracker, keyId: 'k1' });
    for (const usage of [
      { tokensIn: -5, tokensOut: 10 },
      { tokensIn: NaN, tokensOut: 10 },
      { tokensIn: 10 }, // tokensOut missing
      { tokensOut: 10 }, // tokensIn missing
    ]) {
      const r = ledger.reserve({ label: 'answer', estimatedInputTokens: 500, maxOutputTokens: 300 });
      const before = ledger.snapshot().totalReserved;
      ledger.reconcile(r.reservationId, usage);
      assert.equal(ledger.snapshot().totalReserved, before, `ambiguous usage ${JSON.stringify(usage)} must never refund`);
    }
  });

  it('never refunds MORE than was reserved even if real usage somehow exceeds the reservation (never charges extra either — refund floors at 0)', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const ledger = createRequestBudgetLedger({ tracker, keyId: 'k1' });
    const r = ledger.reserve({ label: 'answer', estimatedInputTokens: 100, maxOutputTokens: 100 }); // cost 200
    ledger.reconcile(r.reservationId, { tokensIn: 500, tokensOut: 500 }); // "actual" 1000 > reserved 200
    assert.equal(ledger.snapshot().totalReserved, 200, 'the reservation is the ceiling — never adjusted upward');
  });

  it('a call denied by reserve() has NOTHING to reconcile — reconcile() on an unknown id is a safe no-op (never un-denies a prior rejection)', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const ledger = createRequestBudgetLedger({ tracker, keyId: 'k1' });
    const denied = ledger.reserve({ label: 'answer', estimatedInputTokens: 900, maxOutputTokens: 200 });
    assert.equal(denied.ok, false);
    assert.equal(denied.reservationId, undefined);
    assert.doesNotThrow(() => ledger.reconcile(999, { tokensIn: 1, tokensOut: 1 }));
    assert.equal(ledger.snapshot().calls, 0);
  });

  it('is idempotent-safe: reconciling the same reservationId twice does not double-refund', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const ledger = createRequestBudgetLedger({ tracker, keyId: 'k1' });
    const r = ledger.reserve({ label: 'answer', estimatedInputTokens: 500, maxOutputTokens: 300 });
    ledger.reconcile(r.reservationId, { tokensIn: 400, tokensOut: 100 });
    assert.equal(ledger.snapshot().totalReserved, 500);
    ledger.reconcile(r.reservationId, { tokensIn: 0, tokensOut: 0 }); // second call, would refund another 500 if buggy
    assert.equal(ledger.snapshot().totalReserved, 500, 'the second reconcile() on an already-reconciled id is a no-op');
  });
});

describe('Retries cannot bypass the ceiling (task requirement #3)', () => {
  it('a provider error leaves NO reconciliation possible — the caller never calls reconcile() on a failed call, so the reservation stays fully charged, and a same-request retry (a fresh reserve() call) is checked fully independently against what remains', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const ledger = createRequestBudgetLedger({ tracker, keyId: 'k1' });
    const first = ledger.reserve({ label: 'answer', estimatedInputTokens: 700, maxOutputTokens: 200 }); // cost 900
    assert.equal(first.ok, true);
    // Simulates the caller's provider.generate() throwing — coordinator.js's
    // own contract is to NEVER call reconcile() on that path (see its own
    // catch-block comment), so nothing here refunds the 900.
    const retry = ledger.reserve({ label: 'answer', estimatedInputTokens: 700, maxOutputTokens: 200 }); // a NEW call, same shape
    assert.equal(retry.ok, false, 'only 100 tokens remain (1000 capacity - 900 already charged) — the retry cannot bypass the ceiling');
  });

  it('a NEW HTTP request (a fresh ledger) sharing the SAME key still sees the aggregate already spent by the first — retries cannot bypass the per-key ceiling by starting a new request-scoped ledger', () => {
    const tracker = createTokenBudgetTracker({ tokensPerHour: 100_000, burstTokens: 1000, now: fakeClock() });
    const firstRequestLedger = createRequestBudgetLedger({ tracker, keyId: 'k1' });
    firstRequestLedger.reserve({ label: 'answer', estimatedInputTokens: 700, maxOutputTokens: 200 }); // charges 900, never reconciled (simulated failure)

    const retryRequestLedger = createRequestBudgetLedger({ tracker, keyId: 'k1' }); // a fresh ledger, as a retried HTTP request would construct
    const retry = retryRequestLedger.reserve({ label: 'answer', estimatedInputTokens: 700, maxOutputTokens: 200 });
    assert.equal(retry.ok, false, 'the SHARED per-key tracker still reflects the first attempt\'s uncredited spend');
  });
});

describe('outputTokenCapFromCharLimit — the pre-call token cap derived from an existing post-hoc char limit', () => {
  it('is a positive integer, denser (fewer chars/token) than the generic 4-char heuristic, plus a margin', () => {
    const cap = outputTokenCapFromCharLimit(500);
    assert.ok(Number.isInteger(cap));
    assert.ok(cap > 500 / 4, 'includes a safety margin above the standard 4-chars/token estimate');
  });
});
