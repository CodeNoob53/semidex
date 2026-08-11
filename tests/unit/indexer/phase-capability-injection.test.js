// Phase 8B Step 3 — instance-scoped capability injection across every
// indexer phase module that previously used a module-scope apply*Capability()
// setter (context.js, tag.js, combined.js, skeleton-summary.js, preflight.js)
// plus run.js's own run({ capabilities }) -> local buildRunContext() ctx,
// threaded explicitly through main()/stageA/stageB/stageC. run.js holds no
// module-scope capability state at all — an earlier "run-scoped snapshot"
// design (applyRunCapabilities()/applyAllCapabilities()/ollamaCapabilities())
// was rejected on code review for still being module-scope mutable state
// under real concurrency, and was removed entirely (see run.js's own header
// comment and docs/design/phase-8b-step3-local-ollama-relocation-2026-08-05.md §2.3).
//
// Proves BEHAVIORALLY (via injected fakes) that each function calls through
// its EXPLICIT capability argument — never a module-scope binding of its
// own — that the fake receives the documented arguments, and that a
// capability error propagates unchanged. Also proves the five phase files
// have NO module-scope setter left to leak state between tests (each test
// constructs its own capability object and passes it directly, so there is
// nothing to reset in afterEach — a structural difference from the old
// Step 1 design this file replaces).
//
// Uses the 4 narrow per-concern contracts (core/generation/ollama-capability.js):
// context.js/tag.js/combined.js each consume the single-method
// OllamaGenerateCapability (they call ONLY generate()); skeleton-summary.js
// consumes individual generateFn/getModelContextLengthFn/isThinkingModelFn
// function arguments (not a capability OBJECT — see its own header comment);
// preflight.js consumes OllamaDiscoveryCapability; run.js's own direct call
// (getOllamaEmbeddingDimension) consumes OllamaEmbedCapability.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS,
  REQUIRED_OLLAMA_EMBED_CAPABILITY_METHODS,
  REQUIRED_OLLAMA_DISCOVERY_CAPABILITY_METHODS,
  REQUIRED_OLLAMA_RESOURCE_IDENTITY_CAPABILITY_METHODS,
} from '../../../src/core/generation/ollama-capability.js';
import { REQUIRED_TAG_ONNX_CAPABILITY_METHODS } from '../../../src/shared/indexer/phases/tag-onnx-capability.js';
import { addContext } from '../../../src/shared/indexer/phases/context.js';
import { addTags, addTagsWithModel } from '../../../src/shared/indexer/phases/tag.js';
import { addContextAndTags } from '../../../src/shared/indexer/phases/combined.js';
import { resolveRunNumCtx, generateNavSummaries } from '../../../src/shared/indexer/phases/skeleton-summary.js';
import { checkOllamaPreflight, ensureOllamaPreflight } from '../../../src/shared/indexer/preflight.js';
import { run, stageB } from '../../../src/shared/indexer/run.js';
import { createCloudEmbeddingCapability } from '../../../src/cloud/embedding/cloud-embedding-provider.js';

function fakeGenerateCapability(overrides = {}) {
  const base = {};
  for (const m of REQUIRED_OLLAMA_GENERATE_CAPABILITY_METHODS) base[m] = async () => { throw new Error(`${m} not stubbed`); };
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

function fakeResourceIdentityCapability(overrides = {}) {
  const base = {};
  for (const m of REQUIRED_OLLAMA_RESOURCE_IDENTITY_CAPABILITY_METHODS) base[m] = async () => { throw new Error(`${m} not stubbed`); };
  return { ...base, ...overrides };
}

function fakeTagOnnxCapability(overrides = {}) {
  const base = {};
  for (const m of REQUIRED_TAG_ONNX_CAPABILITY_METHODS) base[m] = async () => undefined;
  return { ...base, ...overrides };
}

describe('phases/context.js — addContext(chunk, opts) takes its capability as a real argument, no module-scope setter', () => {
  it('addContext() calls opts.ollama.generate(model, prompt) — not a hardcoded ollama-lazy.js import, not a module-scope binding', async () => {
    let received = null;
    const ollama = fakeGenerateCapability({
      generate: async (model, prompt) => { received = { model, prompt }; return '  a generated context  '; },
    });
    const chunk = { source_file: 'f.md', section: 's', chunkIndex: 0, totalChunks: 1, text: 'body text' };
    const result = await addContext(chunk, { ollama });
    assert.equal(received.model, process.env.CONTEXT_MODEL || 'gemma3:4b');
    assert.match(received.prompt, /body text/);
    assert.equal(result.context, 'a generated context', 'trimmed, matching addContext()\'s existing .trim() behavior');
  });

  it('a rejecting opts.ollama.generate() propagates the SAME error out of addContext()', async () => {
    const originalError = new Error('ollama unreachable');
    const ollama = fakeGenerateCapability({ generate: async () => { throw originalError; } });
    await assert.rejects(
      () => addContext({ source_file: 'f.md', section: 's', chunkIndex: 0, totalChunks: 1, text: 'x' }, { ollama }),
      (err) => { assert.equal(err, originalError); return true; },
    );
  });

  it('addContext() throws a clear, actionable error when opts.ollama is omitted — no module-scope fallback exists to silently resolve it', async () => {
    await assert.rejects(
      () => addContext({ source_file: 'f.md', section: 's', chunkIndex: 0, totalChunks: 1, text: 'x' }),
      /requires opts\.ollama/,
    );
    await assert.rejects(
      () => addContext({ source_file: 'f.md', section: 's', chunkIndex: 0, totalChunks: 1, text: 'x' }, {}),
      /requires opts\.ollama/,
    );
  });

  it('addContext() rejects a non-conforming opts.ollama before calling it', async () => {
    await assert.rejects(() => addContext({ source_file: 'f.md', text: 'x' }, { ollama: {} }), /generate/);
  });

  it('addContext() accepts an opts.ollama with ONLY generate() — no getModelContextLength/isThinkingModel/embed/discovery methods required', async () => {
    const narrow = fakeGenerateCapability({ generate: async () => 'ok' });
    assert.equal('getModelContextLength' in narrow, false);
    assert.equal('embed' in narrow, false);
    assert.equal('isOllamaReachable' in narrow, false);
    const result = await addContext({ source_file: 'f.md', text: 'x' }, { ollama: narrow });
    assert.equal(result.context, 'ok');
  });
});

describe('phases/tag.js — addTags/addTagsWithModel/addTagsBatch(chunk, opts) take their capability as a real argument, no module-scope setter', () => {
  it('addTags() calls opts.ollama.generate(model, prompt) and parses its own tags out of the result', async () => {
    let received = null;
    const ollama = fakeGenerateCapability({
      generate: async (model, prompt) => { received = { model, prompt }; return 'node-js, testing'; },
    });
    const chunk = { source_file: 'f.md', section: 's', text: 'about node.js testing' };
    const result = await addTags(chunk, { ollama });
    assert.ok(received.model, 'a model was passed through');
    assert.deepEqual(result.tags.sort(), ['node-js', 'testing']);
  });

  it('a rejecting opts.ollama.generate() propagates unchanged through addTagsWithModel()', async () => {
    const originalError = new Error('tag model not pulled');
    const ollama = fakeGenerateCapability({ generate: async () => { throw originalError; } });
    await assert.rejects(
      () => addTagsWithModel({ source_file: 'f.md', section: 's', text: 'x' }, 'some-model', { ollama }),
      (err) => { assert.equal(err, originalError); return true; },
    );
  });

  it('addTagsWithModel() throws a clear, actionable error when opts.ollama is omitted', async () => {
    await assert.rejects(
      () => addTagsWithModel({ source_file: 'f.md', text: 'x' }, 'model'),
      /requires opts\.ollama/,
    );
  });
});

describe('phases/combined.js — addContextAndTags(chunk, model, chunks, opts) takes its capability as a real argument, no module-scope setter', () => {
  it('addContextAndTags() calls opts.ollama.generate() for the combined call (long-enough chunk)', async () => {
    let called = false;
    const ollama = fakeGenerateCapability({
      generate: async () => { called = true; return JSON.stringify({ context: 'ctx', tags: ['a', 'b'] }); },
    });
    const longText = 'x'.repeat(200);
    const result = await addContextAndTags({ source_file: 'f.md', section: 's', chunkIndex: 0, totalChunks: 1, text: longText, context: '', tags: [] }, 'model', [], { ollama });
    assert.equal(called, true);
    assert.equal(result.context, 'ctx');
  });

  it('addContextAndTags() throws a clear, actionable error when opts.ollama is omitted (long-enough chunk that actually needs the combined call)', async () => {
    const longText = 'x'.repeat(200);
    await assert.rejects(
      () => addContextAndTags({ source_file: 'f.md', section: 's', chunkIndex: 0, totalChunks: 1, text: longText }, 'model', []),
      /requires opts\.ollama/,
    );
  });

  it('addContextAndTags()\'s own fallback path (parse failure) threads the SAME opts.ollama into addContext()/addTagsWithModel() — not a second capability resolution', async () => {
    let contextCalls = 0;
    const ollama = fakeGenerateCapability({
      generate: async (model, prompt) => {
        contextCalls++;
        // First call is the combined attempt (malformed JSON) — triggers fallback.
        if (contextCalls === 1) return 'not valid json';
        // Fallback calls: addContext() then addTagsWithModel(), both via the SAME ollama.
        return contextCalls === 2 ? 'fallback context' : 'tag-a, tag-b';
      },
    });
    const longText = 'x'.repeat(200);
    const result = await addContextAndTags({ source_file: 'f.md', section: 's', chunkIndex: 0, totalChunks: 1, text: longText, context: '', tags: [] }, 'model', [], { ollama });
    assert.equal(contextCalls, 3, 'combined attempt + fallback addContext + fallback addTagsWithModel, all via the one opts.ollama');
    assert.equal(result.context, 'fallback context');
    assert.deepEqual(result.tags.sort(), ['tag-a', 'tag-b']);
  });
});

describe('phases/skeleton-summary.js — generateFn is a required opts argument, no module-scope fallback', () => {
  it('resolveRunNumCtx() accepts an explicit getModelContextLengthFn argument instead of a boolean skip flag', async () => {
    const modelMax = async () => 131072;
    const withoutEnvOverride = await resolveRunNumCtx('some-model', 5000, {}, modelMax);
    assert.equal(typeof withoutEnvOverride, 'number');
    assert.ok(withoutEnvOverride <= 131072);
  });

  it('resolveRunNumCtx() falls back to the fixed no-capability constant when getModelContextLengthFn is omitted — never throws, never silently calls a module-scope capability', async () => {
    const result = await resolveRunNumCtx('some-model', 5000, {});
    assert.equal(result, 8000);
  });

  it('generateNavSummaries() throws a clear, actionable error when opts.generateFn is omitted', async () => {
    await assert.rejects(
      () => generateNavSummaries([{ node_id: 'n1', node_type: 'section', node_path: 'a' }], []),
      /requires opts\.generateFn/,
    );
  });
});

describe('indexer/preflight.js — checkOllamaPreflight(url, requiredModels, capability) takes its capability as a real argument, no module-scope setter', () => {
  it('checkOllamaPreflight() calls the given capability\'s isOllamaReachable(baseUrl) with the exact base URL', async () => {
    let receivedUrl = null;
    const capability = fakeDiscoveryCapability({
      isOllamaReachable: async (url) => { receivedUrl = url; return false; },
    });
    await assert.rejects(() => checkOllamaPreflight('http://example:1234/', ['ctx-model', 'tag-model'], capability), /unreachable/);
    assert.equal(receivedUrl, 'http://example:1234');
  });

  it('a listOllamaModels() network error surfaces through checkOllamaPreflight() with an actionable message, not swallowed', async () => {
    const capability = fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => { throw new Error('ECONNRESET'); },
    });
    await assert.rejects(() => checkOllamaPreflight('http://x/', ['a', 'b'], capability), /Could not list Ollama models.*ECONNRESET/s);
  });

  it('validateOllamaModels() missing-models result surfaces as a pull-command message', async () => {
    const capability = fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => ['other-model'],
      validateOllamaModels: async (required, available) => required.filter((m) => !available.includes(m)),
    });
    await assert.rejects(() => checkOllamaPreflight('http://x/', ['ctx-model', 'tag-model'], capability), /ollama pull ctx-model/);
  });

  it('checkOllamaPreflight() throws a clear, actionable error when capability is omitted', async () => {
    await assert.rejects(() => checkOllamaPreflight('http://x/', ['a', 'b']), /requires a capability argument/);
  });

  it('checkOllamaPreflight() accepts a capability with ONLY the 3 discovery methods — no generate/embed methods required', async () => {
    const narrow = fakeDiscoveryCapability({
      isOllamaReachable: async () => true, listOllamaModels: async () => [], validateOllamaModels: async () => null,
    });
    assert.equal('generate' in narrow, false);
    assert.equal('embed' in narrow, false);
    await assert.doesNotReject(() => checkOllamaPreflight('http://x/', ['a', 'b'], narrow));
  });

  // Code review finding (P1): requiredModels is now the exact, minimal
  // list run.js's own resolveRequiredOllamaModels() computes — a model
  // never actually reachable this run (e.g. CONTEXT_MODEL under
  // CONTEXT_MODE=deterministic) must never appear in it, so it's never
  // checked/required to be pulled. This is the direct proof that
  // checkOllamaPreflight() itself has no opinion about WHICH models are
  // required beyond validating exactly the array it's given.
  it('validates only the models actually present in requiredModels — an empty array never fails the model-availability check', async () => {
    const capability = fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => [],
      validateOllamaModels: async (required) => (required.length ? required : null),
    });
    await assert.doesNotReject(() => checkOllamaPreflight('http://x/', [], capability));
  });

  it('a single required model not present in requiredModels is never reported as missing, even if the Ollama server does not have it', async () => {
    let receivedRequired = null;
    const capability = fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => [],
      validateOllamaModels: async (required, available) => {
        receivedRequired = required;
        return required.filter((m) => !available.includes(m)).length ? required.filter((m) => !available.includes(m)) : null;
      },
    });
    await assert.rejects(() => checkOllamaPreflight('http://x/', ['tag-model'], capability), /ollama pull tag-model/);
    assert.deepEqual(receivedRequired, ['tag-model']);
  });
});

// Code review finding (P1): ensureOllamaPreflight()'s process-level cache
// used to memoize the ENTIRE resolved check (reachability + model
// availability) behind a single module-scope promise — so once file 1's
// preflight resolved, every later file's call, even with a completely
// different requiredModels array, just awaited that same stale promise
// and skipped model validation entirely. Fixed: only reachability + the
// installed-model LIST are cached (per capability instance + URL);
// requiredModels is validated fresh on every call.
describe('indexer/preflight.js — ensureOllamaPreflight() caches reachability/model-listing per (capability, url), but validates requiredModels fresh every call', () => {
  it('THE reported scenario: file 1 needs only TAG_MODEL (present), file 2 needs only CONTEXT_MODEL (missing) — file 2 must still fail, not silently reuse file 1\'s cached success', async () => {
    let listCallCount = 0;
    const capability = fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => { listCallCount += 1; return ['tag-model']; }, // CONTEXT_MODEL never pulled
      validateOllamaModels: async (required, available) => {
        const missing = required.filter((m) => !available.includes(m));
        return missing.length ? missing : null;
      },
    });

    // File 1: Markdown, only needs TAG_MODEL — passes.
    await assert.doesNotReject(() => ensureOllamaPreflight('http://x/', ['tag-model'], capability));

    // File 2: PDF, needs CONTEXT_MODEL — must genuinely fail, not silently
    // inherit file 1's cached "everything's fine" result.
    await assert.rejects(
      () => ensureOllamaPreflight('http://x/', ['context-model'], capability),
      /ollama pull context-model/,
    );

    // The installed-model LIST itself is legitimately cached — reachability
    // and listOllamaModels() are called only once across both files.
    assert.equal(listCallCount, 1, 'the model list itself should be cached per (capability, url), only requiredModels validation runs fresh each call');
  });

  it('a capability swapped between calls (different instance) never reads another capability\'s cached availability', async () => {
    const capA = fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => ['model-a'],
      validateOllamaModels: async (required, available) => {
        const missing = required.filter((m) => !available.includes(m));
        return missing.length ? missing : null;
      },
    });
    const capB = fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => ['model-b'],
      validateOllamaModels: async (required, available) => {
        const missing = required.filter((m) => !available.includes(m));
        return missing.length ? missing : null;
      },
    });

    await assert.doesNotReject(() => ensureOllamaPreflight('http://x/', ['model-a'], capA));
    // capB has never seen model-a — must fail, not reuse capA's cache entry.
    await assert.rejects(() => ensureOllamaPreflight('http://x/', ['model-a'], capB), /ollama pull model-a/);
    await assert.doesNotReject(() => ensureOllamaPreflight('http://x/', ['model-b'], capB));
  });

  it('a different ollamaUrl for the SAME capability instance gets its own independent cache entry', async () => {
    const capability = fakeDiscoveryCapability({
      isOllamaReachable: async (base) => true,
      listOllamaModels: async (base) => (base.includes('9999') ? ['model-on-9999'] : ['model-on-11434']),
      validateOllamaModels: async (required, available) => {
        const missing = required.filter((m) => !available.includes(m));
        return missing.length ? missing : null;
      },
    });

    await assert.doesNotReject(() => ensureOllamaPreflight('http://localhost:11434', ['model-on-11434'], capability));
    await assert.rejects(() => ensureOllamaPreflight('http://localhost:9999', ['model-on-11434'], capability), /ollama pull model-on-11434/);
    await assert.doesNotReject(() => ensureOllamaPreflight('http://localhost:9999', ['model-on-9999'], capability));
  });

  it('a transient reachability failure does not permanently poison the cache — a later call after Ollama recovers succeeds', async () => {
    let attempt = 0;
    const capability = fakeDiscoveryCapability({
      isOllamaReachable: async () => { attempt += 1; return attempt > 1; }, // fails once, then recovers
      listOllamaModels: async () => ['model-a'],
      validateOllamaModels: async () => null,
    });

    await assert.rejects(() => ensureOllamaPreflight('http://x/', ['model-a'], capability), /unreachable/);
    await assert.doesNotReject(() => ensureOllamaPreflight('http://x/', ['model-a'], capability));
  });

  it('ensureOllamaPreflight() throws a clear, actionable error when capability is omitted', async () => {
    await assert.rejects(() => ensureOllamaPreflight('http://x/', ['a']), /requires a capability argument/);
  });

  // Code review finding (P2): a cached model list must not survive a real
  // "missing model" report for the rest of the process. Real-world
  // scenario: preflight fails ("model X not pulled"), the user runs
  // `ollama pull X` in another terminal, then retries indexing WITHOUT
  // restarting the process (e.g. a long-lived Admin-triggered job, or two
  // sequential CLI invocations sharing a process). The stale cached list
  // must not keep failing the retry once the model is genuinely present.
  it('a missing-model failure evicts the cached list — retrying after the model becomes available (simulating `ollama pull`) succeeds without a process restart', async () => {
    let modelNowInstalled = false;
    let listCallCount = 0;
    const capability = fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => {
        listCallCount += 1;
        return modelNowInstalled ? ['gemma3:4b'] : [];
      },
      validateOllamaModels: async (required, available) => {
        const missing = required.filter((m) => !available.includes(m));
        return missing.length ? missing : null;
      },
    });

    await assert.rejects(
      () => ensureOllamaPreflight('http://x/', ['gemma3:4b'], capability),
      /ollama pull gemma3:4b/,
    );
    assert.equal(listCallCount, 1);

    // Simulate the user running `ollama pull gemma3:4b` in another
    // terminal, then retrying WITHOUT restarting this process.
    modelNowInstalled = true;
    await assert.doesNotReject(() => ensureOllamaPreflight('http://x/', ['gemma3:4b'], capability));
    // The eviction forced a genuinely fresh listOllamaModels() call —
    // proves this isn't accidentally passing because of some other path.
    assert.equal(listCallCount, 2, 'the missing-model failure must have evicted the cached list, forcing a fresh listOllamaModels() call on retry');
  });

  it('a successful call after the eviction re-caches the fresh list — a THIRD call for a different model does not re-fetch again', async () => {
    let modelNowInstalled = false;
    let listCallCount = 0;
    const capability = fakeDiscoveryCapability({
      isOllamaReachable: async () => true,
      listOllamaModels: async () => {
        listCallCount += 1;
        return modelNowInstalled ? ['gemma3:4b', 'other-model'] : [];
      },
      validateOllamaModels: async (required, available) => {
        const missing = required.filter((m) => !available.includes(m));
        return missing.length ? missing : null;
      },
    });

    await assert.rejects(() => ensureOllamaPreflight('http://x/', ['gemma3:4b'], capability));
    modelNowInstalled = true;
    await assert.doesNotReject(() => ensureOllamaPreflight('http://x/', ['gemma3:4b'], capability));
    assert.equal(listCallCount, 2);

    // A third call, for a DIFFERENT required model already present in the
    // now-cached list, must reuse it — not fetch a third time.
    await assert.doesNotReject(() => ensureOllamaPreflight('http://x/', ['other-model'], capability));
    assert.equal(listCallCount, 2, 'the successful post-eviction fetch should be cached normally, like any other successful resolution');
  });

  // Code review finding (P2): the cache must not hold a strong reference
  // to capability instances forever — a long-lived process constructing
  // fresh capabilities per job (e.g. an Admin server spawning repeated
  // indexer-style work) would otherwise leak every capability (and
  // everything its closure captures) for the process's whole lifetime.
  // A WeakMap allows collection once nothing else references the
  // capability. This can't be proven by forcing a real GC cycle
  // deterministically in a unit test, so this is a structural proof
  // instead: confirms the module actually uses WeakMap, not Map, for
  // this cache — the one-line, load-bearing fact that makes collection
  // possible at all.
  it('the availability cache is a WeakMap, not a Map — capability instances are collectible once nothing else references them', async () => {
    const src = readFileSync(new URL('../../../src/shared/indexer/preflight.js', import.meta.url), 'utf-8');
    assert.match(src, /const _availabilityCache = new WeakMap\(\)/);
  });
});

describe('indexer/run.js — run({ capabilities }) validates its argument into one local context, no module-scope capability state at all', () => {
  // Code review (second pass): an earlier version of this fix built the
  // right context object but STORED it in a module-scope `let
  // _activeRun*Capabilities` "snapshot" set at the top of run() and cleared
  // in `finally` — still module-scope state, so two concurrent run() calls
  // in the same process still raced (Run B's snapshot write silently
  // overwrote Run A's). The fix removed applyRunCapabilities()/
  // applyAllCapabilities()/embedCapabilities()/ollamaCapabilities() and
  // every test-only setter entirely — there is nothing module-scope left
  // in run.js to unit-test as "state." What remains testable: (1) run()'s
  // own argument validation, (2) that two overlapping calls into the real
  // pipeline (stageB, the one exported stage function needing no Qdrant/
  // real Ollama I/O) never observe each other's capability, and (3) that
  // two overlapping real run() calls each clean up their OWN tagOnnx
  // worker, never the other's.
  function makeCapabilities(overrides = {}) {
    return {
      ollamaGenerate: fakeGenerateCapability({ generate: async () => 'x' }),
      ollamaSummary: { generate: async () => 'x', getModelContextLength: async () => 4096, isThinkingModel: async () => false },
      ollamaEmbed: fakeEmbedCapability({ getOllamaEmbeddingDimension: async () => 768 }),
      ollamaDiscovery: fakeDiscoveryCapability({
        isOllamaReachable: async () => true, listOllamaModels: async () => [], validateOllamaModels: async () => null,
      }),
      generationResourceIdentity: fakeResourceIdentityCapability({
        getResourceIdentity: async () => ({ kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null }),
        getEmbeddingResourceIdentity: async () => ({ kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null }),
      }),
      onnxEmbed: { loadOnnx: async () => {}, loadOnnxBatch: async () => {}, shutdown: async () => {} },
      tagOnnx: fakeTagOnnxCapability(),
      ...overrides,
    };
  }

  it('run({ capabilities }) validates each of the seven slots against its own narrow contract before doing any work', async () => {
    await assert.rejects(() => run({ capabilities: makeCapabilities({ ollamaGenerate: {} }) }), /generate/);
    await assert.rejects(() => run({ capabilities: makeCapabilities({ ollamaSummary: { generate: async () => 'x' } }) }), /getModelContextLength/);
    await assert.rejects(() => run({ capabilities: makeCapabilities({ ollamaEmbed: {} }) }), /embed|getOllamaEmbeddingDimension/);
    await assert.rejects(() => run({ capabilities: makeCapabilities({ ollamaDiscovery: {} }) }), /isOllamaReachable|listOllamaModels|validateOllamaModels/);
    await assert.rejects(() => run({ capabilities: makeCapabilities({ generationResourceIdentity: {} }) }), /getResourceIdentity|getEmbeddingResourceIdentity/);
    await assert.rejects(() => run({ capabilities: makeCapabilities({ onnxEmbed: {} }) }), /loadOnnx/);
    await assert.rejects(() => run({ capabilities: makeCapabilities({ tagOnnx: {} }) }), /addTagsOnnxBatch/);
  });

  it('run({ capabilities }) never accepts a single object satisfying one contract as a stand-in for a different slot (no wide "ollama" blob accepted)', async () => {
    const generateOnly = fakeGenerateCapability({ generate: async () => 'x' });
    await assert.rejects(() => run({ capabilities: makeCapabilities({ ollamaSummary: generateOnly }) }), /getModelContextLength/);
    await assert.rejects(() => run({ capabilities: makeCapabilities({ ollamaEmbed: generateOnly }) }), /embed|getOllamaEmbeddingDimension/);
    await assert.rejects(() => run({ capabilities: makeCapabilities({ ollamaDiscovery: generateOnly }) }), /isOllamaReachable|listOllamaModels|validateOllamaModels/);
  });
});

describe('indexer/run.js — TWO real concurrent run() calls each clean up only their OWN tagOnnx worker (behavioral, not simulated)', () => {
  // Genuinely overlapping run() calls, driven far enough into the real
  // pipeline to prove isolation, without touching a real Qdrant/Ollama
  // server: process.env.COLLECTION is set before this test file's own
  // dynamic import of run.js (module-scope `const COLLECTION` is read
  // once, at import time), and process.argv[2] points at a path that does
  // not exist — main()'s own early path-validation throws BEFORE any
  // Qdrant call (see run.js's own "Path validation FIRST" comment), so
  // run({ capabilities }) genuinely executes buildRunContext() -> main(ctx)
  // -> throw -> finally -> ctx.tagOnnx.shutdownOnnxTagWorker() for real,
  // with no mocking below run.js's own boundary.
  //
  // Code review (P2, third pass): this describe block previously also
  // carried a second test titled as if it proved ollamaGenerate isolation
  // ("two overlapping run() calls with DISTINGUISHABLE ollamaGenerate
  // capabilities never see each other's object identity") — but both
  // calls die at the path-validation throw above, before main() ever
  // reaches listCollections() (a real network call, the next line after
  // path validation) let alone stageB()/addContext(). That test only ever
  // re-observed the SAME tagOnnx-cleanup signal as the test below it under
  // a misleading name; it proved nothing about ollamaGenerate. Removed
  // rather than kept as a duplicate. Driving two real run() calls all the
  // way through main() to stageB() would require either a live Qdrant
  // server or a DI seam main() does not currently expose for
  // listCollections()/storageAdapter — out of scope here. The genuine,
  // accurate proof that ollamaGenerate is never shared between two
  // concurrently-executing calls lives in the stageB()-level describe
  // block immediately below this one, which calls stageB() directly (the
  // same function main() calls) with two distinct ctx objects and a real
  // interleaving (a slow call's generate() is still in flight when a fast
  // call's, using a different ctx, has already resolved).
  let run;
  let originalArgv2;

  before(async () => {
    process.env.COLLECTION = 'phase-capability-injection-concurrency-test';
    originalArgv2 = process.argv[2];
    process.argv[2] = '/definitely/does/not/exist/on/any/machine';
    ({ run } = await import(`../../../src/shared/indexer/run.js?concurrency-test-${Date.now()}`));
  });

  after(() => {
    process.argv[2] = originalArgv2;
    delete process.env.COLLECTION;
  });

  it('two overlapping run() calls each reject with the real path error, and each one\'s finally block shuts down ONLY its own tagOnnx worker — never the other\'s', async () => {
    const shutdownCalls = [];
    const tagOnnxA = fakeTagOnnxCapability({ shutdownOnnxTagWorker: async () => { shutdownCalls.push('A'); } });
    const tagOnnxB = fakeTagOnnxCapability({ shutdownOnnxTagWorker: async () => { shutdownCalls.push('B'); } });

    const runA = run({ capabilities: makeSharedCapabilities({ tagOnnx: tagOnnxA }) });
    const runB = run({ capabilities: makeSharedCapabilities({ tagOnnx: tagOnnxB }) });

    const [resultA, resultB] = await Promise.allSettled([runA, runB]);

    assert.equal(resultA.status, 'rejected');
    assert.equal(resultB.status, 'rejected');
    assert.match(resultA.reason.message, /does not exist/);
    assert.match(resultB.reason.message, /does not exist/);

    // Each call's own finally block fired exactly once, for its own
    // capability — not zero times (skipped), not twice (the other call's
    // cleanup leaking in), and neither call's cleanup fired for the
    // OTHER call's tagOnnx object.
    assert.deepEqual(shutdownCalls.sort(), ['A', 'B'], 'both calls\' own cleanup ran, exactly once each, for their own capability');
  });

  function makeSharedCapabilities(overrides = {}) {
    return {
      ollamaGenerate: fakeGenerateCapability({ generate: async () => 'x' }),
      ollamaSummary: { generate: async () => 'x', getModelContextLength: async () => 4096, isThinkingModel: async () => false },
      ollamaEmbed: fakeEmbedCapability({ getOllamaEmbeddingDimension: async () => 768 }),
      ollamaDiscovery: fakeDiscoveryCapability({
        isOllamaReachable: async () => true, listOllamaModels: async () => [], validateOllamaModels: async () => null,
      }),
      generationResourceIdentity: fakeResourceIdentityCapability({
        getResourceIdentity: async () => ({ kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null }),
        getEmbeddingResourceIdentity: async () => ({ kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null }),
      }),
      onnxEmbed: { loadOnnx: async () => {}, loadOnnxBatch: async () => {}, shutdown: async () => {} },
      tagOnnx: fakeTagOnnxCapability(),
      // cloudEmbed (code review, Phase 8B Step 6): buildRunContext() now
      // validates a cloudEmbed slot too — the real factory is a pure
      // constructor (no network I/O until a method is called).
      cloudEmbed: createCloudEmbeddingCapability(),
      ...overrides,
    };
  }
});

describe('indexer/run.js — stageB(prepared, ctx, ...) — two overlapping calls with distinct ctx objects never cross-read each other\'s capability', () => {
  // The real, direct proof of per-call isolation for the pipeline's own
  // Ollama-touching stage, with zero Qdrant/real-Ollama I/O — stageB is
  // already exported specifically for direct testing (mirrors
  // buildEmbedInputsForChunks/computeStaleSourceFiles below). Two calls are
  // started, deliberately interleaved via a controllable delay on the
  // SLOWER one's own generate() call, so the faster call's own ctx is
  // fully consumed and released while the slower one is still in flight —
  // exactly the interleaving the original P1 finding described (Run A
  // starts, Run B starts and would have overwritten a SHARED snapshot, Run
  // A finishes still using what it started with).
  it('a slow call\'s in-flight generate() still resolves against ITS OWN ctx.ollamaGenerate, even after a faster overlapping call with a DIFFERENT ctx has already completed', async () => {
    const rawChunk = (tag) => ({ source_file: `${tag}.md`, section: 's', chunkIndex: 0, totalChunks: 1, text: `body ${tag}`, tags: [] });

    let releaseSlow;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });

    const seenBySlow = [];
    const slowCtx = {
      ollamaGenerate: { generate: async (model, prompt) => { await slowGate; seenBySlow.push('slow-ctx'); return 'slow-context-result'; } },
      ollamaSummary: null, ollamaDiscovery: null, ollamaEmbed: null, onnxEmbed: null,
      tagOnnx: fakeTagOnnxCapability(),
    };

    const seenByFast = [];
    const fastCtx = {
      ollamaGenerate: { generate: async (model, prompt) => { seenByFast.push('fast-ctx'); return 'fast-context-result'; } },
      ollamaSummary: null, ollamaDiscovery: null, ollamaEmbed: null, onnxEmbed: null,
      tagOnnx: fakeTagOnnxCapability(),
    };

    const preparedSlow = { rawChunks: [rawChunk('slow')], combinedCfg: { enabled: false }, profiler: { mark() {}, markAt() {} }, navPoints: [] };
    const preparedFast = { rawChunks: [rawChunk('fast')], combinedCfg: { enabled: false }, profiler: { mark() {}, markAt() {} }, navPoints: [] };

    const originalEnv = { CONTEXT_MODE: process.env.CONTEXT_MODE, SKELETON_SUMMARY: process.env.SKELETON_SUMMARY, TAG_GEN: process.env.TAG_GEN };
    delete process.env.CONTEXT_MODE; // default (llm) path — real addContext() call
    delete process.env.SKELETON_SUMMARY;
    process.env.TAG_GEN = '0';
    try {
      // Start the SLOW call first (its generate() blocks on slowGate), then
      // the FAST call — the fast call fully resolves while the slow one is
      // still parked mid-await, exactly the interleaving a shared
      // module-scope snapshot would have corrupted (a later
      // applyRunCapabilities()-shaped call overwriting what the slow call
      // reads).
      const slowPromise = stageB(preparedSlow, slowCtx);
      const fastPromise = stageB(preparedFast, fastCtx);

      const fastResult = await fastPromise;
      assert.equal(fastResult.taggedChunks[0].context, 'fast-context-result');
      assert.deepEqual(seenByFast, ['fast-ctx']);
      // The slow call has NOT resolved yet — still parked on slowGate.
      assert.deepEqual(seenBySlow, []);

      releaseSlow();
      const slowResult = await slowPromise;
      assert.equal(slowResult.taggedChunks[0].context, 'slow-context-result', 'the slow call\'s own ctx.ollamaGenerate was used, unaffected by the fast call having already completed with a DIFFERENT ctx');
      assert.deepEqual(seenBySlow, ['slow-ctx']);
    } finally {
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
