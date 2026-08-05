// src/indexer/run.js's per-run embed-capability snapshot (code review,
// round 4, P1): embedCapabilities() previously read the mutable _ollama/
// _onnxEmbed bindings live, on every call — so a caller invoking
// applyRunCapabilities() WHILE a run() was still in flight could change
// which backend a LATER chunk in the SAME run embeds against, mid-run. This
// test drives the exact mechanism run() itself uses
// (_activeRunEmbedCapabilities, exposed for tests via
// __setActiveRunEmbedCapabilitiesForTest()) directly, without invoking the
// real run()/main() (which requires a live COLLECTION/target and touches
// Qdrant/Ollama).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { embedCapabilities, applyRunCapabilities, __setActiveRunEmbedCapabilitiesForTest } from '../../../src/indexer/run.js';

// Minimal fakes satisfying validateOllamaEmbedCapability/
// validateOnnxEmbedCapability's required-method contracts
// (core/generation/ollama-capability.js, core/onnx-embed-capability.js) —
// applyRunCapabilities() validates against these before accepting a
// capability, so a bare tagged object isn't enough.
function fakeOllama(tag) {
  return { tag, embed: async () => {}, getOllamaEmbeddingDimension: async () => 384 };
}
function fakeOnnxEmbed(tag) {
  return { tag, loadOnnx: async () => {}, loadOnnxBatch: async () => {} };
}

describe('run.js — embedCapabilities() run-scoped snapshot isolation', () => {
  afterEach(() => {
    // Never leak a test's snapshot into a later test/module — mirrors
    // run()'s own `finally` clear.
    __setActiveRunEmbedCapabilitiesForTest(null);
  });

  it('outside an active run (no snapshot set), reflects the current live _ollama/_onnxEmbed bindings', () => {
    const before = fakeOllama('before');
    applyRunCapabilities({ ollama: before, onnxEmbed: fakeOnnxEmbed('before') });
    assert.equal(embedCapabilities().ollama, before);

    const after = fakeOllama('after');
    applyRunCapabilities({ ollama: after, onnxEmbed: fakeOnnxEmbed('after') });
    assert.equal(embedCapabilities().ollama, after, 'outside a run, embedCapabilities() must track live mutations (existing stageA/stageB/stageC direct-test behavior)');
  });

  it('once a run snapshot is set, changing the global/default capability does NOT affect the active run', () => {
    const runOllama = fakeOllama('run-scoped');
    const runOnnx = fakeOnnxEmbed('run-scoped');
    applyRunCapabilities({ ollama: runOllama, onnxEmbed: runOnnx });

    // Simulates run()'s own snapshot line: _activeRunEmbedCapabilities = { ollama: _ollama, onnxEmbed: _onnxEmbed };
    __setActiveRunEmbedCapabilitiesForTest({ ollama: runOllama, onnxEmbed: runOnnx });

    assert.equal(embedCapabilities().ollama, runOllama);
    assert.equal(embedCapabilities().onnxEmbed, runOnnx);

    // A concurrent caller (e.g. another composition root, or a test)
    // changes the global/default capability WHILE the run is "in flight".
    const laterOllama = fakeOllama('changed-mid-run');
    const laterOnnx = fakeOnnxEmbed('changed-mid-run');
    applyRunCapabilities({ ollama: laterOllama, onnxEmbed: laterOnnx });

    // The active run must keep observing its own fixed snapshot — every
    // embedForIndex()/embedForIndexBatch() call for the rest of this run
    // uses the SAME capability pair it started with.
    assert.equal(embedCapabilities().ollama, runOllama, 'active run must not observe a capability change that happens mid-run');
    assert.equal(embedCapabilities().onnxEmbed, runOnnx, 'active run must not observe a capability change that happens mid-run');
    assert.notEqual(embedCapabilities().ollama, laterOllama);
  });

  it('after the run snapshot is cleared (mirrors run()\'s own finally block), embedCapabilities() reverts to tracking live bindings again', () => {
    const runOllama = fakeOllama('run-scoped-2');
    const runOnnx = fakeOnnxEmbed('run-scoped-2');
    __setActiveRunEmbedCapabilitiesForTest({ ollama: runOllama, onnxEmbed: runOnnx });
    assert.equal(embedCapabilities().ollama, runOllama);

    __setActiveRunEmbedCapabilitiesForTest(null);

    const postRunOllama = fakeOllama('post-run');
    applyRunCapabilities({ ollama: postRunOllama, onnxEmbed: fakeOnnxEmbed('post-run') });
    assert.equal(embedCapabilities().ollama, postRunOllama, 'after the run ends, embedCapabilities() must track live bindings again — same as before any run started');
  });
});
