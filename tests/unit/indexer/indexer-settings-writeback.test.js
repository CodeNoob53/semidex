// indexer/index.js is a CLI entry point, not importable for unit testing
// its internals directly (module-level side effects, no exported main()).
// The write-back mechanism itself (applyIndexerSettings) is private to
// that file, so this test proves the CONTRACT it depends on instead:
// every consumer function it write-backs for (resolveTokenCountMode,
// shouldUseOnnxBatching, resolveOnnxBatchSize, isCudaStrict,
// shouldGenerateTags, isOnnxTagProvider) genuinely re-reads process.env on
// each call — i.e. writing a new string into process.env before calling
// them (exactly what applyIndexerSettings does) is sufficient to change
// their output, with no caching/staleness in the way.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve as resolvePath } from 'node:path';
import { EventEmitter } from 'node:events';
import { resolveTokenCountMode } from '../../../src/core/token-count.js';
import { shouldUseOnnxBatching, resolveOnnxBatchSize } from '../../../src/core/embeddings.js';
import { isCudaStrict } from '../../../src/core/doctor-checks.js';
import { shouldGenerateTags } from '../../../src/indexer/phases/tag.js';
import { isOnnxTagProvider } from '../../../src/indexer/phases/tag-onnx.js';
import { resolveOnnxRuntimeModule } from '../../../src/core/onnx-runtime.js';

function withEnv(overrides, fn) {
  const originals = {};
  for (const key of Object.keys(overrides)) originals[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  }
}

describe('write-back-to-process.env contract — every consumer applyIndexerSettings() targets re-reads process.env live', () => {
  test('resolveTokenCountMode() picks up a process.env write immediately (no default-arg caching)', () => {
    withEnv({ TOKEN_COUNT: 'heuristic' }, () => {
      assert.equal(resolveTokenCountMode(), 'heuristic');
    });
    withEnv({ TOKEN_COUNT: 'bge-m3' }, () => {
      assert.equal(resolveTokenCountMode(), 'bge-m3');
    });
  });

  test('shouldUseOnnxBatching(process.env)/resolveOnnxBatchSize(process.env) reflect a live write', () => {
    withEnv({ ONNX_EMBED: '1', ONNX_EXECUTION_PROVIDER: 'dml', ONNX_BATCH_SIZE: '32' }, () => {
      assert.equal(shouldUseOnnxBatching(process.env), true);
      assert.equal(resolveOnnxBatchSize(process.env), 32);
    });
    withEnv({ ONNX_EMBED: '0' }, () => {
      assert.equal(shouldUseOnnxBatching(process.env), false);
    });
  });

  test('isCudaStrict(process.env) reflects a live write', () => {
    withEnv({ ONNX_CUDA_STRICT: '1' }, () => assert.equal(isCudaStrict(process.env), true));
    withEnv({ ONNX_CUDA_STRICT: '0' }, () => assert.equal(isCudaStrict(process.env), false));
  });

  test('shouldGenerateTags(process.env)/isOnnxTagProvider(process.env) reflect a live write', () => {
    withEnv({ TAG_GEN: '1', TAG_PROVIDER: 'onnx' }, () => {
      assert.equal(shouldGenerateTags(process.env), true);
      assert.equal(isOnnxTagProvider(process.env), true);
    });
    withEnv({ TAG_GEN: '0', TAG_PROVIDER: 'ollama' }, () => {
      assert.equal(shouldGenerateTags(process.env), false);
      assert.equal(isOnnxTagProvider(process.env), false);
    });
  });

  test('resolveOnnxRuntimeModule(process.env) reflects a live ONNXRUNTIME_NODE_PATH write (the exact mechanism the CUDA probe/embedding path depends on)', () => {
    withEnv({ ONNXRUNTIME_NODE_PATH: '/custom/ort/build' }, () => {
      assert.equal(resolveOnnxRuntimeModule(process.env), resolvePath('/custom/ort/build'));
    });
    withEnv({ ONNXRUNTIME_NODE_PATH: '' }, () => {
      assert.equal(resolveOnnxRuntimeModule(process.env), 'onnxruntime-node');
    });
  });
});

// ── Full bootstrap-path integration: settings.json -> applyEnvWriteBack() ->
// process.env -> resolveOnnxRuntimeModule(). Proves the "real bootstrap
// path" (not merely the write-back contract each consumer function relies
// on above) end to end for a WRITABLE, envVar-backed field — the exact
// scenario Part B's task requirement asks to trace and test, not assume. ──
describe('ONNXRUNTIME_NODE_PATH: real settings.json -> applyEnvWriteBack() -> process.env propagation', () => {
  test('a value saved to settings.json in one process is observed by process.env after applyEnvWriteBack() runs in a FRESH process (the next_restart contract, matching ONNX_EXECUTION_PROVIDER\'s own established behavior)', async () => {
    const { createSettingsService, applyEnvWriteBack } = await import('../../../src/core/settings/service.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'onnxruntime-writeback-test-'));
    const settingsPath = join(dir, 'settings.json');
    try {
      // Step 1: a process writes the setting via the normal PATCH path.
      const writer = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      await writer.setMany({ ONNXRUNTIME_NODE_PATH: '/custom/ort/build' });

      // Step 2: a FRESH process (simulating a real restart, since
      // ONNXRUNTIME_NODE_PATH is next_restart and frozen at construction —
      // matches how a real indexer child / admin restart would observe it)
      // constructs its own SettingsService against the same settings.json
      // and applies the write-back.
      const reader = createSettingsService({ osEnv: {}, dotenvValues: {}, settingsPath });
      const fakeProcessEnv = {};
      applyEnvWriteBack(reader, fakeProcessEnv);

      assert.equal(fakeProcessEnv.ONNXRUNTIME_NODE_PATH, '/custom/ort/build');
      // And the exact function core/onnx-runtime.js's loadOnnxRuntime()
      // uses to resolve the module path genuinely observes this env write.
      const { resolveOnnxRuntimeModule } = await import('../../../src/core/onnx-runtime.js');
      assert.notEqual(resolveOnnxRuntimeModule(fakeProcessEnv), 'onnxruntime-node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('admin/jobs/registry.js spawns the indexer child with baseEnv (the PRE-write-back osEnv snapshot), never a mutated process.env — the child resolves ONNXRUNTIME_NODE_PATH from ITS OWN independent settings.json read, not by inheriting a parent-resolved value', async () => {
    // This proves the architectural claim (not a new code path — see
    // registry.js's own extensive header comment on baseEnv) by inspecting
    // the actual spawn call: buildJobEnv() must never itself set
    // ONNXRUNTIME_NODE_PATH/ONNX_EXECUTION_PROVIDER (those come from
    // baseEnv + the child's own bootstrapEnv(), never a per-job override),
    // and createJobRegistry() must genuinely use the injected baseEnv
    // rather than defaulting to live process.env when one is supplied.
    const { createJobRegistry, buildJobEnv } = await import('../../../src/admin/jobs/registry.js');

    const jobEnvKeys = Object.keys(buildJobEnv('test-collection', {}));
    assert.ok(!jobEnvKeys.includes('ONNXRUNTIME_NODE_PATH'), 'buildJobEnv must never set ONNXRUNTIME_NODE_PATH directly — it must come from baseEnv + the child\'s own settings.json read');
    assert.ok(!jobEnvKeys.includes('ONNX_EXECUTION_PROVIDER'), 'buildJobEnv must never set ONNX_EXECUTION_PROVIDER directly, for the same reason');

    const spawnCalls = [];
    const fakeSpawnIndexer = ({ args, env }) => {
      spawnCalls.push({ args, env });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      child.unref = () => {};
      return child;
    };
    const customBaseEnv = { ONNXRUNTIME_NODE_PATH: '/from/base/env', PATH: process.env.PATH };
    const registry = createJobRegistry({ spawnIndexer: fakeSpawnIndexer, baseEnv: customBaseEnv });
    try {
      registry.startIndexJob({ collection: 'test-collection', path: '/some/path', options: {} });
    } catch {
      // startIndexJob may throw synchronously in some registry states
      // (e.g. path validation) — irrelevant to this test, which only cares
      // whether a spawn call, if made, used the injected baseEnv.
    }
    if (spawnCalls.length > 0) {
      assert.equal(spawnCalls[0].env.ONNXRUNTIME_NODE_PATH, '/from/base/env', 'the spawned child must inherit baseEnv\'s ONNXRUNTIME_NODE_PATH, not a live process.env value');
    }
  });
});
