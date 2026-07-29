#!/usr/bin/env node
// Production-path benchmark: MIRACL Russian suite. External Cyrillic
// retrieval validation through the REAL indexer + runHybridSearch()
// production path. Reuses buildAndCacheMiraclSubset() verbatim — the
// existing deterministic 100-query/1000-passage pooled subset. NEVER
// calls fetchCorpusPassages against the full multi-million-document
// corpus directly; this function's own contract already caps the corpus.
//
// Usage:
//   node benchmarks/external/production-path/run-miracl-ru-prodpath.mjs [--smoke] [--resume] [--resume-check] [--restart] [--cuda]
import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { buildAndCacheMiraclSubset } from '../miracl/build-miracl-subset.mjs';
import { pairedBootstrapByQuery, perQueryMetrics } from '../miracl/bootstrap.mjs';
import { runSuiteAcrossProfiles } from './core/run-suite.mjs';
import { runIndexer } from './core/index-via-cli.mjs';
import { queryOne } from './core/query-via-search.mjs';
import { checkpointPathFor, loadCheckpointIfExists, isCompletedProfileRun } from './core/checkpoint.mjs';
import { redact } from './core/redact.mjs';

export const SUITE_ID = 'miracl-ru';

function toMarkdown(doc) {
  return doc.title ? `# ${doc.title}\n\n${doc.text}` : doc.text;
}

function shrinkForSmoke({ corpus, queries, qrels }) {
  const qids = [...queries.keys()].slice(0, 2);
  const keepDocIds = new Set();
  for (const qid of qids) {
    const qr = qrels.get(qid);
    if (qr) for (const docId of qr.keys()) keepDocIds.add(docId);
  }
  for (const docId of corpus.keys()) {
    if (keepDocIds.size >= 8) break;
    keepDocIds.add(docId);
  }
  return {
    corpus: new Map([...corpus.entries()].filter(([id]) => keepDocIds.has(id))),
    queries: new Map(qids.map((qid) => [qid, queries.get(qid)])),
    qrels: new Map(qids.map((qid) => [qid, qrels.get(qid)])),
  };
}

export async function runMiraclRuSuite({ smoke = false, resume = false, restart = false, resumeCheck = false, cudaRequested = false, log = console.log } = {}) {
  if (resumeCheck) {
    const path = checkpointPathFor(SUITE_ID, { smoke });
    const checkpoint = loadCheckpointIfExists(path);
    if (!checkpoint) { log(`No checkpoint at ${path}.`); return null; }
    for (const [profileId, block] of Object.entries(checkpoint.profiles ?? {})) {
      log(`${profileId}: ${isCompletedProfileRun(block, {}) ? 'COMPLETE' : 'INCOMPLETE'}`);
    }
    return checkpoint;
  }

  log('[miracl-ru] building/loading the deterministic pooled subset (100 queries / 1000 passages)...');
  const fullSubset = await buildAndCacheMiraclSubset({ log });

  const dataset = smoke ? shrinkForSmoke(fullSubset) : fullSubset;
  const datasetFingerprint = smoke ? 'miracl-ru-smoke-v1' : `miracl-ru-subset-${dataset.corpus.size}-${dataset.queries.size}`;

  const adapter = createStorageAdapter();
  const { state, rankedRunsByProfile } = await runSuiteAcrossProfiles({
    suiteId: SUITE_ID,
    datasetFingerprint,
    corpus: dataset.corpus, queries: dataset.queries, qrels: dataset.qrels, toMarkdown,
    smoke, resume, restart, cudaRequested,
    adapter, runIndexer, queryOne,
    log: (msg) => log(redact(msg)),
  });

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
  const resume = process.argv.includes('--resume') || process.argv.includes('--resume-check');
  const resumeCheck = process.argv.includes('--resume-check');
  const restart = process.argv.includes('--restart');
  const cudaRequested = process.argv.includes('--cuda');

  if (!process.env.QDRANT_URL || !process.env.QDRANT_KEY) {
    console.log('LIVE_BLOCKED: QDRANT_URL/QDRANT_KEY not set.');
    process.exitCode = 1;
    return;
  }

  const state = await runMiraclRuSuite({ smoke, resume, restart, resumeCheck, cudaRequested });
  if (state) {
    console.log(`\nverdict: ${state.verdict}`);
    if (state.bootstrapComparison) console.log('bootstrap comparison:', JSON.stringify(state.bootstrapComparison, null, 2));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
