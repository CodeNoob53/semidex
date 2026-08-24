#!/usr/bin/env node
// Opt-in release acceptance for the ACTUAL packed Semidex Lite artifact.
// Never include this script in npm test/smoke/CI: it installs packages,
// calls Qdrant Cloud and Gemini, and creates one exact-owned collection.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertOwnedCollectionName, buildChildEnv, computeVerdict, extractCreatedToken,
  findPackedTarball, makeOwnedCollectionName, parseSse, redactSensitive, requireLiveOptIn,
  resolveNpmInvocation, retryTransientGenerationBatch, shouldDeleteOwnedCollection, summarizeAskEvents,
  summarizePartialSse,
} from './lib/lite-release-live.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
let cleanupOk = true;
const secrets = [process.env.QDRANT_KEY, process.env.GEMINI_API_KEY];
const safe = (value) => redactSensitive(value, secrets);
// Categories the JSON report groups checks by (task requirement: the report
// must clearly distinguish packaging, SDK Search, auth, Ask v1, Ask v2, and
// cleanup outcomes) — 'preflight'/'harness'/'report' cover the remaining
// pre-run/failure/report-writing checks that don't belong to any of those
// five, so every recorded check always carries a real category.
const CATEGORY = Object.freeze({
  PREFLIGHT: 'preflight', PACKAGING: 'packaging', AUTH: 'auth', SEARCH: 'search',
  ASK_V1: 'ask-v1', ASK_V2: 'ask-v2', CLEANUP: 'cleanup', HARNESS: 'harness', REPORT: 'report',
});
const record = (name, status, detail = '', category = CATEGORY.HARNESS) => {
  checks.push({ name, status, category, ...(detail ? { detail: safe(detail) } : {}) });
  console.log(`${status === 'pass' ? 'PASS' : 'FAIL'} [${category}] ${name}${detail ? `: ${safe(detail)}` : ''}`);
};

/**
 * Loads createSemidexClient/SemidexApiError from the ACTUAL installed
 * tarball location — `project/node_modules/semidex-lite/lite-src/client/
 * index.js`, the exact file packages/lite/package.json's own
 * `"exports"."./client"` maps to — never repository source and never only
 * raw fetch(). Search below is exercised through this loaded client only.
 */
async function loadInstalledClient(project) {
  const entry = join(project, 'node_modules', 'semidex-lite', 'lite-src', 'client', 'index.js');
  if (!existsSync(entry)) throw new Error('installed semidex-lite/client entry file is missing — packaging is broken');
  return import(pathToFileURL(entry).href);
}

/**
 * Calls Search through the installed SDK client and normalizes both the
 * success and SemidexApiError-failure shapes into one return value this
 * script's own record()/assertion call sites can branch on uniformly —
 * mirrors ask()'s own { status, ... } shape below so the two read the same
 * way in the report.
 */
async function sdkSearch(client, SemidexApiError, { collection, query }) {
  try {
    const result = await client.search({ collection, query });
    return { ok: true, status: 200, result };
  } catch (error) {
    if (error instanceof SemidexApiError) {
      return { ok: false, status: error.status, code: error.code, message: error.message };
    }
    throw error;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'spawn'}): ${safe(result.stderr || result.error?.message)}`);
  }
  return result;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForServer(base, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`serve exited early with code ${child.exitCode}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('serve did not become ready before timeout');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  }
}

function qdrantCollectionUrl(name) {
  const base = new URL(process.env.QDRANT_URL);
  base.username = '';
  base.password = '';
  base.search = '';
  base.hash = '';
  return new URL(`collections/${encodeURIComponent(assertOwnedCollectionName(name))}`, `${base.toString().replace(/\/$/, '')}/`).toString();
}

async function qdrantCollection(name, method = 'GET') {
  return fetch(qdrantCollectionUrl(name), {
    method,
    redirect: 'error',
    headers: { 'api-key': process.env.QDRANT_KEY },
  });
}

async function ask(base, version, token, collection, question) {
  const response = await fetch(`${base}/api/${version}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ collection, question }),
  });
  const chunks = [];
  let bytesReceived = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        bytesReceived += chunk.byteLength;
        chunks.push(chunk);
      }
    }
  } catch (error) {
    const partial = Buffer.concat(chunks).toString('utf8');
    const { eventNames } = summarizePartialSse(partial);
    const causeCode = error?.cause?.code ?? error?.code ?? 'unknown';
    throw new Error(
      `Ask ${version} response stream failed after HTTP ${response.status}; `
      + `bytes=${bytesReceived}; events=${eventNames.join(',') || 'none'}; `
      + `cause=${causeCode}; message=${error?.message ?? String(error)}`,
    );
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return { status: response.status, body: text, summary: response.ok ? summarizeAskEvents(parseSse(text)) : null };
}

function askSummaryDetail(status, summary, attempts = 1) {
  if (!summary) return `HTTP ${status}; no SSE summary`;
  return [
    `HTTP ${status}`,
    `attempts=${attempts}`,
    `done=${summary.donePresent}`,
    `sources=${summary.sourceCount}`,
    `evidence=${summary.evidenceCount ?? 'unknown'}`,
    `citations=${summary.citations.length}`,
    `refused=${summary.refused}`,
    `refusalReason=${summary.refusalReason ?? 'none'}`,
    `answerChars=${summary.answerChars}`,
    `provider=${summary.provider ?? 'unknown'}`,
    `model=${summary.model ?? 'unknown'}`,
    `error=${summary.errorCode ?? 'none'}`,
    `errorMessage=${summary.errorMessage ?? 'none'}`,
  ].join('; ');
}

async function main() {
  const preflight = requireLiveOptIn();
  if (!preflight.ok) {
    console.error(`Live acceptance disabled: ${preflight.reason}. Missing: ${preflight.missing.join(', ')}`);
    console.log('SEMIDEX_LITE_RELEASE_LIVE_REJECT');
    process.exitCode = 1;
    return;
  }

  const npmInvocation = resolveNpmInvocation();

  const collection = makeOwnedCollectionName();
  const otherCollection = makeOwnedCollectionName();
  const work = mkdtempSync(join(tmpdir(), 'semidex-lite-release-live-'));
  const home = join(work, 'home');
  const project = join(work, 'install');
  const fixture = join(work, 'fixture.md');
  const reportPath = process.env.SEMIDEX_LITE_RELEASE_REPORT
    ? resolve(process.env.SEMIDEX_LITE_RELEASE_REPORT)
    : join(root, '.tmp', 'semidex-lite-release-live-report.json');
  let server;
  let serverError = '';
  let collisionConfirmedAbsent = false;

  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(fixture, '# Release acceptance\n\nSemidex Lite indexes multilingual evidence. Контрольне число: 314159.\n', 'utf8');

    const collision = await qdrantCollection(collection);
    if (collision.status !== 404) throw new Error(`Disposable collection collision check returned HTTP ${collision.status}; refusing to continue.`);
    collisionConfirmedAbsent = true;
    record('exact-owned collection is absent', 'pass', '', CATEGORY.PREFLIGHT);

    run(npmInvocation.command, [...npmInvocation.argsPrefix, 'pack', join(root, 'packages', 'lite'), '--pack-destination', work], { cwd: root });
    const tarball = findPackedTarball(work);
    if (!existsSync(tarball)) throw new Error('npm pack did not produce the expected tarball');
    run(npmInvocation.command, [...npmInvocation.argsPrefix, 'install', '--no-audit', '--no-fund', tarball], { cwd: project });
    const cli = join(project, 'node_modules', 'semidex-lite', 'bin', 'semidex-lite.js');
    if (!existsSync(cli)) throw new Error('clean-installed semidex-lite CLI is missing');
    record('pack and clean install', 'pass', '', CATEGORY.PACKAGING);

    const port = await freePort();
    const env = buildChildEnv(process.env, { semidexHome: home, collection, port });
    run(process.execPath, [cli, 'doctor', '--probe-inference'], { cwd: project, env });
    record('installed doctor cloud inference probe', 'pass', '', CATEGORY.PACKAGING);
    run(process.execPath, [cli, 'index', fixture], { cwd: project, env });
    record('installed CLI indexed fixture', 'pass', '', CATEGORY.PACKAGING);

    // Three keys, each scoped to exactly what it is used for below — no key
    // is widened beyond its original operation set. release-valid/
    // release-limited are UNCHANGED from before Integration Search existed
    // (generate-only, the CLI's own default when --operation is omitted);
    // release-search is a NEW, separate key with ONLY the search operation,
    // so a successful Search call below actually proves the search-scoped
    // grant works, not that a generate key was silently widened.
    const validOut = run(process.execPath, [cli, 'key', 'add', '--name', 'release-valid', '--collection', collection], { cwd: project, env });
    const validToken = extractCreatedToken(validOut.stdout);
    secrets.push(validToken);
    const limitedOut = run(process.execPath, [cli, 'key', 'add', '--name', 'release-limited', '--collection', collection, '--requests-per-minute', '1', '--burst', '1'], { cwd: project, env });
    const limitedToken = extractCreatedToken(limitedOut.stdout);
    secrets.push(limitedToken);
    const searchOut = run(process.execPath, [cli, 'key', 'add', '--name', 'release-search', '--collection', collection, '--operation', 'search'], { cwd: project, env });
    const searchToken = extractCreatedToken(searchOut.stdout);
    secrets.push(searchToken);
    record('installed CLI created scoped keys (generate x2, search x1)', 'pass', '', CATEGORY.AUTH);

    server = spawn(process.execPath, [cli, 'serve'], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', (chunk) => { serverError = `${serverError}${chunk}`.slice(-4000); });
    const base = `http://127.0.0.1:${port}`;
    await waitForServer(base, server);
    record('installed server became ready', 'pass', '', CATEGORY.PACKAGING);

    const missing = await ask(base, 'v1', null, collection, 'test');
    record('missing bearer rejected', missing.status === 401 ? 'pass' : 'fail', `HTTP ${missing.status}`, CATEGORY.AUTH);
    const invalid = await ask(base, 'v1', 'invalid', collection, 'test');
    record('invalid bearer rejected', invalid.status === 401 ? 'pass' : 'fail', `HTTP ${invalid.status}`, CATEGORY.AUTH);

    const denied = await ask(base, 'v1', limitedToken, otherCollection, 'test');
    record('out-of-scope collection rejected before storage (Ask)', denied.status === 403 ? 'pass' : 'fail', `HTTP ${denied.status}`, CATEGORY.AUTH);
    const limited = await ask(base, 'v1', limitedToken, otherCollection, 'test');
    record('per-key rate limit enforced pre-body', limited.status === 429 ? 'pass' : 'fail', `HTTP ${limited.status}`, CATEGORY.AUTH);

    // SDK Search — through the INSTALLED semidex-lite/client, never raw
    // fetch() or repository source (task requirement C3).
    const { createSemidexClient, SemidexApiError } = await loadInstalledClient(project);
    const searchClient = createSemidexClient({ baseUrl: base, apiKey: searchToken });

    // Out-of-scope rejection FIRST, before the grounded-evidence call —
    // proves the 403 authorization boundary is enforced ahead of any
    // embedding/storage work, the same ordering already proven for Ask above
    // (task requirement C5), now proven for Search specifically.
    const searchDenied = await sdkSearch(searchClient, SemidexApiError, { collection: otherCollection, query: 'test' });
    record(
      'SDK search: out-of-scope collection rejected before storage',
      !searchDenied.ok && searchDenied.status === 403 ? 'pass' : 'fail',
      `status=${searchDenied.status} code=${searchDenied.code ?? 'none'}`,
      CATEGORY.SEARCH,
    );

    const searchOk = await sdkSearch(searchClient, SemidexApiError, { collection, query: 'What is the control number?' });
    // Stable semantic fields only (collection identity, source identity, the
    // known fixture marker) — never a ranking score or generated wording
    // (task requirement C4).
    const groundedResult = searchOk.ok
      && searchOk.result.collection === collection
      && searchOk.result.results.length > 0
      && searchOk.result.results.some((r) => typeof r.sourceFile === 'string' && r.sourceFile.endsWith('fixture.md'))
      && searchOk.result.results.some((r) => (r.text ?? '').includes('314159') || (r.context ?? '').includes('314159'));
    record(
      'SDK search returns grounded fixture evidence',
      groundedResult ? 'pass' : 'fail',
      searchOk.ok
        ? `collection=${searchOk.result.collection} results=${searchOk.result.results.length} sources=${[...new Set(searchOk.result.results.map((r) => r.sourceFile))].join(',')}`
        : `status=${searchOk.status} code=${searchOk.code ?? 'none'} message=${searchOk.message ?? 'none'}`,
      CATEGORY.SEARCH,
    );

    const askRuns = await retryTransientGenerationBatch([
      {
        name: 'v1',
        run: () => ask(base, 'v1', validToken, collection, 'What is the control number?'),
      },
      {
        name: 'v2',
        run: () => ask(base, 'v2', validToken, collection, 'Яке контрольне число в документі?'),
      },
    ]);
    const v1Run = askRuns.v1;
    const v1 = v1Run.result;
    record('Ask v1 returns grounded evidence', v1.status === 200 && v1.summary?.ok && v1.summary.sourceCount > 0 && v1.summary.citations.length > 0 ? 'pass' : 'fail', askSummaryDetail(v1.status, v1.summary, v1Run.attempts), CATEGORY.ASK_V1);
    const v2Run = askRuns.v2;
    const v2 = v2Run.result;
    record('Ask v2 returns grounded evidence', v2.status === 200 && v2.summary?.ok && v2.summary.sourceCount > 0 && v2.summary.citations.length > 0 ? 'pass' : 'fail', askSummaryDetail(v2.status, v2.summary, v2Run.attempts), CATEGORY.ASK_V2);
    if (server.exitCode !== null) throw new Error(`serve exited unexpectedly: ${safe(serverError)}`);
  } catch (error) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const childState = server
      ? `serverExit=${server.exitCode ?? 'running'}; serverSignal=${server.signalCode ?? 'none'}`
      : 'server=not-started';
    const stderrTail = serverError.trim().slice(-1200);
    record(
      'harness completed',
      'fail',
      `${error?.message ?? String(error)}; ${childState}${stderrTail ? `; serverStderr=${stderrTail}` : ''}`,
      CATEGORY.HARNESS,
    );
  } finally {
    await stopChild(server);
    if (collisionConfirmedAbsent) {
      try {
        const current = await qdrantCollection(collection);
        if (shouldDeleteOwnedCollection(collection, { collisionConfirmedAbsent, lookupStatus: current.status })) {
          const deleted = await qdrantCollection(collection, 'DELETE');
          cleanupOk = deleted.ok;
          record('exact-owned collection deleted', deleted.ok ? 'pass' : 'fail', `HTTP ${deleted.status}`, CATEGORY.CLEANUP);
        } else if (current.status === 404) {
          record('exact-owned collection absent at cleanup', 'pass', '', CATEGORY.CLEANUP);
        } else {
          cleanupOk = false;
          record('exact-owned collection cleanup lookup', 'fail', `HTTP ${current.status}`, CATEGORY.CLEANUP);
        }
      } catch (error) {
        cleanupOk = false;
        record('exact-owned collection deleted', 'fail', error?.message ?? String(error), CATEGORY.CLEANUP);
      }
    }
    try { rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { cleanupOk = false; record('temporary install removed', 'fail', error?.message ?? String(error), CATEGORY.CLEANUP); }

    let verdict = computeVerdict(checks, cleanupOk);
    try {
      mkdirSync(dirname(reportPath), { recursive: true });
      const categorySummary = Object.fromEntries(
        Object.values(CATEGORY).map((cat) => [cat, {
          pass: checks.filter((c) => c.category === cat && c.status === 'pass').length,
          fail: checks.filter((c) => c.category === cat && c.status === 'fail').length,
        }]).filter(([, counts]) => counts.pass + counts.fail > 0),
      );
      const report = {
        schemaVersion: 2, timestamp: new Date().toISOString(), collection, checks, categorySummary, cleanupOk, verdict,
      };
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`Report: ${reportPath}`);
    } catch (error) {
      record('JSON report written', 'fail', error?.message ?? String(error), CATEGORY.REPORT);
      verdict = computeVerdict(checks, cleanupOk);
    }
    console.log(verdict);
    process.exitCode = verdict === 'SEMIDEX_LITE_RELEASE_LIVE_ACCEPT' ? 0 : 1;
  }
}

await main();
