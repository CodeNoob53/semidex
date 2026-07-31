// global-settings-view.js — the IS_LITE/SEMIDEX_LITE dead-code-elimination
// guards (Semidex Lite package boundary, Part F). This is a structural test
// (source-regex), not a behavioral one — the real behavioral proof is the
// build output diff: an actual `vite build`/`vite build --config
// vite.config.lite.js` pair was run and the full build's compiled JS/HTML
// hash is BYTE-IDENTICAL to before these guards were added (proving zero
// behavior change for full Semidex), while the Lite build's compiled
// output has zero occurrences of every local-only marker below (proving
// real dead-code elimination, not just runtime hiding). That diff isn't
// reproducible in a fast unit test (it requires two real Vite builds), so
// this test instead pins the SOURCE-level contract that makes that outcome
// possible: every function containing a local-only marker starts with an
// IS_LITE early-return, and IS_LITE itself is declared in a way that never
// throws when SEMIDEX_LITE is an undeclared global (the exact bug this
// test suite caught once already — see IS_LITE's own header comment).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC_PATH = new URL('../../../src/admin/ui-src/global-settings-view.js', import.meta.url);
const src = readFileSync(SRC_PATH, 'utf-8');

describe('global-settings-view.js — IS_LITE guard declaration', () => {
  it('IS_LITE is declared with a typeof guard, never a bare SEMIDEX_LITE reference', () => {
    assert.match(src, /const IS_LITE = typeof SEMIDEX_LITE !== 'undefined' && SEMIDEX_LITE;/);
  });

  it('no bare (non-typeof-guarded) reference to SEMIDEX_LITE exists outside the IS_LITE declaration itself and comments', () => {
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    const bareRefs = codeOnly.match(/(?<!typeof )SEMIDEX_LITE/g) ?? [];
    // Exactly one occurrence is expected: the right-hand `&& SEMIDEX_LITE`
    // in the IS_LITE declaration itself (the left side of `!==` is preceded
    // by `typeof `, which the negative lookbehind above already excludes).
    assert.equal(bareRefs.length, 1, `expected exactly 1 non-typeof-guarded SEMIDEX_LITE reference (found ${bareRefs.length}) — a bare reference anywhere else would throw ReferenceError when this file is loaded outside a Vite build (e.g. this repo's own vm.Script-based test harness)`);
  });
});

describe('global-settings-view.js — local-only functions start with an IS_LITE guard', () => {
  const guardedFunctions = [
    { name: 'onnxProbePanel', signature: 'function onnxProbePanel(category, entries) {', guard: 'if (IS_LITE) return null;' },
    { name: 'wireOnnxProbePanel', signature: 'function wireOnnxProbePanel(container, category) {', guard: 'if (IS_LITE) return;' },
    { name: 'categoryNeedsOllamaModels', signature: 'function categoryNeedsOllamaModels(category) {', guard: 'if (IS_LITE) return false;' },
    { name: 'refreshOllamaModels', signature: 'async function refreshOllamaModels(main, category, myGeneration, { forceRefresh = false } = {}) {', guard: 'if (IS_LITE) return;' },
  ];

  for (const { name, signature, guard } of guardedFunctions) {
    it(`${name}() has its IS_LITE guard as the first statement in its body`, () => {
      const sigIndex = src.indexOf(signature);
      assert.ok(sigIndex !== -1, `could not find ${name}()'s exact signature — function may have been refactored; update this test's expected signature string`);
      const afterSig = src.slice(sigIndex + signature.length, sigIndex + signature.length + guard.length + 5).trim();
      assert.ok(afterSig.startsWith(guard), `${name}()'s first statement must be "${guard}" — found: "${afterSig.slice(0, 60)}..."`);
    });
  }
});

describe('global-settings-view.js — generic/shared infrastructure stays unguarded', () => {
  it('categoryNeedsGenerationModels() (provider-neutral, used by both Ollama and Gemini) has NO IS_LITE guard', () => {
    const sigIndex = src.indexOf('function categoryNeedsGenerationModels(category) {');
    assert.ok(sigIndex !== -1);
    const body = src.slice(sigIndex, sigIndex + 200);
    assert.ok(!body.includes('IS_LITE'), 'categoryNeedsGenerationModels() must stay unguarded — it is shared generic infrastructure, not local-only code (guarding it would change full-Semidex behavior)');
  });

  it('fieldRow() (the generic per-setting row renderer every category uses) has NO IS_LITE guard', () => {
    const sigIndex = src.indexOf('function fieldRow(category, entry) {');
    assert.ok(sigIndex !== -1);
    const body = src.slice(sigIndex, sigIndex + 200);
    assert.ok(!body.includes('IS_LITE'));
  });
});
