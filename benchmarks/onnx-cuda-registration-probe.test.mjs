import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  classifyProviderRegistrationError,
  probeProviderRegistration,
  resolveProbeRuntime,
  runProviderRegistrationProbe,
} from './onnx-cuda-registration-probe.mjs';

test('classifies a missing backend as not registered', () => {
  const result = classifyProviderRegistrationError(
    new Error('no available backend found. ERR: [cuda] backend not found.'),
  );
  assert.equal(result.registered, false);
});

test('classifies unsupported execution provider as not registered', () => {
  const result = classifyProviderRegistrationError(
    new Error("sessionOptions.executionProviders[0] is unsupported: 'cuda'."),
  );
  assert.equal(result.registered, false);
});

test('classifies missing model after option parsing as registered', () => {
  const result = classifyProviderRegistrationError(
    new Error("Load model failed. File doesn't exist"),
  );
  assert.equal(result.registered, true);
});

test('does not overclaim registration for an unknown error', () => {
  const result = classifyProviderRegistrationError(new Error('unexpected failure'));
  assert.equal(result.registered, null);
});

test('probe passes one provider and classifies the thrown error', async () => {
  const calls = [];
  const ort = {
    InferenceSession: {
      async create(path, options) {
        calls.push({ path, options });
        throw new Error("Load model failed. File doesn't exist");
      },
    },
  };

  const result = await probeProviderRegistration(ort, 'dml');
  assert.equal(result.registered, true);
  assert.deepEqual(calls[0].options.executionProviders, ['dml']);
});

test('full probe checks cuda, dml, and cpu in a stable order', async () => {
  const providers = [];
  const ort = {
    InferenceSession: {
      async create(_path, options) {
        providers.push(options.executionProviders[0]);
        throw new Error("Load model failed. File doesn't exist");
      },
    },
  };

  const results = await runProviderRegistrationProbe(ort);
  assert.deepEqual(providers, ['cuda', 'dml', 'cpu']);
  assert.deepEqual(results.map((result) => result.registered), [true, true, true]);
});

test('probe uses the project dependency when no custom runtime is configured', () => {
  assert.deepEqual(resolveProbeRuntime({}), {
    modulePath: 'onnxruntime-node',
    custom: false,
  });
});

test('probe resolves an explicit custom runtime directory', () => {
  const result = resolveProbeRuntime({ ONNXRUNTIME_NODE_PATH: './custom-ort' });
  assert.equal(result.custom, true);
  assert.equal(result.modulePath, resolve('./custom-ort'));
});
