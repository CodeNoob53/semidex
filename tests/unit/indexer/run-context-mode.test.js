// src/indexer/run.js — stageB() under CONTEXT_MODE=deterministic
// (Semidex Lite foundation, Refactor 2). Integration-level test (not just
// the isolated addContextDeterministic() unit tests in
// tests/unit/indexer/phases/context-deterministic.test.js): proves the
// REAL stageB() legacy-chunk branch — the one chunk.js's PDF/Pandoc/
// plain-text routing actually reaches — never calls Ollama, using a real
// Profiler (no fakes needed for the parts of stageB that don't touch
// Ollama) and no network stubbing. If this branch ever regressed to
// calling addContext() instead of addContextDeterministic(), these tests
// would hang or throw on an unreachable Ollama server rather than
// resolving — that failure mode IS the proof, mirroring the isolated
// unit test's own reasoning.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stageB } from '../../../src/shared/indexer/run.js';
import { Profiler } from '../../../src/shared/indexer/profiler.js';

function legacyChunk({ sourceFile = 'report.pdf', section = 'Summary', text = 'Some real chunk body text.', chunkIndex = 0, totalChunks = 1 } = {}) {
  return {
    source_file: sourceFile, section, text, chunkIndex, totalChunks,
    chunking_model: undefined, // absence => not a skeleton-v1 chunk (isSkeletonChunk checks this)
  };
}

function prepared(rawChunks, { combinedEnabled = false } = {}) {
  return {
    rawChunks,
    combinedCfg: { enabled: combinedEnabled, model: 'gemma3:4b', warning: '' },
    profiler: new Profiler(),
    navPoints: [],
  };
}

// The deterministic-context branch never calls any of these — stageB()
// destructures ctx unconditionally before branching (Phase 8B Step 3: ctx
// is a real per-call argument, not a module-scope fallback), so a stub ctx
// with no working methods is enough here; a real call would throw loudly
// on first use, which these tests treat as their own regression signal.
const unusedCtx = { ollamaGenerate: null, ollamaSummary: null, tagOnnx: null };

describe('stageB() — CONTEXT_MODE=deterministic (legacy/non-skeleton chunks)', () => {
  it('produces deterministic context for every legacy chunk, with zero Ollama calls, under the default branch', async () => {
    const saved = { CONTEXT_MODE: process.env.CONTEXT_MODE, TAG_GEN: process.env.TAG_GEN };
    process.env.CONTEXT_MODE = 'deterministic';
    delete process.env.TAG_GEN;
    try {
      const chunks = [legacyChunk({ chunkIndex: 0, totalChunks: 2 }), legacyChunk({ chunkIndex: 1, totalChunks: 2, section: 'Details' })];
      const result = await stageB(prepared(chunks), unusedCtx);
      assert.equal(result.taggedChunks.length, 2);
      assert.equal(result.taggedChunks[0].context, 'report.pdf › Summary');
      assert.equal(result.taggedChunks[1].context, 'report.pdf › Details');
      // TAG_GEN unset -> tags forced to [] without calling any tag provider.
      assert.deepEqual(result.taggedChunks[0].tags, []);
    } finally {
      process.env.CONTEXT_MODE = saved.CONTEXT_MODE;
      if (saved.TAG_GEN === undefined) delete process.env.TAG_GEN; else process.env.TAG_GEN = saved.TAG_GEN;
    }
  });

  it('ignores COMBINED_LLM=1 for legacy chunks under CONTEXT_MODE=deterministic — never attempts the combined LLM call path', async () => {
    const saved = { CONTEXT_MODE: process.env.CONTEXT_MODE, TAG_GEN: process.env.TAG_GEN };
    process.env.CONTEXT_MODE = 'deterministic';
    delete process.env.TAG_GEN;
    try {
      const chunks = [legacyChunk()];
      // combinedCfg.enabled: true simulates COMBINED_LLM=1 — stageB must
      // still take the deterministic branch, never the combined-LLM branch
      // below it (which would call generate() and hang/throw here).
      const result = await stageB(prepared(chunks, { combinedEnabled: true }), unusedCtx);
      assert.equal(result.taggedChunks[0].context, 'report.pdf › Summary');
    } finally {
      process.env.CONTEXT_MODE = saved.CONTEXT_MODE;
      if (saved.TAG_GEN === undefined) delete process.env.TAG_GEN; else process.env.TAG_GEN = saved.TAG_GEN;
    }
  });

  it('CONTEXT_MODE unset (default) takes the LLM branch instead — full Semidex behavior unchanged (sanity check for the gate itself)', async () => {
    const saved = process.env.CONTEXT_MODE;
    delete process.env.CONTEXT_MODE;
    try {
      // This test does NOT call stageB with a real chunk through the LLM
      // branch (that would require a real Ollama server) — it only proves
      // the gate condition itself resolves to "not deterministic" when
      // unset, via the same isDeterministicContextMode() the branch uses.
      const { isDeterministicContextMode } = await import('../../../src/shared/indexer/phases/context.js');
      assert.equal(isDeterministicContextMode(process.env), false);
    } finally {
      if (saved === undefined) delete process.env.CONTEXT_MODE; else process.env.CONTEXT_MODE = saved;
    }
  });

  it('empty rawChunks array resolves cleanly with zero taggedChunks, never throws', async () => {
    const saved = process.env.CONTEXT_MODE;
    process.env.CONTEXT_MODE = 'deterministic';
    try {
      const result = await stageB(prepared([]), unusedCtx);
      assert.deepEqual(result.taggedChunks, []);
    } finally {
      if (saved === undefined) delete process.env.CONTEXT_MODE; else process.env.CONTEXT_MODE = saved;
    }
  });
});
