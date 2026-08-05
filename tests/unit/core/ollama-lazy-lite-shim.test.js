// core/ollama-lazy.lite.js — the Semidex Lite package-build staging
// replacement for core/ollama-lazy.js.
//
// local/core/ollama.js is never shipped in the Lite tarball, so the real
// ollama-lazy.js's `await import('../local/core/ollama.js')` is a literal
// dynamic-import target that would throw ERR_MODULE_NOT_FOUND in an
// installed Lite package if it were ever reached. build.mjs (the Lite
// package build) substitutes THIS file under the exact same path
// (core/ollama-lazy.js) when staging, so every caller's import specifier
// is unchanged and no caller needs to know which variant it's running
// against.
//
// This test proves three things: (1) the shim's export surface is a
// drop-in match for the real loader (same names, all callable the same
// way), (2) every export rejects with a typed, legible error instead of
// attempting any import, and (3) the error is clearly labeled so a future
// accidental Lite call path fails loudly and diagnosably rather than with
// a bare module-resolution crash.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('core/ollama-lazy.lite.js — Lite staging shim', () => {
  it('exports the exact same function names as the real core/ollama-lazy.js (drop-in replacement)', async () => {
    const real = await import('../../../src/core/ollama-lazy.js');
    const shim = await import('../../../src/core/ollama-lazy.lite.js');
    const realFnNames = Object.keys(real).filter((k) => typeof real[k] === 'function').sort();
    const shimFnNames = Object.keys(shim)
      .filter((k) => typeof shim[k] === 'function' && k !== 'OllamaNotAvailableInLiteError')
      .sort();
    assert.deepEqual(shimFnNames, realFnNames);
  });

  it('every export rejects with a typed not_available_in_lite error instead of importing anything', async () => {
    const shim = await import('../../../src/core/ollama-lazy.lite.js');
    const fnNames = Object.keys(shim).filter((k) => typeof shim[k] === 'function' && k !== 'OllamaNotAvailableInLiteError');
    assert.ok(fnNames.length > 0, 'sanity: the shim must actually export functions to test');
    for (const name of fnNames) {
      await assert.rejects(
        () => shim[name]('arg1', 'arg2'),
        (err) => {
          assert.equal(err.code, 'not_available_in_lite', `${name}() must reject with code 'not_available_in_lite'`);
          assert.match(err.message, /Semidex Lite/, `${name}()'s error message must explain it is unavailable in Semidex Lite`);
          assert.match(err.message, new RegExp(`${name}\\(\\)`), `${name}()'s error message must name the function that was called`);
          return true;
        },
      );
    }
  });

  it('the shim module source contains no ACTUAL (non-comment) dynamic or static import of local/core/ollama.js', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../src/core/ollama-lazy.lite.js', import.meta.url), 'utf-8');
    // Strip line comments first — the file's header deliberately QUOTES the
    // real loader's `await import('../local/core/ollama.js')` in prose, to
    // explain why the shim exists. Checking the raw source (including
    // comments) would false-positive on that documentation; the real
    // invariant is about executable code only.
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/import\(['"]\.\.\/local\/core\/ollama\.js['"]\)/.test(codeOnly), 'must not dynamically import ../local/core/ollama.js in executable code');
    assert.ok(!/from ['"]\.\.\/local\/core\/ollama\.js['"]/.test(codeOnly), 'must not statically import ../local/core/ollama.js in executable code');
  });
});
