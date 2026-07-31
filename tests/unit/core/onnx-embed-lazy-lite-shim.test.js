// core/onnx-embed-lazy.lite.js — the Semidex Lite package-build staging
// replacement for core/onnx-embed-lazy.js. Same three guarantees as
// ollama-lazy-lite-shim.test.js checks for the Ollama shim: export-surface
// parity, typed rejection instead of any real import, and no actual
// (non-comment) reference to the excluded modules in executable code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('core/onnx-embed-lazy.lite.js — Lite staging shim', () => {
  it('exports the exact same function names as the real core/onnx-embed-lazy.js (drop-in replacement)', async () => {
    const real = await import('../../../src/core/onnx-embed-lazy.js');
    const shim = await import('../../../src/core/onnx-embed-lazy.lite.js');
    const realFnNames = Object.keys(real).filter((k) => typeof real[k] === 'function').sort();
    const shimFnNames = Object.keys(shim)
      .filter((k) => typeof shim[k] === 'function' && k !== 'OnnxEmbedNotAvailableInLiteError')
      .sort();
    assert.deepEqual(shimFnNames, realFnNames);
  });

  it('every export rejects with a typed not_available_in_lite error instead of importing anything', async () => {
    const shim = await import('../../../src/core/onnx-embed-lazy.lite.js');
    const fnNames = Object.keys(shim).filter((k) => typeof shim[k] === 'function' && k !== 'OnnxEmbedNotAvailableInLiteError');
    assert.ok(fnNames.length > 0, 'sanity: the shim must actually export functions to test');
    for (const name of fnNames) {
      await assert.rejects(
        () => shim[name](),
        (err) => {
          assert.equal(err.code, 'not_available_in_lite', `${name}() must reject with code 'not_available_in_lite'`);
          assert.match(err.message, /Semidex Lite/, `${name}()'s error message must explain it is unavailable in Semidex Lite`);
          assert.match(err.message, new RegExp(`${name}\\(\\)`), `${name}()'s error message must name the function that was called`);
          return true;
        },
      );
    }
  });

  it('the shim module source contains no ACTUAL (non-comment) dynamic or static import of onnx-embed.js/length-bucket.js', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../src/core/onnx-embed-lazy.lite.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/import\(['"]\.\/onnx-embed\.js['"]\)/.test(codeOnly));
    assert.ok(!/from ['"]\.\/onnx-embed\.js['"]/.test(codeOnly));
    assert.ok(!/import\(['"]\.\/length-bucket\.js['"]\)/.test(codeOnly));
    assert.ok(!/from ['"]\.\/length-bucket\.js['"]/.test(codeOnly));
  });
});
