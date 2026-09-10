import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createContinuationStore, ContinuationError, RUN_STATUS, STORE_LIMITS } from '../../../../src/core/agent/continuation-store.js';

function makeStore(opts = {}) {
  let clock = 1_000;
  const store = createContinuationStore({ now: () => clock, ...opts });
  return { store, advance: (ms) => { clock += ms; }, at: () => clock };
}

// pendingCalls are NEUTRAL {id, name} pairs owned by the store — never
// recovered from the opaque providerState (which is provider-specific).
function seed(store, { identity = 'key-a', pendingCallIds = ['c1'], providerState = { opaque: true } } = {}) {
  return store.create({
    identity,
    context: Object.freeze({ tools: [] }),
    providerState,
    pendingCalls: pendingCallIds.map((id) => ({ id, name: 'lookup_items' })),
    usage: { modelSteps: 1, toolCalls: pendingCallIds.length, reservedTokens: 10 },
  });
}

describe('createContinuationStore — ids and identity binding', () => {
  test('ids are opaque, unguessable and unique', () => {
    const { store } = makeStore();
    const ids = new Set(Array.from({ length: 50 }, () => seed(store, { identity: `k${Math.random()}` })));
    assert.equal(ids.size, 50);
    for (const id of ids) {
      assert.ok(id.length >= 40, 'a run id must carry real entropy');
      assert.match(id, /^[A-Za-z0-9_-]+$/, 'a run id must be URL-safe and opaque');
    }
  });

  test('a run presented by a DIFFERENT principal reports not-found, never forbidden', () => {
    const { store } = makeStore();
    const id = seed(store, { identity: 'key-a' });
    try {
      store.claim({ runId: id, identity: 'key-b', results: [{ callId: 'c1' }] });
      assert.fail('expected a ContinuationError');
    } catch (err) {
      assert.equal(err.code, 'run_not_found');
      assert.match(err.message, /No active agent run/);
      assert.ok(!/forbidden|permission/i.test(err.message), 'the message must not confirm the id exists');
    }
  });

  test('an unknown id is reported identically to a cross-principal id', () => {
    const { store } = makeStore();
    seed(store, { identity: 'key-a' });
    const unknown = (() => { try { store.peek({ runId: 'nope', identity: 'key-a' }); } catch (e) { return e; } })();
    const crossed = (() => {
      const id = seed(store, { identity: 'key-a' });
      try { store.peek({ runId: id, identity: 'key-b' }); } catch (e) { return e; }
      return null;
    })();
    assert.equal(unknown.code, crossed.code);
    assert.equal(unknown.message, crossed.message);
  });
});

describe('claim() — exact result matching, before any state change', () => {
  test('accepts the exact pending set and marks the run in-flight', () => {
    const { store } = makeStore();
    const id = seed(store, { pendingCallIds: ['c1', 'c2'] });
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c2' }, { callId: 'c1' }] });
    assert.deepEqual(claimed.usage, { modelSteps: 1, toolCalls: 2, reservedTokens: 10 });
    assert.equal(store.peek({ runId: id, identity: 'key-a' }).status, RUN_STATUS.IN_FLIGHT);
    claimed.release();
  });

  test('rejects a MISSING result — partial continuation is not supported', () => {
    const { store } = makeStore();
    const id = seed(store, { pendingCallIds: ['c1', 'c2'] });
    assert.throws(() => store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] }),
      (err) => err.code === 'results_mismatch' && /Partial continuation is not supported/.test(err.message));
  });

  test('rejects an EXTRA result for a call this run is not waiting on', () => {
    const { store } = makeStore();
    const id = seed(store, { pendingCallIds: ['c1'] });
    assert.throws(() => store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }, { callId: 'cX' }] }),
      (err) => err.code === 'results_mismatch');
  });

  test('rejects DUPLICATE results for the same call id', () => {
    const { store } = makeStore();
    const id = seed(store, { pendingCallIds: ['c1', 'c2'] });
    assert.throws(() => store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }, { callId: 'c1' }] }),
      (err) => err.code === 'results_mismatch' && /Duplicate/.test(err.message));
  });

  test('a malformed continuation does NOT burn the run — it stays claimable afterwards', () => {
    const { store } = makeStore();
    const id = seed(store, { pendingCallIds: ['c1'] });
    assert.throws(() => store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'wrong' }] }));
    assert.equal(store.peek({ runId: id, identity: 'key-a' }).status, RUN_STATUS.READY,
      'a rejected malformed continuation must leave the run READY, not consumed');
    const ok = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    assert.ok(ok);
    ok.release();
  });
});

describe('claim() — concurrency and replay', () => {
  test('two concurrent claims: exactly one wins, the loser is told it is busy', () => {
    const { store } = makeStore();
    const id = seed(store);
    const first = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    assert.throws(() => store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] }),
      (err) => err.code === 'run_busy');
    first.release();
  });

  test('replaying a completed run does not re-run generation — the run is gone', () => {
    const { store } = makeStore();
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    claimed.release({ status: RUN_STATUS.COMPLETED });
    assert.throws(() => store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] }),
      (err) => err.code === 'run_not_found');
  });

  test('release() advances the run to the next pending set and refreshes its TTL', () => {
    const { store, advance } = makeStore();
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    claimed.release({
      status: RUN_STATUS.READY,
      providerState: { opaque: 'next' },
      pendingCalls: [{ id: 'c2', name: 'lookup_items' }],
      usage: { modelSteps: 2, toolCalls: 2, reservedTokens: 20 },
    });
    advance(STORE_LIMITS.ttlMs - 1);
    const peeked = store.peek({ runId: id, identity: 'key-a' });
    assert.deepEqual(peeked.pendingCalls, [{ id: 'c2', name: 'lookup_items' }]);
    assert.equal(peeked.usage.modelSteps, 2);
  });

  test('release() is idempotent', () => {
    const { store } = makeStore();
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    claimed.release({ status: RUN_STATUS.COMPLETED });
    claimed.release({ status: RUN_STATUS.COMPLETED });
    assert.equal(store.stats().runs, 0);
  });
});

describe('lifecycle and memory', () => {
  test('an expired run is gone, and its memory is released', () => {
    const { store, advance } = makeStore();
    const id = seed(store);
    assert.equal(store.stats().runs, 1);
    advance(STORE_LIMITS.ttlMs + 1);
    assert.throws(() => store.peek({ runId: id, identity: 'key-a' }), (err) => err.code === 'run_not_found');
    assert.equal(store.stats().runs, 0);
    assert.equal(store.stats().totalBytes, 0);
  });

  test('close() frees a run and returns false for an unknown id', () => {
    const { store } = makeStore();
    const id = seed(store);
    assert.equal(store.close({ runId: id, identity: 'key-a' }), true);
    assert.equal(store.stats().runs, 0);
    assert.equal(store.close({ runId: id, identity: 'key-a' }), false);
  });

  test('close() ignores a cross-principal id', () => {
    const { store } = makeStore();
    const id = seed(store, { identity: 'key-a' });
    assert.equal(store.close({ runId: id, identity: 'key-b' }), false);
    assert.equal(store.stats().runs, 1);
  });

  test('enforces the per-principal concurrent-run ceiling', () => {
    const { store } = makeStore({ limits: { maxRunsPerPrincipal: 2 } });
    seed(store, { identity: 'key-a' });
    seed(store, { identity: 'key-a' });
    assert.throws(() => seed(store, { identity: 'key-a' }), (err) => err.code === 'store_full');
    // A different principal is unaffected.
    assert.ok(seed(store, { identity: 'key-b' }));
  });

  test('enforces the process-wide active-run ceiling', () => {
    const { store } = makeStore({ limits: { maxActiveRuns: 2, maxRunsPerPrincipal: 99 } });
    seed(store, { identity: 'a' });
    seed(store, { identity: 'b' });
    assert.throws(() => seed(store, { identity: 'c' }), (err) => err.code === 'store_full');
  });

  test('rejects a run whose state exceeds the per-run byte ceiling', () => {
    const { store } = makeStore({ limits: { maxRunBytes: 200 } });
    assert.throws(() => seed(store, { providerState: { blob: 'x'.repeat(500) } }),
      (err) => err.code === 'run_too_large');
  });

  test('rejects growth past the per-run byte ceiling on release, and frees the run', () => {
    const { store } = makeStore({ limits: { maxRunBytes: 400 } });
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    assert.throws(() => claimed.release({
      status: RUN_STATUS.READY,
      providerState: { blob: 'x'.repeat(2000) },
      pendingCalls: [{ id: 'c2', name: 'lookup_items' }],
      usage: { modelSteps: 2, toolCalls: 2, reservedTokens: 20 },
    }), (err) => err.code === 'run_too_large');
    assert.equal(store.stats().runs, 0, 'an over-large run must not linger in memory');
    assert.equal(store.stats().totalBytes, 0);
  });

  test('expiry sweeps free aggregate bytes so the store recovers capacity', () => {
    const { store, advance } = makeStore({ limits: { maxActiveRuns: 1 } });
    seed(store, { identity: 'a' });
    assert.throws(() => seed(store, { identity: 'b' }), (err) => err.code === 'store_full');
    advance(STORE_LIMITS.ttlMs + 1);
    assert.ok(seed(store, { identity: 'b' }), 'capacity must return after expiry');
  });

  test('two stores are independent — no module-level shared state', () => {
    const a = makeStore().store;
    const b = makeStore().store;
    seed(a);
    assert.equal(a.stats().runs, 1);
    assert.equal(b.stats().runs, 0);
  });
});

// -- Pre-release code-review regression: single-point resource release ---
// sweep() used to delete an IN_FLIGHT run and subtract its bytes; the
// still-running step's own release() then subtracted the SAME bytes again,
// driving the accounting negative (reproduced: totalBytes: -15) and
// corrupting the memory limit for the whole process.

describe('regression: expiry/close/release free a run exactly once', () => {
  test('an IN_FLIGHT run is never swept out from under its running step', () => {
    const { store, advance } = makeStore();
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });

    advance(STORE_LIMITS.ttlMs + 1);
    // A sweep is triggered by any store call. The in-flight run must survive.
    assert.equal(store.stats().runs, 1, 'a run with a live model step must not be swept');
    assert.equal(store.peek({ runId: id, identity: 'key-a' }).status, RUN_STATUS.IN_FLIGHT);

    claimed.release({ status: RUN_STATUS.COMPLETED });
    assert.equal(store.stats().runs, 0);
    assert.equal(store.stats().totalBytes, 0, 'byte accounting must return to exactly zero');
  });

  test('totalBytes never goes negative when expiry and release race', () => {
    const { store, advance } = makeStore();
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    advance(STORE_LIMITS.ttlMs + 1);
    store.stats();                 // force a sweep while the step is in flight
    claimed.release();             // the step then finishes
    assert.equal(store.stats().totalBytes, 0);
    assert.ok(store.stats().totalBytes >= 0, 'the byte pool must never be driven negative');
  });

  test('close() during an in-flight step, followed by release(), frees exactly once', () => {
    const { store } = makeStore();
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    assert.equal(store.close({ runId: id, identity: 'key-a' }), true);
    claimed.release({ status: RUN_STATUS.COMPLETED });
    assert.equal(store.stats().runs, 0);
    assert.equal(store.stats().totalBytes, 0);
  });

  test('an over-size release frees the run once, leaving a clean pool for the next run', () => {
    const { store } = makeStore({ limits: { maxRunBytes: 400 } });
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    assert.throws(() => claimed.release({
      status: RUN_STATUS.READY,
      providerState: { blob: 'x'.repeat(2000) },
      pendingCalls: [{ id: 'c2', name: 'lookup_items' }],
      usage: { modelSteps: 2, toolCalls: 2, reservedTokens: 20 },
    }), (err) => err.code === 'run_too_large');
    assert.equal(store.stats().totalBytes, 0);
    // The pool is clean, so a fresh run still fits.
    assert.ok(seed(store, { identity: 'key-b' }));
  });

  test('an idle (READY) run is still swept on expiry — the fix must not leak runs', () => {
    const { store, advance } = makeStore();
    seed(store);
    advance(STORE_LIMITS.ttlMs + 1);
    assert.equal(store.stats().runs, 0);
    assert.equal(store.stats().totalBytes, 0);
  });
});

// -- Second-round regression: release() after removal must be inert -------
// release()'s READY branch rewrote totalBytes unconditionally, so a run that
// close() had already removed got its bytes ADDED BACK for a record the
// store no longer held. Reproduced as claim -> close -> release(READY):
// runs: 0 but totalBytes: 7, and each repetition leaked more of the pool.

describe('regression: any release after removal is a strict no-op', () => {
  function advanceRelease(store, id) {
    return {
      status: RUN_STATUS.READY,
      providerState: { opaque: 'next' },
      pendingCalls: [{ id: 'c2', name: 'lookup_items' }],
      usage: { modelSteps: 2, toolCalls: 2, reservedTokens: 20 },
    };
  }

  test('claim -> close -> release(READY) leaves the pool at exactly zero', () => {
    const { store } = makeStore();
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });

    assert.equal(store.close({ runId: id, identity: 'key-a' }), true);
    claimed.release(advanceRelease(store, id));

    assert.equal(store.stats().runs, 0);
    assert.equal(store.stats().totalBytes, 0,
      'a closed run must never have its bytes re-added by a late release');
  });

  test('repeating close -> release(READY) does not accumulate phantom bytes', () => {
    const { store } = makeStore();
    for (let i = 0; i < 5; i += 1) {
      const id = seed(store, { identity: `key-${i}` });
      const claimed = store.claim({ runId: id, identity: `key-${i}`, results: [{ callId: 'c1' }] });
      store.close({ runId: id, identity: `key-${i}` });
      claimed.release(advanceRelease(store, id));
    }
    assert.equal(store.stats().runs, 0);
    assert.equal(store.stats().totalBytes, 0,
      'repeated close/late-release cycles must not silently consume the memory limit');
  });

  test('a closed run cannot be resurrected by a late release', () => {
    const { store } = makeStore();
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    store.close({ runId: id, identity: 'key-a' });
    claimed.release(advanceRelease(store, id));

    assert.throws(() => store.peek({ runId: id, identity: 'key-a' }), (err) => err.code === 'run_not_found');
  });

  test('close -> release(COMPLETED) is also inert', () => {
    const { store } = makeStore();
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    store.close({ runId: id, identity: 'key-a' });
    claimed.release({ status: RUN_STATUS.COMPLETED });
    assert.equal(store.stats().totalBytes, 0);
  });

  test('a normal (un-closed) release still advances the run — the guard must not break the happy path', () => {
    const { store } = makeStore();
    const id = seed(store);
    const claimed = store.claim({ runId: id, identity: 'key-a', results: [{ callId: 'c1' }] });
    claimed.release(advanceRelease(store, id));
    const peeked = store.peek({ runId: id, identity: 'key-a' });
    assert.equal(peeked.status, RUN_STATUS.READY);
    assert.deepEqual(peeked.pendingCalls, [{ id: 'c2', name: 'lookup_items' }]);
    assert.ok(store.stats().totalBytes > 0, 'a live run still occupies real bytes');
  });
});
