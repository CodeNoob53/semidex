// index-runtime.js's runAndReportExitCode() — code review, P2. The bug this
// covers: the original runIndexerCli() did `run().catch(err => {
// console.error(err); process.exit(1); })`, a fire-and-forget call that
// never awaited the returned promise — `await runIndexerCli(...)` in
// index-full.js/index-lite.js resolved as soon as run() was merely
// CALLED, not once it actually finished. runAndReportExitCode() was pulled
// out into its own small function specifically so this can be tested with
// a fake runFn, without loading the real indexer environment
// (bootstrapEnv(), a real SettingsService, run.js's own Qdrant-touching
// main()).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAndReportExitCode } from '../../../src/indexer/index-runtime.js';

describe('runAndReportExitCode()', () => {
  it('does not resolve until runFn() itself resolves — genuinely awaits, never fire-and-forget', async () => {
    let resolveRunFn;
    const runFn = () => new Promise((resolve) => { resolveRunFn = resolve; });

    let settled = false;
    const promise = runAndReportExitCode(runFn).then(() => { settled = true; });
    // Race against a real timer — if runAndReportExitCode() resolved as
    // soon as runFn() was merely CALLED (the original fire-and-forget
    // bug), `promise` would already be settled by the time this race
    // finishes, well before resolveRunFn() is ever invoked below.
    await Promise.race([promise, new Promise((r) => setTimeout(r, 20))]);
    assert.equal(settled, false, 'runAndReportExitCode() must still be pending while runFn() itself is pending');

    resolveRunFn();
    await promise;
    assert.equal(settled, true);
  });

  it('resolves normally, sets no exitCode, when runFn() succeeds', async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runAndReportExitCode(async () => {});
      assert.equal(process.exitCode, undefined);
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it('sets process.exitCode = 1 (never calls process.exit()) when runFn() rejects', async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error('process.exit() must never be called — a hard exit could interrupt runFn()\'s own in-flight cleanup'); };
    try {
      const loggedErrors = [];
      await runAndReportExitCode(
        async () => { throw new Error('boom'); },
        (err) => loggedErrors.push(err),
      );
      assert.equal(process.exitCode, 1);
      assert.equal(exitCalled, false, 'process.exit() must never be called');
      assert.equal(loggedErrors.length, 1);
      assert.equal(loggedErrors[0].message, 'boom');
    } finally {
      process.exit = originalExit;
      process.exitCode = savedExitCode;
    }
  });

  it('a rejecting runFn() never produces an unhandled promise rejection — runAndReportExitCode() itself always resolves, never rejects', async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);
    try {
      // No try/catch around this call — if runAndReportExitCode() itself
      // rejected (rather than swallowing runFn()'s rejection internally),
      // this await would throw here AND the assertion below would never
      // run under a bug where it also failed to attach a rejection
      // handler in time; the real proof is the unhandledRejection listener
      // never firing, checked after a real macrotask tick.
      await runAndReportExitCode(async () => { throw new Error('boom'); }, () => {});
      // Yield to the event loop once — unhandledRejection fires on a
      // separate microtask/macrotask turn, never synchronously.
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(unhandled, null, 'runFn()\'s rejection must never surface as an unhandled promise rejection');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.exitCode = savedExitCode;
    }
  });

  it('errorLogFn defaults to console.error when omitted', async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    const originalConsoleError = console.error;
    let loggedWith = null;
    console.error = (err) => { loggedWith = err; };
    try {
      const err = new Error('boom');
      await runAndReportExitCode(async () => { throw err; });
      assert.equal(loggedWith, err);
      assert.equal(process.exitCode, 1);
    } finally {
      console.error = originalConsoleError;
      process.exitCode = savedExitCode;
    }
  });
});
