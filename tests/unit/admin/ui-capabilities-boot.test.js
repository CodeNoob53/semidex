// Tests for shared/capabilities/boot.js — the boot capability object
// (design plan §6, §13 S1): resolved once per app boot from the real
// GET /api/capabilities response plus a build-time edition constant. Plain
// ESM import with a stubbed global fetch (same seam ui-api-client.test.js
// exercises the client through) — no DOM dependency at all.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootCapabilities, capabilities, whenCapabilitiesReady, resetCapabilitiesForTests,
} from '../../../src/shared/admin/ui-src/shared/capabilities/boot.js';

const originalFetch = globalThis.fetch;

function stubFetch(impl) {
  let calls = 0;
  globalThis.fetch = async (...args) => { calls += 1; return impl(...args); };
  return () => calls;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  resetCapabilitiesForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCapabilitiesForTests();
});

describe('bootCapabilities({ edition })', () => {
  it('throws a TypeError for a missing/invalid edition — a real programming-order bug, not a runtime condition', () => {
    assert.throws(() => bootCapabilities({}), TypeError);
    assert.throws(() => bootCapabilities({ edition: 'pro' }), TypeError);
  });

  it('resolves { edition, storage: { backend, capabilities } } from a valid GET /api/capabilities response', async () => {
    stubFetch(async () => jsonResponse(200, { backend: 'qdrant', capabilities: { namedVectors: true, aliases: false } }));
    const result = await bootCapabilities({ edition: 'full' });
    assert.deepEqual(result, {
      edition: 'full',
      storage: { backend: 'qdrant', capabilities: { namedVectors: true, aliases: false } },
    });
  });

  it('the resolved object is deep-frozen — immutable plain data (design plan §6)', async () => {
    stubFetch(async () => jsonResponse(200, { backend: 'qdrant', capabilities: { namedVectors: true } }));
    const result = await bootCapabilities({ edition: 'full' });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.storage));
    assert.ok(Object.isFrozen(result.storage.capabilities));
    assert.throws(() => { result.storage.capabilities.namedVectors = false; }, TypeError);
  });

  it('a second call reuses the same in-flight/resolved promise — never a second /api/capabilities request', async () => {
    const getCallCount = stubFetch(async () => jsonResponse(200, { backend: 'qdrant', capabilities: {} }));
    const p1 = bootCapabilities({ edition: 'full' });
    const p2 = bootCapabilities({ edition: 'full' });
    assert.equal(p1, p2, 'both calls must return the exact same promise');
    await p1;
    assert.equal(getCallCount(), 1);
  });

  it('a malformed capabilities response rejects with a contract ApiError, and capabilities() stays null', async () => {
    stubFetch(async () => jsonResponse(200, { backend: 'qdrant' })); // missing "capabilities"
    await assert.rejects(bootCapabilities({ edition: 'full' }), (err) => err.kind === 'contract');
    assert.equal(capabilities(), null);
  });

  it('Full and Lite boot capability objects differ only through their entry-owned edition input and share the same validated storage capabilities', async () => {
    const backendResponse = { backend: 'qdrant-cloud', capabilities: { namedVectors: true, sparseVectors: true, aliases: false } };

    stubFetch(async () => jsonResponse(200, backendResponse));
    const full = await bootCapabilities({ edition: 'full' });
    resetCapabilitiesForTests();

    stubFetch(async () => jsonResponse(200, backendResponse));
    const lite = await bootCapabilities({ edition: 'lite' });

    assert.equal(full.edition, 'full');
    assert.equal(lite.edition, 'lite');
    assert.deepEqual(full.storage, lite.storage, 'both editions must validate and expose the identical storage capability shape');
  });
});

describe('capabilities() / whenCapabilitiesReady()', () => {
  it('capabilities() is null before bootCapabilities() resolves', () => {
    assert.equal(capabilities(), null);
  });

  it('whenCapabilitiesReady() throws if bootCapabilities() was never called', () => {
    assert.throws(() => whenCapabilitiesReady(), /bootCapabilities/);
  });

  it('whenCapabilitiesReady() returns the SAME promise bootCapabilities() started', async () => {
    stubFetch(async () => jsonResponse(200, { backend: 'qdrant', capabilities: {} }));
    const started = bootCapabilities({ edition: 'lite' });
    assert.equal(whenCapabilitiesReady(), started);
    await started;
  });

  it('capabilities() reflects the resolved value once whenCapabilitiesReady() settles', async () => {
    stubFetch(async () => jsonResponse(200, { backend: 'qdrant', capabilities: { snapshots: true } }));
    bootCapabilities({ edition: 'lite' });
    await whenCapabilitiesReady();
    assert.deepEqual(capabilities(), { edition: 'lite', storage: { backend: 'qdrant', capabilities: { snapshots: true } } });
  });
});
