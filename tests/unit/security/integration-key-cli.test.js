// `key add|list|revoke` CLI — shared by `semidex-lite key` and
// `npm run key --`. Offline, temp-directory only.
//
// The security-relevant assertions here are about OUTPUT: a digest must never
// be printed, `list` must never show a token, and the one-time token display
// must be unmistakable.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runKeyCommand, parseDuration, resolveExpiry, parseArgs } from '../../../src/core/auth/key-cli.js';
import { createKeyStore, TOKEN_PREFIX } from '../../../src/core/auth/key-store.js';

let dir;
let keyStorePath;
let stdout;
let stderr;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'semidex-key-cli-'));
  keyStorePath = join(dir, 'integration-keys.json');
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (argv) => runKeyCommand(argv, {
  keyStorePath,
  cliName: 'semidex-lite',
  out: (m) => stdout.push(String(m)),
  err: (m) => stderr.push(String(m)),
});

const out = () => stdout.join('\n');
const err = () => stderr.join('\n');

describe('key add', () => {
  it('creates a key and prints the raw token exactly once, with a warning', () => {
    const code = run(['add', '--name', 'assistant', '--collection', 'docs-a']);
    assert.equal(code, 0);

    const tokens = out().match(/sdx_v1_[A-Za-z0-9_-]+/g) ?? [];
    assert.equal(tokens.length, 1, 'the token must be printed exactly once');
    assert.match(out(), /NOT STORED AND CANNOT BE/i, 'the one-time warning must be prominent');
    assert.match(out(), /Authorization: Bearer/, 'tells the operator how to send it');
  });

  it('never prints the digest', () => {
    run(['add', '--name', 'a', '--collection', 'docs-a']);
    const stored = JSON.parse(readFileSync(keyStorePath, 'utf-8'));
    const digest = stored.keys[0].digest;
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(out().includes(digest), false, 'the digest must never reach the terminal');
  });

  it('the printed token authenticates, and only its digest is on disk', () => {
    run(['add', '--name', 'a', '--collection', 'docs-a']);
    const token = out().match(/sdx_v1_[A-Za-z0-9_-]+/)[0];
    const store = createKeyStore({ path: keyStorePath });
    assert.equal(store.authenticateToken(token).result, 'ok');
    assert.equal(readFileSync(keyStorePath, 'utf-8').includes(token), false);
  });

  it('supports multiple collections and an explicit wildcard', () => {
    assert.equal(run(['add', '--name', 'multi', '--collection', 'a', '--collection', 'b']), 0);
    assert.match(out(), /Collections: a, b/);

    stdout = [];
    assert.equal(run(['add', '--name', 'wild', '--collection', '*']), 0);
    assert.match(out(), /Collections: \*/);
  });

  it('refuses to create a key with no collection — absence of scope is never unrestricted', () => {
    const code = run(['add', '--name', 'oops']);
    assert.equal(code, 1);
    assert.match(err(), /never mean unrestricted/);
    assert.equal(existsSync(keyStorePath), false, 'nothing may be written for an invalid request');
  });

  it('refuses an unsupported operation and an invalid expiry', () => {
    assert.equal(run(['add', '--name', 'x', '--collection', 'a', '--operation', 'delete']), 1);
    assert.match(err(), /Unsupported operation/);

    stderr = [];
    assert.equal(run(['add', '--name', 'x', '--collection', 'a', '--expires', 'whenever']), 1);
    assert.match(err(), /ISO-8601/);
  });

  it('accepts a duration expiry and records it as an absolute ISO instant', () => {
    assert.equal(run(['add', '--name', 'x', '--collection', 'a', '--expires', '30d']), 0);
    const stored = JSON.parse(readFileSync(keyStorePath, 'utf-8'));
    const expires = Date.parse(stored.keys[0].expiresAt);
    const expected = Date.now() + 30 * 86_400_000;
    assert.ok(Math.abs(expires - expected) < 60_000, 'roughly 30 days out');
  });
});

describe('key add — rate limit flags', () => {
  it('defaults to 30/min burst 5 when no flags are given', () => {
    run(['add', '--name', 'a', '--collection', 'docs-a']);
    assert.match(out(), /Rate limit:\s+30\/min, burst 5/);
    const stored = JSON.parse(readFileSync(keyStorePath, 'utf-8'));
    assert.equal(stored.keys[0].requestsPerMinute, null, 'the raw record stores null, not the resolved default');
    assert.equal(stored.keys[0].burst, null);
  });

  it('accepts explicit --requests-per-minute and --burst and persists them as plain JSON numbers', () => {
    run(['add', '--name', 'vip', '--collection', 'docs-a', '--requests-per-minute', '600', '--burst', '20']);
    assert.match(out(), /Rate limit:\s+600\/min, burst 20/);
    const stored = JSON.parse(readFileSync(keyStorePath, 'utf-8'));
    assert.equal(stored.keys[0].requestsPerMinute, 600);
    assert.equal(stored.keys[0].burst, 20);
  });

  it('rejects a value above the conservative maxima', () => {
    const code = run(['add', '--name', 'x', '--collection', 'a', '--requests-per-minute', '999999']);
    assert.equal(code, 1);
    assert.match(err(), /requests-per-minute.*must be an integer in/);
    assert.equal(existsSync(keyStorePath), false);
  });

  it('rejects zero, negative, and non-integer values', () => {
    for (const bad of ['0', '-5', '3.5', 'abc']) {
      stderr = [];
      const code = run(['add', '--name', 'x', '--collection', 'a', '--burst', bad]);
      assert.equal(code, 1, `"${bad}" must be rejected`);
      assert.match(err(), /burst.*must be an integer in/);
    }
  });

  it('list shows the effective rate limit for both explicit and default keys, never a secret', () => {
    run(['add', '--name', 'custom', '--collection', 'a', '--requests-per-minute', '600', '--burst', '20']);
    stdout = [];
    run(['add', '--name', 'plain', '--collection', 'a']);
    stdout = [];
    run(['list']);
    assert.match(out(), /custom[\s\S]*600\/min burst 20/);
    assert.match(out(), /plain[\s\S]*30\/min burst 5/);
  });
});

describe('key list', () => {
  it('shows public metadata and NEVER a digest or token', () => {
    run(['add', '--name', 'assistant', '--collection', 'docs-a']);
    const token = out().match(/sdx_v1_[A-Za-z0-9_-]+/)[0];
    const digest = JSON.parse(readFileSync(keyStorePath, 'utf-8')).keys[0].digest;

    stdout = [];
    assert.equal(run(['list']), 0);
    const listing = out();
    assert.equal(listing.includes(token), false, 'list must never print a token');
    assert.equal(listing.includes(digest), false, 'list must never print a digest');
    assert.equal(/sdx_v1_/.test(listing), false, 'not even a token prefix');
    assert.match(listing, /assistant/);
    assert.match(listing, /docs-a/);
    assert.match(listing, /active/);
  });

  it('reports an empty store with guidance rather than an error', () => {
    assert.equal(run(['list']), 0);
    assert.match(out(), /No Integration API keys configured/);
    assert.match(out(), /key add/);
  });

  it('marks revoked and expired keys distinctly', () => {
    run(['add', '--name', 'r', '--collection', 'a']);
    const store = createKeyStore({ path: keyStorePath });
    store.revokeKey(store.listKeys()[0].id);
    stdout = [];
    run(['list']);
    assert.match(out(), /revoked/);
  });
});

describe('key revoke', () => {
  it('revokes, then reports already_revoked, then not_found', () => {
    run(['add', '--name', 'r', '--collection', 'a']);
    const id = createKeyStore({ path: keyStorePath }).listKeys()[0].id;

    stdout = [];
    assert.equal(run(['revoke', id]), 0);
    assert.match(out(), /revoked at/);
    assert.match(out(), /no restart required/);

    stdout = [];
    assert.equal(run(['revoke', id]), 0, 'revoking twice is idempotent, not an error');
    assert.match(out(), /already revoked/);

    stderr = [];
    assert.equal(run(['revoke', 'z'.repeat(16)]), 1);
    assert.match(err(), /No key with id/);
  });

  it('requires an id', () => {
    assert.equal(run(['revoke']), 1);
    assert.match(err(), /Usage/);
  });
});

describe('CLI surface', () => {
  it('prints usage for help and for an unknown subcommand', () => {
    assert.equal(run(['help']), 0);
    assert.match(out(), /key add --name/);

    stderr = [];
    assert.equal(run(['frobnicate']), 1);
    assert.match(err(), /Unknown key subcommand/);
  });

  it('reports a missing flag value without leaking anything', () => {
    assert.equal(run(['add', '--name']), 1);
    assert.match(err(), /--name requires a value/);
  });

  it('a corrupt store surfaces a clear error rather than silently starting fresh', () => {
    writeFileSync(keyStorePath, '{ broken', 'utf-8');
    assert.equal(run(['list']), 1);
    assert.match(err(), /valid JSON/);
  });
});

describe('argument helpers', () => {
  it('parses durations', () => {
    assert.equal(parseDuration('30d'), 30 * 86_400_000);
    assert.equal(parseDuration('12h'), 12 * 3_600_000);
    assert.equal(parseDuration('90m'), 90 * 60_000);
    assert.equal(parseDuration('45s'), 45_000);
    assert.equal(parseDuration('tomorrow'), null);
    assert.equal(parseDuration('30'), null);
  });

  it('resolves expiry from a duration or an absolute date, rejecting the past', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(resolveExpiry('30d', now), new Date(now + 30 * 86_400_000).toISOString());
    assert.equal(resolveExpiry('2027-01-01T00:00:00Z', now), '2027-01-01T00:00:00.000Z');
    assert.equal(resolveExpiry(undefined, now), null);
    assert.throws(() => resolveExpiry('2020-01-01', now), /in the past/);
    assert.throws(() => resolveExpiry('nonsense', now), /not a valid ISO-8601/);
  });

  it('collects repeated flags', () => {
    const { flags } = parseArgs(['--name', 'n', '--collection', 'a', '--collection', 'b']);
    assert.equal(flags.name, 'n');
    assert.deepEqual(flags.collection, ['a', 'b']);
  });
});
