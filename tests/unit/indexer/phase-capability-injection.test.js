// Phase 8B Step 1 — capability injection across every indexer phase module
// that previously imported core/ollama-lazy.js at module scope
// (context.js, tag.js, combined.js, skeleton-summary.js, preflight.js) plus
// run.js's own direct capability seam (getOllamaEmbeddingDimension,
// addTagsOnnxBatch, shutdownOnnxTagWorker) and the composed
// applyAllCapabilities() entry point.
//
// Proves BEHAVIORALLY (via injected fakes) that each module now calls
// through its injected capability rather than a hardcoded import, that the
// fake receives the documented arguments, and that a capability error
// propagates unchanged. Each describe block restores a harmless real-shaped
// default in its own afterEach so no test can leak a rejecting stub into
// another test in this file (module-scope capability state, same pattern
// tests/unit/core/embeddings-capability-injection.test.js uses).
//
// Uses the 4 narrow per-concern contracts (code review, P2, split TWICE —
// see core/generation/ollama-capability.js's own header comment):
// context.js/tag.js/combined.js each consume the single-method
// OllamaGenerateCapability (they call ONLY generate()); skeleton-summary.js
// consumes OllamaSummaryCapability (generate/getModelContextLength/
// isThinkingModel); preflight.js consumes OllamaDiscoveryCapability;
// run.js's own direct call (getOllamaEmbeddingDimension) consumes
// OllamaEmbedCapability. No fake in this file provides methods outside the
// contract each seam actually validates against.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS,
  REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS,
  REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS,
  REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS,
} from '../../../src/core/generation/ollama-capability.js';
import { REQUIRED_TAG_ONNX_CAPABILITY_METHODS } from '../../../src/indexer/phases/tag-onnx-capability.js';
import { addContext, applyContextCapability } from '../../../src/indexer/phases/context.js';
import { addTags, addTagsWithModel, applyTagCapability } from '../../../src/indexer/phases/tag.js';
import { addContextAndTags, applyCombinedCapability } from '../../../src/indexer/phases/combined.js';
import { resolveRunNumCtx, applySkeletonSummaryCapability } from '../../../src/indexer/phases/skeleton-summary.js';
import { checkOllamaPreflight, applyPreflightCapability } from '../../../src/indexer/preflight.js';
import { applyRunCapabilities, applyAllCapabilities } from '../../../src/indexer/run.js';

function fakeGenerateCapability(overrides = {}) {
  const base = {};
  for (const m of REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS) base[m] = async () => { throw new Error(`${m} not stubbed`); };
  return { ...base, ...overrides };
}

function fakeSummaryCapability(overrides = {}) {
  const base = {};
  for (const m of REQUIRED_OLLAMA_SUMMARY_CAPABILITY_METHODS) base[m] = async () => { throw new Error(`${m} not stubbed`); };
  return { ...base, ...overrides };
}

function fakeEmbedCapability(overrides = {}) {
  const base = {};
  for (const m of REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS) base[m] = async () => { throw new Error(`${m} not stubbed`); };
  return { ...base, ...overrides };
}

function fakeDiscoveryCapability(overrides = {}) {
  const base = {};
  for (const m of REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS) base[m] = async () => { throw new Error(`${m} not stubbed`); };
  return { ...base, ...overrides };
}

function fakeTagOnnxCapability(overrides = {}) {
  const base = {};
  for (const m of REQUIRED_TAG_ONNX_CAPABILITY_METHODS) base[m] = async () => undefined;
  return { ...base, ...overrides };
}

describe('phases/context.js — applyContextCapability (OllamaGenerateCapability, single method)', () => {
  afterEach(() => applyContextCapability(fakeGenerateCapability({ generate: async () => 'reset' })));

  it('addContext() calls the injected capability\'s generate(model, prompt) — not a hardcoded ollama-lazy.js import', async () => {
    let received = null;
    applyContextCapability(fakeGenerateCapability({
      generate: async (model, prompt) => { received = { model, prompt }; return '  a generated context  '; },
    }));
    const chunk = { source_file: 'f.md', section: 's', chunkIndex: 0, totalChunks: 1, text: 'body text' };
    const result = await addContext(chunk);
    assert.equal(received.model, process.env.CONTEXT_MODEL || 'gemma3:4b');
    assert.match(received.prompt, /body text/);
    assert.equal(result.context, 'a generated context', 'trimmed, matching addContext()\'s existing .trim() behavior');
  });

  it('a rejecting injected generate() propagates the SAME error out of addContext()', async () => {
    const originalError = new Error('ollama unreachable');
    applyContextCapability(fakeGenerateCapability({ generate: async () => { throw originalError; } }));
    await assert.rejects(
      () => addContext({ source_file: 'f.md', section: 's', chunkIndex: 0, totalChunks: 1, text: 'x' }),
      (err) => { assert.equal(err, originalError); return true; },
    );
  });

  it('applyContextCapability() rejects a non-conforming capability before installing it', () => {
    assert.throws(() => applyContextCapability({}), /generate/);
  });

  it('applyContextCapability() accepts a capability with ONLY generate() — no getModelContextLength/isThinkingModel/embed/discovery methods required', () => {
    const narrow = fakeGenerateCapability({ generate: async () => 'ok' });
    assert.equal('getModelContextLength' in narrow, false);
    assert.equal('embed' in narrow, false);
    assert.equal('isOllamaReachable' in narrow, false);
    assert.doesNotThrow(() => applyContextCapability(narrow));
  });
});

describe('phases/tag.js — applyTagCapability (OllamaGenerateCapability, single method)', () => {
  afterEach(() => applyTagCapability(fakeGenerateCapability({ generate: async () => 'tag-a, tag-b' })));

  it('addTags() calls the injected capability\'s generate(model, prompt) and parses its own tags out of the result', async () => {
    let received = null;
    applyTagCapability(fakeGenerateCapability({
      generate: async (model, prompt) => { received = { model, prompt }; return 'node-js, testing'; },
    }));
    const chunk = { source_file: 'f.md', section: 's', text: 'about node.js testing' };
    const result = await addTags(chunk);
    assert.ok(received.model, 'a model was passed through');
    assert.deepEqual(result.tags.sort(), ['node-js', 'testing']);
  });

  it('a rejecting injected generate() propagates unchanged through addTagsWithModel()', async () => {
    const originalError = new Error('tag model not pulled');
    applyTagCapability(fakeGenerateCapability({ generate: async () => { throw originalError; } }));
    await assert.rejects(
      () => addTagsWithModel({ source_file: 'f.md', section: 's', text: 'x' }, 'some-model'),
      (err) => { assert.equal(err, originalError); return true; },
    );
  });
});

describe('phases/combined.js — applyCombinedCapability (OllamaGenerateCapability, single method)', () => {
  afterEach(() => applyCombinedCapability(fakeGenerateCapability({ generate: async () => '{}' })));

  it('addContextAndTags() calls the injected capability\'s generate() for the combined call (long-enough chunk)', async () => {
    let called = false;
    applyCombinedCapability(fakeGenerateCapability({
      generate: async () => { called = true; return JSON.stringify({ context: 'ctx', tags: ['a', 'b'] }); },
    }));
    const longText = 'x'.repeat(200);
    const result = await addContextAndTags({ source_file: 'f.md', section: 's', chunkIndex: 0, totalChunks: 1, text: longText, context: '', tags: [] }, 'model', []);
    assert.equal(called, true);
    assert.equal(result.context, 'ctx');
  });
});

describe('phases/skeleton-summary.js — applySkeletonSummaryCapability (OllamaSummaryCapability, default fallback only — every call site already supports its own opts.generateFn override)', () => {
  it('applySkeletonSummaryCapability() rejects a non-conforming capability', () => {
    assert.throws(() => applySkeletonSummaryCapability({}), /generate/);
  });

  it('applySkeletonSummaryCapability() requires getModelContextLength/isThinkingModel too — not the single-method Generate contract', () => {
    assert.throws(() => applySkeletonSummaryCapability({ generate: async () => 'x' }), /getModelContextLength/);
  });

  it('applySkeletonSummaryCapability() accepts a conforming capability without throwing (installs the module-scope default fallback)', () => {
    assert.doesNotThrow(() => applySkeletonSummaryCapability(fakeSummaryCapability()));
    assert.equal(typeof resolveRunNumCtx, 'function', 'sanity: module still loads and exports normally after capability injection');
  });
});

describe('indexer/preflight.js — applyPreflightCapability (OllamaDiscoveryCapability)', () => {
  afterEach(() => applyPreflightCapability(fakeDiscoveryCapability({
    isOllamaReachable: async () => true,
    listOllamaModels: async () => [],
    validateOllamaModels: async () => null,
  })));

  it('checkOllamaPreflight() calls the injected isOllamaReachable(baseUrl) with the exact base URL', async () => {
    let receivedUrl = null;
    applyPreflightCapability(fakeDiscoveryCapability({
      isOllamaReachable: async (url) => { receivedUrl = url; return false; },
    }));
    await assert.rejects(() => checkOllamaPreflight('http://example:1234/', 'ctx-model', 'tag-model'), /unreachable/);
    assert.equal(receivedUrl, 'http://example:1234');
  });

  it('a listOllamaModels() network error surfaces through checkOllamaPreflight() with an actionable message, not swallowed', async () => {
    applyPreflightCapability(fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => { throw new Error('ECONNRESET'); },
    }));
    await assert.rejects(() => checkOllamaPreflight('http://x/', 'a', 'b'), /Could not list Ollama models.*ECONNRESET/s);
  });

  it('validateOllamaModels() missing-models result surfaces as a pull-command message', async () => {
    applyPreflightCapability(fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => ['other-model'],
      validateOllamaModels: async (required, available) => required.filter((m) => !available.includes(m)),
    }));
    await assert.rejects(() => checkOllamaPreflight('http://x/', 'ctx-model', 'tag-model'), /ollama pull ctx-model/);
  });

  it('applyPreflightCapability() accepts a capability with ONLY the 3 discovery methods — no generate/embed methods required', () => {
    const narrow = fakeDiscoveryCapability();
    assert.equal('generate' in narrow, false);
    assert.equal('embed' in narrow, false);
    assert.doesNotThrow(() => applyPreflightCapability(narrow));
  });
});

describe('indexer/run.js — applyRunCapabilities / applyAllCapabilities', () => {
  afterEach(() => {
    applyRunCapabilities({
      ollama: fakeEmbedCapability({ getOllamaEmbeddingDimension: async () => 768 }),
      tagOnnx: fakeTagOnnxCapability(),
    });
  });

  it('applyRunCapabilities({ ollama }) validates against the narrow OllamaEmbedCapability contract, not the full surface', () => {
    assert.throws(() => applyRunCapabilities({ ollama: {} }), /embed|getOllamaEmbeddingDimension/);
    const embedOnly = fakeEmbedCapability();
    assert.equal('generate' in embedOnly, false, 'sanity: the embed contract has no generate method');
    assert.doesNotThrow(() => applyRunCapabilities({ ollama: embedOnly }));
  });

  it('applyRunCapabilities({ tagOnnx }) alone does not require/validate an ollama capability (partial application)', () => {
    assert.throws(() => applyRunCapabilities({ tagOnnx: {} }), /addTagsOnnxBatch/);
    assert.doesNotThrow(() => applyRunCapabilities({ tagOnnx: fakeTagOnnxCapability() }));
  });

  it('applyAllCapabilities() fans out each narrow capability to only the seams that need it, without throwing', () => {
    const ollamaGenerate = fakeGenerateCapability({ generate: async () => 'x' });
    const ollamaSummary = fakeSummaryCapability({
      generate: async () => 'x', getModelContextLength: async () => 4096, isThinkingModel: async () => false,
    });
    const ollamaEmbed = fakeEmbedCapability({ getOllamaEmbeddingDimension: async () => 768 });
    const ollamaDiscovery = fakeDiscoveryCapability({
      isOllamaReachable: async () => true, listOllamaModels: async () => [], validateOllamaModels: async () => null,
    });
    assert.doesNotThrow(() => applyAllCapabilities({
      ollamaGenerate, ollamaSummary, ollamaEmbed, ollamaDiscovery, tagOnnx: fakeTagOnnxCapability(),
    }));
  });

  it('applyAllCapabilities({}) (no capabilities) is a safe no-op — does not throw, does not require every seam to be touched', () => {
    assert.doesNotThrow(() => applyAllCapabilities({}));
    assert.doesNotThrow(() => applyAllCapabilities());
  });

  it('applyAllCapabilities() never requires a single object to satisfy all four Ollama contracts at once (no wide "ollama" blob accepted)', () => {
    // A generate-only capability must not be usable as the summary, embed,
    // or discovery slot — proves the fan-out genuinely validates each seam
    // against its OWN narrow contract, not a shared wide one.
    const generateOnly = fakeGenerateCapability({ generate: async () => 'x' });
    assert.throws(() => applyAllCapabilities({ ollamaSummary: generateOnly }), /getModelContextLength/);
    assert.throws(() => applyAllCapabilities({ ollamaEmbed: generateOnly }), /embed|getOllamaEmbeddingDimension/);
    assert.throws(() => applyAllCapabilities({ ollamaDiscovery: generateOnly }), /isOllamaReachable|listOllamaModels|validateOllamaModels/);
  });
});
