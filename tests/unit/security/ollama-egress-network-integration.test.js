// Proves the Ollama egress policy is wired into every
// local/core/ollama.js function that performs a fetch(), not just correct in
// isolation (see network-egress-policy.test.js for the policy's own unit
// tests). A blocked baseUrl must fail BEFORE any network call — asserted
// here via a fetch spy that must never be invoked — and every
// already-legitimate baseUrl must keep making the same real fetch() calls
// as before this change (no behavior regression for allowed destinations).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOllamaReachable, listOllamaModels, showModel, getRunningModel,
  getOllamaEmbeddingDimension, embed, generate, generateStream,
} from '../../../src/local/core/ollama.js';
import { EgressPolicyError } from '../../../src/core/security/network-egress-policy.js';

// Shared validator for assert.rejects() below — checks the typed error's
// name/code/reason/capability fields, not just a message-substring regex, so
// a future change that keeps "egress policy" in the text but drops the typed
// shape (or the correct reason) would still fail this test.
function assertBlockedByEgressPolicy(err, { reason = 'metadata_address_blocked' } = {}) {
  assert.ok(err instanceof EgressPolicyError, 'expected an EgressPolicyError instance');
  assert.equal(err.name, 'EgressPolicyError');
  assert.equal(err.code, 'egress_policy_blocked');
  assert.equal(err.capability, 'Ollama');
  assert.equal(err.reason, reason);
  return true;
}

const BLOCKED_URL = 'http://169.254.169.254';
const ENV_KEYS = ['OLLAMA_ALLOW_METADATA_EGRESS'];
let saved;
let originalFetch;
let fetchCallCount;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.OLLAMA_ALLOW_METADATA_EGRESS;
  originalFetch = globalThis.fetch;
  fetchCallCount = 0;
  globalThis.fetch = async (...args) => {
    fetchCallCount += 1;
    throw new Error(`unexpected real network call in test: ${args[0]}`);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('local/core/ollama.js — egress policy blocks every network call for a blocked baseUrl', () => {
  it('isOllamaReachable() returns false without ever calling fetch()', async () => {
    assert.equal(await isOllamaReachable(BLOCKED_URL), false);
    assert.equal(fetchCallCount, 0);
  });

  it('listOllamaModels() throws a typed EgressPolicyError before calling fetch()', async () => {
    await assert.rejects(() => listOllamaModels(BLOCKED_URL), assertBlockedByEgressPolicy);
    assert.equal(fetchCallCount, 0);
  });

  it('showModel() returns null without ever calling fetch()', async () => {
    assert.equal(await showModel('gemma3:4b', BLOCKED_URL), null);
    assert.equal(fetchCallCount, 0);
  });

  it('getRunningModel() returns null without ever calling fetch()', async () => {
    assert.equal(await getRunningModel('gemma3:4b', BLOCKED_URL), null);
    assert.equal(fetchCallCount, 0);
  });

  it('getOllamaEmbeddingDimension() returns null without ever calling fetch() (covers both the /api/show and /api/embed probe paths)', async () => {
    assert.equal(await getOllamaEmbeddingDimension('probe-model', BLOCKED_URL), null);
    assert.equal(fetchCallCount, 0);
  });

  it('generateStream() throws a typed EgressPolicyError before calling fetch() for an explicit blocked baseUrl', async () => {
    await assert.rejects(
      () => generateStream('gemma3:4b', 'hi', { baseUrl: BLOCKED_URL }),
      assertBlockedByEgressPolicy,
    );
    assert.equal(fetchCallCount, 0);
  });

  it('the AWS native-IPv6 metadata literal is blocked the same way', async () => {
    assert.equal(await isOllamaReachable('http://[fd00:ec2::254]'), false);
    assert.equal(fetchCallCount, 0);
  });

  it('the GCP metadata DNS name is blocked the same way', async () => {
    assert.equal(await isOllamaReachable('http://metadata.google.internal'), false);
    assert.equal(fetchCallCount, 0);
  });
});

describe('local/core/ollama.js — allowed destinations still make the real fetch() call (no regression)', () => {
  it('isOllamaReachable() still calls fetch() for a loopback baseUrl', async () => {
    globalThis.fetch = async (url) => { fetchCallCount += 1; assert.match(url, /\/api\/version$/); return { ok: true }; };
    assert.equal(await isOllamaReachable('http://localhost:11434'), true);
    assert.equal(fetchCallCount, 1);
  });

  it('listOllamaModels() still calls fetch() for a LAN baseUrl', async () => {
    globalThis.fetch = async (url) => {
      fetchCallCount += 1;
      assert.match(url, /\/api\/tags$/);
      return { ok: true, json: async () => ({ models: [{ name: 'gemma3:4b' }] }) };
    };
    assert.deepEqual(await listOllamaModels('http://192.168.1.20:11434'), ['gemma3:4b']);
    assert.equal(fetchCallCount, 1);
  });

  it('generateStream() still calls fetch() for a Docker-internal baseUrl', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = async (url) => {
      fetchCallCount += 1;
      assert.match(url, /\/api\/generate$/);
      return {
        ok: true,
        body: { [Symbol.asyncIterator]: async function* () { yield encoder.encode('{"response":"ok","done":true}\n'); } },
      };
    };
    const result = await generateStream('gemma3:4b', 'hi', { baseUrl: 'http://host.docker.internal:11434' });
    assert.equal(result.text, 'ok');
    assert.equal(fetchCallCount, 1);
  });

  it('OLLAMA_ALLOW_METADATA_EGRESS=1 is the explicit, off-by-default escape hatch, honored end-to-end', async () => {
    process.env.OLLAMA_ALLOW_METADATA_EGRESS = '1';
    globalThis.fetch = async () => { fetchCallCount += 1; return { ok: true }; };
    assert.equal(await isOllamaReachable(BLOCKED_URL), true);
    assert.equal(fetchCallCount, 1);
  });
});

// embed()/generate() (unlike every other function in this module) take no
// baseUrl parameter at all — they always target the module-scope OLLAMA_URL
// constant, resolved ONCE from process.env at import time. Proving their
// guard fires therefore requires importing a FRESH module instance with
// OLLAMA_URL already set to a blocked value before that import runs — a
// cache-busting query string forces Node's ESM loader to treat this as a
// distinct module instance from the one imported at the top of this file
// (mirrors tests/unit/core/qdrant-lazy.test.js's own "manipulate env AFTER
// import" constraint, inverted: here the env must be set BEFORE this
// specific import).
describe('local/core/ollama.js — embed()/generate() (module-level OLLAMA_URL default) are guarded too', () => {
  it('embed() and generate() both throw before calling fetch() when OLLAMA_URL itself is blocked', async () => {
    const savedUrl = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = BLOCKED_URL;
    let blockedOllama;
    try {
      blockedOllama = await import(`../../../src/local/core/ollama.js?egress-test-blocked-default`);
    } finally {
      if (savedUrl === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = savedUrl;
    }

    await assert.rejects(() => blockedOllama.embed('some text', 'gemma3:4b'), assertBlockedByEgressPolicy);
    assert.equal(fetchCallCount, 0);
    await assert.rejects(() => blockedOllama.generate('gemma3:4b', 'hi'), assertBlockedByEgressPolicy);
    assert.equal(fetchCallCount, 0);
  });

  it('embed() still calls fetch() when OLLAMA_URL is an allowed loopback address', async () => {
    const savedUrl = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = 'http://localhost:11434';
    let allowedOllama;
    try {
      allowedOllama = await import(`../../../src/local/core/ollama.js?egress-test-allowed-default`);
    } finally {
      if (savedUrl === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = savedUrl;
    }

    globalThis.fetch = async (url) => {
      fetchCallCount += 1;
      assert.match(url, /\/api\/embed$/);
      return { ok: true, json: async () => ({ embeddings: [[0.1, 0.2]] }) };
    };
    const vector = await allowedOllama.embed('some text', 'gemma3:4b');
    assert.deepEqual(vector, [0.1, 0.2]);
    assert.equal(fetchCallCount, 1);
  });
});
