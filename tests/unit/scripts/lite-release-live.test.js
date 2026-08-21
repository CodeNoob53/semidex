import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLLECTION_PREFIX, assertOwnedCollectionName, buildChildEnv, computeVerdict,
  extractCreatedToken, findPackedTarball, makeOwnedCollectionName, parseSse, redactSensitive,
  isTransientGenerationFailure, requireLiveOptIn, resolveNpmInvocation, retryTransientGeneration,
  retryTransientGenerationBatch,
  shouldDeleteOwnedCollection,
  summarizeAskEvents, summarizePartialSse,
} from '../../../scripts/lib/lite-release-live.mjs';

test('live opt-in is explicit and credentials are fail-closed', () => {
  assert.equal(requireLiveOptIn({}).ok, false);
  assert.deepEqual(requireLiveOptIn({ SEMIDEX_LITE_RELEASE_LIVE: '1' }).missing, ['QDRANT_URL', 'QDRANT_KEY', 'GEMINI_API_KEY']);
  assert.equal(requireLiveOptIn({ SEMIDEX_LITE_RELEASE_LIVE: '1', QDRANT_URL: 'x', QDRANT_KEY: 'y', GEMINI_API_KEY: 'z' }).ok, true);
});

test('cleanup deletes only an exact-owned collection proven absent before the run', () => {
  const name = `${COLLECTION_PREFIX}${'cd'.repeat(12)}`;
  assert.equal(shouldDeleteOwnedCollection(name, { collisionConfirmedAbsent: true, lookupStatus: 200 }), true);
  assert.equal(shouldDeleteOwnedCollection(name, { collisionConfirmedAbsent: false, lookupStatus: 200 }), false);
  assert.equal(shouldDeleteOwnedCollection(name, { collisionConfirmedAbsent: true, lookupStatus: 404 }), false);
  assert.throws(() => shouldDeleteOwnedCollection('user-data', { collisionConfirmedAbsent: true, lookupStatus: 200 }), /not owned/);
});

test('owned collection names are exact and unguessable-shaped', () => {
  const name = makeOwnedCollectionName(() => Buffer.alloc(12, 0xab));
  assert.equal(name, `${COLLECTION_PREFIX}${'ab'.repeat(12)}`);
  assert.equal(assertOwnedCollectionName(name), name);
  for (const unsafe of ['user-data', COLLECTION_PREFIX, `${name}-extra`, `${COLLECTION_PREFIX}ABC`]) {
    assert.throws(() => assertOwnedCollectionName(unsafe), /not owned/);
  }
});

test('child environment isolates state and pins cloud providers', () => {
  const env = buildChildEnv({ KEEP: 'yes', SEMIDEX_HOME: 'old' }, { semidexHome: 'temp-home', collection: 'c', port: 9123 });
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.SEMIDEX_HOME, 'temp-home');
  assert.equal(env.COLLECTION, 'c');
  assert.equal(env.ADMIN_HOST, '127.0.0.1');
  assert.equal(env.ADMIN_PORT, '9123');
  assert.equal(env.EMBEDDING_BACKEND, 'qdrant-cloud');
  assert.equal(env.QDRANT_CLOUD_DENSE_MODEL, 'intfloat/multilingual-e5-small');
  assert.equal(env.QDRANT_SPARSE_MODEL, 'qdrant/bm25');
});

test('npm invocation uses npm-cli.js through Node on Windows', () => {
  assert.deepEqual(
    resolveNpmInvocation({ npm_execpath: 'C:\\npm\\bin\\npm-cli.js' }, { platform: 'win32', execPath: 'C:\\node\\node.exe' }),
    { command: 'C:\\node\\node.exe', argsPrefix: ['C:\\npm\\bin\\npm-cli.js'] },
  );
  assert.throws(
    () => resolveNpmInvocation({}, { platform: 'win32', execPath: 'node.exe' }),
    /npm run accept:lite-release-live/,
  );
  assert.deepEqual(
    resolveNpmInvocation({}, { platform: 'linux', execPath: '/usr/bin/node' }),
    { command: 'npm', argsPrefix: [] },
  );
});

test('packed artifact discovery ignores lifecycle stdout and requires one tgz', () => {
  const directory = mkdtempSync(join(tmpdir(), 'semidex-lite-pack-test-'));
  try {
    writeFileSync(join(directory, 'vite-build.log'), 'not JSON', 'utf8');
    assert.throws(() => findPackedTarball(directory), /found 0/);
    const tarball = join(directory, 'semidex-lite-0.1.4.tgz');
    writeFileSync(tarball, 'fixture', 'utf8');
    assert.equal(findPackedTarball(directory), tarball);
    writeFileSync(join(directory, 'second.tgz'), 'fixture', 'utf8');
    assert.throws(() => findPackedTarball(directory), /found 2/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('token extraction requires one token and redaction removes credentials', () => {
  const token = `sdx_v1_${'a'.repeat(16)}_${'b'.repeat(43)}`;
  assert.equal(extractCreatedToken(`created\n${token}\n`), token);
  assert.throws(() => extractCreatedToken('none'), /exactly one/);
  const redacted = redactSensitive(`Authorization: Bearer ${token} secret-value`, ['secret-value']);
  assert.doesNotMatch(redacted, /sdx_v1_|secret-value/);
  const url = redactSensitive('request failed at https://user:pass@example.test/path?api_key=secret#fragment');
  assert.equal(url, 'request failed at https://example.test/path');
});

test('verdict rejects cleanup failure and distinguishes partial', () => {
  assert.equal(computeVerdict([{ status: 'pass' }], true), 'SEMIDEX_LITE_RELEASE_LIVE_ACCEPT');
  assert.equal(computeVerdict([{ status: 'pass' }, { status: 'fail' }], true), 'SEMIDEX_LITE_RELEASE_LIVE_PARTIAL');
  assert.equal(computeVerdict([{ status: 'pass' }], false), 'SEMIDEX_LITE_RELEASE_LIVE_REJECT');
  assert.equal(computeVerdict([], true), 'SEMIDEX_LITE_RELEASE_LIVE_REJECT');
});

test('SSE summary keeps only evidence metadata, not answer text', () => {
  const events = parseSse('event: sources\ndata: {"sources":[{"text":"secret evidence"}]}\n\nevent: answer_delta\ndata: {"text":"raw answer"}\n\nevent: done\ndata: {"citations":[1]}\n\n');
  assert.deepEqual(summarizeAskEvents(events), {
    ok: true,
    donePresent: true,
    sourceCount: 1,
    citations: [1],
    refused: false,
    refusalReason: null,
    answerChars: 0,
    evidenceCount: null,
    provider: null,
    model: null,
    errorCode: null,
    errorMessage: null,
  });
});

test('SSE summary exposes only the public sanitized error payload for diagnosis', () => {
  const events = parseSse('event: error\ndata: {"code":"generation_failed","message":"Public provider failure"}\n\n');
  const summary = summarizeAskEvents(events);
  assert.equal(summary.errorCode, 'generation_failed');
  assert.equal(summary.errorMessage, 'Public provider failure');
  assert.equal(summary.donePresent, false);
});

test('partial SSE diagnostics retain event names but never event data', () => {
  const raw = 'event: sources\ndata: {"sources":[{"text":"private evidence"}]}\n\nevent: answer_delta\ndata: {"text":"private answer"}';
  const summary = summarizePartialSse(raw);
  assert.deepEqual(summary, { eventNames: ['sources', 'answer_delta'] });
  assert.doesNotMatch(JSON.stringify(summary), /private evidence|private answer/);
});

test('transient generation classification is narrow to provider availability failures', () => {
  assert.equal(isTransientGenerationFailure({ errorCode: 'generation_failed', errorMessage: '503 UNAVAILABLE: high demand' }), true);
  assert.equal(isTransientGenerationFailure({ errorCode: 'generation_failed', errorMessage: 'Service Unavailable' }), true);
  assert.equal(isTransientGenerationFailure({ errorCode: 'generation_failed', errorMessage: 'API key is invalid' }), false);
  assert.equal(isTransientGenerationFailure({ errorCode: 'rate_limited', errorMessage: '503' }), false);
  assert.equal(isTransientGenerationFailure({ ok: true, citations: [] }), false);
});

test('transient generation retries are bounded and stop on success', async () => {
  const responses = [
    { summary: { errorCode: 'generation_failed', errorMessage: '503 UNAVAILABLE' } },
    { summary: { errorCode: 'generation_failed', errorMessage: 'high demand' } },
    { summary: { ok: true, citations: [1] } },
  ];
  const sleeps = [];
  const { result, attempts } = await retryTransientGeneration(
    async () => responses.shift(),
    { delaysMs: [5, 15, 30], sleep: async (ms) => sleeps.push(ms) },
  );
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [5, 15]);
  assert.deepEqual(result.summary.citations, [1]);
});

test('persistent transient failure stops after the configured attempts', async () => {
  let calls = 0;
  const { attempts } = await retryTransientGeneration(
    async () => {
      calls += 1;
      return { summary: { errorCode: 'generation_failed', errorMessage: '503 Service Unavailable' } };
    },
    { delaysMs: [1, 2], sleep: async () => {} },
  );
  assert.equal(attempts, 3);
  assert.equal(calls, 3);
});

test('non-transient failures and uncited done responses are never retried', async () => {
  for (const summary of [
    { errorCode: 'generation_failed', errorMessage: 'invalid model' },
    { ok: true, citations: [] },
  ]) {
    let calls = 0;
    const { attempts } = await retryTransientGeneration(async () => {
      calls += 1;
      return { summary };
    }, { sleep: async () => assert.fail('must not sleep') });
    assert.equal(attempts, 1);
    assert.equal(calls, 1);
  }
});

test('batch retries transient generation in fair sequential rounds', async () => {
  const calls = [];
  const sleeps = [];
  const responses = {
    v1: [
      { summary: { errorCode: 'generation_failed', errorMessage: '503 UNAVAILABLE' } },
      { summary: { errorCode: 'generation_failed', errorMessage: 'high demand' } },
      { summary: { ok: true, citations: [1] } },
    ],
    v2: [
      { summary: { errorCode: 'generation_failed', errorMessage: 'Service Unavailable' } },
      { summary: { ok: true, citations: [2] } },
    ],
  };
  const operation = (name) => async () => {
    calls.push(name);
    return responses[name].shift();
  };

  const results = await retryTransientGenerationBatch([
    { name: 'v1', run: operation('v1') },
    { name: 'v2', run: operation('v2') },
  ], { delaysMs: [5, 15], sleep: async (ms) => sleeps.push(ms) });

  assert.deepEqual(calls, ['v1', 'v2', 'v1', 'v2', 'v1']);
  assert.deepEqual(sleeps, [5, 15]);
  assert.equal(results.v1.attempts, 3);
  assert.equal(results.v2.attempts, 2);
  assert.deepEqual(results.v1.result.summary.citations, [1]);
  assert.deepEqual(results.v2.result.summary.citations, [2]);
});

test('batch retries only transient entries and remains bounded', async () => {
  const calls = { transient: 0, invalid: 0, uncited: 0 };
  const results = await retryTransientGenerationBatch([
    {
      name: 'transient',
      run: async () => {
        calls.transient += 1;
        return { summary: { errorCode: 'generation_failed', errorMessage: '503 high demand' } };
      },
    },
    {
      name: 'invalid',
      run: async () => {
        calls.invalid += 1;
        return { summary: { errorCode: 'generation_failed', errorMessage: 'invalid model' } };
      },
    },
    {
      name: 'uncited',
      run: async () => {
        calls.uncited += 1;
        return { summary: { ok: true, citations: [] } };
      },
    },
  ], { delaysMs: [1, 2], sleep: async () => {} });

  assert.deepEqual(calls, { transient: 3, invalid: 1, uncited: 1 });
  assert.equal(results.transient.attempts, 3);
  assert.equal(results.invalid.attempts, 1);
  assert.equal(results.uncited.attempts, 1);
});
