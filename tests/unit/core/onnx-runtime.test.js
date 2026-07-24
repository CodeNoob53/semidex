import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { resolveOnnxRuntimeModule } from '../../../src/core/onnx-runtime.js';

test('uses the project onnxruntime-node dependency by default', () => {
  assert.equal(resolveOnnxRuntimeModule({}), 'onnxruntime-node');
});

test('resolves an explicit ONNXRUNTIME_NODE_PATH', () => {
  assert.equal(
    resolveOnnxRuntimeModule({ ONNXRUNTIME_NODE_PATH: './custom-ort' }),
    resolve('./custom-ort'),
  );
});

test('ignores an empty custom runtime path', () => {
  assert.equal(
    resolveOnnxRuntimeModule({ ONNXRUNTIME_NODE_PATH: '  ' }),
    'onnxruntime-node',
  );
});

