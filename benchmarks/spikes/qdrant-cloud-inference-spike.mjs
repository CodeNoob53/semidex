// Qdrant Cloud Inference capability/compatibility spike for semidex Lite.
//
// This is NOT a production integration, NOT a provider abstraction, and NOT a
// retrieval quality benchmark. It verifies that the API contract the two
// research docs describe actually works against a real cluster through the
// installed @qdrant/js-client-rest:
//   - hosted dense inference (upsert/query by { text, model })
//   - server-side qdrant/bm25 with modifier:idf and text-processing options
//   - dense-only / sparse-only / hybrid Query API
//   - RRF k=2, semidex's k=60, and weighted RRF
//   - update, delete, re-query after wait:true
//   - Ukrainian + identifier-heavy retrieval
//   - latency, sanitized errors, and guaranteed temporary-collection cleanup
//
// It changes no production code, no defaults, and no .env. It reads QDRANT_URL
// and QDRANT_KEY through semidex's own env bootstrap, and reuses semidex's
// pure redaction helpers (not a provider abstraction) so no secret can reach
// stdout or the report. Dense config comes ONLY from QDRANT_SPIKE_DENSE_MODEL
// and QDRANT_SPIKE_DENSE_SIZE — never guessed. If they are absent the dense
// and hybrid parts are skipped and the BM25/sparse parts run standalone.
//
// Run:  node benchmarks/spikes/qdrant-cloud-inference-spike.mjs
// Do not run two copies concurrently (they would create two live collections).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { bootstrapEnv } from '../../src/shared/core/env-bootstrap.js';
import { sanitiseErrorMessage } from '../../src/shared/core/doctor-checks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURE_PATH = resolve(REPO_ROOT, 'benchmarks/fixtures/qdrant-cloud-inference-spike.json');
const RESULTS_DIR = resolve(REPO_ROOT, 'benchmarks/results');
const SUMMARY_JSON_PATH = resolve(RESULTS_DIR, '2026-07-21-qdrant-cloud-inference-live-spike.summary.json');

const COLLECTION_PREFIX = 'semidex-lite-spike-';
const TOP = 5;
const PREFETCH_LIMIT = 10;
const BM25_MODEL = 'qdrant/bm25';

// Language-neutral BM25 text-processing options (the primary Ukrainian
// candidate from the research). Kept IDENTICAL between index and query — a
// mismatch would silently change tokenization and invalidate the lane.
const BM25_OPTIONS = Object.freeze({
  multilingual: { language: 'none', tokenizer: 'multilingual', ascii_folding: true },
  word: { language: 'none', tokenizer: 'word', ascii_folding: true },
  whitespace: { language: 'none', tokenizer: 'whitespace', ascii_folding: true },
});

// Fixed prefetch lane order for every hybrid query — dense first, then
// bm25_multilingual. Weighted-RRF weights map positionally to THIS order, so
// pinning it here prevents weights from being silently transposed.
const HYBRID_LANE_ORDER = Object.freeze(['dense', 'bm25_multilingual']);

// ── redaction ────────────────────────────────────────────────────────────────
// One choke point: everything that could reach stdout or the report passes
// through here. Redacts the Qdrant key, URL userinfo/query strings, and common
// auth-header shapes. Never serialize the client or a raw request object.
function makeRedactor(secret) {
  const authHeaderRe = /("?(?:authorization|api[-_]?key|x-api-key)"?\s*[:=]\s*)("?)([^"\s,}]+)(\2)/gi;
  return (value) => {
    let text = value instanceof Error ? (value.stack || value.message || String(value)) : String(value ?? '');
    text = sanitiseErrorMessage(text, secret); // literal key + credentialed/query URLs -> host-only
    text = text.replace(authHeaderRe, (_m, pre, q) => `${pre}${q}[REDACTED]${q}`);
    return text;
  };
}

// ── endpoint masking ─────────────────────────────────────────────────────────
// redactUrl() keeps protocol+host, but for a Qdrant Cloud URL the host IS the
// account-identifying part (the leading UUID label is the cluster ID). The task
// forbids storing account-specific data, so the report/summary must NOT carry
// the raw hostname. This extracts only non-identifying facts — that a URL is
// configured, its scheme, the cloud provider/region if the hostname matches the
// documented `<cluster-id>.<region>.<provider>.cloud.qdrant.io` shape, and a
// masked host with the cluster-ID label replaced. It never returns the raw
// cluster ID.
function describeEndpoint(raw) {
  if (!raw) return { configured: false };
  let host;
  try { host = new URL(raw).host; } catch { return { configured: true, scheme: null, provider: null, region: null, maskedHost: '(invalid URL)' }; }
  const bare = host.split(':')[0];
  const labels = bare.split('.');
  // Qdrant Cloud: <cluster-id>.<region-with-index>.<provider>.cloud.qdrant.io
  const isQdrantCloud = bare.endsWith('.cloud.qdrant.io') && labels.length >= 5;
  let provider = null;
  let region = null;
  if (isQdrantCloud) {
    // labels: [clusterId, region, provider, 'cloud', 'qdrant', 'io']
    region = labels[1] ?? null;   // e.g. eu-central-1-0
    provider = labels[2] ?? null; // e.g. aws
  }
  // Mask the first label (cluster ID) entirely; keep the rest of the domain.
  const maskedHost = labels.length > 1 ? ['<cluster-id>', ...labels.slice(1)].join('.') : '<cluster-id>';
  let scheme = null;
  try { scheme = new URL(raw).protocol.replace(':', ''); } catch { /* leave null */ }
  return { configured: true, scheme, provider, region, maskedHost };
}

// ── small helpers ──────────────────────────────────────────────────────────────
async function timed(fn) {
  const start = process.hrtime.bigint();
  try {
    const value = await fn();
    return { ok: true, value, ms: Number((process.hrtime.bigint() - start) / 1000000n) };
  } catch (err) {
    return { ok: false, err, ms: Number((process.hrtime.bigint() - start) / 1000000n) };
  }
}

function buildClient() {
  const url = process.env.QDRANT_URL;
  if (!url) throw new Error('QDRANT_URL is not set. Add it to your .env file.');
  const apiKey = process.env.QDRANT_KEY || undefined;
  // Mirror src/core/qdrant/client.js's url/port/prefix parsing so a
  // path-prefixed cluster URL works identically to production, without
  // importing production client construction.
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : null;
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  const prefix = trimmedPath !== '' ? trimmedPath : undefined;
  parsed.pathname = '/';
  const strippedUrl = parsed.toString().replace(/\/$/, '') || parsed.toString();
  return new QdrantClient({ url: strippedUrl, apiKey, port, prefix, timeout: 30000, checkCompatibility: false });
}

function uniqueCollectionName() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(4).toString('hex');
  return `${COLLECTION_PREFIX}${ts}-${suffix}`;
}

// ── retrieval scoring ──────────────────────────────────────────────────────────
function pointIdsFrom(queryResult) {
  const points = queryResult?.points ?? [];
  return points.map((p) => p.id);
}

function rankOf(ids, expectedId) {
  const idx = ids.findIndex((id) => id === expectedId);
  return idx === -1 ? null : idx + 1; // 1-based; null = not in top-k
}

function scoreMode(perQuery) {
  // Recall@5 = fraction of queries whose expected doc appears in top-5.
  const hits = perQuery.filter((q) => q.ran && q.rank !== null).length;
  const ran = perQuery.filter((q) => q.ran).length;
  return { ran, hits, recallAt5: ran > 0 ? hits / ran : null };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  bootstrapEnv();
  const redact = makeRedactor(process.env.QDRANT_KEY);

  const denseModel = process.env.QDRANT_SPIKE_DENSE_MODEL || null;
  const denseSizeRaw = process.env.QDRANT_SPIKE_DENSE_SIZE || null;
  const denseSize = denseSizeRaw !== null ? Number(denseSizeRaw) : null;
  const denseEnabled = Boolean(denseModel) && Number.isInteger(denseSize) && denseSize > 0;

  if ((denseModel || denseSizeRaw) && !denseEnabled) {
    throw new Error(
      'QDRANT_SPIKE_DENSE_MODEL and QDRANT_SPIKE_DENSE_SIZE must BOTH be set, with a positive integer size. '
      + `Got model=${denseModel ? 'set' : 'unset'}, size=${JSON.stringify(denseSizeRaw)}. Refusing to guess dense config.`
    );
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
  const client = buildClient();
  const collection = uniqueCollectionName();

  const summary = {
    startedAt: new Date().toISOString(),
    queryCount: fixture.queries.length,
    environment: {
      // Account-anonymous: no raw cluster hostname, no key length. Only
      // whether a URL/key is configured, the provider/region if derivable,
      // and a masked host with the cluster-ID label removed.
      qdrantEndpoint: describeEndpoint(process.env.QDRANT_URL),
      qdrantKeyConfigured: Boolean(process.env.QDRANT_KEY),
      sdkVersion: null,
      serverVersion: null,
      denseModel: denseEnabled ? denseModel : null,
      denseSize: denseEnabled ? denseSize : null,
      denseEnabled,
      collection,
      top: TOP,
      prefetchLimit: PREFETCH_LIMIT,
      hybridLaneOrder: [...HYBRID_LANE_ORDER],
    },
    capabilities: {},   // step -> { ok, ms, error? }
    bm25Options: {},    // laneOptionName -> { supported, error? }
    modes: {},          // modeName -> { perQuery:[...], score:{...}, error? }
    lifecycle: {},      // update/delete/requery -> { ok, ms, error? }
    latency: [],        // { step, ms }
    errors: [],
    cleanup: { attempted: false, deleted: false, collection, error: null },
    verdict: null,
  };

  const record = (step, r) => {
    summary.capabilities[step] = { ok: r.ok, ms: r.ms, error: r.ok ? null : redact(r.err) };
    summary.latency.push({ step, ms: r.ms });
    if (!r.ok) summary.errors.push({ step, error: redact(r.err) });
    return r;
  };

  // SDK version (best-effort; never fatal).
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'node_modules/@qdrant/js-client-rest/package.json'), 'utf-8'));
    summary.environment.sdkVersion = pkg.version;
  } catch { /* leave null */ }

  let cleanupOk = false;
  try {
    // ── cluster reachability + server version ─────────────────────────────
    const rootProbe = await timed(() => client.api('service').root());
    record('service_root', rootProbe);
    if (rootProbe.ok) {
      summary.environment.serverVersion = rootProbe.value?.data?.version ?? rootProbe.value?.version ?? null;
    }

    // ── build vector schema ───────────────────────────────────────────────
    // Dense (only if config supplied) + three independent BM25 sparse lanes,
    // each modifier:idf. Sparse lanes are configured together; the actual
    // per-lane text-processing option is applied at UPSERT/QUERY time (that is
    // where qdrant/bm25 reads it), so a lane whose options the cluster rejects
    // fails at write/query time, not at collection creation.
    const vectors = denseEnabled ? { dense: { size: denseSize, distance: 'Cosine' } } : {};
    const sparse_vectors = {
      bm25_multilingual: { modifier: 'idf' },
      bm25_word: { modifier: 'idf' },
      bm25_whitespace: { modifier: 'idf' },
    };
    const createRes = await timed(() => client.createCollection(collection, { vectors, sparse_vectors }));
    record('create_collection', createRes);
    if (!createRes.ok) {
      summary.verdict = denseEnabled ? 'QDRANT_CLOUD_INFERENCE_SPIKE_BLOCKED' : 'QDRANT_CLOUD_INFERENCE_SPIKE_BLOCKED';
      throw new Error('Collection creation failed — cannot proceed. See recorded error.');
    }

    // ── per-lane capability probe (one throwaway point PER LANE) ──────────
    // Qdrant's upsert REPLACES a point's entire named-vector set — a second
    // upsert of the same ID carrying only one named vector DROPS the others
    // (verified directly during this spike). So we cannot write one lane per
    // pass over the same IDs. Instead: (1) probe EACH lane on its OWN
    // throwaway point ID, so a failure isolates exactly which lane/options
    // the cluster rejected (dense and bm25_multilingual get separate probes —
    // sharing one probe would hide which of the two broke); then (2) write
    // every corpus point ONCE carrying all supported vectors together. All
    // probe points are deleted before the real corpus is written.
    const docs = fixture.documents;
    const probeText = 'QDRANT_URL налаштування сервера — probe';
    const PROBE_IDS = { dense: 999001, bm25_multilingual: 999002, bm25_word: 999003, bm25_whitespace: 999004 };

    async function probeDense() {
      if (!denseEnabled) return { ok: false, ms: 0, err: new Error('dense disabled (no QDRANT_SPIKE_DENSE_MODEL/SIZE)') };
      return timed(() => client.upsert(collection, {
        wait: true,
        points: [{ id: PROBE_IDS.dense, payload: { probe: 'dense' }, vector: { dense: { text: probeText, model: denseModel } } }],
      }));
    }
    async function probeSparse(sparseVectorName, options) {
      return timed(() => client.upsert(collection, {
        wait: true,
        points: [{ id: PROBE_IDS[sparseVectorName], payload: { probe: sparseVectorName }, vector: { [sparseVectorName]: { text: probeText, model: BM25_MODEL, options } } }],
      }));
    }

    // Dense on its OWN probe point — isolated from every BM25 lane.
    const probeDenseRes = await probeDense();
    if (denseEnabled) record('probe_dense', probeDenseRes);

    const probeMulti = await probeSparse('bm25_multilingual', BM25_OPTIONS.multilingual);
    record('probe_bm25_multilingual', probeMulti);
    summary.bm25Options.multilingual = { supported: probeMulti.ok, error: probeMulti.ok ? null : redact(probeMulti.err) };

    const probeWord = await probeSparse('bm25_word', BM25_OPTIONS.word);
    record('probe_bm25_word', probeWord);
    summary.bm25Options.word = { supported: probeWord.ok, error: probeWord.ok ? null : redact(probeWord.err) };

    const probeWs = await probeSparse('bm25_whitespace', BM25_OPTIONS.whitespace);
    record('probe_bm25_whitespace', probeWs);
    summary.bm25Options.whitespace = { supported: probeWs.ok, error: probeWs.ok ? null : redact(probeWs.err) };

    // Remove all probe points so they never pollute retrieval scoring.
    record('delete_probe_points', await timed(() => client.delete(collection, { wait: true, points: Object.values(PROBE_IDS) })));

    const laneReady = {
      dense: denseEnabled && probeDenseRes.ok,
      bm25_multilingual: probeMulti.ok,
      bm25_word: probeWord.ok,
      bm25_whitespace: probeWs.ok,
    };

    // ── real corpus write: every point carries ALL supported vectors once ─
    // Builds the named-vector map for a point from its text, using only the
    // lanes that passed their probe. Every write (corpus, lifecycle update)
    // goes through this — so a rewritten point never accidentally drops a
    // vector, the pitfall this spike proved.
    const buildVector = (text) => {
      const vector = {};
      if (laneReady.dense) vector.dense = { text, model: denseModel };
      if (laneReady.bm25_multilingual) vector.bm25_multilingual = { text, model: BM25_MODEL, options: BM25_OPTIONS.multilingual };
      if (laneReady.bm25_word) vector.bm25_word = { text, model: BM25_MODEL, options: BM25_OPTIONS.word };
      if (laneReady.bm25_whitespace) vector.bm25_whitespace = { text, model: BM25_MODEL, options: BM25_OPTIONS.whitespace };
      return vector;
    };
    const corpusPoints = docs.map((doc) => ({
      id: doc.id,
      payload: { text: doc.text, lang: doc.lang, kind: doc.kind },
      vector: buildVector(doc.text),
    }));
    const corpusWrite = await timed(() => client.upsert(collection, { wait: true, points: corpusPoints }));
    record('upsert_corpus_all_lanes', corpusWrite);
    if (!corpusWrite.ok) {
      // If the combined write fails, no retrieval mode can run.
      for (const k of Object.keys(laneReady)) laneReady[k] = false;
    }

    // ── query builders ────────────────────────────────────────────────────
    const denseQuery = (text) => ({
      query: { text, model: denseModel }, using: 'dense',
      limit: TOP, with_payload: false,
    });
    const bm25Query = (text, sparseVectorName, options) => ({
      query: { text, model: BM25_MODEL, options }, using: sparseVectorName,
      limit: TOP, with_payload: false,
    });
    // Hybrid: prefetch dense + bm25_multilingual (fixed order), fuse with RRF.
    const hybridQuery = (text, rrf) => ({
      prefetch: [
        { query: { text, model: denseModel }, using: 'dense', limit: PREFETCH_LIMIT },
        { query: { text, model: BM25_MODEL, options: BM25_OPTIONS.multilingual }, using: 'bm25_multilingual', limit: PREFETCH_LIMIT },
      ],
      query: rrf,
      limit: TOP, with_payload: false,
    });

    // ── run a mode across all queries ─────────────────────────────────────
    async function runMode(modeName, ready, buildParams) {
      if (!ready) {
        summary.modes[modeName] = { skipped: true, reason: 'lane not ready (upsert failed or dense disabled)', perQuery: [], score: null };
        return;
      }
      const perQuery = [];
      for (const q of fixture.queries) {
        const r = await timed(() => client.query(collection, buildParams(q.text)));
        summary.latency.push({ step: `${modeName}:${q.id}`, ms: r.ms });
        if (!r.ok) {
          perQuery.push({ queryId: q.id, expected: q.expected, ran: false, rank: null, topIds: [], topScore: null, ms: r.ms, error: redact(r.err) });
          summary.errors.push({ step: `${modeName}:${q.id}`, error: redact(r.err) });
          continue;
        }
        const ids = pointIdsFrom(r.value);
        const topScore = r.value?.points?.[0]?.score ?? null;
        perQuery.push({ queryId: q.id, expected: q.expected, ran: true, rank: rankOf(ids, q.expected), topIds: ids, topScore, ms: r.ms, error: null });
      }
      summary.modes[modeName] = { perQuery, score: scoreMode(perQuery) };
    }

    // Single-lane modes.
    await runMode('dense_only', laneReady.dense, (text) => denseQuery(text));
    await runMode('bm25_multilingual_only', laneReady.bm25_multilingual, (text) => bm25Query(text, 'bm25_multilingual', BM25_OPTIONS.multilingual));
    await runMode('bm25_word_only', laneReady.bm25_word, (text) => bm25Query(text, 'bm25_word', BM25_OPTIONS.word));
    await runMode('bm25_whitespace_only', laneReady.bm25_whitespace, (text) => bm25Query(text, 'bm25_whitespace', BM25_OPTIONS.whitespace));

    // Hybrid modes (need dense + bm25_multilingual both ready).
    const hybridReady = laneReady.dense && laneReady.bm25_multilingual;
    await runMode('hybrid_rrf_k2', hybridReady, (text) => hybridQuery(text, { rrf: { k: 2 } }));
    await runMode('hybrid_rrf_k60', hybridReady, (text) => hybridQuery(text, { rrf: { k: 60 } }));
    // Weighted RRF: weights positional to HYBRID_LANE_ORDER (dense, bm25).
    await runMode('hybrid_rrf_weighted_1_1', hybridReady, (text) => hybridQuery(text, { rrf: { weights: [1, 1] } }));
    await runMode('hybrid_rrf_weighted_1_2', hybridReady, (text) => hybridQuery(text, { rrf: { weights: [1, 2] } }));

    // ── lifecycle: genuine update + delete with unique sentinel tokens ────
    // Every check queries a token that appears in EXACTLY ONE fixture point
    // and does before/after presence assertions, so a pass proves the
    // operation actually changed state (the earlier version updated a doc
    // with a token it already had, and deleted a doc unrelated to the search
    // term — neither proved anything).
    const lc = fixture.lifecycle;
    if (laneReady.bm25_multilingual && lc) {
      const tokenQuery = (token) => timed(() => client.query(collection, bm25Query(token, 'bm25_multilingual', BM25_OPTIONS.multilingual)));
      const idsOf = (r) => (r.ok ? pointIdsFrom(r.value) : []);

      // DELETE: doc 101 uniquely contains lc.deleteToken.
      const delBefore = await tokenQuery(lc.deleteToken);
      const delPresentBefore = idsOf(delBefore).includes(lc.deleteId);
      const del = await timed(() => client.delete(collection, { wait: true, points: [lc.deleteId] }));
      const delAfter = await tokenQuery(lc.deleteToken);
      const delPresentAfter = idsOf(delAfter).includes(lc.deleteId);
      summary.lifecycle.delete = {
        ok: del.ok, ms: del.ms, error: del.ok ? null : redact(del.err),
        token: lc.deleteToken, targetId: lc.deleteId,
        presentBefore: delPresentBefore, presentAfter: delPresentAfter,
        verified: del.ok && delBefore.ok && delAfter.ok && delPresentBefore === true && delPresentAfter === false,
      };

      // UPDATE: doc 102 uniquely contains updateTokenBefore; after update it
      // must contain updateTokenAfter and NO LONGER match updateTokenBefore.
      const updBeforeQ = await tokenQuery(lc.updateTokenBefore);
      const updAfterQ_before = await tokenQuery(lc.updateTokenAfter); // should be empty before update
      const upd = await timed(() => client.upsert(collection, {
        wait: true,
        points: [{ id: lc.updateId, payload: { text: lc.updateTextAfter, kind: 'updated' }, vector: buildVector(lc.updateTextAfter) }],
      }));
      const updBeforeQ_after = await tokenQuery(lc.updateTokenBefore); // should be empty after update
      const updAfterQ_after = await tokenQuery(lc.updateTokenAfter);   // should now include updateId
      summary.lifecycle.update = {
        ok: upd.ok, ms: upd.ms, error: upd.ok ? null : redact(upd.err),
        targetId: lc.updateId, tokenBefore: lc.updateTokenBefore, tokenAfter: lc.updateTokenAfter,
        beforeToken_matchedBefore: idsOf(updBeforeQ).includes(lc.updateId),
        afterToken_matchedBefore: idsOf(updAfterQ_before).includes(lc.updateId),
        beforeToken_matchedAfter: idsOf(updBeforeQ_after).includes(lc.updateId),
        afterToken_matchedAfter: idsOf(updAfterQ_after).includes(lc.updateId),
        verified: upd.ok
          && idsOf(updBeforeQ).includes(lc.updateId) === true      // old token matched before
          && idsOf(updAfterQ_before).includes(lc.updateId) === false // new token absent before
          && idsOf(updBeforeQ_after).includes(lc.updateId) === false // old token gone after
          && idsOf(updAfterQ_after).includes(lc.updateId) === true,   // new token matches after
      };

      // IDF-shift measurement (only if the fixture defines the shared-token
      // probe). A term shared by three docs is queried before and after
      // deleting one of them; we record the SURVIVING docs' top BM25 score in
      // both states. BM25's IDF term rises as document frequency falls, so
      // this captures whether corpus statistics actually recomputed after a
      // delete — as MEASURED numbers, not an assertion. We compare the score
      // of a surviving doc that is present in both queries (same doc, same
      // query, only the corpus DF changed).
      if (lc.idfSharedToken && Array.isArray(lc.idfSharedIds) && lc.idfDeleteVictimId != null) {
        const survivorId = lc.idfSharedIds.find((id) => id !== lc.idfDeleteVictimId);
        const scoreForId = (r, id) => {
          const pts = r.ok ? (r.value?.points ?? []) : [];
          const hit = pts.find((p) => p.id === id);
          return hit ? hit.score : null;
        };
        const idfBefore = await tokenQuery(lc.idfSharedToken);
        const survivorScoreBefore = scoreForId(idfBefore, survivorId);
        const dfBefore = idsOf(idfBefore).length;
        const idfDel = await timed(() => client.delete(collection, { wait: true, points: [lc.idfDeleteVictimId] }));
        const idfAfter = await tokenQuery(lc.idfSharedToken);
        const survivorScoreAfter = scoreForId(idfAfter, survivorId);
        const dfAfter = idsOf(idfAfter).length;
        summary.lifecycle.idf_shift = {
          token: lc.idfSharedToken,
          survivorId,
          deletedId: lc.idfDeleteVictimId,
          deleteOk: idfDel.ok,
          docFreqBefore: dfBefore,
          docFreqAfter: dfAfter,
          survivorScoreBefore,
          survivorScoreAfter,
          // Report only what is measured: did the same surviving doc's score
          // for the same query change after one co-occurring doc was deleted?
          scoreChanged: survivorScoreBefore != null && survivorScoreAfter != null
            && survivorScoreBefore !== survivorScoreAfter,
          scoreDelta: (survivorScoreBefore != null && survivorScoreAfter != null)
            ? survivorScoreAfter - survivorScoreBefore : null,
          error: idfDel.ok ? null : redact(idfDel.err),
        };
      }

      // Re-query after wait:true — a plain retrieval that must still be
      // consistent (deleted sentinel absent, updated sentinel present under
      // its new token).
      const requery = await tokenQuery(lc.deleteToken);
      summary.lifecycle.requery_after_wait = requery.ok
        ? { ok: true, ms: requery.ms, deletedTokenStillMatches: idsOf(requery).includes(lc.deleteId) }
        : { ok: false, ms: requery.ms, error: redact(requery.err) };
    } else {
      summary.lifecycle.note = 'lifecycle checks skipped — bm25_multilingual lane not ready or no lifecycle config in fixture';
    }
  } catch (err) {
    summary.errors.push({ step: 'fatal', error: redact(err) });
  } finally {
    // ── cleanup: delete ONLY this exact spike collection ──────────────────
    summary.cleanup.attempted = true;
    if (!collection.startsWith(COLLECTION_PREFIX)) {
      // Defensive: should be impossible, but never delete a non-spike name.
      summary.cleanup.error = `Refusing to delete: name does not start with ${COLLECTION_PREFIX}`;
    } else {
      const del = await timed(() => client.deleteCollection(collection));
      summary.cleanup.deleted = del.ok;
      cleanupOk = del.ok;
      if (!del.ok) summary.cleanup.error = redact(del.err);
    }
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  summary.finishedAt = new Date().toISOString();
  if (!summary.verdict) summary.verdict = computeVerdict(summary);

  // ── persist machine-readable summary (redacted only) ──────────────────────
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(SUMMARY_JSON_PATH, JSON.stringify(summary, null, 2) + '\n', 'utf-8');

  // ── console: redacted, compact ────────────────────────────────────────────
  console.log('── Qdrant Cloud Inference spike ───────────────────────────────');
  console.log('collection      :', summary.environment.collection);
  const ep = summary.environment.qdrantEndpoint;
  console.log('qdrant endpoint :', ep.configured ? `${ep.provider ?? 'unknown-provider'} / ${ep.region ?? 'unknown-region'} (${ep.maskedHost})` : 'not configured');
  console.log('qdrant key      :', summary.environment.qdrantKeyConfigured ? 'configured' : 'not configured');
  console.log('sdk / server    :', summary.environment.sdkVersion, '/', summary.environment.serverVersion);
  console.log('dense enabled   :', summary.environment.denseEnabled, summary.environment.denseEnabled ? `(size ${summary.environment.denseSize})` : '(no dense config supplied)');
  console.log('bm25 options    :', Object.entries(summary.bm25Options).map(([k, v]) => `${k}=${v.supported ? 'ok' : 'unsupported'}`).join(', ') || '(none run)');
  for (const [mode, data] of Object.entries(summary.modes)) {
    if (data.skipped) { console.log(`mode ${mode.padEnd(26)}: skipped (${data.reason})`); continue; }
    const s = data.score;
    console.log(`mode ${mode.padEnd(26)}: Recall@5 ${s.hits}/${s.ran}` + (s.recallAt5 !== null ? ` (${(s.recallAt5 * 100).toFixed(0)}%)` : ''));
  }
  const lcU = summary.lifecycle.update; const lcD = summary.lifecycle.delete;
  console.log('lifecycle       :', `delete ${lcD ? (lcD.verified ? 'verified' : 'NOT verified') : 'skipped'}, update ${lcU ? (lcU.verified ? 'verified' : 'NOT verified') : 'skipped'}`);
  console.log('cleanup         :', summary.cleanup.deleted ? 'deleted' : `NOT deleted — ${summary.cleanup.error ?? 'unknown'}`);
  console.log('verdict         :', summary.verdict);
  console.log('summary json    :', SUMMARY_JSON_PATH.replace(REPO_ROOT, '.'));

  // ── cleanup contract: if cleanup failed, exit failure and name the collection.
  if (!cleanupOk) {
    console.error('');
    console.error('!! CLEANUP FAILED — the temporary collection may still exist:');
    console.error('!!   ' + summary.cleanup.collection);
    console.error('!! Delete it manually from the Qdrant Cloud Console, then re-run.');
    process.exitCode = 1;
  }
}

function computeVerdict(summary) {
  const expectedQueryCount = summary.queryCount ?? 0;

  const createdOk = summary.capabilities.create_collection?.ok;
  if (!createdOk) return 'QDRANT_CLOUD_INFERENCE_SPIKE_BLOCKED';

  // A mode "fully ran" only if it was not skipped AND every configured query
  // executed without error (ran === total). `ran > 0` was too weak — a mode
  // where 9/10 queries errored would have passed it.
  const fullyRan = (modeName) => {
    const m = summary.modes[modeName];
    if (!m || m.skipped) return false;
    return (m.score?.ran ?? 0) === expectedQueryCount && expectedQueryCount > 0;
  };

  const bm25Ok = summary.bm25Options.multilingual?.supported === true;
  const denseWanted = summary.environment.denseEnabled;
  const denseOk = fullyRan('dense_only');
  const bm25MlOk = fullyRan('bm25_multilingual_only');
  const hybridK2Ok = fullyRan('hybrid_rrf_k2');
  const hybridK60Ok = fullyRan('hybrid_rrf_k60');
  const weightedOk = fullyRan('hybrid_rrf_weighted_1_1') && fullyRan('hybrid_rrf_weighted_1_2');
  const updateVerified = summary.lifecycle.update?.verified === true;
  const deleteVerified = summary.lifecycle.delete?.verified === true;
  // requeryOk must assert the actual post-delete state, not just that the
  // query call itself succeeded — a query that "succeeded" but still
  // returned the deleted sentinel would be a real consistency failure, and
  // requery.ok===true alone would have missed it (code review finding).
  const requeryOk = summary.lifecycle.requery_after_wait?.ok === true
    && summary.lifecycle.requery_after_wait?.deletedTokenStillMatches === false;
  const noErrors = (summary.errors?.length ?? 0) === 0;
  // Cleanup success must gate the verdict, not just the process exit code —
  // a leaked temporary collection is a real failure of this spike's own
  // stated contract (guaranteed cleanup), independent of whether the
  // retrieval capabilities themselves worked (code review finding: ACCEPT
  // was previously reachable even when deleteCollection() failed).
  const cleanupOk = summary.cleanup.attempted === true
    && summary.cleanup.deleted === true
    && summary.cleanup.error == null;

  if (denseWanted) {
    // ACCEPT requires the FULL claimed contract: dense-only + bm25 lane +
    // both hybrid k variants + weighted RRF, ALL fully run across every
    // query, with verified update+delete, a truly consistent re-query,
    // guaranteed cleanup, and zero recorded request errors. Anything less
    // is at most PARTIAL.
    const fullContract = denseOk && bm25Ok && bm25MlOk && hybridK2Ok && hybridK60Ok
      && weightedOk && updateVerified && deleteVerified && requeryOk && noErrors && cleanupOk;
    if (fullContract) return 'QDRANT_CLOUD_INFERENCE_SPIKE_ACCEPT';
    // Something core worked but not the whole contract.
    if (denseOk || bm25Ok) return 'QDRANT_CLOUD_INFERENCE_SPIKE_PARTIAL';
    return 'QDRANT_CLOUD_INFERENCE_SPIKE_REJECT';
  }
  // BM25-only run (dense intentionally not supplied): hybrid is legitimately
  // N/A, so the full dense/hybrid contract can never be ACCEPT — cap at
  // PARTIAL when the BM25 lanes, lifecycle, and cleanup all worked, REJECT
  // otherwise.
  if (bm25Ok && bm25MlOk && updateVerified && deleteVerified && requeryOk && noErrors && cleanupOk) {
    return 'QDRANT_CLOUD_INFERENCE_SPIKE_PARTIAL';
  }
  if (bm25Ok) return 'QDRANT_CLOUD_INFERENCE_SPIKE_PARTIAL';
  return 'QDRANT_CLOUD_INFERENCE_SPIKE_REJECT';
}

main().catch((err) => {
  const redact = makeRedactor(process.env.QDRANT_KEY);
  console.error('Unhandled spike error:', redact(err));
  process.exitCode = 1;
});
