// LOCAL-ONLY RRF fusion-constant sensitivity check on a small, deterministic
// SciFact pooled subset (see build-rrf-mini-set.mjs).
//
// Goal: quickly compare RRF k=2 vs k=60 for the CURRENT local BGE-M3
// dense+sparse provider on a fast, cheap subset — NOT the full BEIR SciFact
// benchmark, NOT a chunker evaluation, and NOT a change to the production
// RRF_K default (core/settings/definitions.js). This script never writes
// to production settings/config.
//
// Scope, locked:
//   profile: local BGE-M3 ONNX dense+sparse only (no cloud profile here)
//   regime:  common-512 only (bodies reused from the already-validated
//            provider-neutral prepare-inputs.mjs cache)
//   corpus:  1000 documents (101 relevant + 899 hard negatives)
//   queries: 100
//   TOP_K: 100, HYBRID_PREFETCH_LIMIT: 200 (same as the full benchmark)
//   RRF: k=2 and k=60, same prefetch, one collection, indexed once
//
// Run:  node benchmarks/external/beir/run-rrf-mini.mjs
// Requires QDRANT_URL / QDRANT_KEY (Semidex's own bootstrapEnv()).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

import { bootstrapEnv } from '../../../src/shared/core/env-bootstrap.js';
import { createOnnxEmbeddingCapability } from '../../../src/local/core/onnx-embed.js';

import { PROFILES, COLLECTION_PREFIX, TOP_K, HYBRID_PREFETCH_LIMIT } from './profiles.mjs';
import { computeMetrics, toTrecRunFormat } from './metrics.mjs';
import { prepareInputs } from './prepare-inputs.mjs';
import { buildAndCacheMiniSet } from './build-rrf-mini-set.mjs';
import {
  makeRedactor, describeEndpoint, buildClient, timed, withBoundedRetry, percentile, buildIdMapping,
} from './harness-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const RUNS_DIR = resolve(__dirname, '.runs');
const RESULTS_DIR = resolve(__dirname, '../results');
const REPORT_JSON_PATH = resolve(RESULTS_DIR, '2026-07-22-beir-scifact-local-rrf-mini.json');
const REPORT_MD_PATH = resolve(RESULTS_DIR, '2026-07-22-beir-scifact-local-rrf-mini.md');

// ── resource safety knobs (same values as run-scifact.mjs) ─────────────────
const INDEX_BATCH_SIZE = 24; // within the required 16-32 range
const RRF_KS_UNDER_TEST = Object.freeze([2, 60]);

const LOCAL_PROFILE = PROFILES.find((p) => p.id === 'local');
if (!LOCAL_PROFILE) throw new Error('profiles.mjs no longer defines a "local" profile — mini harness cannot run.');

function currentCommitHash() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function sdkVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'node_modules/@qdrant/js-client-rest/package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return null;
  }
}

export function computeVerdict(runReport) {
  if (!runReport || runReport.errors.length > 0 || !runReport.cleanup.deleted) return 'LOCAL_RRF_MINI_INVALID';
  const k2 = runReport.metrics.hybrid_k2;
  const k60 = runReport.metrics.hybrid_k60;
  if (!k2 || !k60 || !Number.isFinite(k2.ndcgAt10) || !Number.isFinite(k60.ndcgAt10)) return 'LOCAL_RRF_MINI_INVALID';

  // "Better" judged on the primary metric (nDCG@10). A tie within a small
  // epsilon (avoids reporting a spurious winner from floating-point noise
  // on a metric that is, on a 100-query set, only meaningful to ~3 decimal
  // places) is reported as MIXED, not a coin-flip winner.
  const EPSILON = 0.002;
  const diff = k2.ndcgAt10 - k60.ndcgAt10;
  if (Math.abs(diff) <= EPSILON) return 'LOCAL_RRF_MINI_MIXED';
  return diff > 0 ? 'LOCAL_RRF_MINI_K2_BETTER' : 'LOCAL_RRF_MINI_K60_BETTER';
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

  console.log('[rrf-mini] building deterministic mini-set...');
  const miniSet = await buildAndCacheMiniSet({ log: (m) => console.log(m) });
  const { corpus, queries, qrels } = miniSet;
  console.log(`[rrf-mini] mini-set ready: ${corpus.size} docs, ${queries.size} queries (${miniSet.stats.relevantDocCount} relevant, ${miniSet.stats.negativeDocCount} hard negatives)`);

  console.log('[rrf-mini] preparing common-512 bodies (reuses the validated prepare-inputs cache when available)...');
  const prepared = await prepareInputs({
    corpus, queries, datasetMd5: 'rrf-mini-subset',
    log: (m) => console.log(m), trackRss, progressEvery: 200,
  });

  const client = buildClient();
  const report = {
    startedAt: new Date().toISOString(),
    commitHash: currentCommitHash(),
    scope: {
      profile: 'local', regime: 'common-512',
      corpusSize: corpus.size, queryCount: queries.size,
      rrfKs: [...RRF_KS_UNDER_TEST], topK: TOP_K, hybridPrefetchLimit: HYBRID_PREFETCH_LIMIT,
      indexBatchSize: INDEX_BATCH_SIZE,
      denseModelId: LOCAL_PROFILE.denseModelId, denseSize: LOCAL_PROFILE.denseSize, sparseModelId: LOCAL_PROFILE.sparseModelId,
    },
    miniSetStats: miniSet.stats,
    miniSetManifest: miniSet.manifest ?? null, // includes SciFact MD5 and TREC source SHA-256 hashes
    environment: {
      qdrantEndpoint: describeEndpoint(process.env.QDRANT_URL),
      qdrantKeyConfigured: Boolean(process.env.QDRANT_KEY),
      qdrantSdkVersion: sdkVersion(),
      preparationStats: prepared.stats,
    },
    run: null,
    verdict: null,
  };

  // createOnnxEmbeddingCapability() (Phase 8B — onnx-embed.js no longer
  // exports a bare module-scope-backed embedOnnxBatch function; this
  // benchmark constructs its own instance and releases it explicitly via
  // capability.shutdown() once the run completes).
  const onnxCapability = createOnnxEmbeddingCapability();
  const { embedOnnxBatch } = await onnxCapability.loadOnnxBatch();
  let runReport;
  try {
    runReport = await executeMiniRun({ client, redact, corpus, queries, qrels, prepared, trackRss, embedBatch: embedOnnxBatch });
  } finally {
    await onnxCapability.shutdown();
  }
  report.run = runReport;

  clearInterval(rssTimer);
  trackRss();
  report.environment.peakRssBytes = peakRss.bytes;
  report.finishedAt = new Date().toISOString();
  report.verdict = computeVerdict(runReport);
  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  writeFileSync(REPORT_MD_PATH, renderMarkdownReport(report), 'utf-8');

  console.log('\n[rrf-mini] === SUMMARY ===');
  for (const k of RRF_KS_UNDER_TEST) {
    const m = runReport.metrics[`hybrid_k${k}`];
    console.log(`hybrid_k${k}: nDCG@10=${m?.ndcgAt10?.toFixed(4) ?? 'n/a'} MAP@100=${m?.mapAt100?.toFixed(4) ?? 'n/a'} Recall@10=${m?.recallAt10?.toFixed(4) ?? 'n/a'} Recall@100=${m?.recallAt100?.toFixed(4) ?? 'n/a'} MRR@10=${m?.mrrAt10?.toFixed(4) ?? 'n/a'}`);
  }
  console.log('indexing wall ms:', runReport.indexing.wallMs);
  console.log('peak RSS MB:', (peakRss.bytes / 1e6).toFixed(0));
  console.log('cleanup:', runReport.cleanup.deleted ? 'ok' : 'FAILED');
  console.log('verdict:', report.verdict);
  console.log('report json:', REPORT_JSON_PATH.replace(REPO_ROOT, '.'));
  console.log('report md:', REPORT_MD_PATH.replace(REPO_ROOT, '.'));

  if (!runReport.cleanup.deleted) process.exitCode = 1;
}

/** One collection, indexed once (local BGE-M3 dense+sparse over the
 * mini-set's 1000 common-512 bodies), then dense-only + sparse-only once,
 * hybrid once per RRF k in RRF_KS_UNDER_TEST — same static collection and
 * prefetch specification, with only the fusion constant changed, matching
 * run-scifact.mjs's own no-redundant-reindexing design. */
export async function executeMiniRun({
  client,
  redact,
  corpus,
  queries,
  qrels,
  prepared,
  trackRss = () => {},
  embedBatch,
  writeTrecRun = (path, content) => writeFileSync(path, content, 'utf-8'),
}) {
  const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const collection = `${COLLECTION_PREFIX}local-rrf-mini-${suffix}`;

  const runReport = {
    collection,
    indexing: { wallMs: null, documentsIndexed: 0, batches: 0, errors: 0, retries: 0 },
    queryStats: {
      total: queries.size, ran: 0, errors: 0, retries: 0,
      latencyMs: { dense: [], sparse: [], hybrid_k2: [], hybrid_k60: [] },
    },
    metrics: {},
    trecRunPaths: {},
    cleanup: { attempted: false, deleted: false, collection, error: null },
    errors: [],
  };

  const idMap = buildIdMapping([...corpus.keys()], `${collection}:doc`);
  if (idMap.collisions.length > 0) {
    runReport.errors.push({ step: 'id_mapping', error: `${idMap.collisions.length} point-ID collisions detected — aborting run` });
    return runReport;
  }

  try {
    const docBodies = new Map([...prepared.documents].map(([docId, entry]) => [docId, entry.commonBody]));

    // Local profile: no modifier:idf on the sparse lane — matches
    // production schema (core/qdrant/schema.js) and run-scifact.mjs.
    const vectors = { dense: { size: LOCAL_PROFILE.denseSize, distance: 'Cosine' } };
    const sparse_vectors = { sparse: { index: { on_disk: false } } };
    const createRes = await withBoundedRetry(() => client.createCollection(collection, { vectors, sparse_vectors }));
    if (!createRes.ok) {
      runReport.errors.push({ step: 'create_collection', error: redact(createRes.err) });
      return runReport;
    }

    const indexStart = process.hrtime.bigint();
    const docIds = [...corpus.keys()];
    for (let i = 0; i < docIds.length; i += INDEX_BATCH_SIZE) {
      const batchIds = docIds.slice(i, i + INDEX_BATCH_SIZE);
      const bodies = batchIds.map((id) => docBodies.get(id));
      const embedRes = await timed(() => embedBatch(bodies));
      if (!embedRes.ok) {
        runReport.indexing.errors += 1;
        runReport.errors.push({ step: `embed_batch_${i}`, error: redact(embedRes.err) });
        runReport.indexing.batches += 1;
        continue;
      }
      const points = batchIds.map((docId, j) => {
        const { dense, sparse } = embedRes.value[j];
        return {
          id: idMap.toPoint.get(docId),
          payload: { beir_doc_id: docId, benchmark: 'beir-scifact-rrf-mini', profile: 'local' },
          vector: { dense, sparse: { indices: sparse.indices, values: sparse.values } },
        };
      });
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
        console.log(`[rrf-mini] indexed ${runReport.indexing.documentsIndexed}/${docIds.length}`);
        trackRss();
      }
    }
    runReport.indexing.wallMs = Number((process.hrtime.bigint() - indexStart) / 1000000n);
    console.log(`[rrf-mini] indexing complete: ${runReport.indexing.documentsIndexed} docs in ${runReport.indexing.wallMs}ms`);

    const emptyRun = () => new Map([...queries.keys()].map((qid) => [qid, []]));
    const denseRun = emptyRun();
    const sparseRun = emptyRun();
    const hybridRuns = new Map(RRF_KS_UNDER_TEST.map((k) => [k, emptyRun()]));

    let qi = 0;
    for (const queryId of queries.keys()) {
      qi += 1;
      const queryBody = prepared.queries.get(queryId)?.commonBody;
      if (typeof queryBody !== 'string') {
        runReport.queryStats.errors += 1;
        runReport.errors.push({ step: `prepare_query_${queryId}`, error: 'Prepared query body is missing' });
        continue;
      }

      const embedRes = await timed(() => embedBatch([queryBody]));
      if (!embedRes.ok) {
        runReport.queryStats.errors += 1;
        runReport.errors.push({ step: `embed_query_${queryId}`, error: redact(embedRes.err) });
        continue;
      }
      const { dense: qDense, sparse: qSparseRaw } = embedRes.value[0];
      const qSparse = { indices: qSparseRaw.indices, values: qSparseRaw.values };

      const denseQ = await withBoundedRetry(
        () => client.query(collection, { query: qDense, using: 'dense', limit: TOP_K, with_payload: false }),
        { onRetry: () => { runReport.queryStats.retries += 1; } }
      );
      const sparseQ = await withBoundedRetry(
        () => client.query(collection, { query: qSparse, using: 'sparse', limit: TOP_K, with_payload: false }),
        { onRetry: () => { runReport.queryStats.retries += 1; } }
      );

      const modeResults = [['dense', denseQ, denseRun], ['sparse', sparseQ, sparseRun]];
      for (const k of RRF_KS_UNDER_TEST) {
        const hybridQ = await withBoundedRetry(
          () => client.query(collection, {
            prefetch: [
              { query: qDense, using: 'dense', limit: HYBRID_PREFETCH_LIMIT },
              { query: qSparse, using: 'sparse', limit: HYBRID_PREFETCH_LIMIT },
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
      if (qi % 25 === 0) { console.log(`[rrf-mini] queries ${qi}/${queries.size}`); trackRss(); }
    }

    const toRankedMap = (scoredMap) => {
      const m = new Map();
      for (const [qid, docs] of scoredMap.entries()) m.set(qid, docs.map((d) => d.docId));
      return m;
    };
    runReport.metrics.dense = computeMetrics(qrels, toRankedMap(denseRun));
    runReport.metrics.sparse = computeMetrics(qrels, toRankedMap(sparseRun));
    for (const k of RRF_KS_UNDER_TEST) {
      runReport.metrics[`hybrid_k${k}`] = computeMetrics(qrels, toRankedMap(hybridRuns.get(k)));
    }

    const allModeStores = [['dense', denseRun], ['sparse', sparseRun], ...RRF_KS_UNDER_TEST.map((k) => [`hybrid_k${k}`, hybridRuns.get(k)])];
    for (const [label, scoredMap] of allModeStores) {
      const trecPath = join(RUNS_DIR, `local-rrf-mini-${label}.trec`);
      writeTrecRun(trecPath, toTrecRunFormat(scoredMap, `local-rrf-mini-${label}`));
      runReport.trecRunPaths[label] = trecPath.replace(RUNS_DIR, '.runs');
    }

    for (const label of ['dense', 'sparse', 'hybrid_k2', 'hybrid_k60']) {
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

function metricCell(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : 'n/a';
}

export function renderMarkdownReport(report) {
  const r = report.run;
  const k2 = r?.metrics?.hybrid_k2;
  const k60 = r?.metrics?.hybrid_k60;
  const lat = (label) => r?.queryStats?.latencyMs?.[label];
  const lines = [];
  lines.push('# Local RRF fusion-constant mini sensitivity check (k=2 vs k=60)');
  lines.push('');
  lines.push(`Verdict: **${report.verdict}**`);
  lines.push('');
  lines.push('This is a small, LOCAL-ONLY, deterministic SciFact pooled subset — not the');
  lines.push('full BEIR SciFact benchmark and not a change to the production `RRF_K`');
  lines.push('default. It exists only to check whether the RRF fusion constant matters');
  lines.push('for the current local BGE-M3 dense+sparse provider before touching');
  lines.push('production defaults.');
  lines.push('');
  lines.push('## Provenance');
  lines.push('');
  lines.push(`- Commit: ${report.commitHash ?? 'n/a'}`);
  lines.push(`- SciFact dataset MD5: ${report.miniSetManifest?.datasetMd5 ?? 'n/a'}`);
  for (const src of report.miniSetManifest?.sourceHashes ?? []) {
    lines.push(`- Hard-negative source ${src.path}: sha256 ${src.sha256}`);
  }
  lines.push(`- Mini-set selection seed: \`${report.miniSetManifest?.selectionSeed ?? 'n/a'}\` (schema v${report.miniSetManifest?.schemaVersion ?? 'n/a'})`);
  lines.push(`- Local dense model: ${report.scope.denseModelId} (size ${report.scope.denseSize}), sparse: ${report.scope.sparseModelId}`);
  lines.push(`- Qdrant SDK: ${report.environment.qdrantSdkVersion ?? 'n/a'}`);
  lines.push(`- Index batch size: ${report.scope.indexBatchSize}`);
  lines.push('');
  lines.push('## Mini-set construction');
  lines.push('');
  lines.push(`- Queries: ${report.miniSetStats.selectedQueryCount} (SHA-256-seeded deterministic shuffle of all 300 test`);
  lines.push('  queries, not a lexicographic-order slice — see build-rrf-mini-set.mjs).');
  lines.push(`- Relevant documents: ${report.miniSetStats.relevantDocCount} (union of qrels for the selected queries).`);
  lines.push(`- Hard negatives: ${report.miniSetStats.negativeDocCount} (round-robin from existing local-common-512 dense/sparse TREC runs).`);
  lines.push(`- Total corpus: ${report.miniSetStats.totalCorpusSize} documents (requested ${report.miniSetStats.requestedCorpusSize}, shortfall ${report.miniSetStats.shortfall}).`);
  lines.push(`- Dangling qrels references: ${report.miniSetStats.danglingQrelsRefs.length}.`);
  lines.push('');
  lines.push('## Retrieval quality (local BGE-M3, common-512)');
  lines.push('');
  lines.push('| Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | MRR@10 |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const [label, m] of [['dense', r?.metrics?.dense], ['sparse', r?.metrics?.sparse], ['hybrid_k2', k2], ['hybrid_k60', k60]]) {
    lines.push(`| ${label} | ${metricCell(m?.ndcgAt10)} | ${metricCell(m?.mapAt100)} | ${metricCell(m?.recallAt10)} | ${metricCell(m?.recallAt100)} | ${metricCell(m?.mrrAt10)} |`);
  }
  lines.push('');
  lines.push('### k=2 -> k=60 delta (positive = k=60 better)');
  lines.push('');
  lines.push('| Metric | k=2 | k=60 | delta |');
  lines.push('|---|---:|---:|---:|');
  for (const [label, extract] of [
    ['nDCG@10', (m) => m?.ndcgAt10], ['MAP@100', (m) => m?.mapAt100], ['Recall@10', (m) => m?.recallAt10],
    ['Recall@100', (m) => m?.recallAt100], ['MRR@10', (m) => m?.mrrAt10],
  ]) {
    const v2 = extract(k2); const v60 = extract(k60);
    const delta = typeof v2 === 'number' && typeof v60 === 'number' && Number.isFinite(v2) && Number.isFinite(v60) ? v60 - v2 : null;
    lines.push(`| ${label} | ${metricCell(v2)} | ${metricCell(v60)} | ${delta === null ? 'n/a' : (delta >= 0 ? '+' : '') + delta.toFixed(4)} |`);
  }
  lines.push('');
  lines.push('## Operations');
  lines.push('');
  lines.push(`- Indexed: ${r?.indexing?.documentsIndexed ?? 'n/a'} / ${report.scope.corpusSize}`);
  lines.push(`- Indexing wall time: ${r?.indexing?.wallMs ?? 'n/a'} ms`);
  lines.push(`- Query errors: ${r?.queryStats?.errors ?? 'n/a'}, retries: ${r?.queryStats?.retries ?? 'n/a'}`);
  lines.push(`- hybrid_k2 latency ms: p50=${lat('hybrid_k2')?.p50 ?? 'n/a'} p95=${lat('hybrid_k2')?.p95 ?? 'n/a'} max=${lat('hybrid_k2')?.max ?? 'n/a'}`);
  lines.push(`- hybrid_k60 latency ms: p50=${lat('hybrid_k60')?.p50 ?? 'n/a'} p95=${lat('hybrid_k60')?.p95 ?? 'n/a'} max=${lat('hybrid_k60')?.max ?? 'n/a'}`);
  lines.push(`- Peak process RSS: ${report.environment.peakRssBytes ?? 'n/a'} bytes`);
  lines.push(`- Cleanup: ${r?.cleanup?.deleted ? 'deleted' : 'FAILED'}`);
  lines.push('');
  lines.push('## Interpretation limits');
  lines.push('');
  lines.push('- FACT: values above are measured on a 1000-document / 100-query pooled');
  lines.push('  subset of the official English SciFact test split, not the full corpus.');
  lines.push('- FACT: this checks fusion-constant sensitivity only for the current local');
  lines.push('  BGE-M3 provider — it says nothing about the Qdrant Cloud profile.');
  lines.push('- HYPOTHESIS: any k preference seen here is not verified against the full');
  lines.push('  5183-document corpus or against multilingual/Ukrainian content.');
  lines.push('- The production `RRF_K` default is intentionally left unchanged by this');
  lines.push('  script; any default change is a separate, explicit decision.');
  lines.push('');
  return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    const redact = makeRedactor(process.env.QDRANT_KEY, REPO_ROOT);
    console.error('[rrf-mini] unhandled error:', redact(err));
    process.exitCode = 1;
  });
}
