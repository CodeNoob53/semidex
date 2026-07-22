// MIRACL Russian ('ru') pooled-subset retrieval benchmark: local BGE-M3
// ONNX vs Qdrant Cloud Inference (hosted E5-small dense + server-side
// BM25), validating non-English multilingual/Cyrillic retrieval.
//
// MIRACL does NOT contain Ukrainian. This benchmark is multilingual/
// Cyrillic evidence only — never present it as a Ukrainian-language
// validation, and never treat Russian as a substitute for a dedicated
// Ukrainian dataset (see README.md's "Scope and limits" section).
//
// This is a document-level retrieval-provider benchmark on a GLOBAL
// 1000-passage collection — every one of the 100 selected queries searches
// the SAME collection, not 100 separate per-query reranking pools.
//
// Scope, locked (see miracl-profiles.mjs for the executable source of
// truth): common-512 regime only (no native/full-text regime in this first
// run); both profiles (local, cloud) measured at both RRF k=2 and k=60;
// dense-only, sparse-only, and hybrid for each. Each profile indexed
// EXACTLY ONCE — the two hybrid requests differ only in `rrf.k`, sharing
// the same collection, vectors, prefetch specification, and limits.
//
// No production settings/defaults changed. Nothing committed by this
// script. One profile at a time, one query at a time (bounded concurrency
// 1), bounded indexing batches, bounded retry with backoff, no background
// processes, no ColBERT output requested.
//
// Run:   node benchmarks/external/miracl/run-miracl.mjs
// Smoke: node benchmarks/external/miracl/run-miracl.mjs --smoke
//   (8 documents / 2 queries, cloud profile only, writes to a SEPARATE
//   gitignored report path — never overwrites the real result)
// Requires QDRANT_URL / QDRANT_KEY (Semidex's own bootstrapEnv()).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

import { bootstrapEnv } from '../../../src/core/env-bootstrap.js';
import { embedOnnxBatch } from '../../../src/core/onnx-embed.js';

import { computeMetrics, toTrecRunFormat } from '../beir/metrics.mjs';
import { prepareInputs, formatForLanes } from '../beir/prepare-inputs.mjs';
import {
  makeRedactor, describeEndpoint, buildClient, timed, withBoundedRetry, percentile, buildIdMapping,
} from '../beir/harness-core.mjs';

import {
  PROFILES, COLLECTION_PREFIX, collectionName, BM25_MODEL_ID, BM25_OPTIONS,
  TOP_K, HYBRID_PREFETCH_LIMIT, REGIME,
} from './miracl-profiles.mjs';
import { buildAndCacheMiraclSubset, selectSubsetDocIds, assembleSubset, validateSubset, SUBSET_QUERY_COUNT, SUBSET_CORPUS_SIZE } from './build-miracl-subset.mjs';
import { fetchAndValidateMiraclTopicsQrels, fetchCorpusPassages, MIRACL_TOPICS_QRELS_REVISION, MIRACL_CORPUS_REVISION } from './fetch-miracl.mjs';
import { pairedBootstrapByQuery, perQueryMetrics, DEFAULT_BOOTSTRAP_SEED, DEFAULT_BOOTSTRAP_ITERATIONS } from './bootstrap.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const RUNS_DIR = resolve(__dirname, '.runs');
const RESULTS_DIR = resolve(__dirname, '../results');

const SMOKE = process.argv.includes('--smoke');
const REPORT_JSON_PATH = resolve(RESULTS_DIR, SMOKE ? '.miracl-smoke-report.json' : '2026-07-22-miracl-ru-provider-comparison.json');
const REPORT_MD_PATH = resolve(RESULTS_DIR, '2026-07-22-miracl-ru-provider-comparison.md');

// ── resource safety knobs ────────────────────────────────────────────────
const INDEX_BATCH_SIZE = 24; // within the required <=24 range
const PROVENANCE_FILES = Object.freeze([
  resolve(__dirname, 'run-miracl.mjs'),
  resolve(__dirname, 'build-miracl-subset.mjs'),
  resolve(__dirname, 'miracl-profiles.mjs'),
  resolve(__dirname, 'fetch-miracl.mjs'),
  resolve(__dirname, 'bootstrap.mjs'),
  resolve(REPO_ROOT, 'benchmarks/external/beir/harness-core.mjs'),
  resolve(REPO_ROOT, 'benchmarks/external/beir/metrics.mjs'),
  resolve(REPO_ROOT, 'benchmarks/external/beir/prepare-inputs.mjs'),
  resolve(REPO_ROOT, 'src/core/onnx-embed.js'),
]);

function currentCommitHash() {
  try { return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim(); } catch { return null; }
}

function workingTreeDirty() {
  try { return execSync('git status --porcelain', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim().length > 0; } catch { return null; }
}

function sdkVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'node_modules/@qdrant/js-client-rest/package.json'), 'utf-8'));
    return pkg.version;
  } catch { return null; }
}

function sha256OfFile(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}

function buildProvenance() {
  return {
    commitHash: currentCommitHash(),
    workingTreeDirty: workingTreeDirty(),
    fileHashes: Object.fromEntries(PROVENANCE_FILES.map((p) => [p.replace(REPO_ROOT, '').replace(/\\/g, '/'), sha256OfFile(p)])),
    qdrantSdkVersion: sdkVersion(),
    onnxExecutionProviderRequested: (process.env.ONNX_EXECUTION_PROVIDER ?? 'cpu').trim().toLowerCase() || 'cpu',
  };
}

/** --smoke: an 8-passage/2-query subset built DIRECTLY (bypassing
 * buildAndCacheMiraclSubset()'s full 1000-passage selection), so the smoke
 * path never has to scan for 1000 docids across the corpus shards before
 * shrinking down — it only ever fetches the ~8 passages it actually needs.
 * cloud profile only. Never used for the real report — only to validate
 * the full create/index/query/metrics/cleanup pipeline cheaply, on a
 * SEPARATE gitignored report path that never overwrites the real result. */
async function buildSmokeSubset({ log, trackRss }) {
  const { queries, qrels } = await fetchAndValidateMiraclTopicsQrels({ log });
  const selection = selectSubsetDocIds({ queries, qrels, queryCount: 2, corpusSize: 8 });
  if (selection.stats.shortfall > 0) {
    throw new Error(`[miracl] smoke selection could not reach 8 passages (got ${selection.stats.totalCorpusSize}) — the first 2 canonically-selected queries do not have enough annotated negatives for even the smoke size.`);
  }
  const corpusPassages = await fetchCorpusPassages(selection.subsetDocIds, { log, trackRss });
  const subset = assembleSubset({ selection, corpusPassages });
  // Same validateSubset() gate the real 100-query/1000-passage subset goes
  // through (buildAndCacheMiraclSubset()) — including the "every selected
  // query has qrels AND at least one positive passage" check. Without
  // this, the smoke path could silently accept a 2-query selection where
  // one query has zero positives, which would make Recall/MAP genuinely
  // null downstream for a reason that has nothing to do with retrieval
  // quality.
  const validationErrors = validateSubset(subset, { queryCount: 2, corpusSize: 8 });
  if (validationErrors.length > 0) {
    throw new Error(`[miracl] smoke subset failed validation: ${validationErrors.join('; ')}`);
  }
  return subset;
}

async function main() {
  bootstrapEnv();
  const redact = makeRedactor(process.env.QDRANT_KEY, REPO_ROOT);
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const peakRss = { bytes: process.memoryUsage().rss };
  const trackRss = () => { const cur = process.memoryUsage().rss; if (cur > peakRss.bytes) peakRss.bytes = cur; };
  const rssTimer = setInterval(trackRss, 2000);
  rssTimer.unref();

  console.log(SMOKE ? '[miracl] building smoke subset (8 passages / 2 queries)...' : '[miracl] building deterministic pooled subset...');
  const subset = SMOKE
    ? await buildSmokeSubset({ log: (m) => console.log(m), trackRss })
    : await buildAndCacheMiraclSubset({ log: (m) => console.log(m), trackRss });
  const { corpus, queries, qrels } = subset;
  console.log(`[miracl] subset ready: ${corpus.size} passages, ${queries.size} queries${SMOKE ? ' (SMOKE MODE)' : ''}`);

  console.log('[miracl] preparing common-512 bodies...');
  const prepared = await prepareInputs({
    corpus, queries, datasetMd5: SMOKE ? 'miracl-ru-smoke' : 'miracl-ru-subset',
    log: (m) => console.log(m), trackRss, progressEvery: 200,
  });

  const client = buildClient();
  const profilesToRun = SMOKE ? PROFILES.filter((p) => p.id === 'cloud') : PROFILES;
  console.log(`[miracl] run matrix: ${profilesToRun.map((p) => p.id).join(', ')} (rrfKs: ${profilesToRun[0]?.rrfKs.join(', ')})`);

  const report = {
    startedAt: new Date().toISOString(),
    provenance: buildProvenance(),
    scope: {
      regime: REGIME, corpusSize: corpus.size, queryCount: queries.size,
      requestedCorpusSize: SMOKE ? corpus.size : SUBSET_CORPUS_SIZE,
      requestedQueryCount: SMOKE ? queries.size : SUBSET_QUERY_COUNT,
      topK: TOP_K, hybridPrefetchLimit: HYBRID_PREFETCH_LIMIT, indexBatchSize: INDEX_BATCH_SIZE,
      datasetRevisions: { topicsQrels: MIRACL_TOPICS_QRELS_REVISION, corpus: MIRACL_CORPUS_REVISION },
    },
    subsetStats: subset.stats,
    subsetManifest: subset.manifest ?? null,
    environment: {
      qdrantEndpoint: describeEndpoint(process.env.QDRANT_URL),
      qdrantKeyConfigured: Boolean(process.env.QDRANT_KEY),
      preparationStats: prepared.stats,
    },
    runs: {},
    comparisons: {},
    cleanupSummary: { attempted: 0, deleted: 0, failed: [] },
    verdict: null,
  };

  for (const profile of profilesToRun) {
    console.log(`\n[miracl] === profile: ${profile.id} ===`);
    const runReport = await executeProfileRun({ client, redact, corpus, queries, qrels, prepared, profile, trackRss });
    report.runs[profile.id] = runReport;
    report.cleanupSummary.attempted += 1;
    if (runReport.cleanup?.deleted) report.cleanupSummary.deleted += 1;
    else report.cleanupSummary.failed.push({ profileId: profile.id, collection: runReport.cleanup?.collection, error: runReport.cleanup?.error });
    writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  }

  if (!SMOKE && report.runs.local && report.runs.cloud) {
    report.comparisons = computeComparisons(report.runs);
  }

  clearInterval(rssTimer);
  trackRss();
  report.environment.peakRssBytes = peakRss.bytes;
  report.finishedAt = new Date().toISOString();
  report.verdict = computeVerdict(report, profilesToRun, { smoke: SMOKE });
  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  if (!SMOKE) writeFileSync(REPORT_MD_PATH, renderMarkdownReport(report), 'utf-8');

  console.log('\n[miracl] === SUMMARY ===');
  for (const [profileId, r] of Object.entries(report.runs)) {
    const hybridSummary = (r.rrfKs ?? []).map((k) => {
      const m = r.metrics?.[`hybrid_k${k}`];
      return `k${k} nDCG@10=${m?.ndcgAt10?.toFixed(4) ?? 'n/a'}`;
    }).join(', ');
    console.log(`${profileId}: ${hybridSummary} | cleanup=${r.cleanup?.deleted ? 'ok' : 'FAILED'}`);
  }
  console.log('peak RSS MB:', (peakRss.bytes / 1e6).toFixed(0));
  console.log('verdict:', report.verdict);
  console.log('report json:', REPORT_JSON_PATH.replace(REPO_ROOT, '.'));
  if (!SMOKE) console.log('report md:', REPORT_MD_PATH.replace(REPO_ROOT, '.'));

  if (report.cleanupSummary.failed.length > 0) {
    console.error('\n!! CLEANUP FAILURES:');
    for (const f of report.cleanupSummary.failed) console.error(`!!   ${f.profileId}: ${f.collection}`);
    process.exitCode = 1;
  }
}

/** Runs ONE profile end to end: create collection -> index corpus ONCE
 * (batched) -> for every query run dense-only and sparse-only ONCE, then
 * hybrid ONCE PER rrfK in profile.rrfKs (same prefetch specification,
 * different fusion constant — no re-indexing, no redundant dense/sparse
 * query calls) -> compute metrics (aggregate + per-query for bootstrap) ->
 * write TREC runs -> cleanup. Cleanup always runs in `finally`, guarded to
 * the exact collection name prefix. */
export async function executeProfileRun({
  client, redact, corpus, queries, qrels, prepared, profile, trackRss = () => {},
  embedBatch = embedOnnxBatch,
  writeTrecRun = (path, content) => writeFileSync(path, content, 'utf-8'),
}) {
  const { rrfKs } = profile;
  const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const collection = collectionName(profile.id, suffix);

  const runReport = {
    profileId: profile.id, regime: REGIME, rrfKs, collection,
    indexing: { wallMs: null, documentsIndexed: 0, batches: 0, errors: 0, retries: 0 },
    queryStats: {
      total: queries.size, ran: 0, errors: 0, retries: 0,
      latencyMs: { dense: [], sparse: [], ...Object.fromEntries(rrfKs.map((k) => [`hybrid_k${k}`, []])) },
    },
    metrics: {}, // 'dense' | 'sparse' | 'hybrid_k<K>' -> computeMetrics() result
    perQueryMetrics: {}, // same keys -> Map serialized as [ [qid, {...}], ... ] for bootstrap comparisons
    trecRunPaths: {},
    cleanup: { attempted: false, deleted: false, collection, error: null },
    errors: [],
  };

  const idMap = buildIdMapping([...corpus.keys()], `${collection}:doc`);
  if (idMap.collisions.length > 0) {
    runReport.errors.push({ step: 'id_mapping', error: `${idMap.collisions.length} point-ID collisions detected in doc ID mapping — aborting run` });
    return runReport;
  }

  try {
    const docBodies = new Map([...prepared.documents].map(([docId, entry]) => [docId, entry.commonBody]));

    // modifier:idf is a BM25-specific convention (Qdrant applies live
    // corpus IDF on top of the stored term-frequency-shaped sparse vector)
    // — it does NOT apply to BGE-M3's sparse output, which is already a
    // set of learned per-token weights. Matches Semidex's own production
    // schema (core/qdrant/schema.js) and the BEIR harness's own local lane.
    const vectors = { dense: { size: profile.denseSize, distance: 'Cosine' } };
    const sparse_vectors = profile.kind === 'local'
      ? { sparse: { index: { on_disk: false } } }
      : { sparse: { modifier: 'idf' } };
    const createRes = await withBoundedRetry(() => client.createCollection(collection, { vectors, sparse_vectors }));
    if (!createRes.ok) {
      runReport.errors.push({ step: 'create_collection', error: redact(createRes.err) });
      return runReport;
    }

    // ── index corpus ONCE, in bounded batches ──────────────────────────
    const indexStart = process.hrtime.bigint();
    const docIds = [...corpus.keys()];
    for (let i = 0; i < docIds.length; i += INDEX_BATCH_SIZE) {
      const batchIds = docIds.slice(i, i + INDEX_BATCH_SIZE);
      const points = await buildPoints({ profile, batchIds, docBodies, idMap, redact, runReport, embedBatch });
      if (points === null) continue;
      const upsertRes = await withBoundedRetry(
        () => client.upsert(collection, { wait: true, points }),
        { onRetry: () => { runReport.indexing.retries += 1; } }
      );
      if (!upsertRes.ok) {
        runReport.indexing.errors += 1;
        runReport.errors.push({ step: `upsert_batch_${i}`, error: redact(upsertRes.err) });
      } else {
        runReport.indexing.documentsIndexed += points.length;
      }
      runReport.indexing.batches += 1;
      if (runReport.indexing.batches % 10 === 0) {
        console.log(`[miracl] [${profile.id}] indexed ${runReport.indexing.documentsIndexed}/${docIds.length}`);
        trackRss();
      }
    }
    runReport.indexing.wallMs = Number((process.hrtime.bigint() - indexStart) / 1000000n);
    console.log(`[miracl] [${profile.id}] indexing complete: ${runReport.indexing.documentsIndexed} docs in ${runReport.indexing.wallMs}ms`);

    // ── sequential queries: dense-only, sparse-only ONCE, hybrid ONCE PER k ─
    const emptyRun = () => new Map([...queries.keys()].map((qid) => [qid, []]));
    const denseRun = emptyRun();
    const sparseRun = emptyRun();
    const hybridRuns = new Map(rrfKs.map((k) => [k, emptyRun()]));

    let qi = 0;
    for (const queryId of queries.keys()) {
      qi += 1;
      const queryBody = prepared.queries.get(queryId)?.commonBody;
      if (typeof queryBody !== 'string') {
        runReport.queryStats.errors += 1;
        runReport.errors.push({ step: `prepare_query_${queryId}`, error: 'Prepared query body is missing' });
        continue;
      }

      const queryVectors = await buildQueryVector({ profile, body: queryBody, redact, runReport, embedBatch });
      if (queryVectors === null) { runReport.queryStats.errors += 1; continue; }

      const denseQ = await withBoundedRetry(
        () => client.query(collection, { query: queryVectors.dense, using: 'dense', limit: TOP_K, with_payload: false }),
        { onRetry: () => { runReport.queryStats.retries += 1; } }
      );
      const sparseQ = await withBoundedRetry(
        () => client.query(collection, { query: queryVectors.sparse, using: 'sparse', limit: TOP_K, with_payload: false }),
        { onRetry: () => { runReport.queryStats.retries += 1; } }
      );

      const modeResults = [['dense', denseQ, denseRun], ['sparse', sparseQ, sparseRun]];
      // One hybrid query per rrfK — SAME prefetch specification, only
      // `rrf.k` differs, as required.
      for (const k of rrfKs) {
        const hybridQ = await withBoundedRetry(
          () => client.query(collection, {
            prefetch: [
              { query: queryVectors.dense, using: 'dense', limit: HYBRID_PREFETCH_LIMIT },
              { query: queryVectors.sparse, using: 'sparse', limit: HYBRID_PREFETCH_LIMIT },
            ],
            query: { rrf: { k } },
            limit: TOP_K, with_payload: false,
          }),
          { onRetry: () => { runReport.queryStats.retries += 1; } }
        );
        modeResults.push([`hybrid_k${k}`, hybridQ, hybridRuns.get(k)]);
      }

      for (const [label, res, store] of modeResults) {
        if (res.ok) {
          runReport.queryStats.latencyMs[label].push(res.ms);
          const points = res.value?.points ?? [];
          store.set(queryId, points.map((p) => ({ docId: idMap.toString.get(String(p.id)) ?? String(p.id), score: p.score })));
        } else {
          runReport.queryStats.errors += 1;
          runReport.errors.push({ step: `query_${label}_${queryId}`, error: redact(res.err) });
          store.set(queryId, []);
        }
      }
      runReport.queryStats.ran += 1;
      if (qi % 25 === 0) { console.log(`[miracl] [${profile.id}] queries ${qi}/${queries.size}`); trackRss(); }
    }

    // ── metrics + TREC run persistence ───────────────────────────────────
    const toRankedMap = (scoredMap) => {
      const m = new Map();
      for (const [qid, docs] of scoredMap.entries()) m.set(qid, docs.map((d) => d.docId));
      return m;
    };
    const rankedByMode = {
      dense: toRankedMap(denseRun),
      sparse: toRankedMap(sparseRun),
      ...Object.fromEntries(rrfKs.map((k) => [`hybrid_k${k}`, toRankedMap(hybridRuns.get(k))])),
    };
    for (const [label, ranked] of Object.entries(rankedByMode)) {
      runReport.metrics[label] = computeMetrics(qrels, ranked);
      runReport.perQueryMetrics[label] = [...perQueryMetrics(qrels, ranked).entries()];
    }

    const allModeStores = [['dense', denseRun], ['sparse', sparseRun], ...rrfKs.map((k) => [`hybrid_k${k}`, hybridRuns.get(k)])];
    for (const [label, scoredMap] of allModeStores) {
      const trecPath = join(RUNS_DIR, `${profile.id}-${label}.trec`);
      writeTrecRun(trecPath, toTrecRunFormat(scoredMap, `miracl-ru-${profile.id}-${label}`));
      runReport.trecRunPaths[label] = trecPath.replace(RUNS_DIR, '.runs');
    }

    for (const label of Object.keys(rankedByMode)) {
      const arr = [...runReport.queryStats.latencyMs[label]].sort((a, b) => a - b);
      runReport.queryStats.latencyMs[label] = {
        p50: percentile(arr, 0.5), p95: percentile(arr, 0.95), max: arr.length ? arr[arr.length - 1] : null, count: arr.length,
      };
    }
  } catch (err) {
    runReport.errors.push({ step: 'fatal', error: redact(err) });
  } finally {
    runReport.cleanup.attempted = true;
    if (!collection.startsWith(COLLECTION_PREFIX)) {
      runReport.cleanup.error = `Refusing to delete: name does not start with ${COLLECTION_PREFIX}`;
    } else {
      const delRes = await withBoundedRetry(() => client.deleteCollection(collection));
      runReport.cleanup.deleted = delRes.ok;
      if (!delRes.ok) runReport.cleanup.error = redact(delRes.err);
    }
  }

  return runReport;
}

/** Local profile: computes dense+sparse via embedOnnxBatch() (bounded batch
 * size, sequential across batches — no unbounded Promise.all; the batch
 * function itself never requests ColBERT output, per src/core/onnx-embed.js).
 * Cloud profile: server-side inference — dense via {text, model} on the
 * `dense` vector, sparse via {text, model:'qdrant/bm25', options} on the
 * `sparse` vector, with the E5 asymmetric prefix applied ONLY to the dense
 * lane (formatForLanes never adds it to the sparse/BM25 lane). */
async function buildPoints({ profile, batchIds, docBodies, idMap, redact, runReport, embedBatch }) {
  const bodies = batchIds.map((id) => docBodies.get(id));
  if (profile.kind === 'local') {
    const embedRes = await timed(() => embedBatch(bodies));
    if (!embedRes.ok) {
      runReport.indexing.errors += 1;
      runReport.errors.push({ step: 'embed_batch_local', error: redact(embedRes.err) });
      return null;
    }
    return batchIds.map((docId, i) => {
      const { dense, sparse } = embedRes.value[i];
      return {
        id: idMap.toPoint.get(docId),
        payload: { miracl_doc_id: docId, benchmark: 'miracl-ru', profile: profile.id },
        vector: { dense, sparse: { indices: sparse.indices, values: sparse.values } },
      };
    });
  }
  return batchIds.map((docId, i) => {
    const { denseText, sparseText } = formatForLanes({ body: bodies[i], profileKind: profile.kind, role: 'document' });
    return {
      id: idMap.toPoint.get(docId),
      payload: { miracl_doc_id: docId, benchmark: 'miracl-ru', profile: profile.id },
      vector: {
        dense: { text: denseText, model: profile.denseModelId },
        sparse: { text: sparseText, model: BM25_MODEL_ID, options: BM25_OPTIONS },
      },
    };
  });
}

async function buildQueryVector({ profile, body, redact, runReport, embedBatch }) {
  if (profile.kind === 'local') {
    const embedRes = await timed(() => embedBatch([body]));
    if (!embedRes.ok) {
      runReport.errors.push({ step: 'embed_query_local', error: redact(embedRes.err) });
      return null;
    }
    const { dense, sparse } = embedRes.value[0];
    return { dense, sparse: { indices: sparse.indices, values: sparse.values } };
  }
  const { denseText, sparseText } = formatForLanes({ body, profileKind: profile.kind, role: 'query' });
  return {
    dense: { text: denseText, model: profile.denseModelId },
    sparse: { text: sparseText, model: BM25_MODEL_ID, options: BM25_OPTIONS },
  };
}

/** Deterministic paired-bootstrap comparisons, per the task's required
 * set: k=2 vs k=60 (within each profile), hybrid vs dense, hybrid vs
 * sparse (within each profile, at each k), and local vs cloud under the
 * same k (hybrid). Every comparison reports mean delta, wins/losses/ties,
 * a 95% CI, and a verdict that is ONLY ever "better" when the CI excludes
 * zero — otherwise MIXED or INCONCLUSIVE, never an epsilon-based call. */
export function computeComparisons(runs) {
  const comparisons = {};
  const toMap = (entries) => new Map(entries);

  for (const profileId of Object.keys(runs)) {
    const r = runs[profileId];
    if (!r?.perQueryMetrics) continue;
    const pq = Object.fromEntries(Object.entries(r.perQueryMetrics).map(([label, entries]) => [label, toMap(entries)]));

    if (pq.hybrid_k2 && pq.hybrid_k60) {
      comparisons[`${profileId}_k2_vs_k60`] = pairedBootstrapByQuery(pq.hybrid_k2, pq.hybrid_k60, 'ndcgAt10');
    }
    for (const k of r.rrfKs ?? []) {
      const hybridKey = `hybrid_k${k}`;
      if (pq[hybridKey] && pq.dense) {
        comparisons[`${profileId}_hybrid_k${k}_vs_dense`] = pairedBootstrapByQuery(pq.dense, pq[hybridKey], 'ndcgAt10');
      }
      if (pq[hybridKey] && pq.sparse) {
        comparisons[`${profileId}_hybrid_k${k}_vs_sparse`] = pairedBootstrapByQuery(pq.sparse, pq[hybridKey], 'ndcgAt10');
      }
    }
  }

  if (runs.local?.perQueryMetrics && runs.cloud?.perQueryMetrics) {
    const localPq = Object.fromEntries(Object.entries(runs.local.perQueryMetrics).map(([label, entries]) => [label, toMap(entries)]));
    const cloudPq = Object.fromEntries(Object.entries(runs.cloud.perQueryMetrics).map(([label, entries]) => [label, toMap(entries)]));
    const sharedKs = (runs.local.rrfKs ?? []).filter((k) => (runs.cloud.rrfKs ?? []).includes(k));
    for (const k of sharedKs) {
      const hybridKey = `hybrid_k${k}`;
      if (localPq[hybridKey] && cloudPq[hybridKey]) {
        comparisons[`local_vs_cloud_hybrid_k${k}`] = pairedBootstrapByQuery(localPq[hybridKey], cloudPq[hybridKey], 'ndcgAt10');
      }
    }
  }

  return comparisons;
}

function expectedMetricModes(rrfKs) {
  return ['dense', 'sparse', ...rrfKs.map((k) => `hybrid_k${k}`)];
}

// Every field computeMetrics() (../beir/metrics.mjs) returns per mode that
// this benchmark's report claims to measure — nDCG@10 is checked
// separately elsewhere, but ACCEPT requires ALL of these to be finite
// numbers, not just nDCG. mapAt100/recallAt10/recallAt100 legitimately
// return null when zero queries in the run have any relevant passage — but
// build-miracl-subset.mjs's validateSubset() now REQUIRES every selected
// query to have at least one positive (relevance > 0) passage before the
// subset is ever accepted. A retrieval miss on a query that DOES have a
// positive qrel still yields a finite 0 (recallAtK/averagePrecisionAtK
// divide by the query's total relevant count, which is nonzero here — an
// empty/wrong result set just makes the numerator 0, not the whole value
// null). So a null here on a subset-backed run can only mean the metrics
// computation itself received corrupted/malformed data (e.g. qrels or the
// run map lost the query entirely) — never a legitimate "query had no
// relevant docs" case, which validateSubset() has already ruled out, and
// never a merely-poor retrieval result, which stays finite by
// construction.
const CLAIMED_FINITE_METRIC_FIELDS = Object.freeze(['ndcgAt10', 'mapAt100', 'recallAt10', 'recallAt100', 'precisionAt10', 'mrrAt10']);

function metricsAreFullyValid(m, expectedQueryCount) {
  if (!m || m.queryCount !== expectedQueryCount) return false;
  if ((m.skippedForRecallMap ?? 0) !== 0) return false;
  return CLAIMED_FINITE_METRIC_FIELDS.every((field) => typeof m[field] === 'number' && Number.isFinite(m[field]));
}

export function computeVerdict(report, profilesRun, { smoke = false } = {}) {
  if (smoke) return computeSmokeVerdict(report);

  const expectedProfileIds = new Set(profilesRun.map((p) => p.id));
  const completedProfileIds = new Set(Object.keys(report.runs));
  const allProfilesPresent = expectedProfileIds.size === completedProfileIds.size && [...expectedProfileIds].every((id) => completedProfileIds.has(id));
  if (!allProfilesPresent) return 'MIRACL_RU_HARNESS_BLOCKED';

  const cleanupOk = report.cleanupSummary.failed.length === 0;
  let anyMetricsValid = false;
  let allMetricsValid = true;
  let anyRequestErrors = false;
  for (const run of Object.values(report.runs)) {
    const expectedModes = expectedMetricModes(run.rrfKs ?? []);
    const metricsOk = expectedModes.every((mode) => metricsAreFullyValid(run.metrics?.[mode], run.queryStats.total));
    if (metricsOk) anyMetricsValid = true; else allMetricsValid = false;
    if ((run.errors?.length ?? 0) > 0 || run.queryStats.errors > 0 || run.indexing.errors > 0) anyRequestErrors = true;
  }

  if (allMetricsValid && cleanupOk && !anyRequestErrors) return 'MIRACL_RU_HARNESS_ACCEPT';
  if (anyMetricsValid) return 'MIRACL_RU_HARNESS_PARTIAL';
  return 'MIRACL_RU_HARNESS_REJECT';
}

// Uses the SAME metricsAreFullyValid() gate as the full-harness verdict.
// A prior version of this function only required nDCG@10 finite, on the
// mistaken assumption that mapAt100/recallAt10/recallAt100 could
// legitimately be null even with a positive passage present in qrels
// (e.g. "the top-100 retrieved for a tiny 2-query run genuinely misses
// it"). That is factually wrong: per beir/metrics.mjs's recallAtK()/
// averagePrecisionAtK(), a miss still returns a real number (0/total) —
// null is returned ONLY when totalRelevant(qrelsForQuery) === 0, i.e. no
// positive qrels at all for that query. buildSmokeSubset() now runs the
// same validateSubset() check as the real subset (every selected query
// has qrels with at least one positive passage), so the smoke path has
// exactly the same guarantee the full harness does, and can use the same
// strict gate.
function computeSmokeVerdict(report) {
  const cleanupOk = report.cleanupSummary.failed.length === 0;
  const run = Object.values(report.runs)[0];
  if (!run) return 'MIRACL_RU_SMOKE_REJECT';
  const expectedModes = expectedMetricModes(run.rrfKs ?? []);
  const metricsOk = expectedModes.every((mode) => metricsAreFullyValid(run.metrics?.[mode], run.queryStats.total));
  const anyRequestErrors = (run.errors?.length ?? 0) > 0 || run.queryStats.errors > 0 || run.indexing.errors > 0;
  if (metricsOk && cleanupOk && !anyRequestErrors) return 'MIRACL_RU_SMOKE_ACCEPT';
  if (metricsOk) return 'MIRACL_RU_SMOKE_PARTIAL';
  return 'MIRACL_RU_SMOKE_REJECT';
}

function metricCell(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : 'n/a';
}

function bootstrapCell(cmp) {
  if (!cmp) return 'n/a';
  const ci = cmp.ciLow !== null ? `[${cmp.ciLow.toFixed(4)}, ${cmp.ciHigh.toFixed(4)}]` : 'n/a';
  return `${cmp.verdict} (meanΔ=${cmp.meanDelta !== null ? cmp.meanDelta.toFixed(4) : 'n/a'}, CI95%=${ci}, W/L/T=${cmp.wins}/${cmp.losses}/${cmp.ties}, n=${cmp.n})`;
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push('# MIRACL Russian pooled-subset provider comparison');
  lines.push('');
  lines.push(`Verdict: **${report.verdict}**`);
  lines.push('');
  lines.push('This is a document-level retrieval-provider benchmark on a Russian');
  lines.push('(Cyrillic) pooled subset of the official MIRACL dev split. MIRACL does');
  lines.push('**not** include Ukrainian — this run is multilingual/Cyrillic evidence');
  lines.push('only, never a Ukrainian-language validation and never a substitute for a');
  lines.push('dedicated Ukrainian dataset.');
  lines.push('');
  lines.push('## Provenance');
  lines.push('');
  lines.push(`- Commit: ${report.provenance.commitHash ?? 'n/a'}`);
  lines.push(`- Working tree dirty: ${report.provenance.workingTreeDirty}`);
  lines.push(`- MIRACL topics/qrels revision: ${report.scope.datasetRevisions.topicsQrels}`);
  lines.push(`- MIRACL corpus revision: ${report.scope.datasetRevisions.corpus}`);
  lines.push(`- Mini-set selection seed: \`${report.subsetManifest?.selectionSeed ?? 'n/a'}\` (schema v${report.subsetManifest?.schemaVersion ?? 'n/a'})`);
  lines.push(`- Qdrant SDK: ${report.provenance.qdrantSdkVersion ?? 'n/a'}`);
  lines.push(`- Requested ONNX execution provider: \`${report.provenance.onnxExecutionProviderRequested ?? 'cpu'}\``);
  lines.push('  (performance provenance only; the configured provider list may allow operator-level CPU fallback).');
  lines.push('- File hashes (SHA-256):');
  for (const [path, hash] of Object.entries(report.provenance.fileHashes ?? {})) {
    lines.push(`  - \`${path}\`: ${hash ?? 'n/a'}`);
  }
  lines.push('');
  lines.push('## Subset construction');
  lines.push('');
  lines.push(`- Queries: ${report.subsetStats.selectedQueryCount} (SHA-256-seeded deterministic shuffle of all 1252`);
  lines.push('  Russian dev queries, canonical-sorted before shuffling — see build-miracl-subset.mjs).');
  lines.push(`- Positive passages: ${report.subsetStats.positiveDocCount}.`);
  lines.push(`- Annotated negatives: ${report.subsetStats.negativeDocCount} (MIRACL's own human-annotated`);
  lines.push('  non-relevant qrels rows, NOT retrieval-mined hard negatives — see README.md.');
  lines.push('  Selected round-robin across the selected queries.)');
  lines.push(`- Total corpus: ${report.subsetStats.totalCorpusSize} passages (requested ${report.subsetStats.requestedCorpusSize}, shortfall ${report.subsetStats.shortfall}).`);
  lines.push(`- Dangling qrels references: ${report.subsetStats.danglingQrelsRefs?.length ?? 0}.`);
  lines.push('');
  lines.push('## Retrieval quality');
  lines.push('');
  lines.push('| Profile | Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | Precision@10 | MRR@10 |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const [profileId, r] of Object.entries(report.runs)) {
    for (const mode of expectedMetricModes(r.rrfKs ?? [])) {
      const m = r.metrics?.[mode];
      lines.push(`| ${profileId} | ${mode} | ${metricCell(m?.ndcgAt10)} | ${metricCell(m?.mapAt100)} | ${metricCell(m?.recallAt10)} | ${metricCell(m?.recallAt100)} | ${metricCell(m?.precisionAt10)} | ${metricCell(m?.mrrAt10)} |`);
    }
  }
  lines.push('');
  lines.push('## Statistical comparisons (deterministic paired bootstrap)');
  lines.push('');
  lines.push(`Seed: \`${DEFAULT_BOOTSTRAP_SEED}\`, iterations: ${DEFAULT_BOOTSTRAP_ITERATIONS}. A configuration is called`);
  lines.push('"better" only when the 95% CI excludes zero — otherwise MIXED/INCONCLUSIVE.');
  lines.push('');
  for (const [label, cmp] of Object.entries(report.comparisons ?? {})) {
    lines.push(`- **${label}**: ${bootstrapCell(cmp)}`);
  }
  lines.push('');
  lines.push('## Operations');
  lines.push('');
  lines.push('| Profile | Indexed | Index wall ms | Query errors | Retries | Cleanup |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const [profileId, r] of Object.entries(report.runs)) {
    lines.push(`| ${profileId} | ${r.indexing.documentsIndexed} | ${r.indexing.wallMs} | ${r.queryStats.errors} | ${r.indexing.retries + r.queryStats.retries} | ${r.cleanup?.deleted ? 'deleted' : 'FAILED'} |`);
  }
  lines.push(`\nPeak process RSS: ${report.environment.peakRssBytes ?? 'n/a'} bytes`);
  lines.push('');
  lines.push('## Interpretation limits');
  lines.push('');
  lines.push('- FACT: values above are measured on a 1000-passage / 100-query pooled');
  lines.push('  subset of the official MIRACL Russian dev split, not the full 9.5M-passage corpus.');
  lines.push('- FACT: this validates non-English multilingual/Cyrillic retrieval only.');
  lines.push('- FACT: MIRACL does not include Ukrainian. This result is never Ukrainian-');
  lines.push('  language validation and Russian is never a substitute for a dedicated');
  lines.push('  Ukrainian dataset.');
  lines.push('- FACT: negatives are MIRACL\'s own human-annotated non-relevant passages,');
  lines.push('  not retrieval-mined hard negatives (no official MIRACL baseline run file');
  lines.push('  is available to mine from).');
  lines.push('- No general Semidex-wide winner should be inferred from this benchmark alone.');
  lines.push('');
  return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    const redact = makeRedactor(process.env.QDRANT_KEY, REPO_ROOT);
    console.error('[miracl] unhandled error:', redact(err));
    process.exitCode = 1;
  });
}
