// Tests for src/core/onnx-paths.js's ONNX_DENSE_MODEL_ID — the single
// source of truth for the ONNX dense-embedding model's HF repo id.
// Declared here (not onnx-embed.js) specifically because this module has
// no side-effect-heavy imports (onnxruntime-node/@huggingface/transformers)
// and is safe to import from the settings registry / doctor / tools —
// unlike onnx-embed.js itself.
//
// The "no duplicate literal" regression check is source-grep-based
// deliberately: onnx-embed.js cannot be imported directly in this unit
// suite without pulling in onnxruntime-node, so behavioral testing of the
// runtime consumers isn't practical here — this pins the single-source-of-
// truth invariant at the text level instead.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ONNX_DENSE_MODEL_ID } from '../../../src/core/onnx-paths.js';

describe('ONNX_DENSE_MODEL_ID', () => {
  it('is the expected HF repo id', () => {
    assert.equal(ONNX_DENSE_MODEL_ID, 'aapot/bge-m3-onnx');
  });

  it('the literal string appears in exactly one source file (onnx-paths.js\'s own declaration)', async () => {
    const files = [
      'src/core/onnx-paths.js',
      'src/core/onnx-embed.js',
      'src/core/config.js',
      'src/core/bge-tokenizer.js',
    ];
    for (const relPath of files) {
      const src = await readFile(new URL(`../../../${relPath}`, import.meta.url), 'utf-8');
      const literalMatches = src.match(/'aapot\/bge-m3-onnx'/g) ?? [];
      if (relPath === 'src/core/onnx-paths.js') {
        assert.equal(literalMatches.length, 1, `${relPath}: expected exactly one declaration of the literal`);
      } else {
        assert.equal(literalMatches.length, 0, `${relPath}: must import ONNX_DENSE_MODEL_ID, not re-hardcode the literal string`);
      }
    }
  });

  it('onnx-embed.js imports and re-exports ONNX_DENSE_MODEL_ID from onnx-paths.js', async () => {
    const src = await readFile(new URL('../../../src/core/onnx-embed.js', import.meta.url), 'utf-8');
    assert.match(src, /import\s*\{[^}]*ONNX_DENSE_MODEL_ID[^}]*\}\s*from\s*['"]\.\/onnx-paths\.js['"]/);
  });

  it('config.js, bge-tokenizer.js import ONNX_DENSE_MODEL_ID from onnx-paths.js', async () => {
    const configSrc = await readFile(new URL('../../../src/core/config.js', import.meta.url), 'utf-8');
    assert.match(configSrc, /import\s*\{\s*ONNX_DENSE_MODEL_ID\s*\}\s*from\s*['"]\.\/onnx-paths\.js['"]/);

    // token-count.js delegates tokenizer loading to bge-tokenizer.js
    // entirely (see that module's own header for why: isolating
    // @huggingface/tokenizers from the CUDA-sensitive onnxruntime-node
    // load path) and no longer needs ONNX_DENSE_MODEL_ID directly —
    // bge-tokenizer.js is the actual consumer now.
    const tokenizerSrc = await readFile(new URL('../../../src/core/bge-tokenizer.js', import.meta.url), 'utf-8');
    assert.match(tokenizerSrc, /import\s*\{[^}]*ONNX_DENSE_MODEL_ID[^}]*\}\s*from\s*['"]\.\/onnx-paths\.js['"]/);
  });

  it('sync.js no longer imports ONNX_DENSE_MODEL_ID at all — it never builds a profile from scratch, only reads/migrates native metadata (Part D of the native-metadata task)', async () => {
    const syncSrc = await readFile(new URL('../../../src/sync.js', import.meta.url), 'utf-8');
    assert.ok(!/ONNX_DENSE_MODEL_ID/.test(syncSrc));
  });

  it('token-count.js does not import ONNX_DENSE_MODEL_ID directly — it delegates tokenizer loading to bge-tokenizer.js', async () => {
    const tokenCountSrc = await readFile(new URL('../../../src/core/token-count.js', import.meta.url), 'utf-8');
    assert.ok(!/ONNX_DENSE_MODEL_ID/.test(tokenCountSrc));
    assert.match(tokenCountSrc, /import\s*\{[^}]*loadBgeTokenizer[^}]*\}\s*from\s*['"]\.\/bge-tokenizer\.js['"]/);
  });
});

describe('isOnnxModelCached — the ONE definition of "is the model really on disk"', () => {
  it('matches existsSync(model.onnx) && existsSync(model.onnx.data) against the real filesystem (whatever state it happens to be in)', async () => {
    const { existsSync } = await import('node:fs');
    const { isOnnxModelCached, getOnnxModelPath } = await import('../../../src/core/onnx-paths.js');
    const modelPath = getOnnxModelPath();
    const expected = existsSync(modelPath) && existsSync(`${modelPath}.data`);
    assert.equal(isOnnxModelCached(), expected);
  });

  it('onnx-probe-runner.js imports and calls isOnnxModelCached() rather than re-implementing the same two existsSync checks inline', async () => {
    const probeRunnerSrc = await readFile(new URL('../../../src/core/onnx-probe-runner.js', import.meta.url), 'utf-8');
    assert.match(probeRunnerSrc, /import\s*\{[^}]*isOnnxModelCached[^}]*\}\s*from\s*['"]\.\/onnx-paths\.js['"]/);
    assert.match(probeRunnerSrc, /const modelCached = isOnnxModelCached\(\)/);
    assert.ok(!/existsSync\(modelPath\)\s*&&\s*existsSync\(modelDataPath\)/.test(probeRunnerSrc), 'must not re-implement the same check inline anymore');
  });
});
