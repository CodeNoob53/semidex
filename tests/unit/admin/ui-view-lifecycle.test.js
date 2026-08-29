// Tests for src/shared/admin/ui-src/shared/lifecycle/view.js —
// createViewController(), the mount/dispose primitive every v2 feature view
// is built on (design plan §8.4, §15 item 1). No DOM dependency at all, so
// this is a plain ESM import, not a vm-harness module (same convention as
// structural-renderer.js's tests).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createViewController } from '../../../src/shared/admin/ui-src/shared/lifecycle/view.js';

describe('view.js — createViewController()', () => {
  it('exposes a signal, and dispose() aborts it', () => {
    const view = createViewController();
    assert.equal(view.signal.aborted, false);
    view.dispose();
    assert.equal(view.signal.aborted, true);
  });

  it('a listener registered with { signal } is removed once dispose() aborts', () => {
    const view = createViewController();
    const target = new EventTarget();
    let calls = 0;
    target.addEventListener('ping', () => { calls++; }, { signal: view.signal });
    target.dispatchEvent(new Event('ping'));
    assert.equal(calls, 1, 'sanity: listener fires before dispose');

    view.dispose();
    target.dispatchEvent(new Event('ping'));
    assert.equal(calls, 1, 'an aborted signal must remove the listener — no further calls after dispose()');
  });

  it('runs registered teardown callbacks in reverse (LIFO) order', () => {
    const view = createViewController();
    const order = [];
    view.onDispose(() => order.push('first'));
    view.onDispose(() => order.push('second'));
    view.onDispose(() => order.push('third'));
    view.dispose();
    assert.deepEqual(order, ['third', 'second', 'first']);
  });

  it('runs every teardown exactly once, even if dispose() is called repeatedly', () => {
    const view = createViewController();
    let calls = 0;
    view.onDispose(() => { calls++; });
    view.dispose();
    view.dispose();
    view.dispose();
    assert.equal(calls, 1, 'repeated dispose() must not re-run teardowns');
  });

  it('repeated dispose() does not throw and leaves the signal aborted', () => {
    const view = createViewController();
    view.dispose();
    assert.doesNotThrow(() => view.dispose());
    assert.equal(view.signal.aborted, true);
  });

  it('a teardown that throws does not prevent the remaining teardowns from running', () => {
    const view = createViewController();
    const order = [];
    view.onDispose(() => order.push('a'));
    view.onDispose(() => { throw new Error('boom'); });
    view.onDispose(() => order.push('c'));
    assert.doesNotThrow(() => view.dispose());
    assert.deepEqual(order, ['c', 'a'], 'the throwing teardown is skipped over, not fatal to the rest');
  });

  it('nextGeneration() returns increasing values, and isCurrent() is true only for the latest one', () => {
    const view = createViewController();
    const gen1 = view.nextGeneration();
    assert.equal(view.isCurrent(gen1), true);

    const gen2 = view.nextGeneration();
    assert.notEqual(gen1, gen2);
    assert.equal(view.isCurrent(gen1), false, 'a superseded generation must no longer be current');
    assert.equal(view.isCurrent(gen2), true);
  });

  it('dispose() invalidates every generation issued before it, including the current one', () => {
    const view = createViewController();
    const gen1 = view.nextGeneration();
    const gen2 = view.nextGeneration();
    view.dispose();
    assert.equal(view.isCurrent(gen1), false);
    assert.equal(view.isCurrent(gen2), false);
  });

  it('isCurrent() is false for a generation requested AFTER dispose(), too', () => {
    const view = createViewController();
    view.dispose();
    const genAfterDispose = view.nextGeneration();
    assert.equal(view.isCurrent(genAfterDispose), false, 'a disposed view has no current generation, ever again');
  });

  it('isCurrent(0) is true before any nextGeneration() call, and false once disposed', () => {
    const view = createViewController();
    assert.equal(view.isCurrent(0), true, 'a view that never called nextGeneration() is still validly "current" at its initial 0 state');
    view.dispose();
    assert.equal(view.isCurrent(0), false);
  });

  it('the ownership-check pattern from the design plan works end to end', async () => {
    const view = createViewController();
    const gen = view.nextGeneration();
    let committed = false;
    const resultPromise = Promise.resolve('data').then((result) => {
      if (!view.isCurrent(gen)) return;
      committed = true;
      return result;
    });
    view.dispose(); // supersede before the async work resolves
    await resultPromise;
    assert.equal(committed, false, 'a response arriving after dispose() must never commit');
  });

  it('onDispose(fn) called AFTER dispose() runs fn immediately, synchronously, rather than storing a teardown that can never run', () => {
    const view = createViewController();
    view.dispose();
    let called = false;
    view.onDispose(() => { called = true; });
    assert.equal(called, true, 'a late registration must run immediately, not be silently dropped/leaked');
  });

  it('onDispose(fn) registered after dispose() does not get called again by a later (no-op) dispose()', () => {
    const view = createViewController();
    view.dispose();
    let calls = 0;
    view.onDispose(() => { calls++; });
    assert.equal(calls, 1, 'sanity: ran once, immediately');
    view.dispose(); // repeated dispose() is a no-op
    assert.equal(calls, 1, 'a late-registered teardown must not run a second time on a subsequent dispose() call');
  });

  it('onDispose() late-registration ordering: each call runs immediately in the order it was made, independent of the original teardown batch', () => {
    const view = createViewController();
    const order = [];
    view.onDispose(() => order.push('early'));
    view.dispose();
    assert.deepEqual(order, ['early']);
    view.onDispose(() => order.push('late-1'));
    view.onDispose(() => order.push('late-2'));
    assert.deepEqual(order, ['early', 'late-1', 'late-2']);
  });

  it('onDispose(fn) rejects a non-function argument before disposal', () => {
    const view = createViewController();
    assert.throws(() => view.onDispose(null), TypeError);
    assert.throws(() => view.onDispose(undefined), TypeError);
    assert.throws(() => view.onDispose('not a function'), TypeError);
    assert.throws(() => view.onDispose(42), TypeError);
  });

  it('onDispose(fn) rejects a non-function argument after disposal too (immediate-run path validates the same way)', () => {
    const view = createViewController();
    view.dispose();
    assert.throws(() => view.onDispose(null), TypeError);
    assert.throws(() => view.onDispose({}), TypeError);
  });

  it('a rejected non-function registration never mutates the teardown list (a later valid onDispose() still works)', () => {
    const view = createViewController();
    assert.throws(() => view.onDispose('nope'));
    let called = false;
    view.onDispose(() => { called = true; });
    view.dispose();
    assert.equal(called, true);
  });

  it('two independent controllers do not share generation counters or teardown lists', () => {
    const a = createViewController();
    const b = createViewController();
    const genA = a.nextGeneration();
    let bTeardownCalls = 0;
    b.onDispose(() => { bTeardownCalls++; });

    a.dispose();
    assert.equal(a.isCurrent(genA), false);
    assert.equal(b.signal.aborted, false, 'disposing one controller must not affect another');
    assert.equal(bTeardownCalls, 0);
  });
});
