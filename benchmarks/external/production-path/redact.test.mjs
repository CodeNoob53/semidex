// core/redact.mjs — offline, no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './core/redact.mjs';

describe('redact()', () => {
  it('redacts a literal secret string wherever it appears', () => {
    const out = redact('request failed with key sk-super-secret-key-value', 'sk-super-secret-key-value');
    assert.ok(!out.includes('sk-super-secret-key-value'));
  });

  it('redacts this harness\'s own .cache path segments (materialized/config/telemetry)', () => {
    const out = redact('indexer stdout: wrote points under C:\\repo\\benchmarks\\external\\production-path\\.cache\\materialized\\scifact\\cloud-abc123\\doc-1.md');
    assert.ok(!out.includes('materialized'));
    assert.ok(out.includes('<production-path-cache>'));
  });

  it('handles an Error object, using its stack/message', () => {
    const err = new Error('failed: secret-value-xyz');
    const out = redact(err, 'secret-value-xyz');
    assert.ok(!out.includes('secret-value-xyz'));
  });

  it('is a no-op on ordinary text with no secret and no harness cache paths', () => {
    const out = redact('a normal informational message');
    assert.equal(out, 'a normal informational message');
  });

  it('handles null/undefined without throwing', () => {
    assert.doesNotThrow(() => redact(null));
    assert.doesNotThrow(() => redact(undefined));
  });
});
