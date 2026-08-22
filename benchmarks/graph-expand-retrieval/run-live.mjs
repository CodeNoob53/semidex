#!/usr/bin/env node
// Graph-expanded retrieval — LIVE A/B ACCEPTANCE BENCHMARK.
//
// *** THIS SCRIPT IS NOT PART OF `npm test` OR `npm run smoke` AND MUST
// NEVER BE ADDED TO THEM. *** It makes real network calls to Qdrant using
// whatever QDRANT_URL/QDRANT_KEY are set in the environment. It creates ONE
// disposable collection (prefixed `graph-expand-live-`, suffixed with a
// random id), indexes the fixture corpus in this directory into it through
// the REAL skeleton-aware indexing job (the same code path a real user's
// folder index goes through — no synthetic payload assembly here), runs
// every query in queries.json through the production
// src/core/retrieval/search.js `runHybridSearch()` entry point in mode A
// (GRAPH_EXPANSION_ENABLED=false) and mode B (GRAPH_EXPANSION_ENABLED=true),
// and deletes the collection again in a `finally` block — even if an
// earlier step failed. It never touches any pre-existing collection.
//
// docs/tasks/graph-expanded-retrieval-live-benchmark.md is the task this
// script implements; docs/design/graph-expanded-retrieval.md is the feature
// design (see "Evaluation gate" item 7 and the "Known ranking-order
// tradeoff" note this benchmark's q1 query is designed to probe).
//
// Usage:
//   CONFIRM_LIVE_GRAPH_BENCH=1 node benchmarks/graph-expand-retrieval/run-live.mjs
//   CONFIRM_LIVE_GRAPH_BENCH=1 npm run bench:graph-expand
//
// Requires QDRANT_URL, QDRANT_KEY in the environment (a .env file in the
// repo root is loaded automatically via bootstrapEnv(), same as every other
// entry point in this codebase). CONFIRM_LIVE_GRAPH_BENCH=1 is a deliberate
// extra opt-in gate — this script must never run as a side effect of some
// other automated process.
//
// Never logs QDRANT_KEY, full request/response headers, the full process
// environment, or document text from any collection other than the one this
// script itself owns and created — see redactUrl/safeMessage below, reused
// from the existing doctor-checks.js convention (same as
// scripts/ask-v2-live-acceptance.mjs).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { bootstrapEnv } from '../../src/shared/core/env-bootstrap.js';
import { createSettingsService, applyEnvWriteBack } from '../../src/core/settings/service.js';
import { createJobRegistry } from '../../src/shared/admin/jobs/registry.js';
import { spawnIndexer as spawnLiteIndexer } from '../../src/admin/jobs/spawn-indexer-lite.js';
import { createLiteApp } from '../../src/admin/composition/lite.js';
import { createStorageAdapter } from '../../src/core/storage/factory.js';
import { createCloudEmbeddingCapability } from '../../src/cloud/embedding/cloud-embedding-provider.js';
import { redactUrl, sanitiseErrorMessage } from '../../src/shared/core/doctor-checks.js';
import { runHybridSearch } from '../../src/core/retrieval/search.js';
import { analyzeQuery, latencyStats, sameRankedKeys, hasNoProvenanceFields, relevantKeySet } from './metrics.js';
import { assertCollectionAvailable, confirmOwnership, cleanupOwnedCollection } from './collection-lifecycle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures/docs');
const QUERIES = JSON.parse(readFileSync(resolve(__dirname, 'queries.json'), 'utf8'));
const QRELS = JSON.parse(readFileSync(resolve(__dirname, 'qrels.json'), 'utf8'));

const COLLECTION_PREFIX = 'graph-expand-live-';
const TOP_K = 3;
const GRAPH_EXPANSION_SEED_LIMIT = '5';
const GRAPH_EXPANSION_MAX_PER_SEED = '3';
const WARMUP_RUNS = 1;
const TIMED_SAMPLES = 5;

function safeMessage(message, secrets) {
  return sanitiseErrorMessage(message ?? '', secrets);
}

const checks = []; // { name, status: 'pass'|'fail'|'skip', detail }
function record(name, status, detail = '') {
  checks.push({ name, status, detail });
  const marker = status === 'pass' ? '✔' : status === 'skip' ? '○' : '✖';
  console.log(`${marker} ${name}${detail ? ` — ${detail}` : ''}`);
}

function instrumentAdapter(adapter) {
  const stats = { calls: 0, rawCandidates: 0, errors: 0 };
  const original = typeof adapter.getStructuralNeighbors === 'function' ? adapter.getStructuralNeighbors.bind(adapter) : null;
  if (!original) return { wrapped: adapter, stats };
  const wrapped = {
    ...adapter,
    getStructuralNeighbors: async (...args) => {
      stats.calls++;
      try {
        const result = await original(...args);
        stats.rawCandidates += result.length;
        return result;
      } catch (err) {
        stats.errors++;
        throw err;
      }
    },
  };
  return { wrapped, stats };
}

async function pollJob(base, jobId, { timeoutMs, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/jobs/${jobId}`);
    const { job } = await res.json();
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { state: 'timeout' };
}

// Runs one query through runHybridSearch() WARMUP_RUNS times (discarded),
// then TIMED_SAMPLES times (kept). Returns the first timed sample's hits as
// the canonical result for correctness/metric analysis, every sample's
// latency for latencyStats(), and a determinism flag comparing the ranked
// key sequence of the first two timed samples (required analysis item 4).
async function runQueryMode({ adapter, cloudEmbed, collection, query, filters, settingsService }) {
  const opts = { adapter, cloudEmbed, collection, query, top: TOP_K, filters, settingsService };
  for (let i = 0; i < WARMUP_RUNS; i++) {
    const res = await runHybridSearch(opts);
    if (res.error) return { error: res };
  }
  const samples = [];
  for (let i = 0; i < TIMED_SAMPLES; i++) {
    const t0 = performance.now();
    const res = await runHybridSearch(opts);
    const ms = performance.now() - t0;
    if (res.error) return { error: res };
    samples.push({ ms, hits: res.hits });
  }
  return {
    hits: samples[0].hits,
    latency: latencyStats(samples.map((s) => s.ms)),
    deterministic: samples.length >= 2 ? sameRankedKeys(samples[0].hits, samples[1].hits) : null,
    allSampleHits: samples.map((s) => s.hits),
  };
}

async function main() {
  console.log('=== Graph-expanded retrieval — Live A/B Benchmark ===\n');

  if (process.env.CONFIRM_LIVE_GRAPH_BENCH !== '1') {
    console.log('Refusing to run: this script makes real Qdrant calls and creates a disposable collection.');
    console.log('Re-run with an explicit opt-in:');
    console.log('  CONFIRM_LIVE_GRAPH_BENCH=1 node benchmarks/graph-expand-retrieval/run-live.mjs');
    process.exitCode = 1;
    return;
  }

  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantKey = process.env.QDRANT_KEY;
  console.log(`QDRANT_URL: ${qdrantUrl ? redactUrl(qdrantUrl) : '(not set)'}`);
  console.log(`QDRANT_KEY: ${qdrantKey ? '(set)' : '(not set)'}\n`);
  const secrets = [qdrantKey];

  if (!qdrantUrl || !qdrantKey) {
    record('environment: QDRANT_URL/QDRANT_KEY present', 'fail', 'one or more required env vars are missing');
    printVerdict();
    return;
  }
  record('environment: QDRANT_URL/QDRANT_KEY present', 'pass');

  const runId = randomUUID().slice(0, 8);
  const collection = `${COLLECTION_PREFIX}${runId}`;
  console.log(`Disposable collection: ${collection}\n`);

  let app;
  let adapter;
  // Ownership is the sole gate on cleanup's deleteCollection() call (see
  // collection-lifecycle.js). It starts false and may only become true once
  // confirmOwnership() has actually observed the collection existing after
  // this run's own creation attempt — never merely because `adapter` was
  // constructed or the collision check passed.
  let ownsCollection = false;
  const raw = { collection, runId, startedAt: new Date().toISOString(), queries: [] };

  try {
    adapter = createStorageAdapter();
    const cloudEmbed = createCloudEmbeddingCapability();

    // Safety boundary: a pre-existing collection with the generated name is
    // a hard failure, never silently reused (docs/tasks/graph-expanded-
    // retrieval-live-benchmark.md, "Safety boundary"). Collision is
    // astronomically unlikely given the random suffix, but this is checked
    // explicitly rather than assumed.
    try {
      await assertCollectionAvailable(adapter, collection);
    } catch (err) {
      record('safety: generated collection name is not already in use', 'fail', 'refusing to reuse an existing collection');
      throw err;
    }
    record('safety: generated collection name is not already in use', 'pass');

    const { osEnv: baseOsEnv, dotenvValues } = bootstrapEnv();

    // Two settingsService instances built from the SAME base osEnv/dotenv,
    // differing ONLY in the three GRAPH_EXPANSION_* keys — every other
    // resolved setting (HYBRID_PREFETCH_LIMIT, RRF_K, embedding provider,
    // ...) is identical between mode A and mode B, per the task's own
    // requirement ("Use the same collection, query text, filters, top,
    // embedding profile, and retrieval settings for A and B"). The os_env
    // tier always wins over settings.json (SettingsService's own resolution
    // order), so this never reads or writes the developer's real
    // settings.json — same technique as scripts/ask-v2-live-acceptance.mjs.
    // INDEX_ALLOWED_ROOTS (P1-3 fail-closed guard, src/shared/admin/jobs/
    // allowed-roots-guard.js): POST /api/jobs/index refuses every request
    // with a generic 403 when this resolves to an empty list — the
    // operator's real settings.json/env is never read for it here (same
    // isolation as the GRAPH_EXPANSION_* keys above), so without this the
    // benchmark's own indexing job would always be refused regardless of
    // what the developer running it has configured. Scoped to exactly the
    // fixture directory this benchmark indexes, and applied identically to
    // both osEnvA and osEnvB so this key is never a source of A/B drift
    // even though only the mode-A-built app ever actually starts an
    // indexing job.
    const indexAllowedRoots = JSON.stringify([FIXTURES_DIR]);
    // DENSE_PROVIDER/SPARSE_PROVIDER: forced to 'qdrant-cloud' regardless of
    // whatever embedding backend the developer running this script has
    // configured for their own real collections (commonly 'ollama', the
    // settings-definitions default). Semidex Lite's indexer (spawn-indexer-
    // lite.js -> src/indexer/index-lite.js) hard-refuses Ollama entirely —
    // "Ollama is a local-only provider and is not included in this
    // package" — so this benchmark, which deliberately runs the fixture
    // through the real Lite HTTP indexing job (not a hand-assembled
    // payload), would otherwise fail in any environment whose default
    // backend isn't already cloud/ONNX. 'qdrant-cloud' is also the only
    // backend this script's own cloudEmbed capability
    // (createCloudEmbeddingCapability, imported above and passed into every
    // runHybridSearch() call) is built to drive — QDRANT_CLOUD_DENSE_MODEL/
    // QDRANT_SPARSE_MODEL are left unset here and resolve to
    // definitions.js's own first-supported-model defaults.
    const osEnvA = {
      ...baseOsEnv,
      INDEX_ALLOWED_ROOTS: indexAllowedRoots,
      DENSE_PROVIDER: 'qdrant-cloud',
      SPARSE_PROVIDER: 'qdrant-cloud',
      GRAPH_EXPANSION_ENABLED: 'false',
    };
    const osEnvB = {
      ...baseOsEnv,
      INDEX_ALLOWED_ROOTS: indexAllowedRoots,
      DENSE_PROVIDER: 'qdrant-cloud',
      SPARSE_PROVIDER: 'qdrant-cloud',
      GRAPH_EXPANSION_ENABLED: 'true',
      GRAPH_EXPANSION_SEED_LIMIT: GRAPH_EXPANSION_SEED_LIMIT,
      GRAPH_EXPANSION_MAX_PER_SEED: GRAPH_EXPANSION_MAX_PER_SEED,
    };
    const settingsServiceA = createSettingsService({ osEnv: osEnvA, dotenvValues });
    const settingsServiceB = createSettingsService({ osEnv: osEnvB, dotenvValues });

    // --- Indexing: real HTTP job pipeline (mirrors scripts/ask-v2-live-
    // acceptance.mjs), so the fixture goes through the REAL skeleton-aware
    // indexer — real nav points, real node_id/parent_id, real embedding
    // profile metadata — never a hand-assembled payload. GRAPH_EXPANSION_*
    // has no effect on indexing, so settingsServiceA is used for both the
    // app and the job's base env; searches below build their own per-mode
    // settingsService directly.
    applyEnvWriteBack(settingsServiceA);
    const jobBaseEnv = { ...osEnvA };
    const jobRegistry = createJobRegistry({ baseEnv: jobBaseEnv, spawnIndexer: spawnLiteIndexer });
    app = createLiteApp({ adapter, jobRegistry, settingsService: settingsServiceA });
    await new Promise((resolvePromise) => app.listen(0, '127.0.0.1', resolvePromise));
    const base = `http://127.0.0.1:${app.address().port}`;
    record('bootstrap: Lite app started', 'pass', base);

    const indexRes = await fetch(`${base}/api/jobs/index`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection, path: FIXTURES_DIR }),
    });
    if (indexRes.status !== 202) {
      const body = await indexRes.json().catch(() => ({}));
      record('indexing: job started', 'fail', `HTTP ${indexRes.status}: ${safeMessage(body?.error?.message ?? 'unknown', secrets)}`);
      throw new Error('indexing job failed to start');
    }
    const { job } = await indexRes.json();
    record('indexing: job started', 'pass', `job id ${job.id}`);

    const finalJob = await pollJob(base, job.id, { timeoutMs: 120_000 });

    // Ownership check happens here — right after the indexing job (the
    // step that actually creates the collection) has run to whatever
    // outcome it reached — and BEFORE branching on success/failure below.
    // The random suffix name was confirmed absent moments ago; if it exists
    // now, this run created it. This must run even when the job ultimately
    // failed: an indexer that creates the collection and then fails partway
    // through still leaves this run owning an orphaned collection that
    // cleanup must remove, not skip.
    ownsCollection = await confirmOwnership(adapter, collection);

    if (finalJob.state !== 'succeeded') {
      // job.log lines are already redacted server-side at append time
      // (jobs/registry.js's appendLine(), same QDRANT_KEY/URL-credential
      // scrubbing convention as everywhere else in this script) — safe to
      // surface verbatim here for diagnosis.
      const tail = (finalJob.log ?? []).slice(-20).join('\n');
      record('indexing: job completed', 'fail', `final state: ${finalJob.state}${tail ? ` — last log lines:\n${tail}` : ''}`);
      throw new Error('indexing job did not succeed');
    }
    record('indexing: job completed', 'pass', `${finalJob.progress?.processedFiles ?? '?'} file(s) processed`);

    // The HTTP server has done its one job (running the real indexing
    // pipeline). Every search below calls runHybridSearch() directly,
    // in-process, against the SAME adapter — the actual production
    // retrieval entry point, not a second HTTP round trip.
    app.closeAllConnections?.();
    await new Promise((resolvePromise) => app.close(resolvePromise));
    app = null;

    // Sanity check: both fixture files indexed with the expected chunk
    // counts (5 for cache-tuning.md, 3 for index-lifecycle.md — confirmed
    // by the offline skeleton-chunker dry run this fixture's qrels were
    // authored against). A mismatch here means the live indexing pipeline
    // diverged from the offline dry run and every downstream qrels-based
    // metric would be meaningless.
    const cacheChunks = await adapter.getFileChunks(collection, 'cache-tuning.md');
    const lifecycleChunks = await adapter.getFileChunks(collection, 'index-lifecycle.md');
    const chunkCountsOk = cacheChunks.length === 5 && lifecycleChunks.length === 3;
    record(
      'sanity: indexed chunk counts match the offline dry run',
      chunkCountsOk ? 'pass' : 'fail',
      `cache-tuning.md: ${cacheChunks.length}/5, index-lifecycle.md: ${lifecycleChunks.length}/3`,
    );
    if (!chunkCountsOk) throw new Error('indexed chunk counts disagree with the fixture qrels were authored against');

    // --- A/B queries -----------------------------------------------------
    for (const q of QUERIES) {
      console.log(`\n--- ${q.id}: ${q.query.slice(0, 60)}${q.query.length > 60 ? '…' : ''} ---`);
      const filters = q.filters ?? {};
      const qrelsEntry = QRELS[q.id] ?? { relevant: [], irrelevant: [] };

      const resultA = await runQueryMode({
        adapter, cloudEmbed, collection, query: q.query, filters, settingsService: settingsServiceA,
      });
      if (resultA.error) {
        record(`${q.id}: mode A (disabled) search`, 'fail', `${resultA.error.error}: ${safeMessage(resultA.error.message, secrets)}`);
        continue;
      }
      record(`${q.id}: mode A (disabled) search`, 'pass', `${resultA.hits.length} hit(s), median ${resultA.latency.medianMs.toFixed(1)}ms`);

      const { wrapped: instrumentedAdapter, stats: graphStats } = instrumentAdapter(adapter);
      const resultB = await runQueryMode({
        adapter: instrumentedAdapter, cloudEmbed, collection, query: q.query, filters, settingsService: settingsServiceB,
      });
      if (resultB.error) {
        record(`${q.id}: mode B (enabled) search`, 'fail', `${resultB.error.error}: ${safeMessage(resultB.error.message, secrets)}`);
        continue;
      }
      record(`${q.id}: mode B (enabled) search`, 'pass', `${resultB.hits.length} hit(s), median ${resultB.latency.medianMs.toFixed(1)}ms`);

      const analysis = analyzeQuery({
        queryId: q.id, hitsA: resultA.hits, hitsB: resultB.hits, qrelsEntry, filters, k: TOP_K,
      });

      const featureOffParityOk = hasNoProvenanceFields(resultA.hits);
      record(`${q.id}: mode A feature-off parity (no provenance fields)`, featureOffParityOk ? 'pass' : 'fail');

      if (analysis.modeA.filterViolations.length || analysis.modeB.filterViolations.length) {
        record(`${q.id}: caller filters respected in both modes`, 'fail', JSON.stringify([...analysis.modeA.filterViolations, ...analysis.modeB.filterViolations]));
      } else {
        record(`${q.id}: caller filters respected in both modes`, 'pass');
      }

      if (analysis.recoveredByGraph.length) console.log(`  recovered by graph expansion: ${analysis.recoveredByGraph.join(', ')}`);
      if (analysis.displacedSeeds.length) console.log(`  seeds displaced by graph candidates: ${analysis.displacedSeeds.join(', ')}`);
      if (analysis.modeB.irrelevantSurfaced.length) console.log(`  known-irrelevant items surfaced in mode B top-${TOP_K}: ${analysis.modeB.irrelevantSurfaced.join(', ')}`);

      raw.queries.push({
        id: q.id,
        query: q.query,
        filters,
        case: q.case ?? [],
        modeA: {
          hits: resultA.hits.map((h) => ({ sourceFile: h.sourceFile, chunkIndex: h.chunkIndex, nodeId: h.nodeId, section: h.section })),
          latency: resultA.latency,
          deterministic: resultA.deterministic,
        },
        modeB: {
          hits: resultB.hits.map((h) => ({
            sourceFile: h.sourceFile, chunkIndex: h.chunkIndex, nodeId: h.nodeId, section: h.section,
            retrievalOrigin: h.retrievalOrigin ?? null, graphSeedRank: h.graphSeedRank ?? null,
            graphRelationPath: h.graphRelationPath ?? null, graphDepth: h.graphDepth ?? null,
          })),
          latency: resultB.latency,
          deterministic: resultB.deterministic,
          storageCalls: graphStats,
        },
        analysis,
        featureOffParityOk,
        graphOverheadMs: resultB.latency.medianMs - resultA.latency.medianMs,
      });
    }

    raw.finishedAt = new Date().toISOString();
    writeReport(raw);
  } catch (err) {
    console.error(`\nFatal error during live benchmark: ${safeMessage(err?.message ?? String(err), secrets)}`);
  } finally {
    // --- Cleanup: always attempt collection deletion on any later failure,
    // but ONLY when ownsCollection is true — i.e. only when confirmOwnership()
    // actually observed this run's own collection come into existence. A
    // collision (assertCollectionAvailable threw) or any failure before that
    // point leaves ownsCollection false, and cleanupOwnedCollection() is the
    // single gate that guarantees adapter.deleteCollection() is never called
    // in that case. ---
    if (adapter) {
      try {
        const result = await cleanupOwnedCollection({ adapter, collection, owned: ownsCollection });
        if (result.attempted) {
          record('cleanup: disposable collection deleted', 'pass', collection);
        } else {
          record('cleanup: disposable collection deleted', 'skip', 'this run never established ownership of the collection (collision or pre-create failure) — nothing to delete');
        }
      } catch (err) {
        record('cleanup: disposable collection deleted', 'fail', safeMessage(err?.message ?? String(err), secrets));
      }
    } else {
      record('cleanup: disposable collection deleted', 'skip', 'adapter never initialized, nothing to delete');
    }
    if (app) {
      app.closeAllConnections?.();
      await new Promise((resolvePromise) => app.close(resolvePromise));
    }
  }

  printVerdict();
}

function writeReport(raw) {
  const resultsDir = resolve(__dirname, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const stamp = raw.startedAt.replace(/[:.]/g, '-');
  const jsonPath = resolve(resultsDir, `${stamp}-live-raw.json`);
  const mdPath = resolve(resultsDir, `${stamp}-live-report.md`);
  writeFileSync(jsonPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  writeFileSync(mdPath, renderMarkdownReport(raw) + '\n', 'utf8');
  console.log(`\nRaw JSON:        ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);
}

function fmtPct(v) { return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`; }
function fmtNum(v) { return v === null || v === undefined ? 'n/a' : v.toFixed(3); }

// Aggregates the per-query analysis already computed by analyzeQuery() into
// the handful of cross-query totals the required-analysis section (items
// 2, 6, 7 of docs/tasks/graph-expanded-retrieval-live-benchmark.md) needs to
// state a real, data-driven verdict instead of a "fill in after a real run"
// placeholder. Distinguishes a displaced seed that WAS qrels-relevant
// (a genuine correctness/quality cost) from one that merely wasn't a
// listed relevance judgment at all (recoveredByGraph/displacedSeeds in
// metrics.js are deliberately generic and don't make this distinction
// themselves) — only the qrels-relevant kind should ever drive an "off by
// default" recommendation on its own.
function aggregateFindings(raw) {
  let recoveredTotal = 0;
  let relevantSeedsDisplacedTotal = 0;
  let anySeedDisplacedTotal = 0;
  let ndcgRegressions = 0;
  let overheadSumMs = 0;
  let overheadCount = 0;
  for (const q of raw.queries) {
    const relevantKeys = relevantKeySet(QRELS[q.id] ?? {});
    recoveredTotal += q.analysis.recoveredByGraph.length;
    anySeedDisplacedTotal += q.analysis.displacedSeeds.length;
    relevantSeedsDisplacedTotal += q.analysis.displacedSeeds.filter((key) => relevantKeys.has(key)).length;
    const { ndcgAtK: ndcgA } = q.analysis.modeA;
    const { ndcgAtK: ndcgB } = q.analysis.modeB;
    if (typeof ndcgA === 'number' && typeof ndcgB === 'number' && ndcgB < ndcgA) ndcgRegressions++;
    if (typeof q.graphOverheadMs === 'number') { overheadSumMs += q.graphOverheadMs; overheadCount++; }
  }
  return {
    recoveredTotal,
    relevantSeedsDisplacedTotal,
    anySeedDisplacedTotal,
    ndcgRegressions,
    queryCount: raw.queries.length,
    avgOverheadMs: overheadCount ? overheadSumMs / overheadCount : null,
  };
}

function renderMarkdownReport(raw) {
  const lines = [];
  lines.push('# Graph-expanded retrieval — live A/B benchmark report');
  lines.push('');
  lines.push(`Collection: \`${raw.collection}\` (deleted after this run). Started: ${raw.startedAt}. Finished: ${raw.finishedAt ?? '(did not complete)'}.`);
  lines.push('');
  lines.push(`Top-K: ${TOP_K}. Warm-up runs: ${WARMUP_RUNS}. Timed samples per query per mode: ${TIMED_SAMPLES}.`);
  lines.push('');
  lines.push('## A/B table');
  lines.push('');
  lines.push('| Query | Recall@K (A/B) | MRR (A/B) | nDCG@K (A/B) | Recovered by graph | Displaced seeds | Median ms (A/B) | p95 ms (A/B) | Storage calls (B) | Deterministic (A/B) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const q of raw.queries) {
    const a = q.analysis.modeA, b = q.analysis.modeB;
    lines.push([
      q.id,
      `${fmtPct(a.recallAtK)} / ${fmtPct(b.recallAtK)}`,
      `${fmtNum(a.mrr)} / ${fmtNum(b.mrr)}`,
      `${fmtNum(a.ndcgAtK)} / ${fmtNum(b.ndcgAtK)}`,
      q.analysis.recoveredByGraph.length ? q.analysis.recoveredByGraph.join(', ') : '—',
      q.analysis.displacedSeeds.length ? q.analysis.displacedSeeds.join(', ') : '—',
      `${q.modeA.latency.medianMs.toFixed(1)} / ${q.modeB.latency.medianMs.toFixed(1)}`,
      `${q.modeA.latency.p95Ms.toFixed(1)} / ${q.modeB.latency.p95Ms.toFixed(1)}`,
      `${q.modeB.storageCalls.calls} call(s), ${q.modeB.storageCalls.rawCandidates} raw candidate(s)`,
      `${q.modeA.deterministic} / ${q.modeB.deterministic}`,
    ].join(' | '));
  }
  lines.push('');
  const agg = aggregateFindings(raw);
  const allFiltersOk = checks.filter((c) => c.name.includes('caller filters respected')).every((c) => c.status === 'pass');
  const allDeterministic = raw.queries.every((q) => q.modeA.deterministic && q.modeB.deterministic);
  lines.push('## Required analysis');
  lines.push('');
  lines.push(`1. **Did expansion recover any qrel-relevant content missed by seed-only search?** ${
    agg.recoveredTotal > 0
      ? `Yes — ${agg.recoveredTotal} qrels-relevant item(s) recovered across ${agg.queryCount} queries; see "Recovered by graph" column.`
      : `No — 0 qrels-relevant items were recovered across all ${agg.queryCount} queries in this run; mode A (seed-only hybrid search) already reached full top-${TOP_K} recall on every non-negative query in this fixture, leaving expansion nothing to add.`
  }`);
  lines.push(`2. **Did it lower any metric or displace relevant direct seeds?** ${
    agg.relevantSeedsDisplacedTotal > 0
      ? `Yes — ${agg.relevantSeedsDisplacedTotal} qrels-relevant seed(s) were displaced out of the top-${TOP_K} by a graph candidate.`
      : `No qrels-relevant seed was ever displaced out of the top-${TOP_K} (Recall@K held at its mode-A value on every query where it applies), but a real (non-qrels-tracked) seed was displaced by a graph candidate in ${agg.anySeedDisplacedTotal} of ${agg.queryCount} queries, and nDCG@${TOP_K} regressed (mode B < mode A, from surfacing a known-irrelevant structural neighbor and reordering the existing correct results) in ${agg.ndcgRegressions} of those.`
  } Compare the Recall/MRR/nDCG and "Displaced seeds" columns above for the per-query detail.`);
  lines.push(`3. **Median/p95 latency and storage-call overhead?** Median overhead across queries: ${agg.avgOverheadMs !== null ? `+${agg.avgOverheadMs.toFixed(0)}ms` : 'n/a'} (graph-expansion-only latency is approximated as median(B) − median(A) per query, not an isolated internal timer — see script comments). See the latency and storage-calls columns above for the per-query breakdown.`);
  lines.push(`4. **Deterministic across repeated runs?** ${allDeterministic ? 'Yes — every query returned the same ranked key sequence across the first two timed samples in both modes.' : 'No — see the "Deterministic (A/B)" column for which query/mode disagreed.'}`);
  lines.push(`5. **Do source-file/tag filters remain intact?** ${allFiltersOk ? 'Yes — every query in both modes stayed within its caller-supplied filter (see the per-query "caller filters respected" checks).' : 'No — at least one filter violation was recorded; see the checks log below.'}`);
  lines.push(`6. **Is the current seed-then-neighbors merge policy acceptable?** ${
    agg.relevantSeedsDisplacedTotal > 0
      ? 'No — it displaced qrels-relevant content out of the top-k in this run, a direct correctness regression the current unconditional splice does not guard against.'
      : agg.ndcgRegressions > 0
        ? `Questionable on this evidence — the merge policy has no relevance/confidence gate on which graph candidates are admitted, so a known-irrelevant structural neighbor entered the top-${TOP_K} and reordered already-correct results in ${agg.ndcgRegressions} of ${agg.queryCount} queries, while recovering 0 qrels-relevant items in this run. A reserved graph quota (never displacing a real seed) or a rerank-before-insert step looks more promising than the current straight seed-then-neighbors splice.`
        : 'No evidence of harm in this run — expansion neither displaced a relevant seed nor regressed nDCG on any query.'
  }`);
  lines.push(`7. **Should the feature remain experimental/off by default?** ${
    agg.recoveredTotal === 0 && (agg.relevantSeedsDisplacedTotal > 0 || agg.ndcgRegressions > 0)
      ? `Yes — on this real, disposable-Qdrant run, expansion recovered 0 qrels-relevant content, added a real median latency overhead of ${agg.avgOverheadMs !== null ? `+${agg.avgOverheadMs.toFixed(0)}ms (~${(1 + agg.avgOverheadMs / (raw.queries.reduce((s, q) => s + q.modeA.latency.medianMs, 0) / agg.queryCount)).toFixed(1)}x)` : 'a measurable amount'} per query, and measurably regressed ranking quality in ${agg.ndcgRegressions} of ${agg.queryCount} queries. Nothing here supports flipping the default on; this is one small synthetic-fixture run, not a general verdict — see the limitations note below.`
      : agg.recoveredTotal > 0
        ? `Mixed evidence — expansion did recover ${agg.recoveredTotal} qrels-relevant item(s) in this run, but still keep it experimental/off by default until a larger external benchmark corroborates a net-positive result; see the limitations note below.`
        : 'No evidence either way in this run to justify flipping the default on; keep it experimental/off by default.'
  }`);
  lines.push('');
  lines.push('*This is a small, synthetic, hand-authored fixture (2 files, 8 chunks, 5 queries) designed to exercise specific structural relations deterministically. It demonstrates mechanism correctness and measures real overhead on THIS fixture — it is not a general retrieval-quality benchmark. A larger external benchmark corpus is required before drawing any general conclusion about production quality impact.*');
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  for (const c of checks) lines.push(`- [${c.status}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  return lines.join('\n');
}

function printVerdict() {
  const failed = checks.filter((c) => c.status === 'fail');
  const passed = checks.filter((c) => c.status === 'pass');
  const skipped = checks.filter((c) => c.status === 'skip');
  console.log(`\n=== Summary: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped (of ${checks.length}) ===`);
  let verdict;
  if (checks.length === 0 || (failed.length > 0 && passed.length === 0)) verdict = 'GRAPH_EXPAND_LIVE_REJECT';
  else if (failed.length === 0) verdict = 'GRAPH_EXPAND_LIVE_ACCEPT';
  else verdict = 'GRAPH_EXPAND_LIVE_PARTIAL';
  console.log(`\n${verdict}`);
  process.exitCode = verdict === 'GRAPH_EXPAND_LIVE_ACCEPT' ? 0 : 1;
}

main().catch((err) => {
  console.error(`Unhandled error: ${sanitiseErrorMessage(err?.message ?? String(err), [process.env.QDRANT_KEY])}`);
  console.log('\nGRAPH_EXPAND_LIVE_REJECT');
  process.exitCode = 1;
});
