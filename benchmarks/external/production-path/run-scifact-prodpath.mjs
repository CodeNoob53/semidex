#!/usr/bin/env node
// Production-path benchmark: SciFact (BEIR) suite. English external
// retrieval baseline through the REAL indexer + runHybridSearch()
// production path. Reuses benchmarks/external/beir/fetch-scifact.mjs
// verbatim for dataset fetch/validation — never reimplemented.
//
// Reports HYBRID ONLY (runHybridSearch() has no dense-only/sparse-only
// mode). For a dense/sparse lane breakdown on the SAME SciFact corpus,
// see the EXISTING benchmarks/external/beir/run-scifact.mjs raw-client
// results — that is non-production-path context, not part of this
// harness's own measurement.
//
// Usage:
//   node benchmarks/external/production-path/run-scifact-prodpath.mjs [--smoke] [--pilot] [--resume] [--resume-check] [--restart] [--cuda]
import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { fetchAndValidateScifact } from '../beir/fetch-scifact.mjs';
import { runSuiteAcrossProfiles } from './core/run-suite.mjs';
import { runIndexer } from './core/index-via-cli.mjs';
import { queryOne } from './core/query-via-search.mjs';
import { checkpointPathFor, loadCheckpointIfExists, isCompletedProfileRun } from './core/checkpoint.mjs';
import { redact } from './core/redact.mjs';
import { buildAndCachePilotSubset } from './core/pilot-subset.mjs';
import { pairedBootstrapByQuery, perQueryMetrics } from '../miracl/bootstrap.mjs';

export const SUITE_ID = 'scifact';

function toMarkdown(doc) {
  return `# ${doc.title}\n\n${doc.text}`;
}

/** --smoke: 2 queries + every doc their qrels judge + a couple of
 * distractors — tiny plumbing check, never used for the runtime
 * estimate (that's --pilot's job, a real qrels-validated subset). */
function shrinkForSmoke({ corpus, queries, qrels }) {
  const testQids = [...queries.keys()].slice(0, 2);
  const keepDocIds = new Set();
  for (const qid of testQids) {
    const qr = qrels.get(qid);
    if (qr) for (const docId of qr.keys()) keepDocIds.add(docId);
  }
  for (const docId of corpus.keys()) {
    if (keepDocIds.size >= 8) break;
    keepDocIds.add(docId);
  }
  return {
    corpus: new Map([...corpus.entries()].filter(([id]) => keepDocIds.has(id))),
    queries: new Map(testQids.map((qid) => [qid, queries.get(qid)])),
    qrels: new Map(testQids.map((qid) => [qid, qrels.get(qid)])),
  };
}

export async function runScifactSuite({ smoke = false, pilot = false, resume = false, restart = false, resumeCheck = false, cudaRequested = false, log = console.log } = {}) {
  if (resumeCheck) {
    const path = checkpointPathFor(SUITE_ID, { smoke });
    const checkpoint = loadCheckpointIfExists(path);
    if (!checkpoint) { log(`No checkpoint at ${path}.`); return null; }
    for (const [profileId, block] of Object.entries(checkpoint.profiles ?? {})) {
      log(`${profileId}: ${isCompletedProfileRun(block, {}) ? 'COMPLETE' : 'INCOMPLETE'}`);
    }
    return checkpoint;
  }

  log('[scifact] fetching/validating dataset (cached after first run)...');
  const fullDataset = await fetchAndValidateScifact({ log });

  let dataset;
  let datasetFingerprint;
  if (smoke) {
    dataset = shrinkForSmoke(fullDataset);
    datasetFingerprint = 'scifact-smoke-v1';
  } else if (pilot) {
    dataset = buildAndCachePilotSubset(fullDataset);
    datasetFingerprint = dataset.fingerprint;
    log(`[scifact] pilot subset: ${dataset.corpus.size} docs, ${dataset.queries.size} queries`);
  } else {
    dataset = fullDataset;
    datasetFingerprint = fullDataset.validation?.stats ? `scifact-full-${fullDataset.validation.stats.corpusSize}-${fullDataset.validation.stats.queryCount}` : 'scifact-full';
  }

  const adapter = createStorageAdapter();
  const { state, rankedRunsByProfile } = await runSuiteAcrossProfiles({
    suiteId: SUITE_ID,
    datasetFingerprint,
    corpus: dataset.corpus, queries: dataset.queries, qrels: dataset.qrels, toMarkdown,
    smoke, resume, restart, cudaRequested,
    adapter, runIndexer, queryOne,
    log: (msg) => log(redact(msg)),
  });

  // The one place local-hybrid vs cloud-hybrid gets a real statistical
  // comparison — reused identically by the MIRACL/Slavic runners.
  if (rankedRunsByProfile.local && rankedRunsByProfile.cloud) {
    const perQueryLocal = perQueryMetrics(dataset.qrels, rankedRunsByProfile.local);
    const perQueryCloud = perQueryMetrics(dataset.qrels, rankedRunsByProfile.cloud);
    state.bootstrapComparison = {};
    for (const metricKey of ['ndcgAt10', 'mapAt100', 'recallAt10', 'recallAt100', 'mrrAt10']) {
      state.bootstrapComparison[metricKey] = pairedBootstrapByQuery(perQueryLocal, perQueryCloud, metricKey);
    }
  }

  return state;
}

async function main() {
  const smoke = process.argv.includes('--smoke');
  const pilot = process.argv.includes('--pilot');
  const resume = process.argv.includes('--resume') || process.argv.includes('--resume-check');
  const resumeCheck = process.argv.includes('--resume-check');
  const restart = process.argv.includes('--restart');
  const cudaRequested = process.argv.includes('--cuda');

  if (smoke && pilot) throw new Error('Use either --smoke or --pilot, not both.');

  if (!process.env.QDRANT_URL || !process.env.QDRANT_KEY) {
    console.log('LIVE_BLOCKED: QDRANT_URL/QDRANT_KEY not set.');
    process.exitCode = 1;
    return;
  }

  const state = await runScifactSuite({ smoke, pilot, resume, restart, resumeCheck, cudaRequested });
  if (state) {
    console.log(`\nverdict: ${state.verdict}`);
    if (state.bootstrapComparison) console.log('bootstrap comparison:', JSON.stringify(state.bootstrapComparison, null, 2));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
