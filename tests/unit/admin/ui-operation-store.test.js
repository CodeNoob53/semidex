// Tests for src/admin/ui-src/operation-store.js — the ONE shared client-side
// poller for GET /api/operations (Phase 3S). operation-modal.js and
// topbar.js both subscribe to this instead of polling independently; these
// tests exercise the store in isolation (no DOM/template dependency at all).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadOperationStoreHelpers } from './ui-test-helpers.js';

describe('operation-store.js — polling and subscription', () => {
  it('startPolling() fetches /api/operations immediately, not only after the first delay', async () => {
    let calls = 0;
    const { startPolling, __flushTimers } = loadOperationStoreHelpers({
      apiImpl: async () => { calls++; return { operations: [] }; },
    });
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
  });

  it('startPolling() is idempotent — calling it twice does not start a second poll loop', async () => {
    let calls = 0;
    const { startPolling, __flushTimers } = loadOperationStoreHelpers({
      apiImpl: async () => { calls++; return { operations: [] }; },
    });
    startPolling();
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'a second startPolling() call while already polling must be a no-op, not a second concurrent loop');
  });

  it('schedules the next tick at the fast interval while an operation is active, slow interval otherwise', async () => {
    const { startPolling, __flushTimers, __lastScheduledDelay } = loadOperationStoreHelpers({
      apiImpl: async () => ({ operations: [{ id: '1', kind: 'index', collection: 'a', path: null, state: 'running', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, cancellable: true, progress: null, error: null, }] }),
    });
    startPolling();
    await __flushTimers();
    assert.equal(__lastScheduledDelay(), 1500, 'an active operation must poll at the fast (1.5s) cadence');
  });

  it('schedules the next tick at the slow interval once nothing is active', async () => {
    const { startPolling, __flushTimers, __lastScheduledDelay } = loadOperationStoreHelpers({
      apiImpl: async () => ({ operations: [{ id: '1', kind: 'index', collection: 'a', path: null, state: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', cancellable: false, progress: null, error: null, }] }),
    });
    startPolling();
    await __flushTimers();
    assert.equal(__lastScheduledDelay(), 5000, 'no active operation must poll at the slow (5s) cadence');
  });

  it('getOperations()/getOperation(id)/getActiveOperation() reflect the last successful poll', async () => {
    const { startPolling, __flushTimers, getOperations, getOperation, getActiveOperation } = loadOperationStoreHelpers({
      apiImpl: async () => ({ operations: [
        { id: '1', kind: 'index', collection: 'a', path: null, state: 'running', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, cancellable: true, progress: null, error: null, },
        { id: '2', kind: 'repair', collection: 'b', path: null, state: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', cancellable: false, progress: null, error: null, },
      ] }),
    });
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getOperations().length, 2);
    assert.equal(getOperation('2').collection, 'b');
    assert.equal(getOperation('nope'), null);
    assert.equal(getActiveOperation().id, '1', 'only the running one counts as active');
  });

  it('a transient API error does not throw and leaves prior state intact', async () => {
    let shouldFail = false;
    const { startPolling, __flushTimers, getOperations } = loadOperationStoreHelpers({
      apiImpl: async () => {
        if (shouldFail) throw new Error('network error');
        return { operations: [{ id: '1', kind: 'index', collection: 'a', path: null, state: 'running', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, cancellable: true, progress: null, error: null, }] };
      },
    });
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getOperations().length, 1);

    shouldFail = true;
    await assert.doesNotReject(__flushTimers());
    assert.equal(getOperations().length, 1, 'a failed poll must not clear/replace the last good snapshot');
  });

  it('notifies subscribers with an "update" event on every successful poll', async () => {
    const { startPolling, __flushTimers, subscribe } = loadOperationStoreHelpers({
      apiImpl: async () => ({ operations: [] }),
    });
    const events = [];
    subscribe((e) => events.push(e));
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.some(e => e.type === 'update'));
  });

  it('fires a "transition" event exactly once when an operation changes state, not once per poll tick', async () => {
    let state = 'running';
    const { startPolling, __flushTimers, subscribe } = loadOperationStoreHelpers({
      apiImpl: async () => ({ operations: [{ id: '1', kind: 'index', collection: 'a', path: null, state, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: state === 'succeeded' ? '2026-01-01T00:01:00.000Z' : null, cancellable: state === 'running', progress: null, error: null, }] }),
    });
    const transitions = [];
    subscribe((e) => { if (e.type === 'transition') transitions.push(e); });
    startPolling();
    await new Promise((resolve) => setImmediate(resolve)); // first poll: no prior state, no transition yet
    assert.equal(transitions.length, 0, 'the very first sighting of an operation is not a transition');

    await __flushTimers(); // still running — no change
    assert.equal(transitions.length, 0);

    state = 'succeeded';
    await __flushTimers(); // running -> succeeded
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].from, 'running');
    assert.equal(transitions[0].to, 'succeeded');

    await __flushTimers(); // still succeeded — must not fire again
    assert.equal(transitions.length, 1, 'a transition must fire once per actual state change, not once per poll tick showing the same terminal state');
  });

  it('unsubscribe stops further notifications to that listener', async () => {
    const { startPolling, __flushTimers, subscribe } = loadOperationStoreHelpers({
      apiImpl: async () => ({ operations: [] }),
    });
    let count = 0;
    const unsubscribe = subscribe(() => { count++; });
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));
    const afterFirst = count;
    unsubscribe();
    await __flushTimers();
    assert.equal(count, afterFirst, 'no further events must reach an unsubscribed listener');
  });

  it('pollNow() forces an immediate fetch without waiting for the scheduled delay', async () => {
    let calls = 0;
    const { startPolling, __flushTimers, pollNow } = loadOperationStoreHelpers({
      apiImpl: async () => { calls++; return { operations: [] }; },
    });
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));
    const afterStart = calls;
    pollNow();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, afterStart + 1, 'pollNow() must trigger a fresh fetch immediately, not wait for the next scheduled tick');
  });

  // Regression (P1, code review): every "start an operation" flow in this
  // codebase calls pollNow() twice in quick succession without awaiting the
  // first (e.g. jobs-view.js's startIndexJob() calls pollNow(), then
  // openOperationModal() calls pollNow() again before that first fetch
  // resolves). The original implementation had no guard against this —
  // each pollNow() call unconditionally started its own pollOnce(), so two
  // GET /api/operations requests ran concurrently and only one of the two
  // reschedules survived in pollTimer, orphaning the other.
  it('a second pollNow() while the first fetch is still in flight does not start a concurrent fetch', async () => {
    let calls = 0;
    let resolveFirst;
    const pending = new Promise((resolve) => { resolveFirst = resolve; });
    const { pollNow } = loadOperationStoreHelpers({
      apiImpl: async () => {
        calls++;
        if (calls === 1) { await pending; }
        return { operations: [] };
      },
    });
    pollNow(); // starts the first fetch, which is now blocked on `pending`
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'sanity: the first pollNow() call started exactly one fetch');

    pollNow(); // arrives while the first fetch is still in flight
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'a pollNow() call while a fetch is already in flight must not start a second concurrent one');

    resolveFirst({ operations: [] });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, 'the deferred request must fire exactly once, immediately after the in-flight one finishes');
  });

  it('several pollNow() calls while one fetch is in flight collapse into exactly one follow-up fetch, not one per call', async () => {
    let calls = 0;
    let resolveFirst;
    const pending = new Promise((resolve) => { resolveFirst = resolve; });
    const { pollNow } = loadOperationStoreHelpers({
      apiImpl: async () => {
        calls++;
        if (calls === 1) { await pending; }
        return { operations: [] };
      },
    });
    pollNow();
    await new Promise((resolve) => setImmediate(resolve));
    pollNow();
    pollNow();
    pollNow();
    resolveFirst({ operations: [] });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, 'three redundant pollNow() calls while busy must collapse into exactly one deferred follow-up, not three');
  });

  // Regression: pollNow()'s returned promise must resolve with the store
  // already reflecting the DEFERRED follow-up fetch's data — not the
  // in-flight fetch that was already running when this particular
  // pollNow() call arrived. A caller that awaits pollNow() specifically to
  // read fresh state right after (e.g. settings-view.js's
  // runSettingsRepair() failure-path findLatestOperation() lookup) would
  // otherwise see stale data from before their own request was even made.
  it('await pollNow() resolves only once the store reflects a fetch requested at or after that call, not a stale in-flight one', async () => {
    let resolveFirst;
    const pending = new Promise((resolve) => { resolveFirst = resolve; });
    let servedGeneration = 'stale'; // what the FIRST (already in-flight) fetch will return
    const { pollNow, getOperations } = loadOperationStoreHelpers({
      apiImpl: async () => {
        if (servedGeneration === 'stale') { await pending; }
        return { operations: [{ id: servedGeneration, kind: 'repair', collection: 'x', path: null, state: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', cancellable: false, progress: null, error: null, }] };
      },
    });

    pollNow(); // starts the in-flight "stale" fetch (blocked on `pending`)
    await new Promise((resolve) => setImmediate(resolve));

    // Now request a FRESH poll while the stale one is still in flight —
    // this is the promise under test.
    servedGeneration = 'fresh';
    const freshPollDone = pollNow();

    // Let the stale fetch resolve — its own promise (if anything awaited
    // pollNow()'s FIRST call directly) would already be settled by now,
    // but freshPollDone must NOT be, since the deferred follow-up it's
    // actually waiting on hasn't run yet.
    resolveFirst({ operations: [{ id: 'stale', kind: 'repair', collection: 'x', path: null, state: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', cancellable: false, progress: null, error: null, }] });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    await freshPollDone;
    assert.equal(getOperations()[0].id, 'fresh', 'by the time the second pollNow()\'s promise resolves, the store must reflect the FRESH fetch, not the stale in-flight one it arrived during');
  });

  it('findLatestOperation({ collection, kind }) returns the newest match', async () => {
    const { startPolling, getOperations, findLatestOperation } = loadOperationStoreHelpers({
      apiImpl: async () => ({ operations: [
        { id: 'newer', kind: 'repair', collection: 'my-docs', path: null, state: 'succeeded', startedAt: '2026-01-02T00:00:00Z', finishedAt: '2026-01-02T00:01:00Z', cancellable: false, progress: null, error: null, },
        { id: 'older', kind: 'repair', collection: 'my-docs', path: null, state: 'succeeded', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', cancellable: false, progress: null, error: null, },
        { id: 'other-kind', kind: 'index', collection: 'my-docs', path: null, state: 'succeeded', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', cancellable: false, progress: null, error: null, },
      ] }),
    });
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getOperations().length, 3, 'sanity: the stub list loaded');
    assert.equal(findLatestOperation({ collection: 'my-docs', kind: 'repair' }).id, 'newer',
      'operations is already newest-first (server-sorted), so the first match must win');
    assert.equal(findLatestOperation({ collection: 'my-docs', kind: 'reindex' }), null, 'no match must return null, not throw');
  });

  // Regression (P1, code review): repair can complete before any poll ever
  // observes it mid-flight (it's just a few Qdrant round trips — often
  // faster than a poll round trip to this very admin server). Without
  // seeding, the store's "first sighting of an id is never a transition"
  // rule would swallow the completion entirely: the first real poll of a
  // repair task already shows it succeeded/failed, and with no prior
  // lastSeenState entry that reads as "just discovered," not "just
  // finished" — so settings-view.js's completion toast/modal-open would
  // never fire for a repair that happened to finish fast.
  it('seedOperationAsRunning() makes the NEXT poll of that id a real transition even if it is already terminal', async () => {
    const { seedOperationAsRunning, subscribe, startPolling } = loadOperationStoreHelpers({
      apiImpl: async () => ({ operations: [{ id: 'fast-repair', kind: 'repair', collection: 'my-docs', path: null, state: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', cancellable: false, progress: null, error: null, }] }),
    });
    const transitions = [];
    subscribe((e) => { if (e.type === 'transition') transitions.push(e); });

    seedOperationAsRunning('fast-repair'); // called before the id has ever been polled
    startPolling();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(transitions.length, 1, 'seeding must make the first real poll count as a transition, not a first-sighting no-op');
    assert.equal(transitions[0].from, 'running');
    assert.equal(transitions[0].to, 'succeeded');
  });
});
