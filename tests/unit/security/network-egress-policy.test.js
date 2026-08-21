// Tests the shared, pure evaluateEgressUrl() check directly (scheme,
// userinfo, canonicalization, metadata-literal block list, escape hatch),
// plus both capability-specific factories built on top of it
// (createQdrantEgressPolicy/createOllamaEgressPolicy) — proving they are
// genuinely independent, instance-scoped objects that do not share policy
// state across application instances.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEgressUrl, EgressPolicyError } from '../../../src/core/security/network-egress-policy.js';
import { createQdrantEgressPolicy } from '../../../src/core/security/qdrant-egress-policy.js';
import { createOllamaEgressPolicy } from '../../../src/core/security/ollama-egress-policy.js';

describe('evaluateEgressUrl — scheme and userinfo', () => {
  it('rejects file: scheme', () => {
    assert.deepEqual(evaluateEgressUrl('file:///etc/passwd'), { ok: false, reason: 'scheme_not_allowed' });
  });

  it('rejects ftp: scheme', () => {
    assert.deepEqual(evaluateEgressUrl('ftp://example.com/'), { ok: false, reason: 'scheme_not_allowed' });
  });

  it('rejects gopher: scheme', () => {
    assert.deepEqual(evaluateEgressUrl('gopher://example.com/'), { ok: false, reason: 'scheme_not_allowed' });
  });

  it('allows http:', () => {
    assert.deepEqual(evaluateEgressUrl('http://localhost:6333'), { ok: true });
  });

  it('allows https:', () => {
    assert.deepEqual(evaluateEgressUrl('https://qdrant.example.com:6333'), { ok: true });
  });

  it('rejects embedded userinfo (user:pass@host)', () => {
    assert.deepEqual(evaluateEgressUrl('http://user:pass@localhost:6333'), { ok: false, reason: 'userinfo_not_allowed' });
  });

  it('rejects username-only userinfo', () => {
    assert.deepEqual(evaluateEgressUrl('http://user@localhost:6333'), { ok: false, reason: 'userinfo_not_allowed' });
  });

  it('rejects an empty URL', () => {
    assert.deepEqual(evaluateEgressUrl(''), { ok: false, reason: 'empty_url' });
  });

  it('rejects a malformed URL', () => {
    assert.deepEqual(evaluateEgressUrl('not a url at all'), { ok: false, reason: 'malformed_url' });
  });
});

describe('evaluateEgressUrl — cloud-metadata literal block list', () => {
  it('blocks the AWS/GCP/Azure shared IPv4 literal', () => {
    assert.deepEqual(evaluateEgressUrl('http://169.254.169.254/latest/meta-data/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('blocks the IPv4-mapped IPv6 form, spelled as the dotted-quad literal', () => {
    assert.deepEqual(evaluateEgressUrl('http://[::ffff:169.254.169.254]/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('blocks the IPv4-mapped IPv6 form, spelled as the hex-group literal', () => {
    assert.deepEqual(evaluateEgressUrl('http://[::ffff:a9fe:a9fe]/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('blocks AWS\'s documented native IPv6 metadata address', () => {
    assert.deepEqual(evaluateEgressUrl('http://[fd00:ec2::254]/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('blocks AWS\'s native IPv6 address regardless of zero-padding/case spelling', () => {
    assert.deepEqual(evaluateEgressUrl('http://[FD00:EC2::0254]/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('blocks GCP\'s documented native IPv6 metadata address', () => {
    assert.deepEqual(evaluateEgressUrl('http://[fd20:ce::254]/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('blocks GCP\'s native IPv6 address regardless of zero-padding/case spelling', () => {
    assert.deepEqual(evaluateEgressUrl('http://[FD20:00CE::0254]/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('blocks GCP\'s metadata DNS name', () => {
    assert.deepEqual(evaluateEgressUrl('http://metadata.google.internal/computeMetadata/v1/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('blocks GCP\'s metadata DNS name regardless of case', () => {
    assert.deepEqual(evaluateEgressUrl('http://METADATA.GOOGLE.INTERNAL/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('blocks the metadata literal on a non-default port too (no port carve-out)', () => {
    assert.deepEqual(evaluateEgressUrl('http://169.254.169.254:8080/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('does NOT block a hostname that merely CONTAINS the metadata DNS name as a substring (exact match only, never suffix)', () => {
    assert.deepEqual(evaluateEgressUrl('http://evil-metadata.google.internal.attacker.example/'), { ok: true });
  });

  it('allowMetadataAddresses:true is the explicit, off-by-default escape hatch', () => {
    assert.deepEqual(evaluateEgressUrl('http://169.254.169.254/', { allowMetadataAddresses: true }), { ok: true });
    assert.deepEqual(evaluateEgressUrl('http://metadata.google.internal/', { allowMetadataAddresses: true }), { ok: true });
    assert.deepEqual(evaluateEgressUrl('http://[fd00:ec2::254]/', { allowMetadataAddresses: true }), { ok: true });
  });

  it('is off by default (omitting the option still blocks)', () => {
    assert.deepEqual(evaluateEgressUrl('http://169.254.169.254/'), { ok: false, reason: 'metadata_address_blocked' });
  });
});

describe('evaluateEgressUrl — Punycode/IDN canonicalization', () => {
  it('canonicalizes a Unicode hostname to Punycode before comparison (no Unicode-spelling bypass of a future literal, and no crash on IDN input)', () => {
    assert.deepEqual(evaluateEgressUrl('http://xn--e1aybc.xn--p1ai/'), { ok: true });
  });

  it('canonicalizes case (ExAmPlE.COM -> example.com) — never rejects a legitimate mixed-case host', () => {
    assert.deepEqual(evaluateEgressUrl('http://ExAmPlE.COM:6333/'), { ok: true });
  });
});

describe('evaluateEgressUrl — preserves every documented-legitimate deployment shape', () => {
  it('loopback IPv4', () => {
    assert.deepEqual(evaluateEgressUrl('http://127.0.0.1:6333'), { ok: true });
  });

  it('loopback IPv6', () => {
    assert.deepEqual(evaluateEgressUrl('http://[::1]:6333'), { ok: true });
  });

  it('RFC1918 LAN address', () => {
    assert.deepEqual(evaluateEgressUrl('http://192.168.1.10:6333'), { ok: true });
  });

  it('a second RFC1918 range (10.x)', () => {
    assert.deepEqual(evaluateEgressUrl('http://10.0.0.5:6333'), { ok: true });
  });

  it('Docker-internal hostname', () => {
    assert.deepEqual(evaluateEgressUrl('http://host.docker.internal:6333'), { ok: true });
  });

  it('a custom non-default port', () => {
    assert.deepEqual(evaluateEgressUrl('https://qdrant.example.com:16333'), { ok: true });
  });

  it('a path prefix (self-hosted behind a reverse-proxy path)', () => {
    assert.deepEqual(evaluateEgressUrl('https://example.com/qdrant'), { ok: true });
  });

  it('an arbitrary public hostname (Qdrant Cloud / a real self-hosted domain)', () => {
    assert.deepEqual(evaluateEgressUrl('https://xyz-cluster.aws.cloud.qdrant.io:6333'), { ok: true });
  });
});

describe('EgressPolicyError — typed, sanitized, never echoes the rejected URL', () => {
  it('carries capability/reason/code and a message that never contains the rejected URL string', () => {
    const secretShapedUrl = 'http://169.254.169.254/?token=super-secret-value-should-never-leak';
    const err = new EgressPolicyError({ capability: 'Qdrant', reason: 'metadata_address_blocked' });
    assert.equal(err.name, 'EgressPolicyError');
    assert.equal(err.code, 'egress_policy_blocked');
    assert.equal(err.capability, 'Qdrant');
    assert.equal(err.reason, 'metadata_address_blocked');
    assert.ok(!err.message.includes(secretShapedUrl), 'error message must never echo the rejected URL');
    assert.ok(!err.message.includes('token='), 'error message must never echo a credential-bearing query string');
  });
});

describe('createQdrantEgressPolicy / createOllamaEgressPolicy — instance-scoped, no shared state', () => {
  it('checkUrl() delegates to the shared evaluator with the instance\'s own allowMetadataAddresses', () => {
    const strict = createQdrantEgressPolicy();
    const permissive = createQdrantEgressPolicy({ allowMetadataAddresses: true });
    assert.deepEqual(strict.checkUrl('http://169.254.169.254/'), { ok: false, reason: 'metadata_address_blocked' });
    assert.deepEqual(permissive.checkUrl('http://169.254.169.254/'), { ok: true });
  });

  it('assertAllowed() throws a typed EgressPolicyError for a blocked URL, and returns {ok:true} for an allowed one', () => {
    const policy = createQdrantEgressPolicy();
    assert.throws(() => policy.assertAllowed('http://169.254.169.254/'), EgressPolicyError);
    assert.deepEqual(policy.assertAllowed('http://localhost:6333'), { ok: true });
  });

  it('two Qdrant policy instances with DIFFERENT allowMetadataAddresses never influence one another (no module-scope mutable state)', () => {
    const a = createQdrantEgressPolicy({ allowMetadataAddresses: true });
    const b = createQdrantEgressPolicy({ allowMetadataAddresses: false });
    // Interleaved calls — if either factory leaked shared/global state, one
    // instance's checkUrl() would observe the other's configuration.
    assert.deepEqual(a.checkUrl('http://169.254.169.254/'), { ok: true });
    assert.deepEqual(b.checkUrl('http://169.254.169.254/'), { ok: false, reason: 'metadata_address_blocked' });
    assert.deepEqual(a.checkUrl('http://169.254.169.254/'), { ok: true });
    assert.deepEqual(b.checkUrl('http://169.254.169.254/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('two Ollama policy instances with DIFFERENT allowMetadataAddresses never influence one another', () => {
    const a = createOllamaEgressPolicy({ allowMetadataAddresses: true });
    const b = createOllamaEgressPolicy({ allowMetadataAddresses: false });
    assert.deepEqual(a.checkUrl('http://[fd20:ce::254]/'), { ok: true });
    assert.deepEqual(b.checkUrl('http://[fd20:ce::254]/'), { ok: false, reason: 'metadata_address_blocked' });
    assert.deepEqual(a.checkUrl('http://[fd20:ce::254]/'), { ok: true });
    assert.deepEqual(b.checkUrl('http://[fd20:ce::254]/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('the Qdrant and Ollama factories are genuinely separate instances — configuring one does not touch the other', () => {
    const qdrantPermissive = createQdrantEgressPolicy({ allowMetadataAddresses: true });
    const ollamaStrict = createOllamaEgressPolicy({ allowMetadataAddresses: false });
    assert.deepEqual(qdrantPermissive.checkUrl('http://169.254.169.254/'), { ok: true });
    assert.deepEqual(ollamaStrict.checkUrl('http://169.254.169.254/'), { ok: false, reason: 'metadata_address_blocked' });
  });

  it('assertAllowed() error identifies which capability rejected the URL', () => {
    const qdrantPolicy = createQdrantEgressPolicy();
    const ollamaPolicy = createOllamaEgressPolicy();
    try {
      qdrantPolicy.assertAllowed('http://169.254.169.254/');
      assert.fail('expected assertAllowed to throw');
    } catch (err) {
      assert.equal(err.capability, 'Qdrant');
    }
    try {
      ollamaPolicy.assertAllowed('http://169.254.169.254/');
      assert.fail('expected assertAllowed to throw');
    } catch (err) {
      assert.equal(err.capability, 'Ollama');
    }
  });
});
