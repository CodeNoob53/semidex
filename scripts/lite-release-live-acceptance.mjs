#!/usr/bin/env node
// Opt-in release acceptance for the ACTUAL packed Semidex Lite artifact.
// Never include this script in npm test/smoke/CI: it installs packages,
// calls Qdrant Cloud and Gemini, and creates one exact-owned collection.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const record = (name, status, detail = '') => {
  checks.push({ name, status, ...(detail ? { detail: safe(detail) } : {}) });
  console.log(`${status === 'pass' ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${safe(detail)}` : ''}`);
};

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
    record('exact-owned collection is absent', 'pass');

    run(npmInvocation.command, [...npmInvocation.argsPrefix, 'pack', join(root, 'packages', 'lite'), '--pack-destination', work], { cwd: root });
    const tarball = findPackedTarball(work);
    if (!existsSync(tarball)) throw new Error('npm pack did not produce the expected tarball');
    run(npmInvocation.command, [...npmInvocation.argsPrefix, 'install', '--no-audit', '--no-fund', tarball], { cwd: project });
    const cli = join(project, 'node_modules', 'semidex-lite', 'bin', 'semidex-lite.js');
    if (!existsSync(cli)) throw new Error('clean-installed semidex-lite CLI is missing');
    record('pack and clean install', 'pass');

    const port = await freePort();
    const env = buildChildEnv(process.env, { semidexHome: home, collection, port });
    run(process.execPath, [cli, 'doctor', '--probe-inference'], { cwd: project, env });
    record('installed doctor cloud inference probe', 'pass');
    run(process.execPath, [cli, 'index', fixture], { cwd: project, env });
    record('installed CLI indexed fixture', 'pass');

    const validOut = run(process.execPath, [cli, 'key', 'add', '--name', 'release-valid', '--collection', collection], { cwd: project, env });
    const validToken = extractCreatedToken(validOut.stdout);
    secrets.push(validToken);
    const limitedOut = run(process.execPath, [cli, 'key', 'add', '--name', 'release-limited', '--collection', collection, '--requests-per-minute', '1', '--burst', '1'], { cwd: project, env });
    const limitedToken = extractCreatedToken(limitedOut.stdout);
    secrets.push(limitedToken);
    record('installed CLI created scoped keys', 'pass');

    server = spawn(process.execPath, [cli, 'serve'], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', (chunk) => { serverError = `${serverError}${chunk}`.slice(-4000); });
    const base = `http://127.0.0.1:${port}`;
    await waitForServer(base, server);
    record('installed server became ready', 'pass');

    const missing = await ask(base, 'v1', null, collection, 'test');
    record('missing bearer rejected', missing.status === 401 ? 'pass' : 'fail', `HTTP ${missing.status}`);
    const invalid = await ask(base, 'v1', 'invalid', collection, 'test');
    record('invalid bearer rejected', invalid.status === 401 ? 'pass' : 'fail', `HTTP ${invalid.status}`);

    const denied = await ask(base, 'v1', limitedToken, otherCollection, 'test');
    record('out-of-scope collection rejected before storage', denied.status === 403 ? 'pass' : 'fail', `HTTP ${denied.status}`);
    const limited = await ask(base, 'v1', limitedToken, otherCollection, 'test');
    record('per-key rate limit enforced pre-body', limited.status === 429 ? 'pass' : 'fail', `HTTP ${limited.status}`);

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
    record('Ask v1 returns grounded evidence', v1.status === 200 && v1.summary?.ok && v1.summary.sourceCount > 0 && v1.summary.citations.length > 0 ? 'pass' : 'fail', askSummaryDetail(v1.status, v1.summary, v1Run.attempts));
    const v2Run = askRuns.v2;
    const v2 = v2Run.result;
    record('Ask v2 returns grounded evidence', v2.status === 200 && v2.summary?.ok && v2.summary.sourceCount > 0 && v2.summary.citations.length > 0 ? 'pass' : 'fail', askSummaryDetail(v2.status, v2.summary, v2Run.attempts));
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
    );
  } finally {
    await stopChild(server);
    if (collisionConfirmedAbsent) {
      try {
        const current = await qdrantCollection(collection);
        if (shouldDeleteOwnedCollection(collection, { collisionConfirmedAbsent, lookupStatus: current.status })) {
          const deleted = await qdrantCollection(collection, 'DELETE');
          cleanupOk = deleted.ok;
          record('exact-owned collection deleted', deleted.ok ? 'pass' : 'fail', `HTTP ${deleted.status}`);
        } else if (current.status === 404) {
          record('exact-owned collection absent at cleanup', 'pass');
        } else {
          cleanupOk = false;
          record('exact-owned collection cleanup lookup', 'fail', `HTTP ${current.status}`);
        }
      } catch (error) {
        cleanupOk = false;
        record('exact-owned collection deleted', 'fail', error?.message ?? String(error));
      }
    }
    try { rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { cleanupOk = false; record('temporary install removed', 'fail', error?.message ?? String(error)); }

    let verdict = computeVerdict(checks, cleanupOk);
    try {
      mkdirSync(dirname(reportPath), { recursive: true });
      const report = { schemaVersion: 1, timestamp: new Date().toISOString(), collection, checks, cleanupOk, verdict };
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`Report: ${reportPath}`);
    } catch (error) {
      record('JSON report written', 'fail', error?.message ?? String(error));
      verdict = computeVerdict(checks, cleanupOk);
    }
    console.log(verdict);
    process.exitCode = verdict === 'SEMIDEX_LITE_RELEASE_LIVE_ACCEPT' ? 0 : 1;
  }
}

await main();
