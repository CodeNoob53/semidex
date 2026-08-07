import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIntParam,
  requireIntParam,
  requireExactlyOne,
  requireStringParam,
} from '../../../src/shared/admin/api/query-params.js';

function qs(str) {
  return new URLSearchParams(str);
}

describe('parseIntParam', () => {
  it('returns defaultValue when the param is missing', () => {
    assert.equal(parseIntParam(qs(''), 'limit', { defaultValue: 100 }), 100);
  });

  it('returns defaultValue when the param is an empty string', () => {
    assert.equal(parseIntParam(qs('limit='), 'limit', { defaultValue: 100 }), 100);
  });

  it('parses a valid integer', () => {
    assert.equal(parseIntParam(qs('limit=5'), 'limit', { defaultValue: 100 }), 5);
  });

  it('rejects a non-integer value', () => {
    assert.throws(() => parseIntParam(qs('limit=abc'), 'limit', {}), /must be an integer/);
  });

  it('rejects a float', () => {
    assert.throws(() => parseIntParam(qs('limit=1.5'), 'limit', {}), /must be an integer/);
  });

  it('clamps below min by default', () => {
    assert.equal(parseIntParam(qs('limit=-5'), 'limit', { min: 0 }), 0);
  });

  it('clamps above max by default', () => {
    assert.equal(parseIntParam(qs('limit=9999'), 'limit', { max: 1000 }), 1000);
  });

  it('rejects below min when belowMin: "reject"', () => {
    assert.throws(() => parseIntParam(qs('limit=0'), 'limit', { min: 1, belowMin: 'reject' }), /must be >= 1/);
  });

  it('rejects above max when aboveMax: "reject"', () => {
    assert.throws(() => parseIntParam(qs('window=99'), 'window', { max: 5, aboveMax: 'reject' }), /must be <= 5/);
  });

  it('accepts negative integers when min allows it', () => {
    assert.equal(parseIntParam(qs('x=-3'), 'x', {}), -3);
  });
});

describe('requireIntParam', () => {
  it('rejects a missing param', () => {
    assert.throws(() => requireIntParam(qs(''), 'chunkIndex', {}), /is required/);
  });

  it('rejects an empty-string param', () => {
    assert.throws(() => requireIntParam(qs('chunkIndex='), 'chunkIndex', {}), /is required/);
  });

  it('parses a present valid integer', () => {
    assert.equal(requireIntParam(qs('chunkIndex=4'), 'chunkIndex', { min: 0 }), 4);
  });

  it('applies bound rules like parseIntParam', () => {
    assert.throws(
      () => requireIntParam(qs('chunkIndex=-1'), 'chunkIndex', { min: 0, belowMin: 'reject' }),
      /must be >= 0/,
    );
  });
});

describe('requireExactlyOne', () => {
  it('returns the single present param', () => {
    assert.deepEqual(requireExactlyOne(qs('nodeId=n1'), ['nodeId', 'nodePath']), { key: 'nodeId', value: 'n1' });
  });

  it('returns the other param when only it is present', () => {
    assert.deepEqual(requireExactlyOne(qs('nodePath=p1'), ['nodeId', 'nodePath']), { key: 'nodePath', value: 'p1' });
  });

  it('rejects when neither is present', () => {
    assert.throws(() => requireExactlyOne(qs(''), ['nodeId', 'nodePath']), /exactly one/);
  });

  it('rejects when both are present', () => {
    assert.throws(() => requireExactlyOne(qs('nodeId=n1&nodePath=p1'), ['nodeId', 'nodePath']), /exactly one/);
  });

  it('treats an empty-string param as absent', () => {
    assert.deepEqual(requireExactlyOne(qs('nodeId=&nodePath=p1'), ['nodeId', 'nodePath']), { key: 'nodePath', value: 'p1' });
  });
});

describe('requireStringParam', () => {
  it('returns the param value when present', () => {
    assert.equal(requireStringParam(qs('sourceFile=a.md'), 'sourceFile'), 'a.md');
  });

  it('rejects a missing param', () => {
    assert.throws(() => requireStringParam(qs(''), 'sourceFile'), /is required/);
  });

  it('rejects an empty-string param', () => {
    assert.throws(() => requireStringParam(qs('sourceFile='), 'sourceFile'), /is required/);
  });
});
