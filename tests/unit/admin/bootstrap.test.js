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
import { readFileSync } from 'node:fs';
import {
  snapshotOsEnv, loadDotenvValues, applyDotenvValues, bootstrapEnv,
} from '../../../src/admin/bootstrap.js';
import * as envBootstrap from '../../../src/shared/core/env-bootstrap.js';

describe('bootstrap.js — re-exports env-bootstrap.js unchanged', () => {
  test('snapshotOsEnv/loadDotenvValues/applyDotenvValues/bootstrapEnv are the same functions as core/env-bootstrap.js', () => {
    assert.equal(snapshotOsEnv, envBootstrap.snapshotOsEnv);
    assert.equal(loadDotenvValues, envBootstrap.loadDotenvValues);
    assert.equal(applyDotenvValues, envBootstrap.applyDotenvValues);
    assert.equal(bootstrapEnv, envBootstrap.bootstrapEnv);
  });
});

describe('bootstrap.js — resolves the effective ONNX CUDA runtime before applyEnvWriteBack()', () => {
  const src = readFileSync(new URL('../../../src/admin/bootstrap.js', import.meta.url), 'utf-8');

  // Structural wiring only — bootstrap.js is a self-starting isMainModule
  // script with no exported composition function (unlike
  // indexer/index-full.js's own runFullIndexerComposition()), so it
  // cannot be called directly with injected fakes in a test. The
  // resolution/typed-unavailable-capability BEHAVIOR itself has full
  // behavioral coverage elsewhere: resolveOnnxRuntimeForProcess() in
  // tests/unit/local/core/onnx-runtime-source-resolution.test.js, and
  // createOnnxRuntimeUnavailableCapability() in
  // tests/unit/local/core/onnx-runtime-unavailable-capability.test.js.
  test('resolves via the shared resolveOnnxRuntimeForProcess() INSIDE the isMainModule guard, right after settingsService is constructed and before applyEnvWriteBack()', () => {
    const guardStart = src.indexOf('if (isMainModule)');
    const settingsServiceLine = src.indexOf('createSettingsService({ osEnv, dotenvValues })');
    const resolveCall = src.indexOf('resolveOnnxRuntimeForProcess({ settingsService, env: process.env })');
    const writeBackCall = src.indexOf('applyEnvWriteBack(settingsService)');
    const createAppCall = src.indexOf('createApp({ generationRuntime, settingsService, jobBaseEnv, onnxEmbedCapability })');
    assert.ok(guardStart >= 0);
    assert.ok(settingsServiceLine > guardStart);
    assert.ok(resolveCall > settingsServiceLine, 'resolution must run after settingsService is constructed');
    assert.ok(writeBackCall > resolveCall, 'resolution must run before applyEnvWriteBack()');
    assert.ok(createAppCall > resolveCall, 'the resolved onnxEmbedCapability must reach createApp()');
  });

  test('a non-ok prepared result builds a typed-unavailable onnxEmbedCapability via createOnnxRuntimeUnavailableCapability(), passed into createApp() — never throws/crashes admin startup', () => {
    assert.match(src, /import \{ createOnnxRuntimeUnavailableCapability \} from '\.\.\/local\/core\/onnx-runtime-unavailable-capability\.js'/);
    assert.match(src, /const onnxEmbedCapability = onnxRuntimeResolution\.prepared\.ok\s*\n\s*\? undefined\s*\n\s*: createOnnxRuntimeUnavailableCapability\(onnxRuntimeResolution\.prepared\.reason\);/);
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
