// Phase 8B Step 1 explicitly requires the 3 *-lazy.js modules' own export
// surface and dynamic-import-on-first-call behavior to stay untouched by
// this phase's capability-contract/injection work — nothing in Step 1
// edited core/ollama-lazy.js, core/onnx-embed-lazy.js, or
// indexer/phases/tag-onnx-lazy.js themselves.
//
// Round 4 update: their CONSUMERS no longer default to these exact modules
// at module scope. Every former consumer (core/embeddings.js, the phase
// modules, indexer/preflight.js, indexer/run.js, core/generation/
// ollama-provider.js) was migrated to explicit capability injection with
// NO real-module fallback of its own — a caller that never injects a
// capability gets a clear error, never a silent real-network default. The
// ONE place that still imports these three real modules for Full's actual
// production use is indexer/index-full.js (and admin/bootstrap.js/
// server-full.js/mcp/server.js for their own composition-time capability
// resolution) — see that file's own header comment for why the former
// shared indexer/index.js could not safely keep doing this itself.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('core/ollama-lazy.js — unchanged, still the real default a fresh capability seam resolves to', () => {
  it('exports exactly its own real 9 functions (generateStream included — no narrow capability contract needs it, but the real module still exports it, unchanged)', async () => {
    const mod = await import('../../../src/core/ollama-lazy.js');
    const fnNames = Object.keys(mod).filter((k) => typeof mod[k] === 'function').sort();
    assert.deepEqual(fnNames, [
      'embed', 'generate', 'generateStream', 'getModelContextLength', 'getOllamaEmbeddingDimension',
      'isOllamaReachable', 'isThinkingModel', 'listOllamaModels', 'validateOllamaModels',
    ]);
  });
});

describe('core/onnx-embed-lazy.js — unchanged, still the real default a fresh capability seam resolves to', () => {
  it('exports exactly loadOnnx and loadOnnxBatch', async () => {
    const mod = await import('../../../src/core/onnx-embed-lazy.js');
    const fnNames = Object.keys(mod).filter((k) => typeof mod[k] === 'function').sort();
    assert.deepEqual(fnNames, ['loadOnnx', 'loadOnnxBatch']);
  });
});

describe('indexer/phases/tag-onnx-lazy.js — unchanged, still the real default a fresh capability seam resolves to', () => {
  it('exports isOnnxTagProvider (re-export), addTagsOnnxBatch, and shutdownOnnxTagWorker', async () => {
    const mod = await import('../../../src/indexer/phases/tag-onnx-lazy.js');
    const fnNames = Object.keys(mod).filter((k) => typeof mod[k] === 'function').sort();
    assert.deepEqual(fnNames, ['addTagsOnnxBatch', 'isOnnxTagProvider', 'shutdownOnnxTagWorker']);
  });
});

describe('every former *-lazy.js consumer now requires explicit capability injection — no module-scope real-module default (code review, round 4)', () => {
  it('core/embeddings.js, indexer/phases/{context,tag,combined,skeleton-summary}.js, indexer/preflight.js, indexer/run.js, and core/generation/ollama-provider.js no longer import ollama-lazy.js/onnx-embed-lazy.js/tag-onnx-lazy.js at all', async () => {
    const { readFileSync } = await import('node:fs');
    const files = [
      '../../../src/core/embeddings.js',
      '../../../src/indexer/phases/context.js',
      '../../../src/indexer/phases/tag.js',
      '../../../src/indexer/phases/combined.js',
      '../../../src/indexer/phases/skeleton-summary.js',
      '../../../src/indexer/preflight.js',
      '../../../src/indexer/run.js',
      '../../../src/core/generation/ollama-provider.js',
    ];
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf-8');
      // Doesn't grep for the bare substring — several of these files'
      // own header comments legitimately mention "ollama-lazy.js" in
      // prose explaining why they no longer import it. What must be
      // absent is a real import statement/specifier.
      assert.doesNotMatch(src, /^import[^\n]*ollama-lazy\.js/m, `${f} must not import ollama-lazy.js`);
      assert.doesNotMatch(src, /^import[^\n]*onnx-embed-lazy\.js/m, `${f} must not import onnx-embed-lazy.js`);
      assert.doesNotMatch(src, /^import[^\n]*tag-onnx-lazy\.js/m, `${f} must not import tag-onnx-lazy.js`);
    }
  });

  it('core/embeddings.js\'s applyEmbeddingCapabilities() default starts unset (null) — a bare call with no injected capability throws a clear error, never a silent real network attempt', async () => {
    const embeddings = await import('../../../src/core/embeddings.js?backward-compat-unset-check');
    const profile = {
      schemaVersion: 1, managedBy: 'semidex', embeddingSchemaVersion: 2,
      embedding: {
        dense: { provider: 'ollama', model: 'bge-m3', vectorName: 'dense', dimensions: 1024, distance: 'Cosine', execution: 'client' },
        sparse: { provider: 'hashed-tf', model: 'hashed-tf', vectorName: 'sparse', execution: 'client' },
      },
    };
    await assert.rejects(
      () => embeddings.embedForSearch(profile, 'q'),
      (err) => { assert.match(err.message, /no ollama capability available/); return true; },
    );
  });
});
