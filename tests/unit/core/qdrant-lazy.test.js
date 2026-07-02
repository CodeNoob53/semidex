// Lazy-init contract of the SDK-backed Qdrant access layer.
//
// Deliberately does NOT import tests/helpers/setup.js: this file verifies that
// src/core/qdrant.js works without QDRANT_URL. Note that qdrant.js itself
// loads dotenv, so on a developer machine a local .env may re-populate
// QDRANT_URL during import — every test therefore manipulates env AFTER the
// import, which is exactly what lazy initialization must support.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.QDRANT_URL;
delete process.env.QDRANT_KEY;

// Import must not throw even with QDRANT_URL unset (pre-migration qdrant.js
// threw at import time; this is the core regression guard).
const qdrant = await import('../../../src/core/qdrant.js');

const ENV_KEYS = ['QDRANT_URL', 'QDRANT_KEY'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('import-time safety', () => {
  it('module imported successfully without QDRANT_URL at import time', () => {
    assert.equal(typeof qdrant.listCollections, 'function');
    assert.equal(typeof qdrant.getQdrantClient, 'function');
  });

  it('isSemidexPayload works without QDRANT_URL', () => {
    delete process.env.QDRANT_URL;
    assert.equal(qdrant.isSemidexPayload(null), false);
    assert.equal(qdrant.isSemidexPayload({}), false);
    assert.equal(qdrant.isSemidexPayload({
      source_file: 'a.md', chunk_index: 0, file_hash: 'x',
      dense_provider: 'ollama', dense_model: 'bge-m3', sparse_provider: 'hashed-tf',
      embedding_schema_version: 2, vector_size: 1024,
      chunking_schema_version: 4, token_count_mode: 'bge-m3',
    }), true);
  });
});

describe('lazy env reads', () => {
  it('network function without QDRANT_URL throws the missing-env error', async () => {
    delete process.env.QDRANT_URL;
    await assert.rejects(
      () => qdrant.listCollections(),
      /QDRANT_URL is not set\. Add it to your \.env file\./,
    );
  });

  it('getQdrantClient without QDRANT_URL throws the missing-env error', () => {
    delete process.env.QDRANT_URL;
    assert.throws(() => qdrant.getQdrantClient(), /QDRANT_URL is not set/);
  });

  it('getQdrantClient constructs a client once env is set (no network call)', () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    const client = qdrant.getQdrantClient();
    assert.ok(client, 'expected a client instance');
  });
});

describe('URL path/prefix handling', () => {
  // The SDK never reads pathname off `url` — only via a separate `prefix`
  // option — so a path in QDRANT_URL must be forwarded explicitly and
  // normalized (no trailing slash, else the SDK's own request paths get a
  // double slash, e.g. .../qdrant//collections).
  it('preserves a path component (no trailing slash) in the client REST URI', () => {
    process.env.QDRANT_URL = 'https://example.com/qdrant';
    const client = qdrant.getQdrantClient();
    assert.equal(client._restUri, 'https://example.com/qdrant');
  });

  it('strips a trailing slash from a path component', () => {
    process.env.QDRANT_URL = 'https://example.com/qdrant/';
    const client = qdrant.getQdrantClient();
    assert.equal(client._restUri, 'https://example.com/qdrant');
  });

  it('preserves a multi-segment path with a trailing slash', () => {
    process.env.QDRANT_URL = 'https://example.com/a/b/';
    const client = qdrant.getQdrantClient();
    assert.equal(client._restUri, 'https://example.com/a/b');
  });

  it('root path produces no prefix', () => {
    process.env.QDRANT_URL = 'https://example.com/';
    const client = qdrant.getQdrantClient();
    assert.equal(client._restUri, 'https://example.com');
  });

  it('explicit port is preserved alongside a path prefix', () => {
    process.env.QDRANT_URL = 'http://localhost:6333/qdrant';
    const client = qdrant.getQdrantClient();
    assert.equal(client._restUri, 'http://localhost:6333/qdrant');
  });
});

describe('client caching', () => {
  it('same env returns the same cached instance', () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    assert.equal(qdrant.getQdrantClient(), qdrant.getQdrantClient());
  });

  it('read and write clients are distinct instances (different timeouts)', () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    assert.notEqual(qdrant.getQdrantClient(), qdrant.getQdrantClient({ write: true }));
  });

  it('changing QDRANT_URL rebuilds the client', () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    const first = qdrant.getQdrantClient();
    process.env.QDRANT_URL = 'http://localhost:7777';
    const second = qdrant.getQdrantClient();
    assert.notEqual(first, second);
  });

  it('changing QDRANT_KEY rebuilds the client', () => {
    process.env.QDRANT_URL = 'http://localhost:6333';
    delete process.env.QDRANT_KEY;
    const first = qdrant.getQdrantClient();
    process.env.QDRANT_KEY = 'secret';
    const second = qdrant.getQdrantClient();
    assert.notEqual(first, second);
  });
});
