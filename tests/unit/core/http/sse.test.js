import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startSseHeartbeat, waitForDrain } from '../../../../src/core/http/sse.js';

function fakeRes({ destroyed = false, writableEnded = false } = {}) {
  const res = new EventEmitter();
  res.destroyed = destroyed;
  res.writableEnded = writableEnded;
  return res;
}

describe('waitForDrain', () => {
  test('resolves when drain fires', async () => {
    const res = fakeRes();
    const p = waitForDrain(res);
    res.emit('drain');
    await p; // must not hang
  });

  test('resolves when close fires instead of drain (client disconnected while buffer was full)', async () => {
    // Regression: a client that disconnects while res's internal write
    // buffer is still full never fires 'drain' (nothing is draining a dead
    // socket) — waitForDrain() previously only listened for 'drain' and
    // hung forever in that case, which meant the awaiting onToken() call in
    // generateStream()'s NDJSON loop never resolved, generate() never
    // resolved, and the coordinator's finally{ busy = false } never ran
    // (code review finding, confirmed at runtime: a pending promise after
    // close).
    const res = fakeRes();
    const p = waitForDrain(res);
    res.emit('close');
    await p; // must not hang
  });

  test('resolves when error fires', async () => {
    const res = fakeRes();
    const p = waitForDrain(res);
    res.emit('error', new Error('socket error'));
    await p;
  });

  test('resolves immediately without attaching listeners when res is already destroyed', async () => {
    const res = fakeRes({ destroyed: true });
    let listenerCount = 0;
    const originalOnce = res.once.bind(res);
    res.once = (...args) => { listenerCount++; return originalOnce(...args); };
    await waitForDrain(res);
    assert.equal(listenerCount, 0);
  });

  test('resolves immediately without attaching listeners when res.writableEnded is already true', async () => {
    const res = fakeRes({ writableEnded: true });
    let listenerCount = 0;
    const originalOnce = res.once.bind(res);
    res.once = (...args) => { listenerCount++; return originalOnce(...args); };
    await waitForDrain(res);
    assert.equal(listenerCount, 0);
  });

  test('removes all three listeners once one fires (no listener leak across repeated calls on the same res)', async () => {
    const res = fakeRes();
    const p = waitForDrain(res);
    res.emit('drain');
    await p;
    assert.equal(res.listenerCount('drain'), 0);
    assert.equal(res.listenerCount('close'), 0);
    assert.equal(res.listenerCount('error'), 0);
  });

  test('a second waitForDrain() call after the first settles does not accumulate stale listeners', async () => {
    const res = fakeRes();
    await Promise.all([
      (async () => { const p = waitForDrain(res); res.emit('drain'); await p; })(),
    ]);
    const p2 = waitForDrain(res);
    res.emit('drain');
    await p2;
    assert.equal(res.listenerCount('drain'), 0);
  });
});

describe('startSseHeartbeat', () => {
  function heartbeatHarness(overrides = {}) {
    const res = fakeRes();
    const writes = [];
    let tick;
    let cleared = 0;
    res.write = (value) => { writes.push(value); return true; };
    Object.assign(res, overrides);
    const stop = startSseHeartbeat(res, {
      intervalMs: 15_000,
      setIntervalFn: (fn) => { tick = fn; return { unref() {} }; },
      clearIntervalFn: () => { cleared += 1; },
    });
    return { res, writes, tick: () => tick(), stop, cleared: () => cleared };
  }

  test('writes only an SSE comment and no application event or data', () => {
    const harness = heartbeatHarness();
    harness.tick();
    assert.deepEqual(harness.writes, [': keep-alive\n\n']);
    assert.doesNotMatch(harness.writes[0], /event:|data:/);
    harness.stop();
  });

  test('skips a heartbeat while the response is under backpressure', () => {
    const harness = heartbeatHarness({ writableNeedDrain: true });
    harness.tick();
    assert.deepEqual(harness.writes, []);
    harness.stop();
  });

  test('stops and removes listeners on normal response finish', () => {
    const harness = heartbeatHarness();
    harness.res.emit('finish');
    assert.equal(harness.cleared(), 1);
    assert.equal(harness.res.listenerCount('finish'), 0);
    assert.equal(harness.res.listenerCount('close'), 0);
    harness.stop();
    assert.equal(harness.cleared(), 1, 'manual cleanup after finish stays idempotent');
  });

  test('stops without writing when the response is already closed', () => {
    const harness = heartbeatHarness({ destroyed: true });
    harness.tick();
    assert.deepEqual(harness.writes, []);
    assert.equal(harness.cleared(), 1);
  });
});
