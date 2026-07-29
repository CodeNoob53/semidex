#!/usr/bin/env node
// Production-path benchmark: Slavic (Belebele-derived) suite. Through
// the REAL indexer + runHybridSearch() production path, across 7
// languages (ukr_Cyrl, rus_Cyrl, bul_Cyrl, pol_Latn, ces_Latn, slk_Latn,
// eng_Latn control), each an INDEPENDENT corpus/collection pair (never
// merged into one multilingual collection) — checkpoint granularity is
// (language, profile), i.e. 14 independently resumable units, achieved
// here by giving each language its own suiteId suffix
// ("slavic-<lang>"), each with its own checkpoint file.
//
// CAVEAT (verbatim, required by the task spec): this suite supports
// comparative multilingual retrieval claims, but is NOT equivalent to a
// natural-document RAG benchmark — Belebele/FLORES passages are short,
// synthetic MRC excerpts with exactly one relevant document per query
// (MRC-derived qrels, never pooled/graded).
//
// Usage:
//   node benchmarks/external/production-path/run-slavic-prodpath.mjs [--smoke] [--resume] [--resume-check] [--restart] [--cuda] [--lang=ukr_Cyrl]
import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { fetchAndValidateLanguage } from '../slavic/fetch-belebele.mjs';
import { pairedBootstrapByQuery, perQueryMetrics } from '../miracl/bootstrap.mjs';
import { runSuiteAcrossProfiles } from './core/run-suite.mjs';
import { runIndexer } from './core/index-via-cli.mjs';
import { queryOne } from './core/query-via-search.mjs';
import { checkpointPathFor, loadCheckpointIfExists, isCompletedProfileRun } from './core/checkpoint.mjs';
import { redact } from './core/redact.mjs';

export const SUITE_ID_BASE = 'slavic';
export const LANGUAGES = Object.freeze(['ukr_Cyrl', 'rus_Cyrl', 'bul_Cyrl', 'pol_Latn', 'ces_Latn', 'slk_Latn', 'eng_Latn']);

export const SLAVIC_CAVEAT = 'This suite supports comparative multilingual retrieval signal only, not a natural-document RAG benchmark — Belebele/FLORES passages are short, synthetic MRC excerpts with exactly one relevant document per query.';

function suiteIdFor(lang) {
  return `${SUITE_ID_BASE}-${lang}`;
}

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

async function runOneLanguage(lang, { smoke, resume, restart, resumeCheck, cudaRequested, log }) {
  const suiteId = suiteIdFor(lang);
  if (resumeCheck) {
    const path = checkpointPathFor(suiteId, { smoke });
    const checkpoint = loadCheckpointIfExists(path);
    if (!checkpoint) { log(`[${lang}] No checkpoint at ${path}.`); return null; }
    for (const [profileId, block] of Object.entries(checkpoint.profiles ?? {})) {
      log(`[${lang}] ${profileId}: ${isCompletedProfileRun(block, {}) ? 'COMPLETE' : 'INCOMPLETE'}`);
    }
    return checkpoint;
  }

  log(`[slavic/${lang}] fetching/validating language data (cached after first run)...`);
  const fullTask = await fetchAndValidateLanguage(lang, { log });
  const dataset = smoke ? shrinkForSmoke(fullTask) : fullTask;
  const datasetFingerprint = smoke ? `slavic-${lang}-smoke-v1` : `slavic-${lang}-${dataset.corpus.size}-${dataset.queries.size}`;

  const adapter = createStorageAdapter();
  const { state, rankedRunsByProfile } = await runSuiteAcrossProfiles({
    suiteId, datasetFingerprint,
    corpus: dataset.corpus, queries: dataset.queries, qrels: dataset.qrels, toMarkdown,
    smoke, resume, restart, cudaRequested,
    adapter, runIndexer, queryOne,
    log: (msg) => log(redact(`[${lang}] ${msg}`)),
  });

  if (rankedRunsByProfile.local && rankedRunsByProfile.cloud) {
    const perQueryLocal = perQueryMetrics(dataset.qrels, rankedRunsByProfile.local);
    const perQueryCloud = perQueryMetrics(dataset.qrels, rankedRunsByProfile.cloud);
    state.bootstrapComparison = {};
    for (const metricKey of ['ndcgAt10', 'mapAt100', 'recallAt10', 'recallAt100', 'mrrAt10']) {
      state.bootstrapComparison[metricKey] = pairedBootstrapByQuery(perQueryLocal, perQueryCloud, metricKey);
    }
  }
  state.caveat = SLAVIC_CAVEAT;
  return state;
}

/** --smoke for this suite defaults to eng_Latn ONLY (fastest, no
 * download-cache-miss risk beyond what's already cached), tiny subset —
 * never all 7 languages. Full runs iterate every language in LANGUAGES. */
export async function runSlavicSuite({ smoke = false, resume = false, restart = false, resumeCheck = false, cudaRequested = false, languages, log = console.log } = {}) {
  const langs = languages ?? (smoke ? ['eng_Latn'] : LANGUAGES);
  const results = {};
  for (const lang of langs) {
    log(`\n=== slavic / ${lang} ===`);
    results[lang] = await runOneLanguage(lang, { smoke, resume, restart, resumeCheck, cudaRequested, log });
  }
  return results;
}

async function main() {
  const smoke = process.argv.includes('--smoke');
  const resume = process.argv.includes('--resume') || process.argv.includes('--resume-check');
  const resumeCheck = process.argv.includes('--resume-check');
  const restart = process.argv.includes('--restart');
  const cudaRequested = process.argv.includes('--cuda');
  const langArg = process.argv.find((a) => a.startsWith('--lang='));
  const languages = langArg ? [langArg.slice('--lang='.length)] : undefined;

  if (!process.env.QDRANT_URL || !process.env.QDRANT_KEY) {
    console.log('LIVE_BLOCKED: QDRANT_URL/QDRANT_KEY not set.');
    process.exitCode = 1;
    return;
  }

  const results = await runSlavicSuite({ smoke, resume, restart, resumeCheck, cudaRequested, languages });
  console.log(`\n${SLAVIC_CAVEAT}`);
  for (const [lang, state] of Object.entries(results)) {
    if (state) console.log(`${lang}: ${state.verdict}`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
