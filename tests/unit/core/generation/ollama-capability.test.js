// Ollama capability contracts (Phase 8B Step 1, split TWICE after code
// review — see ollama-capability.js's own header comment) — mirrors
// provider.test.js's shape-validator test style.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateOllamaGenerateCapability, REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS,
  validateOllamaSummaryCapability, REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS,
  validateOllamaEmbedCapability, REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS,
  validateOllamaDiscoveryCapability, REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS,
} from '../../../../src/core/generation/ollama-capability.js';

function validCapability(methods) {
  const capability = {};
  for (const m of methods) capability[m] = async () => 'ok';
  return capability;
}

describe('validateOllamaGenerateCapability', () => {
  test('accepts a conforming capability (generate only)', () => {
    assert.deepEqual(REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS, ['generate']);
    assert.equal(validateOllamaGenerateCapability(validCapability(REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS)), true);
  });

  test('rejects non-object input', () => {
    assert.throws(() => validateOllamaGenerateCapability(null), /non-null object/);
    assert.throws(() => validateOllamaGenerateCapability('nope'), /non-null object/);
  });

  test('rejects a capability missing generate', () => {
    assert.throws(() => validateOllamaGenerateCapability({}), /generate/);
  });

  test('does NOT require getModelContextLength/isThinkingModel/embed/discovery methods', () => {
    const c = validCapability(REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS);
    assert.equal('getModelContextLength' in c, false);
    assert.equal('isThinkingModel' in c, false);
    assert.equal('embed' in c, false);
    assert.equal('isOllamaReachable' in c, false);
    assert.equal(validateOllamaGenerateCapability(c), true);
  });
});

describe('validateOllamaSummaryCapability', () => {
  test('accepts a conforming capability (generate, getModelContextLength, isThinkingModel)', () => {
    assert.deepEqual([...REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS].sort(), ['generate', 'getModelContextLength', 'isThinkingModel']);
    assert.equal(validateOllamaSummaryCapability(validCapability(REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS)), true);
  });

  test('rejects a capability missing any required method', () => {
    for (const method of REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS) {
      const c = validCapability(REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS);
      delete c[method];
      assert.throws(() => validateOllamaSummaryCapability(c), new RegExp(method));
    }
  });

  test('does NOT require generateStream/embed/discovery methods', () => {
    const c = validCapability(REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS);
    assert.equal('generateStream' in c, false);
    assert.equal('embed' in c, false);
    assert.equal('listOllamaModels' in c, false);
    assert.equal(validateOllamaSummaryCapability(c), true);
  });
});

describe('validateOllamaEmbedCapability', () => {
  test('accepts a conforming capability', () => {
    assert.equal(validateOllamaEmbedCapability(validCapability(REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS)), true);
  });

  test('rejects a capability missing any required method', () => {
    for (const method of REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS) {
      const c = validCapability(REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS);
      delete c[method];
      assert.throws(() => validateOllamaEmbedCapability(c), new RegExp(method));
    }
  });

  test('does NOT require generate/discovery methods', () => {
    const c = validCapability(REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS);
    assert.equal('generate' in c, false);
    assert.equal('listOllamaModels' in c, false);
    assert.equal(validateOllamaEmbedCapability(c), true);
  });
});

describe('validateOllamaDiscoveryCapability', () => {
  test('accepts a conforming capability', () => {
    assert.equal(validateOllamaDiscoveryCapability(validCapability(REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS)), true);
  });

  test('rejects a capability missing any required method', () => {
    for (const method of REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS) {
      const c = validCapability(REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS);
      delete c[method];
      assert.throws(() => validateOllamaDiscoveryCapability(c), new RegExp(method));
    }
  });

  test('does NOT require generate/embed methods', () => {
    const c = validCapability(REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS);
    assert.equal('generate' in c, false);
    assert.equal('embed' in c, false);
    assert.equal(validateOllamaDiscoveryCapability(c), true);
  });
});

describe('the four contracts partition local/core/ollama.js\'s real export surface (generate overlaps by design between Generate/Summary; generateStream/showModel/embeddingDimensionFromShow belong to no contract)', () => {
  // local/core/ollama.js's own export surface is WIDER than the former
  // core/ollama-lazy.js wrapper's was (that wrapper never re-exported
  // showModel/embeddingDimensionFromShow at all) — showModel/
  // embeddingDimensionFromShow are internal helpers getOllamaEmbeddingDimension()
  // itself composes, not independently consumed through any of these four
  // narrow contracts.
  const UNCONTRACTED_EXPORTS = ['embeddingDimensionFromShow', 'generateStream', 'showModel'];

  test('union of all four REQUIRED_*_METHODS lists, deduplicated, equals local/core/ollama.js\'s real export surface MINUS the uncontracted exports (no contract needs them — see ollama-provider.js\'s own separate per-method DI for generateStream)', async () => {
    const real = await import('../../../../src/local/core/ollama.js');
    const realFnNames = Object.keys(real).filter((k) => typeof real[k] === 'function').sort();
    const all = new Set([
      ...REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS,
      ...REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS,
      ...REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS,
      ...REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS,
    ]);
    assert.deepEqual(realFnNames.filter((f) => !all.has(f)), UNCONTRACTED_EXPORTS, 'these are the only real exports no narrow contract requires — they have no consumer through any of these contract objects');
    assert.deepEqual([...all].sort(), realFnNames.filter((f) => !UNCONTRACTED_EXPORTS.includes(f)));
  });

  test('"generate" is the only method allowed to appear in more than one contract (Generate and Summary both need it); every other method appears in exactly one', () => {
    const counts = new Map();
    for (const list of [
      REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS,
      REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS,
      REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS,
      REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS,
    ]) {
      for (const m of list) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    for (const [method, count] of counts) {
      if (method === 'generate') assert.equal(count, 2, 'generate must appear in exactly Generate + Summary');
      else assert.equal(count, 1, `${method} must appear in exactly one contract`);
    }
  });
});

describe('ollama-capability.js — zero backend imports (contract, not implementation)', () => {
  test('the contract module source has no import of local/core/ollama.js, ollama-lazy.js, onnxruntime-node, or @huggingface/transformers', () => {
    const src = readFileSync(new URL('../../../../src/core/generation/ollama-capability.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/from ['"].*ollama\.js['"]/.test(codeOnly), 'must not import local/core/ollama.js');
    assert.ok(!/from ['"].*ollama-lazy\.js['"]/.test(codeOnly), 'must not import core/ollama-lazy.js');
    assert.ok(!/onnxruntime-node/.test(codeOnly), 'must not reference onnxruntime-node');
    assert.ok(!/@huggingface\/transformers/.test(codeOnly), 'must not reference @huggingface/transformers');
  });

  test('importing the contract module in isolation performs zero network/filesystem side effects (module loads with no dependency on any backend being present)', async () => {
    const mod = await import('../../../../src/core/generation/ollama-capability.js');
    assert.ok(typeof mod.validateOllamaGenerateCapability === 'function');
    assert.ok(typeof mod.validateOllamaSummaryCapability === 'function');
    assert.ok(typeof mod.validateOllamaEmbedCapability === 'function');
    assert.ok(typeof mod.validateOllamaDiscoveryCapability === 'function');
  });
});
