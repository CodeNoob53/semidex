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
import { shouldSkipOllamaPreflight, resolveRequiredOllamaModels } from '../../../src/shared/indexer/run.js';

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

// Code review finding (P1): checkOllamaPreflight() must validate the
// EXACT, minimal set of models this run's stageB call will use — not a
// flat contextModel+tagModel pair checked unconditionally. Supersedes
// the earlier resolvePreflightTagModel() fix, which corrected WHICH
// single tag-model name to check but still always paired it with
// contextModel regardless of whether context is ever actually called
// this run — for CONTEXT_MODE=deterministic + TAG_GEN=1 +
// TAG_PROVIDER=ollama + TAG_MODEL set (CONTEXT_MODEL never pulled),
// preflight incorrectly failed requiring CONTEXT_MODEL even though no
// stageB branch for this file ever calls it.
describe('resolveRequiredOllamaModels()', () => {
  function skeletonChunkMeta() { return { chunkingModel: 'skeleton-v1' }; }
  function legacyChunkMeta() { return { chunkingModel: undefined }; }

  it('THE reported combination: CONTEXT_MODE=deterministic + TAG_GEN=1 + TAG_PROVIDER=ollama + TAG_MODEL set, CONTEXT_MODEL never pulled -> requires ONLY tag-model', () => {
    const env = { CONTEXT_MODE: 'deterministic', TAG_MODEL: 'tag-model' };
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), env, {
      contextModel: 'context-model', genTagsPreflight: true, tagViaOnnx: false, combinedEnabled: false,
    });
    assert.deepEqual(models, ['tag-model']);
  });

  it('the earlier variant with COMBINED_LLM=1 also set -> still requires ONLY tag-model (deterministic context ignores combined mode, matching stageB)', () => {
    const env = { CONTEXT_MODE: 'deterministic', TAG_MODEL: 'tag-model' };
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), env, {
      contextModel: 'context-model', genTagsPreflight: true, tagViaOnnx: false, combinedEnabled: true,
    });
    assert.deepEqual(models, ['tag-model']);
  });

  it('CONTEXT_MODE=deterministic + tags off -> requires nothing at all (empty array)', () => {
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), { CONTEXT_MODE: 'deterministic' }, {
      contextModel: 'context-model', genTagsPreflight: false, tagViaOnnx: false, combinedEnabled: true,
    });
    assert.deepEqual(models, []);
  });

  it('CONTEXT_MODE=deterministic + tags routed to ONNX -> requires nothing (tags never reach Ollama, context is deterministic)', () => {
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), { CONTEXT_MODE: 'deterministic', TAG_MODEL: 'tag-model' }, {
      contextModel: 'context-model', genTagsPreflight: true, tagViaOnnx: true, combinedEnabled: true,
    });
    assert.deepEqual(models, []);
  });

  it('CONTEXT_MODE=deterministic, TAG_MODEL unset -> falls back to contextModel\'s own name for the tag slot', () => {
    // resolveTagModel(env) re-derives from env.TAG_MODEL||env.CONTEXT_MODEL
    // directly (tag.js's own fallback order) — env.CONTEXT_MODEL must be
    // set consistently with the contextModel opt for this fallback to
    // land on the SAME name a real caller (run.js, where contextModel IS
    // literally process.env.CONTEXT_MODEL||'gemma3:4b') would see.
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), { CONTEXT_MODE: 'deterministic', CONTEXT_MODEL: 'context-model' }, {
      contextModel: 'context-model', genTagsPreflight: true, tagViaOnnx: false, combinedEnabled: false,
    });
    assert.deepEqual(models, ['context-model']);
  });

  it('skeleton file (Markdown), tags on Ollama -> requires ONLY the tag model (skeleton context is always deterministic, matching stageB)', () => {
    const models = resolveRequiredOllamaModels(skeletonChunkMeta(), { TAG_MODEL: 'tag-model' }, {
      contextModel: 'context-model', genTagsPreflight: true, tagViaOnnx: false, combinedEnabled: false,
    });
    assert.deepEqual(models, ['tag-model']);
  });

  it('skeleton file, tags off, SKELETON_SUMMARY unset -> requires nothing at all', () => {
    const models = resolveRequiredOllamaModels(skeletonChunkMeta(), {}, {
      contextModel: 'context-model', genTagsPreflight: false, tagViaOnnx: false, combinedEnabled: false,
    });
    assert.deepEqual(models, []);
  });

  it('skeleton file, SKELETON_SUMMARY=llm -> requires contextModel even with tags off (nav summaries use it)', () => {
    const models = resolveRequiredOllamaModels(skeletonChunkMeta(), { SKELETON_SUMMARY: 'llm' }, {
      contextModel: 'context-model', genTagsPreflight: false, tagViaOnnx: false, combinedEnabled: false,
    });
    assert.deepEqual(models, ['context-model']);
  });

  it('default (non-deterministic legacy file) COMBINED_LLM=1 -> requires only contextModel (TAG_MODEL ignored in combined mode)', () => {
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), {}, {
      contextModel: 'context-model', genTagsPreflight: true, tagViaOnnx: false, combinedEnabled: true,
    });
    assert.deepEqual(models, ['context-model']);
  });

  it('default (non-deterministic legacy file), not combined, tags on Ollama -> requires BOTH context and tag models', () => {
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), { TAG_MODEL: 'tag-model' }, {
      contextModel: 'context-model', genTagsPreflight: true, tagViaOnnx: false, combinedEnabled: false,
    });
    assert.deepEqual(models, ['context-model', 'tag-model']);
  });

  it('default, TAG_MODEL unset (falls back to contextModel) -> de-duplicated to a single entry', () => {
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), { CONTEXT_MODEL: 'context-model' }, {
      contextModel: 'context-model', genTagsPreflight: true, tagViaOnnx: false, combinedEnabled: false,
    });
    assert.deepEqual(models, ['context-model']);
  });

  it('default, tags off -> requires only contextModel', () => {
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), {}, {
      contextModel: 'context-model', genTagsPreflight: false, tagViaOnnx: false, combinedEnabled: false,
    });
    assert.deepEqual(models, ['context-model']);
  });

  it('default (ONNX-parallel branch), tags routed to ONNX -> requires only contextModel', () => {
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), { TAG_MODEL: 'tag-model' }, {
      contextModel: 'context-model', genTagsPreflight: true, tagViaOnnx: true, combinedEnabled: false,
    });
    assert.deepEqual(models, ['context-model']);
  });

  it('legacy file, SKELETON_SUMMARY=llm -> also requires contextModel on top of whatever the branch already needs (de-duplicated)', () => {
    const models = resolveRequiredOllamaModels(legacyChunkMeta(), { SKELETON_SUMMARY: 'llm', TAG_MODEL: 'tag-model' }, {
      contextModel: 'context-model', genTagsPreflight: true, tagViaOnnx: false, combinedEnabled: false,
    });
    assert.deepEqual(models, ['context-model', 'tag-model']);
  });
});
