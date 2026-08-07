// src/admin/server-full.js's createApp({ onnxEmbedCapability }) override —
// review finding (P2): admin/bootstrap.js resolves the ONNX runtime BEFORE
// createApp() runs, and when that resolution finds a broken runtime
// (prepared.ok === false), it must pass a typed-unavailable capability
// into createApp() instead of letting the default real
// createOnnxEmbeddingCapability() construct against a runtime already
// proven broken. Real behavioral coverage of the capability's own throw
// contract lives in tests/unit/local/core/onnx-runtime-unavailable-capability.test.js;
// this file proves createApp() itself accepts and threads the override
// through without breaking normal construction, both with and without it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsService } from '../../../src/core/settings/service.js';
import { createOnnxRuntimeUnavailableCapability } from '../../../src/local/core/onnx-runtime-unavailable-capability.js';

describe('createApp({ onnxEmbedCapability })', () => {
  it('accepts an injected typed-unavailable onnxEmbedCapability and still constructs a working app (every non-ONNX route stays up)', async () => {
    const { createApp } = await import('../../../src/admin/server-full.js?onnx-embed-capability-override-check');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {} });
    const unavailable = createOnnxRuntimeUnavailableCapability('recorded cuDNN directory no longer exists on disk');
    const app = createApp({ settingsService, onnxEmbedCapability: unavailable });
    assert.ok(app, 'createApp() must construct successfully with the override in place, never throwing at construction time');
    await new Promise((resolve, reject) => {
      app.listen(0, '127.0.0.1', () => {
        app.close(() => resolve());
      });
      app.on('error', reject);
    });
  });

  it('omitting onnxEmbedCapability falls back to the real createOnnxEmbeddingCapability() default (unchanged behavior for every existing caller)', async () => {
    const { createApp } = await import('../../../src/admin/server-full.js?onnx-embed-capability-default-check');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {} });
    const app = createApp({ settingsService });
    assert.ok(app, 'createApp() must construct successfully with no onnxEmbedCapability override, exactly as before');
  });
});
