import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitForDrain } from '../../../src/admin/sse.js';

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
