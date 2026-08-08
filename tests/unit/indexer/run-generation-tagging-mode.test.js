// src/shared/indexer/run.js — stageB()'s generationTaggingExecutionMode
// parameter (plan: recursive-roaming-anchor.md §2's fourth-review P1 fix).
// Direct, real stageB() calls (mirrors run-context-mode.test.js's own
// pattern) proving the TAG_PROVIDER=onnx branch actually consumes the
// mode string to gate its internal Ollama-context-call vs.
// ONNX-tag-call concurrency — not merely a parameter that reaches
// stageB and is silently ignored.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stageB } from '../../../src/shared/indexer/run.js';
import { Profiler } from '../../../src/shared/indexer/profiler.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function chunk({ sourceFile = 'doc.md', section = 'Intro', text = 'Some chunk body text.', chunkIndex = 0, totalChunks = 1 } = {}) {
  return { source_file: sourceFile, section, text, chunkIndex, totalChunks, chunking_model: undefined };
}

function prepared(rawChunks) {
  return { rawChunks, combinedCfg: { enabled: false, model: 'gemma3:4b', warning: '' }, profiler: new Profiler(), navPoints: [] };
}

function makeCtx({ generationGate, taggingGate, counters }) {
  return {
    ollamaGenerate: {
      generate: async () => {
        counters.activeGenerationCount += 1;
        if (generationGate) await generationGate.promise;
        counters.activeGenerationCount -= 1;
        return 'a context sentence';
      },
    },
    ollamaSummary: null,
    tagOnnx: {
      addTagsOnnxBatch: async (chunks) => {
        counters.activeTaggingCount += 1;
        if (taggingGate) await taggingGate.promise;
        counters.activeTaggingCount -= 1;
        return chunks.map((c) => ({ ...c, tags: ['onnx-tag'] }));
      },
    },
  };
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  Object.assign(process.env, overrides);
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

describe('stageB() — generationTaggingExecutionMode (TAG_PROVIDER=onnx branch)', () => {
  it('TEST A — sequential mode: generation and tagging never run concurrently', async () => {
    await withEnv({ TAG_PROVIDER: 'onnx', TAG_GEN: '1', COMBINED_LLM: '0', CONTEXT_MODE: '' }, async () => {
      const counters = { activeGenerationCount: 0, activeTaggingCount: 0 };
      const events = [];
      const ctx = makeCtx({ counters });
      // Wrap generate/addTagsOnnxBatch to also push events for the
      // never-interleaved assertion, while keeping the concurrency counters.
      const origGenerate = ctx.ollamaGenerate.generate;
      ctx.ollamaGenerate.generate = async (...args) => {
        events.push('generation:start');
        assert.ok(counters.activeGenerationCount + counters.activeTaggingCount <= 1, 'generation overlapped with tagging in sequential mode');
        const r = await origGenerate(...args);
        events.push('generation:end');
        return r;
      };
      const origTag = ctx.tagOnnx.addTagsOnnxBatch;
      ctx.tagOnnx.addTagsOnnxBatch = async (...args) => {
        events.push('tagging:start');
        assert.ok(counters.activeGenerationCount + counters.activeTaggingCount <= 1, 'tagging overlapped with generation in sequential mode');
        const r = await origTag(...args);
        events.push('tagging:end');
        return r;
      };

      const chunks = [chunk()];
      const result = await stageB(prepared(chunks), ctx, null, null, 'sequential');

      assert.equal(result.taggedChunks.length, 1);
      const genStart = events.indexOf('generation:start');
      const genEnd = events.indexOf('generation:end');
      const tagStart = events.indexOf('tagging:start');
      assert.ok(tagStart < genStart || tagStart > genEnd, `'tagging:start' occurred inside the generation window: ${events.join(', ')}`);
    });
  });

  it('TEST B — parallel mode: generation and tagging genuinely overlap', async () => {
    await withEnv({ TAG_PROVIDER: 'onnx', TAG_GEN: '1', COMBINED_LLM: '0', CONTEXT_MODE: '' }, async () => {
      const counters = { activeGenerationCount: 0, activeTaggingCount: 0 };
      const generationGate = deferred();
      const taggingGate = deferred();
      const ctx = makeCtx({ counters, generationGate, taggingGate });

      const chunks = [chunk()];
      const resultPromise = stageB(prepared(chunks), ctx, null, null, 'parallel');

      // If stageB had actually serialized generation and tagging, this
      // would hang forever (each gate only releases once BOTH are seen
      // held simultaneously) -- the timeout below is the structural proof.
      const bothHeld = await Promise.race([
        (async () => {
          while (!(counters.activeGenerationCount === 1 && counters.activeTaggingCount === 1)) {
            await new Promise((r) => setImmediate(r));
          }
          return true;
        })(),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      assert.equal(bothHeld, true, 'generation and tagging were never simultaneously active — stageB serialized them despite parallel mode');

      generationGate.resolve();
      taggingGate.resolve();
      const result = await resultPromise;
      assert.equal(result.taggedChunks.length, 1);
    });
  });

  it('TEST B2 — omitting the 5th argument entirely still exercises the parallel (Promise.all) path (default-parameter regression guard)', async () => {
    await withEnv({ TAG_PROVIDER: 'onnx', TAG_GEN: '1', COMBINED_LLM: '0', CONTEXT_MODE: '' }, async () => {
      const counters = { activeGenerationCount: 0, activeTaggingCount: 0 };
      const generationGate = deferred();
      const taggingGate = deferred();
      const ctx = makeCtx({ counters, generationGate, taggingGate });

      const chunks = [chunk()];
      // Omit BOTH ollamaSem and generationTaggingExecutionMode -- today's
      // exact existing call shape.
      const resultPromise = stageB(prepared(chunks), ctx);

      const bothHeld = await Promise.race([
        (async () => {
          while (!(counters.activeGenerationCount === 1 && counters.activeTaggingCount === 1)) {
            await new Promise((r) => setImmediate(r));
          }
          return true;
        })(),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      assert.equal(bothHeld, true, 'default parameter should preserve today\'s Promise.all() behavior');

      generationGate.resolve();
      taggingGate.resolve();
      await resultPromise;
    });
  });

  it('output shape/content is identical between sequential and parallel modes for the same input', async () => {
    await withEnv({ TAG_PROVIDER: 'onnx', TAG_GEN: '1', COMBINED_LLM: '0', CONTEXT_MODE: '' }, async () => {
      const chunks = [chunk({ chunkIndex: 0, totalChunks: 2 }), chunk({ chunkIndex: 1, totalChunks: 2, section: 'Details' })];

      const ctxSeq = makeCtx({ counters: { activeGenerationCount: 0, activeTaggingCount: 0 } });
      const resultSeq = await stageB(prepared(chunks), ctxSeq, null, null, 'sequential');

      const ctxPar = makeCtx({ counters: { activeGenerationCount: 0, activeTaggingCount: 0 } });
      const resultPar = await stageB(prepared(chunks), ctxPar, null, null, 'parallel');

      assert.equal(resultSeq.taggedChunks.length, resultPar.taggedChunks.length);
      for (let i = 0; i < resultSeq.taggedChunks.length; i++) {
        assert.equal(resultSeq.taggedChunks[i].context, resultPar.taggedChunks[i].context);
        assert.deepEqual(resultSeq.taggedChunks[i].tags, resultPar.taggedChunks[i].tags);
        assert.equal(resultSeq.taggedChunks[i].text, resultPar.taggedChunks[i].text);
      }
    });
  });
});
