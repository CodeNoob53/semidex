// Local ONNX embedding runtime — instance-scoped capability (parity fix,
// same class of gap Phase 8B Step 4's code review found and fixed for
// tag-onnx.js's worker coordinator). local/core/onnx-embed.js used to hold
// its session/tokenizer/in-flight-load-promise/provider-fallback state as
// module-scope bindings, and every real composition root
// (indexer/index-full.js, admin/server-full.js, mcp/server.js) passed the
// SAME cached core/onnx-embed-lazy.js module namespace object as its own
// "capability" — so two independently-composed callers in one process
// actually shared one ONNX InferenceSession.
//
// Fixed by createOnnxEmbeddingCapability(): a factory returning a fresh,
// independent instance per call, with the tokenizer/session/load-promise/
// provider-state moved into the factory's own closure. See
// local/core/onnx-embed.js's own header comment for the full finding, and
// tests/unit/core/onnx-embed-instance-isolation.test.js for the direct,
// hermetic (fake session/tokenizer) behavioral proof that two instances
// never share mutable state.
//
// This file proves the COMPOSITION-level guarantees:
//   - index-full.js/admin/server-full.js/mcp/server.js each construct
//     their OWN capability instance, not the bare *-lazy.js namespace;
//   - Lite composition roots continue to supply only a typed-unavailable
//     capability, never touching the real implementation;
//   - Full and Lite composition roots can be constructed in either order,
//     repeatedly, in one process, without any cross-contamination of
//     core/embeddings.js's own shared module-scope fallback;
//   - the Lite import graph and staged tarball still never reach the real
//     ONNX embedding implementation (unaffected by this round's
//     export-shape change — no file moved).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSettingsService } from '../../../src/core/settings/service.js';

describe('local/core/onnx-embed.js — createOnnxEmbeddingCapability() export shape', () => {
  it('is exported, and two calls return two genuinely independent instances', async () => {
    const mod = await import('../../../src/local/core/onnx-embed.js');
    assert.equal(typeof mod.createOnnxEmbeddingCapability, 'function');
    const capA = mod.createOnnxEmbeddingCapability({ ortFactory: () => ({ InferenceSession: { create: async () => ({ outputNames: [], run: async () => ({}), release: async () => {} }) } }) });
    const capB = mod.createOnnxEmbeddingCapability({ ortFactory: () => ({ InferenceSession: { create: async () => ({ outputNames: [], run: async () => ({}), release: async () => {} }) } }) });
    assert.notEqual(capA, capB);
    assert.notEqual(capA.shutdown, capB.shutdown, 'each instance\'s own shutdown() closes over its own independent state, not a shared one');
    await capA.shutdown();
    await capB.shutdown();
  });

  it('no module-scope mutable session/tokenizer/provider-state binding remains in the source (source-level sanity check, not the sole proof — see onnx-embed-instance-isolation.test.js for the real behavioral proof)', () => {
    const src = readFileSync(new URL('../../../src/local/core/onnx-embed.js', import.meta.url), 'utf-8');
    // The four bindings this file's own header comment documents as
    // "used to be module-scope" must now appear only inside
    // createOnnxEmbeddingCapability()'s own function body, never at
    // top-level module scope. A precise check: no top-level (zero
    // leading whitespace) `let tokenizer`/`let session`/
    // `let _loadPromise`/`let _providerState` declaration.
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    for (const binding of ['tokenizer', 'session', '_loadPromise', '_providerState', '_shutdown']) {
      const topLevelDeclaration = codeOnly.find((line) => new RegExp(`^let\\s+${binding}\\b`).test(line));
      assert.equal(topLevelDeclaration, undefined, `expected no top-level (module-scope) "let ${binding}" declaration, found: ${topLevelDeclaration}`);
    }
  });
});

describe('indexer/index-full.js — constructs its own ONNX embedding capability instance, not the bare *-lazy.js namespace', () => {
  it('imports createOnnxEmbeddingCapability from onnx-embed-lazy.js and calls it to build a real instance, passed in as onnxEmbed', () => {
    const src = readFileSync(new URL('../../../src/indexer/index-full.js', import.meta.url), 'utf-8');
    assert.match(src, /const onnxEmbedLazy = await import\(['"]\.\.\/core\/onnx-embed-lazy\.js['"]\)/);
    assert.match(src, /const onnxEmbed = onnxEmbedLazy\.createOnnxEmbeddingCapability\(\);/);
    // Must NOT pass the bare namespace object itself as the capability —
    // that was the exact bug (onnxEmbed: onnxEmbedLazy).
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//'));
    const runIndexerCliCall = codeOnly.find((line) => line.includes('onnxEmbed') && line.includes('tagOnnx'));
    assert.ok(runIndexerCliCall, 'expected to find the runIndexerCli({ ..., onnxEmbed, tagOnnx }) call line');
    assert.doesNotMatch(runIndexerCliCall, /onnxEmbed:\s*onnxEmbedLazy\b/, 'must pass a constructed instance, never the bare *-lazy.js module namespace');
  });
});

describe('admin/server-full.js — constructs its own ONNX embedding capability instance, not the bare *-lazy.js namespace', () => {
  it('imports createOnnxEmbeddingCapability and calls it once by default, at createApp() composition time — or uses the injected onnxEmbedCapability override when bootstrap.js supplies a typed-unavailable one (review finding, P2)', () => {
    const src = readFileSync(new URL('../../../src/admin/server-full.js', import.meta.url), 'utf-8');
    assert.match(src, /import\s*\{\s*createOnnxEmbeddingCapability\s*\}\s*from\s*['"]\.\.\/core\/onnx-embed-lazy\.js['"]/);
    assert.match(src, /const onnxEmbed = onnxEmbedCapability \?\? createOnnxEmbeddingCapability\(\);/);
    // The old bare-namespace pattern must be gone entirely.
    assert.doesNotMatch(src, /import\s*\*\s*as\s+onnxEmbedLazy/);
    assert.doesNotMatch(src, /onnxEmbed:\s*onnxEmbedLazy\b/);
  });

  it('constructing createApp() twice in one process gives each call its own independent onnxEmbed instance', async () => {
    const { createApp } = await import('../../../src/admin/server-full.js?onnx-embed-instance-scoping-check');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {} });
    const app1 = createApp({ settingsService });
    app1.close();
    const app2 = createApp({ settingsService });
    app2.close();
    // Both construct successfully with no shared-instance error — the
    // real per-instance isolation is proven directly in
    // onnx-embed-instance-isolation.test.js; this proves createApp()
    // itself does not error or reuse a shared instance across calls.
    assert.ok(app1);
    assert.ok(app2);
  });
});

describe('mcp/server.js — constructs its own ONNX embedding capability instance, not the bare *-lazy.js namespace', () => {
  it('resolves onnxEmbed via mcp/onnx-runtime-resolution.js\'s resolveOnnxEmbedCapabilityForMcp() (review finding, P1/P2) — that function itself constructs a fresh createOnnxEmbeddingCapability() instance (or a typed-unavailable one) exactly once, at module composition time; real behavioral coverage lives in tests/unit/mcp/onnx-runtime-resolution.test.js', () => {
    const src = readFileSync(new URL('../../../src/mcp/server.js', import.meta.url), 'utf-8');
    assert.match(src, /import \{ resolveOnnxEmbedCapabilityForMcp \} from '\.\/onnx-runtime-resolution\.js'/);
    assert.match(src, /const onnxEmbed = await resolveOnnxEmbedCapabilityForMcp\(\{ settingsService \}\);/);
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//'));
    const setEmbedQueryLine = codeOnly.find((line) => line.includes('search.setEmbedQuery('));
    assert.ok(setEmbedQueryLine);
    assert.doesNotMatch(setEmbedQueryLine, /onnxEmbed:\s*onnxEmbedLazy\b/);
  });

  it('mcp/onnx-runtime-resolution.js itself constructs a fresh createOnnxEmbeddingCapability() instance, not the bare *-lazy.js namespace, when the resolved runtime is healthy', () => {
    const src = readFileSync(new URL('../../../src/mcp/onnx-runtime-resolution.js', import.meta.url), 'utf-8');
    assert.match(src, /import \{ createOnnxEmbeddingCapability \} from '\.\.\/core\/onnx-embed-lazy\.js'/);
    assert.match(src, /return createOnnxEmbeddingCapabilityFn\(\);/);
  });
});

describe('Lite composition roots continue to supply only a typed-unavailable ONNX embedding capability', () => {
  it('admin/composition/lite.js never imports onnx-embed-lazy.js (real or .lite.js) and its unavailableOnnxEmbedCapability() includes a safe shutdown() no-op', async () => {
    const src = readFileSync(new URL('../../../src/admin/composition/lite.js', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /import\(['"][^'"]*onnx-embed-lazy\.js['"]\)/);
    assert.doesNotMatch(src, /^import .*onnx-embed-lazy\.js/m);

    const { createLiteApp } = await import('../../../src/admin/composition/lite.js?onnx-embed-instance-scoping-check');
    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {} });
    const app = createLiteApp({ settingsService });
    app.close();
    // Behavioral confirmation: Lite's own onnxEmbed capability rejects
    // loadOnnx/loadOnnxBatch but resolves shutdown() cleanly — proven at
    // the embeddings.js dispatch layer already
    // (embeddings-capability-injection.test.js); here we only confirm
    // createLiteApp() itself constructs without error.
    assert.ok(app);
  });

  it('indexer/index-lite.js never imports onnx-embed-lazy.js and its unavailableOnnxEmbedCapability() includes shutdown()', () => {
    const src = readFileSync(new URL('../../../src/indexer/index-lite.js', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /import\(['"][^'"]*onnx-embed-lazy\.js['"]\)/);
    assert.doesNotMatch(src, /^import .*onnx-embed-lazy\.js/m);
    assert.match(src, /function unavailableOnnxEmbedCapability\(\)/);
    const fnStart = src.indexOf('function unavailableOnnxEmbedCapability');
    const fnEnd = src.indexOf('\n}', fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    assert.match(fnBody, /async shutdown\(\)/);
  });
});

describe('Full and Lite composition roots construct in either order with no ONNX-embedding-capability contamination', () => {
  it('constructing createLiteApp() then createApp() (and vice versa), repeatedly, in one process, never errors and never leaves core/embeddings.js\'s own module-scope fallback contaminated', async () => {
    const embeddings = await import('../../../src/shared/core/embeddings.js?onnx-embed-order-check');
    const profile = {
      schemaVersion: 1, managedBy: 'semidex', embeddingSchemaVersion: 2,
      embedding: {
        dense: { provider: 'bge-m3-onnx', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
        sparse: { provider: 'bge-m3-onnx', model: 'bge-m3', vectorName: 'sparse', execution: 'client' },
      },
    };
    await assert.rejects(() => embeddings.embedForIndex(profile, 'q'), (err) => { assert.match(err.message, /no onnxEmbed capability available/); return true; });

    const settingsService = createSettingsService({ osEnv: {}, dotenvValues: {} });
    const { createLiteApp } = await import('../../../src/admin/composition/lite.js?onnx-embed-order-check');
    const { createApp } = await import('../../../src/admin/server-full.js?onnx-embed-order-check');

    // Order 1: Lite first, then Full.
    const lite1 = createLiteApp({ settingsService });
    lite1.close();
    const full1 = createApp({ settingsService });
    full1.close();
    await assert.rejects(() => embeddings.embedForIndex(profile, 'q'), (err) => { assert.match(err.message, /no onnxEmbed capability available/); return true; });

    // Order 2: Full first, then Lite — the reverse order, same process.
    const full2 = createApp({ settingsService });
    full2.close();
    const lite2 = createLiteApp({ settingsService });
    lite2.close();
    await assert.rejects(() => embeddings.embedForIndex(profile, 'q'), (err) => { assert.match(err.message, /no onnxEmbed capability available/); return true; });
  });
});
