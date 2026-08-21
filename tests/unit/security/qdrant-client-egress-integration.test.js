// Proves the Qdrant egress policy is wired into
// getQdrantClient(), not just correct in isolation (see
// network-egress-policy.test.js for the policy's own unit tests). A blocked
// QDRANT_URL must fail BEFORE any QdrantClient is constructed and before any
// network call, with a typed, sanitized error; every already-legitimate
// QDRANT_URL shape (loopback/LAN/Docker/custom port/path prefix) must keep
// working exactly as before this change.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getQdrantClient, resetQdrantClientCache } from '../../../src/core/qdrant/client.js';
import { EgressPolicyError } from '../../../src/core/security/network-egress-policy.js';

const ENV_KEYS = ['QDRANT_URL', 'QDRANT_KEY', 'QDRANT_ALLOW_METADATA_EGRESS'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  resetQdrantClientCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetQdrantClientCache();
});

describe('getQdrantClient() — egress policy wired before construction', () => {
  it('throws a typed EgressPolicyError for a blocked (metadata-literal) QDRANT_URL, never constructing a client', () => {
    process.env.QDRANT_URL = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
    delete process.env.QDRANT_ALLOW_METADATA_EGRESS;
    assert.throws(() => getQdrantClient(), (err) => {
      assert.ok(err instanceof EgressPolicyError, 'expected an EgressPolicyError');
      assert.equal(err.code, 'egress_policy_blocked');
      assert.equal(err.capability, 'Qdrant');
      assert.equal(err.reason, 'metadata_address_blocked');
      assert.ok(!err.message.includes('169.254.169.254'), 'error message must never echo the rejected URL');
      return true;
    });
  });

  it('blocks the AWS native-IPv6 metadata address the same way', () => {
    process.env.QDRANT_URL = 'http://[fd00:ec2::254]/latest/meta-data/';
    delete process.env.QDRANT_ALLOW_METADATA_EGRESS;
    assert.throws(() => getQdrantClient(), EgressPolicyError);
  });

  it('blocks a scheme other than http/https before construction', () => {
    process.env.QDRANT_URL = 'file:///etc/passwd';
    assert.throws(() => getQdrantClient(), (err) => {
      assert.ok(err instanceof EgressPolicyError);
      assert.equal(err.reason, 'scheme_not_allowed');
      return true;
    });
  });

  it('blocks a QDRANT_URL carrying embedded userinfo', () => {
    process.env.QDRANT_URL = 'http://attacker:pwned@169.254.169.254/';
    assert.throws(() => getQdrantClient(), (err) => {
      assert.ok(err instanceof EgressPolicyError);
      assert.equal(err.reason, 'userinfo_not_allowed');
      return true;
    });
  });

  it('a blocked URL leaves no cached client behind — a subsequent call with a valid URL still succeeds', () => {
    process.env.QDRANT_URL = 'http://169.254.169.254/';
    assert.throws(() => getQdrantClient(), EgressPolicyError);

    process.env.QDRANT_URL = 'http://localhost:6333';
    const client = getQdrantClient();
    assert.ok(client, 'expected a real client instance once QDRANT_URL is corrected');
  });

  it('QDRANT_ALLOW_METADATA_EGRESS=1 is the explicit, off-by-default escape hatch, honored end-to-end through getQdrantClient()', () => {
    process.env.QDRANT_URL = 'http://169.254.169.254/';
    process.env.QDRANT_ALLOW_METADATA_EGRESS = '1';
    const client = getQdrantClient();
    assert.ok(client, 'expected a client instance when the escape hatch is explicitly enabled');
  });

  it('the escape hatch requires the exact value "1" — any other value keeps blocking', () => {
    process.env.QDRANT_URL = 'http://169.254.169.254/';
    process.env.QDRANT_ALLOW_METADATA_EGRESS = 'true';
    assert.throws(() => getQdrantClient(), EgressPolicyError);
  });

  it('every already-legitimate deployment shape still constructs a client with no policy change in behavior', () => {
    for (const url of [
      'http://localhost:6333',
      'http://127.0.0.1:6333',
      'http://192.168.1.10:6333',
      'http://host.docker.internal:6333',
      'https://example.com/qdrant',
      'https://xyz-cluster.aws.cloud.qdrant.io:6333',
    ]) {
      resetQdrantClientCache();
      process.env.QDRANT_URL = url;
      delete process.env.QDRANT_ALLOW_METADATA_EGRESS;
      const client = getQdrantClient();
      assert.ok(client, `expected a client instance for ${url}`);
    }
  });
});
