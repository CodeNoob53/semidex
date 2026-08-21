import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const LIVE_GUARD = 'SEMIDEX_LITE_RELEASE_LIVE';
export const COLLECTION_PREFIX = 'semidex-lite-release-accept-';
export const TOKEN_RE = /sdx_v1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}/;

export function makeOwnedCollectionName(random = randomBytes) {
  return `${COLLECTION_PREFIX}${random(12).toString('hex')}`;
}

export function assertOwnedCollectionName(name) {
  if (typeof name !== 'string' || !new RegExp(`^${COLLECTION_PREFIX}[a-f0-9]{24}$`).test(name)) {
    throw new Error('Refusing collection operation: name is not owned by this release-acceptance run.');
  }
  return name;
}

export function shouldDeleteOwnedCollection(name, { collisionConfirmedAbsent, lookupStatus }) {
  assertOwnedCollectionName(name);
  return collisionConfirmedAbsent === true && lookupStatus >= 200 && lookupStatus < 300;
}

export function requireLiveOptIn(env = process.env) {
  if (env[LIVE_GUARD] !== '1') {
    return { ok: false, missing: [LIVE_GUARD], reason: `${LIVE_GUARD}=1 is required` };
  }
  const missing = ['QDRANT_URL', 'QDRANT_KEY', 'GEMINI_API_KEY'].filter((key) => !env[key]);
  return missing.length ? { ok: false, missing, reason: 'required credentials are missing' } : { ok: true, missing: [] };
}

export function resolveNpmInvocation(env = process.env, {
  platform = process.platform,
  execPath = process.execPath,
} = {}) {
  if (env.npm_execpath) {
    return { command: execPath, argsPrefix: [env.npm_execpath] };
  }
  if (platform === 'win32') {
    throw new Error('Unable to locate npm-cli.js. Run this harness through `npm run accept:lite-release-live`.');
  }
  return { command: 'npm', argsPrefix: [] };
}

export function findPackedTarball(directory) {
  const tarballs = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
    .map((entry) => join(directory, entry.name));
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one npm tarball in the pack directory; found ${tarballs.length}.`);
  }
  return tarballs[0];
}

export function buildChildEnv(baseEnv, { semidexHome, collection, port }) {
  return {
    ...baseEnv,
    SEMIDEX_HOME: semidexHome,
    COLLECTION: collection,
    ADMIN_HOST: '127.0.0.1',
    ADMIN_PORT: String(port),
    EMBEDDING_BACKEND: 'qdrant-cloud',
    DENSE_PROVIDER: 'qdrant-cloud',
    SPARSE_PROVIDER: 'qdrant-cloud',
    QDRANT_CLOUD_DENSE_MODEL: 'intfloat/multilingual-e5-small',
    QDRANT_SPARSE_MODEL: 'qdrant/bm25',
  };
}

export function extractCreatedToken(stdout) {
  const matches = String(stdout ?? '').match(new RegExp(TOKEN_RE.source, 'g')) ?? [];
  if (matches.length !== 1) throw new Error(`Expected exactly one generated Integration API token; found ${matches.length}.`);
  return matches[0];
}

export function redactSensitive(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(String(secret), '[REDACTED]');
  }
  text = text.replace(new RegExp(TOKEN_RE.source, 'g'), '[REDACTED_TOKEN]');
  text = text.replace(/(api-key|authorization)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]');
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
    try {
      const url = new URL(match);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return match.replace(/\/\/[^\s/@]+:[^\s/@]+@/, '//[REDACTED]@');
    }
  });
}

export function computeVerdict(checks, cleanupOk) {
  const passed = checks.filter((item) => item.status === 'pass').length;
  const failed = checks.filter((item) => item.status === 'fail').length;
  if (!cleanupOk || passed === 0) return 'SEMIDEX_LITE_RELEASE_LIVE_REJECT';
  if (failed > 0) return 'SEMIDEX_LITE_RELEASE_LIVE_PARTIAL';
  return 'SEMIDEX_LITE_RELEASE_LIVE_ACCEPT';
}

export function parseSse(text) {
  const events = [];
  for (const frame of String(text).replaceAll('\r\n', '\n').split('\n\n')) {
    if (!frame.trim()) continue;
    let event = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (!data.length) continue;
    try { events.push({ event, data: JSON.parse(data.join('\n')) }); } catch { events.push({ event: '__parse_error__', data: null }); }
  }
  return events;
}

export function summarizeAskEvents(events) {
  const sources = events.find((item) => item.event === 'sources')?.data?.sources ?? [];
  const done = events.find((item) => item.event === 'done')?.data ?? null;
  const error = events.find((item) => item.event === 'error')?.data ?? null;
  return {
    ok: Boolean(done) && !error,
    donePresent: Boolean(done),
    sourceCount: sources.length,
    citations: done?.citations ?? [],
    refused: Boolean(done?.refused),
    refusalReason: done?.refusalReason ?? null,
    answerChars: typeof done?.answer === 'string' ? done.answer.length : 0,
    evidenceCount: Number.isInteger(done?.evidenceCount) ? done.evidenceCount : null,
    provider: typeof done?.provider === 'string' ? done.provider : null,
    model: typeof done?.model === 'string' ? done.model : null,
    errorCode: error?.code ?? null,
    errorMessage: typeof error?.message === 'string' ? error.message : null,
  };
}

export function summarizePartialSse(text) {
  const eventNames = [];
  const normalized = String(text ?? '').replaceAll('\r\n', '\n');
  for (const match of normalized.matchAll(/^event:\s*([^\n]+)$/gm)) {
    const name = match[1].trim();
    if (name && !eventNames.includes(name)) eventNames.push(name);
  }
  return { eventNames };
}

export function isTransientGenerationFailure(summary) {
  if (summary?.errorCode !== 'generation_failed') return false;
  const message = String(summary.errorMessage ?? '');
  return /(?:\b503\b|service unavailable|\bunavailable\b|high demand)/i.test(message);
}

export async function retryTransientGeneration(operation, {
  delaysMs = [5_000, 15_000],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let result = await operation();
  let attempts = 1;
  for (const delayMs of delaysMs) {
    if (!isTransientGenerationFailure(result?.summary)) break;
    await sleep(delayMs);
    result = await operation();
    attempts += 1;
  }
  return { result, attempts };
}

export async function retryTransientGenerationBatch(operations, {
  delaysMs = [5_000, 15_000],
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const entries = operations.map(({ name, run }) => ({ name, run, result: null, attempts: 0 }));

  for (const entry of entries) {
    entry.result = await entry.run();
    entry.attempts += 1;
  }

  for (const delayMs of delaysMs) {
    const pending = entries.filter((entry) => isTransientGenerationFailure(entry.result?.summary));
    if (!pending.length) break;
    await sleep(delayMs);
    for (const entry of pending) {
      entry.result = await entry.run();
      entry.attempts += 1;
    }
  }

  return Object.fromEntries(entries.map(({ name, result, attempts }) => [name, { result, attempts }]));
}
