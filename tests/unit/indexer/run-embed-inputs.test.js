// src/indexer/run.js's buildEmbedInputsForChunks() — the pure helper that
// decides what text each chunk embeds against. taggedChunks NEVER contains
// an entity_raw point (entity-split.js's canonical points are threaded
// through the pipeline as their own separate entityRawPoints array, never
// mixed into the retrieval chunk_index sequence — see stageA/stageC in
// run.js) — this file only exercises the ordinary retrieval_content shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbedInputsForChunks } from '../../../src/indexer/run.js';
import { POINT_KINDS } from '../../../src/indexer/phases/node-policy.js';

describe('buildEmbedInputsForChunks', () => {
  test('an ordinary chunk embeds context+text joined by a blank line, with context passed through', () => {
    const chunks = [{ point_kind: POINT_KINDS.RETRIEVAL, context: 'Heading path', text: 'body text' }];
    const { embedTexts, embedContexts } = buildEmbedInputsForChunks(chunks);
    assert.equal(embedTexts[0], 'Heading path\n\nbody text');
    assert.equal(embedContexts[0], 'Heading path');
  });

  test('useTextOnly=true embeds bare text, no context prefix, and context is reported as null', () => {
    const chunks = [{ point_kind: POINT_KINDS.RETRIEVAL, context: 'Heading path', text: 'body text' }];
    const { embedTexts, embedContexts } = buildEmbedInputsForChunks(chunks, { useTextOnly: true });
    assert.equal(embedTexts[0], 'body text');
    assert.equal(embedContexts[0], null);
  });

  test('a fragment chunk (retrieval_content with entity_id) embeds like any other retrieval chunk — context+text, nothing special', () => {
    const chunks = [{
      point_kind: POINT_KINDS.RETRIEVAL, context: 'Section A — table', text: 'fragment one row',
      entity_id: 'canonical-uuid', fragment_index: 0, fragment_count: 2,
    }];
    const { embedTexts, embedContexts } = buildEmbedInputsForChunks(chunks);
    assert.equal(embedTexts[0], 'Section A — table\n\nfragment one row');
    assert.equal(embedContexts[0], 'Section A — table');
  });

  test('a mixed batch of ordinary chunks each get their own correct embed input', () => {
    const chunks = [
      { point_kind: POINT_KINDS.RETRIEVAL, context: 'Section A', text: 'prose one' },
      { point_kind: POINT_KINDS.RETRIEVAL, context: 'Section A — table', text: 'fragment one row' },
    ];
    const { embedTexts, embedContexts } = buildEmbedInputsForChunks(chunks);
    assert.equal(embedTexts[0], 'Section A\n\nprose one');
    assert.equal(embedContexts[0], 'Section A');
    assert.equal(embedTexts[1], 'Section A — table\n\nfragment one row');
    assert.equal(embedContexts[1], 'Section A — table');
  });
});
