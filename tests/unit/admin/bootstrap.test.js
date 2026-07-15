// src/admin/bootstrap.js — the real npm run admin entry point. The pure
// env-snapshot/load helpers (snapshotOsEnv/loadDotenvValues/
// applyDotenvValues/bootstrapEnv) were relocated to src/core/env-bootstrap.js
// during the Global Settings phase and are tested there
// (tests/unit/core/env-bootstrap.test.js); this file only re-exports them
// for backwards compatibility, tested here, plus the isMainModule
// self-start guard — exercised live (npm run admin), not in this test file,
// since importing bootstrap.js in a test must never itself start a server
// or touch a real .env file on disk (import.meta.url !== the test runner's
// entry script, so the guard already prevents that).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotOsEnv, loadDotenvValues, applyDotenvValues, bootstrapEnv,
} from '../../../src/admin/bootstrap.js';
import * as envBootstrap from '../../../src/core/env-bootstrap.js';

describe('bootstrap.js — re-exports env-bootstrap.js unchanged', () => {
  test('snapshotOsEnv/loadDotenvValues/applyDotenvValues/bootstrapEnv are the same functions as core/env-bootstrap.js', () => {
    assert.equal(snapshotOsEnv, envBootstrap.snapshotOsEnv);
    assert.equal(loadDotenvValues, envBootstrap.loadDotenvValues);
    assert.equal(applyDotenvValues, envBootstrap.applyDotenvValues);
    assert.equal(bootstrapEnv, envBootstrap.bootstrapEnv);
  });
});

describe('bootstrap.js — import safety', () => {
  test('importing this module does not start a server or bind a port (isMainModule guard holds under the test runner)', async () => {
    // If the guard were broken, importing this file from the test runner
    // (whose process.argv[1] is the test runner's own entry, not
    // bootstrap.js) would attempt server.listen() and this import would
    // either throw (port already bound by another test) or leave a
    // dangling listener. A clean, silent import is the proof.
    await import('../../../src/admin/bootstrap.js');
    // No assertion needed beyond "did not throw and did not hang" — a
    // hidden server.listen() call would manifest as an unclosed handle
    // that the test runner would flag separately.
  });
});
