// src/indexer/phases/context.js — addContextDeterministic() and
// isDeterministicContextMode() (CONTEXT_MODE=deterministic, Semidex Lite
// foundation). addContextDeterministic() is the zero-LLM counterpart to
// addContext() for legacy (non-skeleton) chunks — PDF/Pandoc/plain-text —
// mirroring the skeleton chunker's own deterministic context
// (proseContext(headingPath) = headingPath.join(' › '), skeleton-chunk.js)
// but built from the flat source_file/section fields legacy chunks carry
// instead of a headingPath array.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addContextDeterministic, isDeterministicContextMode } from '../../../../src/shared/indexer/phases/context.js';

describe('isDeterministicContextMode', () => {
  it('true when CONTEXT_MODE=deterministic', () => {
    assert.equal(isDeterministicContextMode({ CONTEXT_MODE: 'deterministic' }), true);
  });

  it('false when CONTEXT_MODE=llm', () => {
    assert.equal(isDeterministicContextMode({ CONTEXT_MODE: 'llm' }), false);
  });

  it('false (default) when CONTEXT_MODE is unset — full Semidex behavior unchanged', () => {
    assert.equal(isDeterministicContextMode({}), false);
  });

  it('false for any other value — never silently treats a typo as deterministic', () => {
    assert.equal(isDeterministicContextMode({ CONTEXT_MODE: 'Deterministic' }), false);
    assert.equal(isDeterministicContextMode({ CONTEXT_MODE: '1' }), false);
  });
});

describe('addContextDeterministic', () => {
  it('builds context from source_file and section, joined the same way as the skeleton chunker (› separator)', async () => {
    const chunk = { source_file: 'docs/report.pdf', section: 'Introduction', text: 'body', chunkIndex: 0, totalChunks: 3 };
    const result = await addContextDeterministic(chunk);
    assert.equal(result.context, 'docs/report.pdf › Introduction');
  });

  it('omits the section segment when section is empty/falsy, never producing a trailing separator', async () => {
    const chunk = { source_file: 'notes.txt', section: '', text: 'body', chunkIndex: 0, totalChunks: 1 };
    const result = await addContextDeterministic(chunk);
    assert.equal(result.context, 'notes.txt');
  });

  it('omits the source_file segment when absent, never crashing on a missing field', async () => {
    const chunk = { section: 'Appendix', text: 'body', chunkIndex: 0, totalChunks: 1 };
    const result = await addContextDeterministic(chunk);
    assert.equal(result.context, 'Appendix');
  });

  it('produces an empty string (never throws, never "undefined") when both fields are absent', async () => {
    const chunk = { text: 'body', chunkIndex: 0, totalChunks: 1 };
    const result = await addContextDeterministic(chunk);
    assert.equal(result.context, '');
  });

  it('preserves every other field on the chunk unchanged (same return shape as addContext())', async () => {
    const chunk = { source_file: 'a.txt', section: 's', text: 'body text', chunkIndex: 2, totalChunks: 5, tags: ['x'] };
    const result = await addContextDeterministic(chunk);
    assert.equal(result.source_file, chunk.source_file);
    assert.equal(result.text, chunk.text);
    assert.equal(result.chunkIndex, chunk.chunkIndex);
    assert.equal(result.totalChunks, chunk.totalChunks);
    assert.deepEqual(result.tags, chunk.tags);
  });

  it('never calls any Ollama function — resolves with no network/generate call at all (the whole point)', async () => {
    // addContextDeterministic has no import of generate()/ollama-lazy.js in
    // its own module scope beyond what context.js already imports for
    // addContext() — proven structurally by NOT needing to stub `generate`
    // at all here: if this function ever regressed to calling generate(),
    // it would throw (no real Ollama server reachable in a unit test
    // environment) rather than silently resolving. Its passing here IS the
    // proof of zero-LLM-call behavior.
    const chunk = { source_file: 'x.txt', section: 'y', text: 'z', chunkIndex: 0, totalChunks: 1 };
    const result = await addContextDeterministic(chunk);
    assert.equal(typeof result.context, 'string');
  });
});
