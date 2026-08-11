import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlightGate } from '../../../../src/core/ask/single-flight-gate.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createSingleFlightGate', () => {
  test('sequential run() calls both succeed, in order', async () => {
    const gate = createSingleFlightGate();
    const first = await gate.run(async () => 'a');
    const second = await gate.run(async () => 'b');
    assert.deepEqual(first, { ok: true, value: 'a' });
    assert.deepEqual(second, { ok: true, value: 'b' });
  });

  test('a run() started while another is in-flight returns {ok:false} immediately, never queues', async () => {
    const gate = createSingleFlightGate();
    const held = deferred();
    const first = gate.run(() => held.promise);
    await new Promise((r) => setImmediate(r));
    assert.equal(gate.isBusy(), true);

    const second = await gate.run(async () => 'should not run');
    assert.deepEqual(second, { ok: false });

    held.resolve('first result');
    const firstOutcome = await first;
    assert.deepEqual(firstOutcome, { ok: true, value: 'first result' });
  });

  test('the gate releases after the held fn resolves normally', async () => {
    const gate = createSingleFlightGate();
    await gate.run(async () => 'done');
    assert.equal(gate.isBusy(), false);
    const second = await gate.run(async () => 'ok');
    assert.deepEqual(second, { ok: true, value: 'ok' });
  });

  test('the gate releases after the held fn throws/rejects (finally semantics)', async () => {
    const gate = createSingleFlightGate();
    await assert.rejects(() => gate.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(gate.isBusy(), false);
    const second = await gate.run(async () => 'ok');
    assert.deepEqual(second, { ok: true, value: 'ok' });
  });

  test('isBusy() reflects true only strictly between acquisition and release (resolve case)', async () => {
    const gate = createSingleFlightGate();
    const held = deferred();
    assert.equal(gate.isBusy(), false);
    const run = gate.run(() => held.promise);
    await new Promise((r) => setImmediate(r));
    assert.equal(gate.isBusy(), true);
    held.resolve('x');
    await run;
    assert.equal(gate.isBusy(), false);
  });

  test('isBusy() reflects true only strictly between acquisition and release (reject case)', async () => {
    const gate = createSingleFlightGate();
    const held = deferred();
    assert.equal(gate.isBusy(), false);
    const run = gate.run(() => held.promise);
    await new Promise((r) => setImmediate(r));
    assert.equal(gate.isBusy(), true);
    held.reject(new Error('boom'));
    await assert.rejects(() => run, /boom/);
    assert.equal(gate.isBusy(), false);
  });

  test('two independently-constructed gate instances never share state', async () => {
    const gateA = createSingleFlightGate();
    const gateB = createSingleFlightGate();
    const held = deferred();
    const runA = gateA.run(() => held.promise);
    await new Promise((r) => setImmediate(r));
    assert.equal(gateA.isBusy(), true);
    assert.equal(gateB.isBusy(), false);

    const resultB = await gateB.run(async () => 'b ran fine');
    assert.deepEqual(resultB, { ok: true, value: 'b ran fine' });

    held.resolve('a result');
    await runA;
    assert.equal(gateA.isBusy(), false);
  });
});
