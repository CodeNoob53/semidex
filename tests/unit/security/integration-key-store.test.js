// Integration API key store — persistence, token format, and authentication
// primitives. Offline: a temp directory per test, never the developer's real
// SEMIDEX_HOME, never a real Qdrant/Gemini call.
//
// Contract: docs/security/integration-api-auth-design-note.md
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKeyStore, parseToken, generateToken, digestsMatch, parseKeyStore,
  collectionAllowed, toPublicKey, AUTH_RESULT, SCHEMA_VERSION, TOKEN_PREFIX, KeyStoreError,
} from '../../../src/core/auth/key-store.js';

let dir;
let path;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'semidex-keystore-'));
  path = join(dir, 'integration-keys.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const store = () => createKeyStore({ path });
const addKey = (over = {}) => store().createKey({ name: 'test', collections: ['docs-a'], ...over });

describe('Token format and entropy', () => {
  it('generates sdx_v1_<keyId>_<secret> with 256 bits of secret entropy', () => {
    const { token, keyId, secret } = generateToken();
    assert.ok(token.startsWith(TOKEN_PREFIX), 'must carry the versioned prefix');
    assert.equal(token, `${TOKEN_PREFIX}${keyId}_${secret}`);
    // 43 base64url chars = 258 bits of encoding over 256 bits of randomness.
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.match(keyId, /^[A-Za-z0-9_-]{16}$/);
  });

  it('produces unique tokens across many generations (a real RNG, not a stub)', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const { token } = generateToken();
      assert.equal(seen.has(token), false, 'token collision');
      seen.add(token);
    }
  });

  it('parses only strictly well-formed tokens', () => {
    const { token, keyId, secret } = generateToken();
    assert.deepEqual(parseToken(token), { keyId, secret });

    for (const bad of [
      '', 'sdx_v1_', 'sdx_v1_short_abc', `${keyId}_${secret}`,
      `sdx_v2_${keyId}_${secret}`,                    // wrong version
      `sdx_v1_${keyId}_${secret}extra`,               // secret too long
      `sdx_v1_${keyId.slice(0, 8)}_${secret}`,        // keyId too short
      `sdx_v1_${keyId}_${secret.replace(/.$/, '!')}`, // invalid char
      null, undefined, 42, {},
    ]) {
      assert.equal(parseToken(bad), null, `"${String(bad)}" must not parse`);
    }
  });

  // REGRESSION: base64url's alphabet includes '_', so ~20% of random keyIds
  // contain one. An earlier parseToken() split on the FIRST underscore, which
  // cut inside such an id and rejected a perfectly valid freshly minted token
  // — surfacing as an intermittent ~20% authentication failure. The split is
  // positional (both segments are fixed-width), never delimiter-based.
  it('parses a keyId that itself contains underscores', () => {
    const keyId = 'ab_cd_ef_gh_ij_k';   // 16 chars, four underscores
    const secret = 'z'.repeat(43);
    assert.equal(keyId.length, 16);
    assert.deepEqual(parseToken(`${TOKEN_PREFIX}${keyId}_${secret}`), { keyId, secret });
  });

  it('parses a secret that contains underscores', () => {
    const keyId = 'a'.repeat(16);
    const secret = `_${'b'.repeat(41)}_`; // 43 chars, leading and trailing '_'
    assert.equal(secret.length, 43);
    assert.deepEqual(parseToken(`${TOKEN_PREFIX}${keyId}_${secret}`), { keyId, secret });
  });

  it('every freshly generated token round-trips through parseToken (fuzzed over the real RNG)', () => {
    for (let i = 0; i < 1000; i++) {
      const { token, keyId, secret } = generateToken();
      assert.deepEqual(parseToken(token), { keyId, secret }, `failed for ${token}`);
    }
  });

  it('the version prefix makes a future format unambiguous', () => {
    // A v2 token must be rejected outright by a v1 parser rather than being
    // partially interpreted.
    assert.equal(parseToken('sdx_v2_aaaaaaaaaaaaaaaa_' + 'a'.repeat(43)), null);
  });
});

describe('Digest storage — the raw token is never persisted', () => {
  it('stores only a SHA-256 digest', () => {
    const { token } = addKey();
    const raw = readFileSync(path, 'utf-8');
    const secret = token.split('_').pop();
    assert.equal(raw.includes(token), false, 'the full token must never appear on disk');
    assert.equal(raw.includes(secret), false, 'the secret must never appear on disk');
    const parsed = JSON.parse(raw);
    assert.match(parsed.keys[0].digest, /^[a-f0-9]{64}$/, 'a SHA-256 hex digest is stored instead');
  });

  it('returns the raw token exactly once, and never again through listKeys()', () => {
    const { token, key } = addKey();
    assert.ok(token.startsWith(TOKEN_PREFIX));
    const listed = store().listKeys();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, key.id);
    assert.equal('digest' in listed[0], false, 'listKeys must not expose the digest');
    assert.equal('token' in listed[0], false);
    assert.equal('secret' in listed[0], false);
    assert.equal(JSON.stringify(listed).includes(token), false);
  });

  it('toPublicKey() omits the digest', () => {
    const record = { id: 'a'.repeat(16), name: 'n', digest: 'f'.repeat(64), operations: ['generate'], collections: ['c'], createdAt: 'x', expiresAt: null, revokedAt: null };
    const pub = toPublicKey(record);
    assert.equal('digest' in pub, false);
    assert.equal(JSON.stringify(pub).includes('f'.repeat(64)), false);
  });

  it('digestsMatch uses a constant-time comparison and rejects length mismatch safely', () => {
    const a = 'a'.repeat(64);
    assert.equal(digestsMatch(a, a), true);
    assert.equal(digestsMatch(a, 'b'.repeat(64)), false);
    // A length mismatch must return false rather than letting timingSafeEqual throw.
    assert.doesNotThrow(() => digestsMatch(a, 'abc'));
    assert.equal(digestsMatch(a, 'abc'), false);
    assert.equal(digestsMatch(null, a), false);
  });
});

describe('Store integrity — corruption must never read as "empty"', () => {
  it('a missing file authenticates as NOT_CONFIGURED, not as an open API', () => {
    assert.equal(store().authenticateToken('anything').result, AUTH_RESULT.NOT_CONFIGURED);
  });

  it('malformed JSON fails closed as STORE_UNAVAILABLE', () => {
    writeFileSync(path, '{ this is not json', 'utf-8');
    const outcome = store().authenticateToken('anything');
    assert.equal(outcome.result, AUTH_RESULT.STORE_UNAVAILABLE);
    assert.equal(outcome.error.code, 'corrupt');
  });

  it('an unsupported schemaVersion fails closed', () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, keys: [] }), 'utf-8');
    const outcome = store().authenticateToken('anything');
    assert.equal(outcome.result, AUTH_RESULT.STORE_UNAVAILABLE);
    assert.equal(outcome.error.code, 'unsupported_schema_version');
  });

  it('a malformed key record fails closed rather than being skipped', () => {
    writeFileSync(path, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      keys: [{ id: 'a'.repeat(16), name: 'x', digest: 'not-a-digest', operations: ['generate'], collections: ['c'], createdAt: 'x' }],
    }), 'utf-8');
    assert.equal(store().authenticateToken('anything').result, AUTH_RESULT.STORE_UNAVAILABLE);
  });

  it('an empty operations or collections list is rejected — it must never mean unrestricted', () => {
    for (const bad of [{ operations: [] }, { collections: [] }]) {
      const record = {
        id: 'a'.repeat(16), name: 'x', digest: 'f'.repeat(64),
        operations: ['generate'], collections: ['c'], createdAt: new Date().toISOString(), ...bad,
      };
      assert.throws(
        () => parseKeyStore(JSON.stringify({ schemaVersion: SCHEMA_VERSION, keys: [record] })),
        /must list at least one/
      );
    }
  });

  it('duplicate key ids are rejected', () => {
    const rec = { id: 'a'.repeat(16), name: 'x', digest: 'f'.repeat(64), operations: ['generate'], collections: ['c'], createdAt: new Date().toISOString() };
    assert.throws(() => parseKeyStore(JSON.stringify({ schemaVersion: SCHEMA_VERSION, keys: [rec, { ...rec }] })), /duplicate key id/);
  });
});

describe('Atomic writes and file permissions', () => {
  it('leaves no .tmp file behind after a successful write', () => {
    addKey();
    assert.equal(existsSync(`${path}.tmp`), false, 'the temp file must be renamed, not left in place');
    assert.equal(existsSync(path), true);
  });

  it('writes through a temp file then renames (a crash cannot truncate the live store)', () => {
    const order = [];
    const s = createKeyStore({
      path,
      writeFileSyncFn: (p) => { order.push(`write:${p.endsWith('.tmp') ? 'tmp' : 'target'}`); },
      renameSyncFn: () => { order.push('rename'); },
      existsSyncFn: () => false,
      chmodSyncFn: () => {},
    });
    s.createKey({ name: 'n', collections: ['c'] });
    assert.deepEqual(order, ['write:tmp', 'rename'], 'must write the temp file first, then rename over the target');
  });

  it('attempts restrictive permissions on the stored file', () => {
    const modes = [];
    const s = createKeyStore({
      path,
      writeFileSyncFn: () => {},
      renameSyncFn: () => {},
      existsSyncFn: () => false,
      chmodSyncFn: (_p, mode) => modes.push(mode),
    });
    s.createKey({ name: 'n', collections: ['c'] });
    assert.ok(modes.length > 0, 'a restrictive mode must be attempted');
    assert.ok(modes.every((m) => m === 0o600), `expected 0o600, got ${modes.map((m) => m.toString(8))}`);
  });

  it('a chmod failure (unsupported platform) does not abort the write', () => {
    const s = createKeyStore({
      path,
      chmodSyncFn: () => { throw new Error('EPERM: not supported'); },
    });
    assert.doesNotThrow(() => s.createKey({ name: 'n', collections: ['c'] }));
    assert.equal(existsSync(path), true);
  });

  it('creates a genuinely absent, multi-level parent directory (e.g. a fresh SEMIDEX_HOME) on the first write', () => {
    // Nested two levels deep under the temp dir — neither level exists yet,
    // proving this is not merely "the immediate parent is missing" but a
    // real fresh-install shape (SEMIDEX_HOME itself not yet created).
    const freshHome = join(dir, 'fresh-app-data', 'semidex');
    const freshPath = join(freshHome, 'integration-keys.json');
    assert.equal(existsSync(freshHome), false, 'test fixture must start with the parent directory genuinely absent');

    const s = createKeyStore({ path: freshPath });
    assert.doesNotThrow(() => s.createKey({ name: 'n', collections: ['c'] }));
    assert.equal(existsSync(freshPath), true);
    // The store must be immediately usable through a fresh instance too —
    // not just the one that happened to create the directory.
    assert.equal(createKeyStore({ path: freshPath }).listKeys().length, 1);
  });

  it('a second write to an already-existing parent directory is unaffected (mkdir recursive is a safe no-op)', () => {
    const s = createKeyStore({ path });
    s.createKey({ name: 'first', collections: ['c'] });
    assert.doesNotThrow(() => s.createKey({ name: 'second', collections: ['c'] }));
    assert.equal(s.listKeys().length, 2);
  });
});

describe('Authentication outcomes', () => {
  it('accepts a valid token and returns a plain JSON-like principal', () => {
    const { token, key } = addKey({ collections: ['docs-a', 'docs-b'] });
    const outcome = store().authenticateToken(token);
    assert.equal(outcome.result, AUTH_RESULT.OK);
    assert.equal(outcome.principal.keyId, key.id);
    assert.deepEqual(outcome.principal.collections, ['docs-a', 'docs-b']);
    assert.deepEqual(outcome.principal.operations, ['generate']);
    // Must satisfy the router's principal contract: no digest, no secret.
    assert.equal(JSON.stringify(outcome.principal).includes(token), false);
    assert.equal('digest' in outcome.principal, false);
  });

  it('rejects a wrong secret, an unknown keyId and a malformed token identically', () => {
    const { key } = addKey();
    const results = [
      store().authenticateToken(`${TOKEN_PREFIX}${key.id}_${'z'.repeat(43)}`),   // wrong secret
      store().authenticateToken(`${TOKEN_PREFIX}${'b'.repeat(16)}_${'z'.repeat(43)}`), // unknown id
      store().authenticateToken('garbage'),                                       // malformed
      store().authenticateToken(undefined),                                       // absent
    ];
    for (const r of results) {
      assert.equal(r.result, AUTH_RESULT.INVALID);
      assert.deepEqual(Object.keys(r), ['result'], 'no detail may distinguish the failure cause');
    }
  });

  it('rejects a revoked key immediately, with no restart', () => {
    const { token, key } = addKey();
    assert.equal(store().authenticateToken(token).result, AUTH_RESULT.OK);
    store().revokeKey(key.id);
    // A brand-new store instance is NOT required — the file is re-read per call.
    assert.equal(store().authenticateToken(token).result, AUTH_RESULT.INVALID);
  });

  it('rejects an expired key', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const s = createKeyStore({ path });
    const { token } = s.createKey({ name: 'n', collections: ['c'], expiresAt: null });
    // Rewrite the record with a past expiry (createKey refuses to mint one).
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    data.keys[0].expiresAt = past;
    writeFileSync(path, JSON.stringify(data), 'utf-8');
    assert.equal(store().authenticateToken(token).result, AUTH_RESULT.INVALID);
  });

  it('accepts a key whose expiry is still in the future', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const { token } = addKey({ expiresAt: future });
    assert.equal(store().authenticateToken(token).result, AUTH_RESULT.OK);
  });
});

describe('createKey validation', () => {
  it('refuses an empty collection list — absence of scope is never unrestricted access', () => {
    assert.throws(() => store().createKey({ name: 'n', collections: [] }), /never mean unrestricted/);
    assert.throws(() => store().createKey({ name: 'n', collections: undefined }), /never mean unrestricted/);
  });

  it('refuses an empty name and an unsupported operation', () => {
    assert.throws(() => store().createKey({ name: '', collections: ['c'] }), /name is required/);
    assert.throws(() => store().createKey({ name: 'n', collections: ['c'], operations: ['delete'] }), /Unsupported operation/);
    assert.throws(() => store().createKey({ name: 'n', collections: ['c'], operations: [] }), /At least one operation/);
  });

  it('refuses a malformed expiry', () => {
    assert.throws(() => store().createKey({ name: 'n', collections: ['c'], expiresAt: 'soon' }), /ISO-8601/);
  });
});

describe('Revocation is idempotent and typed', () => {
  it('reports revoked, then already_revoked, then not_found', () => {
    const { key } = addKey();
    assert.equal(store().revokeKey(key.id).status, 'revoked');
    assert.equal(store().revokeKey(key.id).status, 'already_revoked');
    assert.equal(store().revokeKey('c'.repeat(16)).status, 'not_found');
  });
});

describe('collectionAllowed — wildcard must be explicit', () => {
  it('matches exact names only, unless "*" is present', () => {
    assert.equal(collectionAllowed(['docs-a'], 'docs-a'), true);
    assert.equal(collectionAllowed(['docs-a'], 'docs-b'), false);
    assert.equal(collectionAllowed(['docs-a'], 'docs-a-extra'), false, 'no prefix matching');
    assert.equal(collectionAllowed(['*'], 'anything'), true);
    assert.equal(collectionAllowed(['docs-a', '*'], 'other'), true);
  });

  it('an empty or absent scope grants nothing', () => {
    assert.equal(collectionAllowed([], 'docs-a'), false);
    assert.equal(collectionAllowed(undefined, 'docs-a'), false);
    assert.equal(collectionAllowed(null, 'docs-a'), false);
  });

  it('does not alter legitimate Qdrant collection identifiers', () => {
    for (const name of ['My_Collection-1', 'docs.v2', 'UPPER', 'a-b_c.d']) {
      assert.equal(collectionAllowed([name], name), true, `${name} must match itself exactly`);
    }
  });
});

describe('Per-key rate limits', () => {
  it('createKey persists null (not the resolved default) when no limit is given', () => {
    addKey();
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(raw.keys[0].requestsPerMinute, null);
    assert.equal(raw.keys[0].burst, null);
  });

  it('an explicit requestsPerMinute/burst is persisted as a plain JSON number', () => {
    addKey({ requestsPerMinute: 600, burst: 20 });
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(raw.keys[0].requestsPerMinute, 600);
    assert.equal(raw.keys[0].burst, 20);
  });

  it('toPublicKey resolves a null/legacy limit to the documented default', () => {
    const legacy = { id: 'a'.repeat(16), name: 'x', digest: 'f'.repeat(64), operations: ['generate'], collections: ['c'], createdAt: new Date().toISOString() };
    const pub = toPublicKey(legacy);
    assert.equal(pub.requestsPerMinute, 30);
    assert.equal(pub.burst, 5);
  });

  it('toPublicKey passes through an explicit stored limit unchanged', () => {
    const record = { id: 'a'.repeat(16), name: 'x', digest: 'f'.repeat(64), operations: ['generate'], collections: ['c'], createdAt: new Date().toISOString(), requestsPerMinute: 100, burst: 10 };
    const pub = toPublicKey(record);
    assert.equal(pub.requestsPerMinute, 100);
    assert.equal(pub.burst, 10);
  });

  it('the authenticated principal carries the EFFECTIVE limits (resolved, never raw null)', () => {
    const { token } = addKey();
    const outcome = store().authenticateToken(token);
    assert.equal(outcome.principal.requestsPerMinute, 30);
    assert.equal(outcome.principal.burst, 5);
  });

  it('the authenticated principal carries an explicit per-key override', () => {
    const { token } = addKey({ requestsPerMinute: 600, burst: 20 });
    const outcome = store().authenticateToken(token);
    assert.equal(outcome.principal.requestsPerMinute, 600);
    assert.equal(outcome.principal.burst, 20);
  });

  it('a legacy key record (no requestsPerMinute/burst field at all) authenticates fine and gets defaults', () => {
    // Simulates a key created BEFORE this field existed — the JSON object
    // genuinely lacks the keys, not merely nulls them.
    const { token, key } = addKey();
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    delete raw.keys[0].requestsPerMinute;
    delete raw.keys[0].burst;
    writeFileSync(path, JSON.stringify(raw), 'utf-8');

    const outcome = store().authenticateToken(token);
    assert.equal(outcome.result, AUTH_RESULT.OK);
    assert.equal(outcome.principal.requestsPerMinute, 30);
    assert.equal(outcome.principal.burst, 5);
    assert.equal(store().listKeys().find((k) => k.id === key.id).requestsPerMinute, 30);
  });

  it('createKey rejects an out-of-range or non-integer limit', () => {
    assert.throws(() => store().createKey({ name: 'n', collections: ['c'], requestsPerMinute: 0 }), /requestsPerMinute/);
    assert.throws(() => store().createKey({ name: 'n', collections: ['c'], requestsPerMinute: 6001 }), /requestsPerMinute/);
    assert.throws(() => store().createKey({ name: 'n', collections: ['c'], requestsPerMinute: 30.5 }), /requestsPerMinute/);
    assert.throws(() => store().createKey({ name: 'n', collections: ['c'], burst: 0 }), /burst/);
    assert.throws(() => store().createKey({ name: 'n', collections: ['c'], burst: 1001 }), /burst/);
  });

  it('a corrupt/out-of-range persisted limit fails the whole store closed, not just that field', () => {
    writeFileSync(path, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      keys: [{
        id: 'a'.repeat(16), name: 'x', digest: 'f'.repeat(64), operations: ['generate'], collections: ['c'],
        createdAt: new Date().toISOString(), requestsPerMinute: -5,
      }],
    }), 'utf-8');
    assert.equal(store().authenticateToken('anything').result, AUTH_RESULT.STORE_UNAVAILABLE);
  });
});

describe('Instance scoping', () => {
  it('two stores on different paths are fully independent', () => {
    const otherPath = join(dir, 'other-keys.json');
    const a = createKeyStore({ path });
    const b = createKeyStore({ path: otherPath });
    const { token } = a.createKey({ name: 'a', collections: ['c'] });
    assert.equal(a.authenticateToken(token).result, AUTH_RESULT.OK);
    assert.equal(b.authenticateToken(token).result, AUTH_RESULT.NOT_CONFIGURED,
      'a key in one store must not authenticate against another');
  });
});
