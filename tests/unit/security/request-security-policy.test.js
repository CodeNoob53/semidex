// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md
// Phase 1 hardening — Origin/Fetch-Metadata policy (Part B), Content-Type
// enforcement (Part C), and Host/DNS-rebinding validation (Part E).
//
// Behavioral tests against a real HTTP server wherever the behavior is
// observable that way. Host-header cases use a raw socket rather than
// fetch(), because fetch() forbids setting Host — testing it through fetch()
// would silently assert nothing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  createRequestSecurityPolicy,
  parseHostHeader,
  normalizeAllowedHost,
  parseAllowedHosts,
  checkJsonContentType,
  evaluateRequestSecurity,
} from '../../../src/core/http/request-security.js';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';

function makeStubAdapter() {
  return {
    name: () => 'stub',
    capabilities: () => ({}),
    ping: async () => ({ ok: true }),
    listCollections: async () => [],
    getCollection: async (name) => ({ name, vectorsCount: 0 }),
    ensureCollectionSchema: async () => ({ repaired: [], warnings: [] }),
  };
}

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

// This file is about Origin/Content-Type/Host enforcement, not path scoping
// (see tests/unit/security/spawn-indexer-path-validation.test.js for that) — the fixed
// VALID_JOB_BODY path below is a fake, nonexistent string the real guard
// would reject regardless of these tests' own concerns.
const ALLOW_ALL_ROOTS_GUARD = { checkTarget: (rawPath) => ({ ok: true, canonicalPath: rawPath }) };

// Boots a real Lite server on an ephemeral port and records whether the
// indexer was ever spawned — the concrete side effect the original
// vulnerability produced.
async function withLiteServer(fn) {
  let spawned = null;
  const jobRegistry = createJobRegistry({
    spawnIndexer: (opts) => { spawned = opts; return fakeChild(); },
    baseEnv: {},
  });
  const app = createLiteApp({
    adapter: makeStubAdapter(),
    embedQuery: async () => ({ dense: [], sparse: {} }),
    jobRegistry,
    allowedRootsGuard: ALLOW_ALL_ROOTS_GUARD,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const port = app.address().port;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, port, wasSpawned: () => spawned !== null });
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

// Sends a request with a verbatim Host header (fetch() cannot).
function rawRequest({ port, host, method = 'POST', path = '/api/jobs/index', headers = [], body = '' }) {
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host}`,
    ...headers,
    // Content-Length only when there is a body — sending "Content-Length: 0"
    // on a GET is legal but noise, and Part C treats a declared-empty body
    // as needing no Content-Type, which these Host-focused cases rely on.
    ...(body === '' ? [] : [`Content-Length: ${Buffer.byteLength(body)}`]),
    'Connection: close',
    '',
    body,
  ];
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(lines.join('\r\n')));
    let buf = '';
    socket.on('data', (d) => { buf += d; });
    socket.on('end', () => {
      const status = Number(buf.split('\r\n')[0].split(' ')[1]);
      resolve({ status, raw: buf });
    });
    socket.on('error', reject);
  });
}

const VALID_JOB_BODY = JSON.stringify({ collection: 'victim', path: './docs' });

describe('Part E — Host validation / DNS-rebinding defense', () => {
  it('accepts the loopback hosts the server is actually listening on (IPv4, localhost, IPv6)', async () => {
    await withLiteServer(async ({ port }) => {
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
        const res = await rawRequest({
          port, host, headers: ['Content-Type: application/json'], body: VALID_JOB_BODY,
        });
        assert.ok(res.status !== 403, `expected ${host} to pass Host validation, got ${res.status}`);
      }
    });
  });

  it('rejects a foreign Host — the DNS-rebinding case — before the job is spawned', async () => {
    await withLiteServer(async ({ port, wasSpawned }) => {
      const res = await rawRequest({
        port, host: 'evil.example.com', headers: ['Content-Type: application/json'], body: VALID_JOB_BODY,
      });
      assert.equal(res.status, 403);
      assert.equal(wasSpawned(), false, 'no indexer may be spawned for a rejected Host');
    });
  });

  it('rejects a loopback hostname carrying the WRONG port — port is compared exactly, never ignored', async () => {
    await withLiteServer(async ({ port, wasSpawned }) => {
      const res = await rawRequest({
        port, host: '127.0.0.1:9999', headers: ['Content-Type: application/json'], body: VALID_JOB_BODY,
      });
      assert.equal(res.status, 403);
      assert.equal(wasSpawned(), false);
    });
  });

  it('rejects a suffix-shaped near-miss ("notlocalhost") — no endsWith() matching anywhere', async () => {
    await withLiteServer(async ({ port }) => {
      const res = await rawRequest({
        port, host: 'notlocalhost', headers: ['Content-Type: application/json'], body: VALID_JOB_BODY,
      });
      assert.equal(res.status, 403);
    });
  });

  it('rejects a malformed/duplicated Host value', async () => {
    await withLiteServer(async ({ port }) => {
      const res = await rawRequest({
        port, host: `127.0.0.1:${port}, evil.example.com`,
        headers: ['Content-Type: application/json'], body: VALID_JOB_BODY,
      });
      assert.ok(res.status === 400 || res.status === 403, `expected 400/403, got ${res.status}`);
    });
  });

  // REGRESSION (2026-08-18): an earlier revision checked
  // `Array.isArray(req.headers.host)`, which is dead code — node collapses a
  // repeated Host header to the FIRST value in req.headers, so two Host
  // headers passed validation and returned 200. Must be detected via
  // headersDistinct/rawHeaders instead. Raw socket required: fetch() cannot
  // send a duplicate Host.
  it('rejects TWO Host headers even when the first one is valid (duplicate-Host regression)', async () => {
    await withLiteServer(async ({ port, wasSpawned }) => {
      const res = await rawRequest({
        port,
        host: `127.0.0.1:${port}`,
        headers: ['Host: evil.example.com', 'Content-Type: application/json'],
        body: VALID_JOB_BODY,
      });
      assert.equal(res.status, 400, 'a duplicated Host header must be rejected, not silently resolved to the first value');
      assert.equal(wasSpawned(), false);
    });
  });

  it('rejects two Host headers on a safe GET as well', async () => {
    await withLiteServer(async ({ port }) => {
      const res = await rawRequest({
        port, method: 'GET', path: '/api/health',
        host: `127.0.0.1:${port}`, headers: ['Host: evil.example.com'],
      });
      assert.equal(res.status, 400);
    });
  });
});

// REGRESSION (2026-08-18): handleStatic() was reached before any security
// check ran, so the static dashboard shell was served regardless of Host.
// The API was always protected, so nothing leaked — but the DNS-rebinding
// boundary was incomplete, contradicting the "every GET is Host-validated"
// claim. Static responses are plain text/HTML, not JSON, so these assert on
// status only.
describe('Part E — Host validation covers the static UI, not only /api/*', () => {
  it('serves the dashboard shell for a valid loopback Host', async () => {
    await withLiteServer(async ({ port }) => {
      const res = await rawRequest({ port, method: 'GET', path: '/', host: `127.0.0.1:${port}` });
      assert.ok(res.status === 200 || res.status === 404,
        `expected the static handler to run (200, or 404 when dist/ is unbuilt), got ${res.status}`);
    });
  });

  it('rejects a foreign Host on a static path', async () => {
    await withLiteServer(async ({ port }) => {
      const res = await rawRequest({ port, method: 'GET', path: '/', host: 'evil.example.com' });
      assert.equal(res.status, 403, 'static UI must be Host-validated too');
    });
  });

  it('rejects a duplicated Host on a static path', async () => {
    await withLiteServer(async ({ port }) => {
      const res = await rawRequest({
        port, method: 'GET', path: '/', host: `127.0.0.1:${port}`, headers: ['Host: evil.example.com'],
      });
      assert.equal(res.status, 400);
    });
  });
});

describe('Part E — parseHostHeader / allow-list normalization (unit level)', () => {
  it('parses plain host, host:port, and bracketed IPv6 forms', () => {
    assert.deepEqual(parseHostHeader('example.com'), { hostname: 'example.com', port: null });
    assert.deepEqual(parseHostHeader('example.com:8642'), { hostname: 'example.com', port: '8642' });
    assert.deepEqual(parseHostHeader('[::1]:8642'), { hostname: '[::1]', port: '8642' });
  });

  it('rejects whitespace, commas, bare IPv6, empty values and non-numeric ports', () => {
    for (const bad of ['', 'a b', 'a,b', '::1:8642', ':8642', 'example.com:abc', 'example.com:']) {
      assert.equal(parseHostHeader(bad), null, `expected "${bad}" to be rejected`);
    }
  });

  it('lowercases hostnames so Host matching is case-insensitive (per RFC), without suffix matching', () => {
    assert.equal(normalizeAllowedHost('EXAMPLE.com:8642'), 'example.com:8642');
  });

  it('parseAllowedHosts collects valid entries and reports invalid ones separately', () => {
    const { hosts, invalid } = parseAllowedHosts('semidex.example.com, 192.168.1.10:8642 , not valid');
    assert.deepEqual([...hosts].sort(), ['192.168.1.10:8642', 'semidex.example.com']);
    assert.deepEqual(invalid, ['not valid']);
  });
});

describe('Part E — fail-closed remote mode (deliberate breaking change)', () => {
  it('throws when ADMIN_ALLOW_REMOTE is enabled without ADMIN_ALLOWED_HOSTS', () => {
    assert.throws(
      () => createRequestSecurityPolicy({ port: 8642, allowRemote: true }),
      /ADMIN_ALLOW_REMOTE=1 requires ADMIN_ALLOWED_HOSTS/
    );
  });

  it('the error message tells the operator exactly how to configure it', () => {
    try {
      createRequestSecurityPolicy({ port: 8642, allowRemote: true });
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /ADMIN_ALLOWED_HOSTS=semidex\.example\.com,192\.168\.1\.10:8642/);
    }
  });

  it('succeeds once ADMIN_ALLOWED_HOSTS is provided, and does NOT silently keep loopback in remote mode', () => {
    const policy = createRequestSecurityPolicy({
      port: 8642, allowRemote: true, allowedHosts: 'semidex.example.com',
    });
    assert.ok(policy.allowedHosts.has('semidex.example.com'));
    assert.equal(policy.allowedHosts.has('127.0.0.1:8642'), false,
      'remote mode uses the explicit list only — an unlisted loopback alias must not be implicitly allowed');
  });

  it('rejects an unparseable ADMIN_ALLOWED_HOSTS entry instead of silently dropping it', () => {
    assert.throws(
      () => createRequestSecurityPolicy({ port: 8642, allowedHosts: 'good.example.com,bad host' }),
      /unparseable entries/
    );
  });

  it('loopback mode keeps the loopback defaults AND any extra configured alias', () => {
    const policy = createRequestSecurityPolicy({ port: 8642, allowedHosts: 'dev.local:8642' });
    assert.ok(policy.allowedHosts.has('127.0.0.1:8642'));
    assert.ok(policy.allowedHosts.has('dev.local:8642'));
  });

  it('trusted-proxy behavior is off unless explicitly configured', () => {
    assert.equal(createRequestSecurityPolicy({ port: 8642 }).trustProxy, false);
  });
});

describe('Part B — documented treatment of missing Origin / missing Sec-Fetch-*', () => {
  const policy = createRequestSecurityPolicy({ port: 8642 });
  const req = (method, headers) => ({ method, headers: { host: '127.0.0.1:8642', ...headers } });

  it('BOTH absent (curl / server-to-server) -> allowed', () => {
    assert.equal(evaluateRequestSecurity(req('POST', {}), policy).ok, true);
  });

  it('Sec-Fetch-Site: same-origin -> allowed', () => {
    assert.equal(evaluateRequestSecurity(req('POST', { 'sec-fetch-site': 'same-origin' }), policy).ok, true);
  });

  it('Sec-Fetch-Site: none (user-initiated) -> allowed', () => {
    assert.equal(evaluateRequestSecurity(req('POST', { 'sec-fetch-site': 'none' }), policy).ok, true);
  });

  it('Sec-Fetch-Site: cross-site -> rejected, and it wins over an otherwise-matching Origin', () => {
    const verdict = evaluateRequestSecurity(
      req('POST', { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:8642' }),
      policy
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'cross_site_blocked');
  });

  it('Sec-Fetch-Site: same-site -> rejected (a sibling subdomain is not this origin)', () => {
    assert.equal(evaluateRequestSecurity(req('POST', { 'sec-fetch-site': 'same-site' }), policy).ok, false);
  });

  it('Origin matching this server (no Sec-Fetch-*) -> allowed', () => {
    assert.equal(evaluateRequestSecurity(req('POST', { origin: 'http://127.0.0.1:8642' }), policy).ok, true);
  });

  it('foreign Origin -> rejected', () => {
    assert.equal(evaluateRequestSecurity(req('POST', { origin: 'https://evil.example.com' }), policy).ok, false);
  });

  it('Origin: null -> rejected, never treated as same-origin', () => {
    assert.equal(evaluateRequestSecurity(req('POST', { origin: 'null' }), policy).ok, false);
  });

  it('malformed Origin -> rejected', () => {
    assert.equal(evaluateRequestSecurity(req('POST', { origin: ':::not-a-url' }), policy).ok, false);
  });

  it('safe methods (GET/HEAD) skip the cross-site check but still get Host validation', () => {
    assert.equal(evaluateRequestSecurity(req('GET', { origin: 'https://evil.example.com' }), policy).ok, true);
    const badHost = { method: 'GET', headers: { host: 'evil.example.com' } };
    assert.equal(evaluateRequestSecurity(badHost, policy).ok, false);
  });

  it('Referer is never used as the basis for a decision', () => {
    const verdict = evaluateRequestSecurity(
      req('POST', { origin: 'https://evil.example.com', referer: 'http://127.0.0.1:8642/' }),
      policy
    );
    assert.equal(verdict.ok, false, 'a friendly Referer must not rescue a foreign Origin');
  });

  // REGRESSION (2026-08-18): an earlier revision returned early whenever
  // Sec-Fetch-Site was same-origin/none, WITHOUT validating Origin. Fetch
  // Metadata is unforgeable by page JavaScript but trivially forgeable by a
  // non-browser client, so it may narrow a decision and must never widen
  // one. Both signals are now evaluated whenever both are present.
  it('a foreign Origin is still rejected when paired with Sec-Fetch-Site: none', () => {
    const verdict = evaluateRequestSecurity(
      req('POST', { origin: 'https://evil.example.com', 'sec-fetch-site': 'none' }),
      policy
    );
    assert.equal(verdict.ok, false, 'Sec-Fetch-Site must not be able to bypass Origin validation');
  });

  it('a foreign Origin is still rejected when paired with Sec-Fetch-Site: same-origin (contradictory signals)', () => {
    const verdict = evaluateRequestSecurity(
      req('POST', { origin: 'https://evil.example.com', 'sec-fetch-site': 'same-origin' }),
      policy
    );
    assert.equal(verdict.ok, false);
  });

  // REGRESSION (2026-08-18): Origin was compared on host ONLY, so an
  // https:// Origin matched a plaintext http:// server — different origins
  // by the web's own definition.
  it('rejects an https Origin against this plaintext http server — scheme is part of the comparison', () => {
    const verdict = evaluateRequestSecurity(req('POST', { origin: 'https://127.0.0.1:8642' }), policy);
    assert.equal(verdict.ok, false, 'scheme mismatch must be rejected; comparison is scheme+host+port');
  });

  it('rejects an Origin with the right host but the wrong port', () => {
    assert.equal(evaluateRequestSecurity(req('POST', { origin: 'http://127.0.0.1:9999' }), policy).ok, false);
  });

  it('accepts the exact matching origin (scheme + host + port)', () => {
    assert.equal(evaluateRequestSecurity(req('POST', { origin: 'http://127.0.0.1:8642' }), policy).ok, true);
  });

  it('rejects an Origin when the request carries no Host to compare against', () => {
    const verdict = evaluateRequestSecurity(
      { method: 'POST', headers: { origin: 'http://127.0.0.1:8642' } },
      policy
    );
    // No Host at all fails Host validation first — either way it must not pass.
    assert.equal(verdict.ok, false);
  });
});

describe('Part B — ADMIN_ALLOWED_ORIGINS (explicit exact-origin allow-list for reverse proxies)', () => {
  it('accepts a configured proxy origin that does not match the local scheme/Host', () => {
    const policy = createRequestSecurityPolicy({
      port: 8642, allowedOrigins: 'https://semidex.example.com',
    });
    const verdict = evaluateRequestSecurity(
      { method: 'POST', headers: { host: '127.0.0.1:8642', origin: 'https://semidex.example.com' } },
      policy
    );
    assert.equal(verdict.ok, true);
  });

  it('still rejects an unlisted origin when an allow-list is configured', () => {
    const policy = createRequestSecurityPolicy({
      port: 8642, allowedOrigins: 'https://semidex.example.com',
    });
    const verdict = evaluateRequestSecurity(
      { method: 'POST', headers: { host: '127.0.0.1:8642', origin: 'https://evil.example.com' } },
      policy
    );
    assert.equal(verdict.ok, false);
  });

  it('compares full origins, so a listed host on a different scheme does not match', () => {
    const policy = createRequestSecurityPolicy({
      port: 8642, allowedOrigins: 'https://semidex.example.com',
    });
    const verdict = evaluateRequestSecurity(
      { method: 'POST', headers: { host: '127.0.0.1:8642', origin: 'http://semidex.example.com' } },
      policy
    );
    assert.equal(verdict.ok, false);
  });

  it('rejects an unparseable ADMIN_ALLOWED_ORIGINS entry at construction time', () => {
    assert.throws(
      () => createRequestSecurityPolicy({ port: 8642, allowedOrigins: 'not-an-origin' }),
      /ADMIN_ALLOWED_ORIGINS contains invalid entries/
    );
  });

  // REGRESSION (2026-08-18): the first cut stored `new URL(entry).origin`,
  // which SILENTLY DISCARDS userinfo, path, query and fragment — so
  // "https://user:pass@semidex.example.com/admin" became
  // "https://semidex.example.com", i.e. every path on that host with no
  // credentials required. An operator writing that string would reasonably
  // believe they had restricted access. It also accepted any scheme, so
  // "ftp://host" was stored verbatim and could never match a real Origin.
  // Surprising input must be rejected, never normalized into a broader rule.
  describe('strict entry validation (no silent widening)', () => {
    const mustReject = [
      ['userinfo + path', 'https://user:pass@semidex.example.com/admin'],
      ['userinfo only', 'https://user@semidex.example.com'],
      ['non-HTTP scheme', 'ftp://semidex.example.com'],
      ['path', 'https://semidex.example.com/some/path'],
      ['query string', 'https://semidex.example.com?q=1'],
      ['fragment', 'https://semidex.example.com#frag'],
      ['opaque origin (file:)', 'file:///etc/passwd'],
      ['opaque origin (javascript:)', 'javascript:alert(1)'],
    ];

    for (const [label, entry] of mustReject) {
      it(`rejects ${label}: ${entry}`, () => {
        assert.throws(
          () => createRequestSecurityPolicy({ port: 8642, allowedOrigins: entry }),
          /ADMIN_ALLOWED_ORIGINS contains invalid entries/,
          `"${entry}" must be rejected rather than normalized to a broader origin`
        );
      });
    }

    it('the error explains the required form so the operator can fix it', () => {
      try {
        createRequestSecurityPolicy({ port: 8642, allowedOrigins: 'https://user:pass@host/admin' });
        assert.fail('expected a throw');
      } catch (err) {
        assert.match(err.message, /scheme, host and optional port ONLY/);
        assert.match(err.message, /ADMIN_ALLOWED_ORIGINS=https:\/\/semidex\.example\.com/);
      }
    });

    it('accepts a bare origin, with or without a trailing slash', () => {
      for (const entry of ['https://semidex.example.com', 'https://semidex.example.com/']) {
        const policy = createRequestSecurityPolicy({ port: 8642, allowedOrigins: entry });
        assert.deepEqual([...policy.allowedOrigins], ['https://semidex.example.com']);
      }
    });

    it('accepts an explicit port and a plain-http origin (LAN deployments)', () => {
      const policy = createRequestSecurityPolicy({ port: 8642, allowedOrigins: 'http://192.168.1.10:8642' });
      assert.ok(policy.allowedOrigins.has('http://192.168.1.10:8642'));
    });

    it('accepts a comma-separated list and lowercases entries', () => {
      const policy = createRequestSecurityPolicy({
        port: 8642,
        allowedOrigins: 'HTTPS://SEMIDEX.EXAMPLE.COM, http://192.168.1.10:8642',
      });
      assert.deepEqual(
        [...policy.allowedOrigins].sort(),
        ['http://192.168.1.10:8642', 'https://semidex.example.com']
      );
    });

    it('rejects the whole config if ANY entry is invalid — never silently drops one', () => {
      assert.throws(
        () => createRequestSecurityPolicy({
          port: 8642,
          allowedOrigins: 'https://good.example.com,https://bad.example.com/path',
        }),
        /ADMIN_ALLOWED_ORIGINS contains invalid entries/
      );
    });
  });
});

describe('Part C — Content-Type enforcement for JSON bodies', () => {
  const withBody = (contentType, length = '42') => ({
    headers: {
      ...(contentType === null ? {} : { 'content-type': contentType }),
      'content-length': length,
    },
  });

  it('accepts application/json', () => {
    assert.equal(checkJsonContentType(withBody('application/json')).ok, true);
  });

  it('accepts application/json; charset=utf-8 (parameter allowed)', () => {
    assert.equal(checkJsonContentType(withBody('application/json; charset=utf-8')).ok, true);
  });

  it('accepts a structured +json suffix type', () => {
    assert.equal(checkJsonContentType(withBody('application/vnd.semidex+json')).ok, true);
  });

  it('is case-insensitive about the media type', () => {
    assert.equal(checkJsonContentType(withBody('Application/JSON')).ok, true);
  });

  it('rejects text/plain with a non-empty body — this is the exact CORS-simple smuggling shape', () => {
    const verdict = checkJsonContentType(withBody('text/plain'));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 415);
    assert.equal(verdict.code, 'unsupported_media_type');
  });

  it('rejects form and multipart types (the other two CORS-safelisted content types)', () => {
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      assert.equal(checkJsonContentType(withBody(type)).ok, false, `${type} must be rejected`);
    }
  });

  it('rejects a missing Content-Type when a body IS present', () => {
    assert.equal(checkJsonContentType(withBody(null)).ok, false);
  });

  it('allows a genuinely EMPTY body with no Content-Type — body-less POSTs must keep working', () => {
    assert.equal(checkJsonContentType({ headers: { 'content-length': '0' } }).ok, true);
    assert.equal(checkJsonContentType({ headers: {} }).ok, true);
  });

  it('treats a chunked body as non-empty and therefore requires a Content-Type', () => {
    assert.equal(checkJsonContentType({ headers: { 'transfer-encoding': 'chunked' } }).ok, false);
  });
});

describe('Part C — Content-Type enforcement end-to-end (415 before any work)', () => {
  it('text/plain carrying valid JSON returns 415 from a non-browser client and never spawns the indexer', async () => {
    await withLiteServer(async ({ base, wasSpawned }) => {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: VALID_JOB_BODY,
      });
      assert.equal(res.status, 415);
      const body = await res.json();
      assert.equal(body.error.code, 'unsupported_media_type');
      assert.equal(wasSpawned(), false, 'a 415 must be decided before the job is started');
    });
  });

  it('application/json; charset=utf-8 is accepted end-to-end', async () => {
    await withLiteServer(async ({ base, wasSpawned }) => {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: VALID_JOB_BODY,
      });
      assert.equal(res.status, 202);
      assert.equal(wasSpawned(), true);
    });
  });
});

describe('Part F — no permissive CORS was introduced by the hardening pass', () => {
  it('a rejected cross-origin response carries no Access-Control-Allow-Origin', async () => {
    await withLiteServer(async ({ base }) => {
      const res = await fetch(base + '/api/jobs/index', {
        method: 'POST',
        headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
        body: VALID_JOB_BODY,
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    });
  });

  it('an accepted same-origin response also carries no ACAO, and does set Vary + nosniff', async () => {
    await withLiteServer(async ({ base }) => {
      const res = await fetch(base + '/api/health');
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      assert.match(res.headers.get('vary') ?? '', /Origin/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    });
  });
});
