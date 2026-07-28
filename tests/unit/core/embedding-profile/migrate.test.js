import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldPayloadConsistency, checkPayloadConsistency, inferLegacyProfile,
} from '../../../../src/core/embedding-profile/migrate.js';

function onnxPayload(overrides = {}) {
  return {
    source_file: 'docs/a.md', dense_provider: 'bge-m3-onnx', dense_model: 'aapot/bge-m3-onnx',
    sparse_provider: 'bge-m3-onnx', embedding_schema_version: 2, vector_size: 1024,
    ...overrides,
  };
}

function ollamaPayload(overrides = {}) {
  return {
    source_file: 'docs/b.md', dense_provider: 'ollama', dense_model: 'bge-m3',
    sparse_provider: 'hashed-tf', embedding_schema_version: 2, vector_size: 1024,
    ...overrides,
  };
}

const onnxSchema = { dense: { name: 'dense', dimensions: 1024, distance: 'Cosine' }, sparse: { name: 'sparse', modifier: null } };
const ollamaSchema = { dense: { name: 'dense', dimensions: 1024, distance: 'Cosine' }, sparse: { name: 'sparse', modifier: null } };

describe('checkPayloadConsistency / foldPayloadConsistency', () => {
  it('an empty payload array is reported as consistent: false, reason: empty', () => {
    assert.deepEqual(checkPayloadConsistency([]), { consistent: false, reason: 'empty' });
  });

  it('a single-point sample is trivially consistent', () => {
    const result = checkPayloadConsistency([onnxPayload()]);
    assert.equal(result.consistent, true);
    assert.equal(result.agreed.denseProvider, 'bge-m3-onnx');
    assert.equal(result.count, 1);
  });

  it('multiple agreeing points across different files are consistent', () => {
    const result = checkPayloadConsistency([onnxPayload(), onnxPayload({ source_file: 'docs/c.md' }), onnxPayload({ source_file: 'docs/d.md' })]);
    assert.equal(result.consistent, true);
    assert.equal(result.count, 3);
  });

  it('a disagreement appearing on a later point is caught, not silently ignored', () => {
    const result = checkPayloadConsistency([
      onnxPayload(), onnxPayload({ source_file: 'x.md' }), ollamaPayload({ source_file: 'y.md' }),
    ]);
    assert.equal(result.consistent, false);
    assert.equal(result.disagreement.sourceFile, 'y.md');
  });

  it('foldPayloadConsistency across multiple pages accumulates correctly when all pages agree', () => {
    let acc = null;
    acc = foldPayloadConsistency(acc, [onnxPayload(), onnxPayload({ source_file: 'p1b.md' })]);
    assert.equal(acc.consistent, true);
    acc = foldPayloadConsistency(acc, [onnxPayload({ source_file: 'p2.md' })]);
    assert.equal(acc.consistent, true);
    assert.equal(acc.count, 3);
  });

  it('foldPayloadConsistency stops being useful (terminal) once a page disagrees — a later fold call is a no-op passthrough', () => {
    let acc = foldPayloadConsistency(null, [onnxPayload()]);
    acc = foldPayloadConsistency(acc, [ollamaPayload({ source_file: 'bad.md' })]);
    assert.equal(acc.consistent, false);
    const acc2 = foldPayloadConsistency(acc, [onnxPayload({ source_file: 'irrelevant.md' })]);
    assert.equal(acc2, acc, 'a terminal disagreement must not be reprocessed');
  });

  it('an empty page mid-sequence does not disturb an already-consistent accumulator', () => {
    let acc = foldPayloadConsistency(null, [onnxPayload()]);
    acc = foldPayloadConsistency(acc, []);
    assert.equal(acc.consistent, true);
    assert.equal(acc.count, 1);
  });
});

describe('inferLegacyProfile', () => {
  it('infers the bge-m3-onnx + bge-m3-onnx combo from a consistent sample', () => {
    const consistency = checkPayloadConsistency([onnxPayload(), onnxPayload({ source_file: 'x.md' })]);
    const result = inferLegacyProfile(consistency, onnxSchema);
    assert.equal(result.status, 'inferred');
    assert.equal(result.profile.embedding.dense.provider, 'bge-m3-onnx');
    assert.equal(result.profile.embedding.sparse.provider, 'bge-m3-onnx');
    assert.equal(result.profile.embedding.dense.dimensions, 1024);
  });

  it('infers the ollama + hashed-tf combo from a consistent sample', () => {
    const consistency = checkPayloadConsistency([ollamaPayload(), ollamaPayload({ source_file: 'x.md' })]);
    const result = inferLegacyProfile(consistency, ollamaSchema);
    assert.equal(result.status, 'inferred');
    assert.equal(result.profile.embedding.dense.provider, 'ollama');
    assert.equal(result.profile.embedding.sparse.provider, 'hashed-tf');
  });

  it('an inconsistent sample is reported ambiguous, never silently resolved to a majority', () => {
    const consistency = checkPayloadConsistency([onnxPayload(), ollamaPayload({ source_file: 'x.md' })]);
    const result = inferLegacyProfile(consistency, onnxSchema);
    assert.equal(result.status, 'ambiguous');
  });

  it('an unknown/unrecognized provider combination is ambiguous, never guessed', () => {
    const consistency = checkPayloadConsistency([onnxPayload({ dense_provider: 'ollama', sparse_provider: 'bge-m3-onnx' })]);
    const result = inferLegacyProfile(consistency, onnxSchema);
    assert.equal(result.status, 'ambiguous');
  });

  it('a dimension mismatch between payload and live schema is reported, not silently accepted', () => {
    const consistency = checkPayloadConsistency([onnxPayload({ vector_size: 768 })]);
    const result = inferLegacyProfile(consistency, onnxSchema); // schema says 1024
    assert.equal(result.status, 'ambiguous');
    assert.match(result.reason, /vector_size/);
  });

  it('a missing sparse vector in the live schema, despite payload claiming sparse_provider, is reported', () => {
    const consistency = checkPayloadConsistency([onnxPayload()]);
    const denseOnlySchema = { dense: onnxSchema.dense, sparse: null };
    const result = inferLegacyProfile(consistency, denseOnlySchema);
    assert.equal(result.status, 'ambiguous');
  });

  it('zero content points (empty sample) is reported as no_payload, not ambiguous', () => {
    const consistency = checkPayloadConsistency([]);
    const result = inferLegacyProfile(consistency, onnxSchema);
    assert.equal(result.status, 'no_payload');
  });

  it('a live schema missing dense entirely is reported (cannot verify identity)', () => {
    const consistency = checkPayloadConsistency([onnxPayload()]);
    const result = inferLegacyProfile(consistency, { dense: null, sparse: null });
    assert.equal(result.status, 'ambiguous');
  });
});
