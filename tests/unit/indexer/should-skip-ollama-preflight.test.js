// src/indexer/run.js — shouldSkipOllamaPreflight(). Extracted from stageA()
// after a live Qdrant Cloud indexing run caught a real gap: legacy
// (non-Markdown) files under CONTEXT_MODE=deterministic still called
// ensureOllamaPreflight() and threw through Semidex Lite's ollama-lazy
// shim, even though stageB's own context-generation branch already
// correctly never called Ollama for that file — the preflight GATE and
// the context-generation CALL SITE had silently drifted onto two
// different conditions. This test pins the fixed, single source of truth
// both cases must agree with.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipOllamaPreflight } from '../../../src/shared/indexer/run.js';

function skeletonChunkMeta() {
  return { chunkingModel: 'skeleton-v1' };
}
function legacyChunkMeta() {
  return { chunkingModel: undefined };
}

describe('shouldSkipOllamaPreflight() — skeleton (Markdown) files', () => {
  it('skips preflight for a skeleton file with tags off, SKELETON_SUMMARY unset', () => {
    const skip = shouldSkipOllamaPreflight(skeletonChunkMeta(), {}, { genTagsPreflight: false, tagViaOnnx: false });
    assert.equal(skip, true);
  });

  it('does NOT skip when SKELETON_SUMMARY=llm (nav summaries need Ollama)', () => {
    const skip = shouldSkipOllamaPreflight(skeletonChunkMeta(), { SKELETON_SUMMARY: 'llm' }, { genTagsPreflight: false, tagViaOnnx: false });
    assert.equal(skip, false);
  });

  it('does NOT skip when tags are on and routed to Ollama (not ONNX)', () => {
    const skip = shouldSkipOllamaPreflight(skeletonChunkMeta(), {}, { genTagsPreflight: true, tagViaOnnx: false });
    assert.equal(skip, false);
  });

  it('still skips when tags are on but routed to the ONNX worker', () => {
    const skip = shouldSkipOllamaPreflight(skeletonChunkMeta(), {}, { genTagsPreflight: true, tagViaOnnx: true });
    assert.equal(skip, true);
  });
});

describe('shouldSkipOllamaPreflight() — legacy (non-Markdown: PDF/Pandoc/plain-text) files', () => {
  it('skips preflight under CONTEXT_MODE=deterministic with tags off — THE bug a live Qdrant Cloud run caught', () => {
    const skip = shouldSkipOllamaPreflight(legacyChunkMeta(), { CONTEXT_MODE: 'deterministic' }, { genTagsPreflight: false, tagViaOnnx: false });
    assert.equal(skip, true);
  });

  it('does NOT skip under the default CONTEXT_MODE=llm (unset)', () => {
    const skip = shouldSkipOllamaPreflight(legacyChunkMeta(), {}, { genTagsPreflight: false, tagViaOnnx: false });
    assert.equal(skip, false);
  });

  it('does NOT skip under CONTEXT_MODE=deterministic when tags are on and routed to Ollama', () => {
    const skip = shouldSkipOllamaPreflight(legacyChunkMeta(), { CONTEXT_MODE: 'deterministic' }, { genTagsPreflight: true, tagViaOnnx: false });
    assert.equal(skip, false);
  });

  it('still skips under CONTEXT_MODE=deterministic when tags are on but routed to the ONNX worker', () => {
    const skip = shouldSkipOllamaPreflight(legacyChunkMeta(), { CONTEXT_MODE: 'deterministic' }, { genTagsPreflight: true, tagViaOnnx: true });
    assert.equal(skip, true);
  });
});

describe('shouldSkipOllamaPreflight() — Semidex Lite\'s exact hard-pinned configuration', () => {
  it('skips preflight for BOTH a Markdown file and a non-Markdown file under Lite\'s pins (CONTEXT_MODE=deterministic, TAG_GEN=0, SKELETON_SUMMARY=deterministic)', () => {
    const liteEnv = { CONTEXT_MODE: 'deterministic', SKELETON_SUMMARY: 'deterministic', TAG_GEN: '0' };
    assert.equal(shouldSkipOllamaPreflight(skeletonChunkMeta(), liteEnv, { genTagsPreflight: false, tagViaOnnx: false }), true);
    assert.equal(shouldSkipOllamaPreflight(legacyChunkMeta(), liteEnv, { genTagsPreflight: false, tagViaOnnx: false }), true);
  });
});
