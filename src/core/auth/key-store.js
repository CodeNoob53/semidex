// Integration API key store — the persistence and authentication primitives
// for bearer keys. Zero HTTP knowledge: this module reads/writes a JSON file
// and answers "does this token authenticate, and to what?". The policy that
// USES it lives in src/core/auth/integration-policy.js; the seam it plugs
// into is documented in docs/security/integration-api-auth-design-note.md.
//
// Deliberately NOT settings.json: that file is served to the browser through
// GET /api/settings, so key material must never live there. This store is a
// separate file under SEMIDEX_HOME with its own strict schema.
//
// TOKEN FORMAT (versioned, strict)
// --------------------------------
//   sdx_v1_<keyId>_<secret>
//
//   sdx_v1  literal prefix + format version, so a future format can be
//           introduced without ambiguity and an old one rejected explicitly.
//   keyId   16 random base64url chars (96 bits) — a PUBLIC identifier, not a
//           secret. Present in the token so authentication is an O(1) lookup
//           plus exactly one constant-time comparison, rather than a scan
//           over every key. Also gives revocation and (future) rate-limit
//           identity something stable to key on.
//   secret  43 base64url chars = 256 bits of crypto.randomBytes entropy.
//
// Exposing keyId costs nothing: an attacker who has the token already has the
// secret, and one who does not cannot derive it from an id. To keep the id
// from enabling enumeration, an unknown keyId still performs a dummy
// constant-time comparison and returns the SAME failure as a wrong secret —
// see authenticateToken().
//
// Only a SHA-256 digest of the secret is ever persisted. A fast hash is
// correct here (unlike for passwords): the secret is 256 bits of uniform
// randomness, so there is nothing to brute-force and no need for a memory-
// hard KDF on a per-request path.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const TOKEN_PREFIX = 'sdx_v1_';
export const SCHEMA_VERSION = 1;
const KEY_ID_BYTES = 12;   // 96 bits -> 16 base64url chars
const SECRET_BYTES = 32;   // 256 bits -> 43 base64url chars
const KEY_ID_CHARS = 16;
const SECRET_CHARS = 43;
// base64url alphabet — note it INCLUDES '_', which is why parseToken() splits
// positionally rather than on the first underscore.
const KEY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const WILDCARD = '*';

/** Operations an integration key may be scoped to. Mirrors OPERATION in route-audience.js. */
export const SUPPORTED_OPERATIONS = Object.freeze(['generate']);

/**
 * Typed outcomes. `authenticateToken()` never throws for an auth failure —
 * failures are values, so no call site can accidentally treat a thrown error
 * as "allowed".
 */
export const AUTH_RESULT = Object.freeze({
  OK: 'ok',
  NOT_CONFIGURED: 'not_configured',   // no keys exist -> 503
  STORE_UNAVAILABLE: 'store_unavailable', // corrupt/unreadable -> 503, never "open"
  INVALID: 'invalid',                 // malformed/unknown/wrong/revoked/expired -> 401
});

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A fixed, valid digest used for the dummy comparison on an unknown keyId. */
const DUMMY_DIGEST = sha256('semidex-dummy-secret-for-constant-time-comparison');

/**
 * Constant-time digest comparison. Both inputs are fixed-length lowercase hex
 * (SHA-256), so length equality is guaranteed for well-formed values; the
 * length guard exists only for a corrupt store and returns false rather than
 * letting timingSafeEqual throw.
 */
export function digestsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Parses a token into { keyId, secret }, or null when it is not a
 * well-formed sdx_v1 token. Strict: exact prefix, exact segment count, exact
 * character class and length. A malformed token is never "close enough".
 * @param {unknown} token
 */
export function parseToken(token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const rest = token.slice(TOKEN_PREFIX.length);

  // Split at the FIXED keyId length, never at the first '_'.
  //
  // base64url's alphabet includes '_', so roughly one keyId in five contains
  // one, and an indexOf('_') split would cut inside the id — producing a
  // short keyId and an over-long secret, and rejecting a perfectly valid
  // token. (Found by a flaky test: ~20% of freshly minted keys failed to
  // authenticate.) Both segments are fixed-width by construction, so the
  // boundary is positional and unambiguous.
  if (rest.length !== KEY_ID_CHARS + 1 + SECRET_CHARS) return null;
  if (rest[KEY_ID_CHARS] !== '_') return null;
  const keyId = rest.slice(0, KEY_ID_CHARS);
  const secret = rest.slice(KEY_ID_CHARS + 1);
  if (!KEY_ID_RE.test(keyId)) return null;
  if (!SECRET_RE.test(secret)) return null;
  return { keyId, secret };
}

/** Generates a fresh { keyId, secret, token, digest }. */
export function generateToken() {
  const keyId = base64url(randomBytes(KEY_ID_BYTES));
  const secret = base64url(randomBytes(SECRET_BYTES));
  return { keyId, secret, token: `${TOKEN_PREFIX}${keyId}_${secret}`, digest: sha256(secret) };
}

export class KeyStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function validateRecord(record, index) {
  const where = `keys[${index}]`;
  const fail = (msg) => { throw new KeyStoreError('invalid_record', `${where} ${msg}`); };

  if (record === null || typeof record !== 'object' || Array.isArray(record)) fail('must be an object');
  if (!/^[A-Za-z0-9_-]{16}$/.test(record.id ?? '')) fail('has a missing or malformed "id"');
  if (typeof record.name !== 'string' || record.name.length === 0) fail('has a missing or empty "name"');
  if (!/^[a-f0-9]{64}$/.test(record.digest ?? '')) fail('has a missing or malformed "digest"');
  if (!Array.isArray(record.operations) || record.operations.length === 0) {
    fail('must list at least one operation (an empty list must never mean unrestricted)');
  }
  for (const op of record.operations) {
    if (!SUPPORTED_OPERATIONS.includes(op)) fail(`has unsupported operation "${op}"`);
  }
  if (!Array.isArray(record.collections) || record.collections.length === 0) {
    fail('must list at least one collection, or ["*"] for explicit wildcard (an empty list must never mean unrestricted)');
  }
  for (const c of record.collections) {
    if (typeof c !== 'string' || c.length === 0) fail('has a malformed collection entry');
  }
  for (const field of ['createdAt', 'expiresAt', 'revokedAt']) {
    const v = record[field];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) fail(`has a malformed "${field}" (expected an ISO-8601 string or null)`);
  }
  if (typeof record.createdAt !== 'string') fail('has a missing "createdAt"');
}

/**
 * Parses and validates raw file contents. Throws KeyStoreError on ANY
 * problem — a corrupt or unknown-version store must never be interpreted as
 * an empty store, because "empty" and "broken" have opposite security
 * meanings here (see the design note's row 6).
 * @param {string} raw
 */
export function parseKeyStore(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new KeyStoreError('corrupt', `key store is not valid JSON: ${err.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new KeyStoreError('corrupt', 'key store must be a JSON object');
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new KeyStoreError(
      'unsupported_schema_version',
      `key store schemaVersion ${JSON.stringify(data.schemaVersion)} is not supported (this build understands ${SCHEMA_VERSION})`
    );
  }
  if (!Array.isArray(data.keys)) {
    throw new KeyStoreError('corrupt', 'key store "keys" must be an array');
  }
  data.keys.forEach(validateRecord);

  const ids = new Set();
  for (const k of data.keys) {
    if (ids.has(k.id)) throw new KeyStoreError('corrupt', `duplicate key id "${k.id}"`);
    ids.add(k.id);
  }
  return { schemaVersion: data.schemaVersion, keys: data.keys };
}

/** Public view of a key record — never includes the digest or any secret. */
export function toPublicKey(record) {
  return {
    id: record.id,
    name: record.name,
    operations: [...record.operations],
    collections: [...record.collections],
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
    revokedAt: record.revokedAt ?? null,
  };
}

function isExpired(record, now) {
  return record.expiresAt != null && Date.parse(record.expiresAt) <= now;
}

/**
 * Creates an instance-scoped key store bound to one file path. No module-level
 * mutable state: two servers in one process get two independent stores.
 *
 * Reload strategy: the file is re-read on every authentication (correctness
 * first, per the design note). Revoking or adding a key therefore takes effect
 * immediately with no restart and no cache-invalidation logic to get wrong.
 * An Ask request performs a Gemini round-trip anyway, so one small synchronous
 * read is not a meaningful cost; optimize only if profiling says otherwise.
 *
 * @param {{ path: string, now?: () => number, readFileSyncFn?: Function, writeFileSyncFn?: Function }} opts
 */
export function createKeyStore({
  path,
  now = () => Date.now(),
  readFileSyncFn = readFileSync,
  writeFileSyncFn = writeFileSync,
  renameSyncFn = renameSync,
  existsSyncFn = existsSync,
  chmodSyncFn = chmodSync,
  mkdirSyncFn = mkdirSync,
} = {}) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('createKeyStore requires a file path.');
  }

  /** @returns {{ state: 'missing' } | { state: 'ok', store: Object } | { state: 'error', error: KeyStoreError }} */
  function load() {
    if (!existsSyncFn(path)) return { state: 'missing' };
    let raw;
    try {
      raw = readFileSyncFn(path, 'utf-8');
    } catch (err) {
      return { state: 'error', error: new KeyStoreError('unreadable', `key store could not be read: ${err.message}`) };
    }
    try {
      return { state: 'ok', store: parseKeyStore(raw) };
    } catch (err) {
      return { state: 'error', error: err instanceof KeyStoreError ? err : new KeyStoreError('corrupt', String(err?.message ?? err)) };
    }
  }

  function persist(store) {
    const tmp = `${path}.tmp`;
    const payload = JSON.stringify(store, null, 2);
    // The key store's parent directory (SEMIDEX_HOME, or wherever
    // keyStorePath points) is not guaranteed to exist yet — a fresh install
    // or a first `key add` before anything else has written to that
    // directory would otherwise fail here with ENOENT. mkdirSync is called
    // unconditionally (not gated on an existsSync check first): recursive
    // mkdir on an already-existing directory is a documented no-op, so this
    // adds no new race or extra failure mode, and it means the caller never
    // has to create SEMIDEX_HOME itself before the first key. Runs on every
    // persist(), not just when the file is first created, since a deleted
    // parent directory between calls must be recreated too, not just missed.
    mkdirSyncFn(dirname(path), { recursive: true });
    // Atomic: write a temp file, then rename over the target. A crash mid-write
    // leaves the previous store intact rather than a truncated one, which for
    // this file would mean "corrupt" and therefore a hard 503.
    writeFileSyncFn(tmp, payload, { encoding: 'utf-8', mode: 0o600 });
    try {
      // Best-effort restrictive permissions. A no-op on Windows, where ACLs
      // rather than POSIX modes govern access — documented as a portability
      // limitation rather than silently assumed to have worked.
      chmodSyncFn(tmp, 0o600);
    } catch { /* not supported on this platform/filesystem */ }
    renameSyncFn(tmp, path);
    try { chmodSyncFn(path, 0o600); } catch { /* as above */ }
  }

  function mutate(fn) {
    const loaded = load();
    if (loaded.state === 'error') throw loaded.error;
    const store = loaded.state === 'ok' ? loaded.store : { schemaVersion: SCHEMA_VERSION, keys: [] };
    const next = fn(store);
    persist(next.store);
    return next.result;
  }

  return {
    /**
     * Creates a key and returns { key, token }. The raw token is returned
     * exactly once and never persisted — only its digest is stored.
     */
    createKey({ name, collections, operations = ['generate'], expiresAt = null }) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new KeyStoreError('invalid_argument', 'A key name is required.');
      }
      if (!Array.isArray(collections) || collections.length === 0) {
        throw new KeyStoreError('invalid_argument',
          'At least one --collection is required. An empty scope must never mean unrestricted access; pass --collection "*" to grant all collections explicitly.');
      }
      for (const c of collections) {
        if (typeof c !== 'string' || c.trim().length === 0) {
          throw new KeyStoreError('invalid_argument', 'Collection names must be non-empty strings.');
        }
      }
      if (!Array.isArray(operations) || operations.length === 0) {
        throw new KeyStoreError('invalid_argument', 'At least one operation is required.');
      }
      for (const op of operations) {
        if (!SUPPORTED_OPERATIONS.includes(op)) {
          throw new KeyStoreError('invalid_argument', `Unsupported operation "${op}" (supported: ${SUPPORTED_OPERATIONS.join(', ')}).`);
        }
      }
      if (expiresAt !== null && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))) {
        throw new KeyStoreError('invalid_argument', 'expiresAt must be an ISO-8601 date string or null.');
      }

      const { keyId, token, digest } = generateToken();
      const record = {
        id: keyId,
        name: name.trim(),
        digest,
        operations: [...operations],
        collections: collections.map((c) => c.trim()),
        createdAt: new Date(now()).toISOString(),
        expiresAt,
        revokedAt: null,
      };

      return mutate((store) => ({
        store: { ...store, keys: [...store.keys, record] },
        result: { key: toPublicKey(record), token },
      }));
    },

    /** Public metadata only — never a digest, never a token. */
    listKeys() {
      const loaded = load();
      if (loaded.state === 'error') throw loaded.error;
      if (loaded.state === 'missing') return [];
      return loaded.store.keys.map(toPublicKey);
    },

    /** Idempotent: returns a typed result rather than throwing for an unknown id. */
    revokeKey(id) {
      return mutate((store) => {
        const record = store.keys.find((k) => k.id === id);
        if (!record) return { store, result: { status: 'not_found', id } };
        if (record.revokedAt) return { store, result: { status: 'already_revoked', key: toPublicKey(record) } };
        const revoked = { ...record, revokedAt: new Date(now()).toISOString() };
        return {
          store: { ...store, keys: store.keys.map((k) => (k.id === id ? revoked : k)) },
          result: { status: 'revoked', key: toPublicKey(revoked) },
        };
      });
    },

    /**
     * Authenticates a raw token. Returns a typed result; never throws for an
     * auth failure.
     *
     * Every failure that is not "the store itself is unusable" collapses to
     * AUTH_RESULT.INVALID with no detail, so a caller cannot distinguish an
     * unknown keyId from a wrong secret, a revoked key, or an expired one. An
     * unknown keyId still performs a dummy constant-time comparison so the
     * timing of "no such key" matches "wrong secret".
     */
    authenticateToken(rawToken) {
      const loaded = load();
      if (loaded.state === 'error') {
        return { result: AUTH_RESULT.STORE_UNAVAILABLE, error: loaded.error };
      }
      if (loaded.state === 'missing' || loaded.store.keys.length === 0) {
        return { result: AUTH_RESULT.NOT_CONFIGURED };
      }

      const parsed = parseToken(rawToken);
      if (!parsed) {
        digestsMatch(DUMMY_DIGEST, DUMMY_DIGEST); // keep the work symmetric
        return { result: AUTH_RESULT.INVALID };
      }

      const record = loaded.store.keys.find((k) => k.id === parsed.keyId);
      const candidate = sha256(parsed.secret);
      if (!record) {
        digestsMatch(candidate, DUMMY_DIGEST); // dummy compare — no keyId enumeration
        return { result: AUTH_RESULT.INVALID };
      }
      if (!digestsMatch(candidate, record.digest)) return { result: AUTH_RESULT.INVALID };
      if (record.revokedAt) return { result: AUTH_RESULT.INVALID };
      if (isExpired(record, now())) return { result: AUTH_RESULT.INVALID };

      return { result: AUTH_RESULT.OK, principal: buildPrincipal(record) };
    },

    /** Exposed for diagnostics/tests; never used to gate a request. */
    describeAvailability() {
      const loaded = load();
      if (loaded.state === 'error') return { available: false, reason: loaded.error.code };
      if (loaded.state === 'missing') return { available: false, reason: 'missing' };
      if (loaded.store.keys.length === 0) return { available: false, reason: 'no_keys' };
      return { available: true, keyCount: loaded.store.keys.length };
    },
  };
}

/**
 * Builds the plain, JSON-like principal the router deep-freezes. Deliberately
 * contains no digest and no token — a principal flows into policy code and
 * (in a future phase) audit logs.
 */
function buildPrincipal(record) {
  return {
    keyId: record.id,
    name: record.name,
    operations: [...record.operations],
    collections: [...record.collections],
    expiresAt: record.expiresAt ?? null,
  };
}

/** True when `collections` grants access to `collection`. Wildcard must be explicit. */
export function collectionAllowed(collections, collection) {
  if (!Array.isArray(collections) || collections.length === 0) return false;
  if (collections.includes(WILDCARD)) return true;
  return collections.includes(collection);
}
