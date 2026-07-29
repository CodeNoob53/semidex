#!/usr/bin/env node
// Production-path benchmark: structural retrieval fixture suite.
// Internal-only suite (not an external benchmark) — verifies that
// Qdrant Cloud's 512-token window and the entity_raw/fragment topology
// (src/indexer/phases/entity-split.js) preserve retrievability for
// oversized table/code_block/checklist entities, through the REAL
// indexer + runHybridSearch() production path.
//
// Usage:
//   node benchmarks/external/production-path/run-structural-prodpath.mjs [--smoke] [--resume] [--resume-check] [--restart] [--cuda]
import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { runSuiteAcrossProfiles } from './core/run-suite.mjs';
import { runIndexer } from './core/index-via-cli.mjs';
import { queryOne } from './core/query-via-search.mjs';
import { checkpointPathFor, loadCheckpointIfExists, isCompletedProfileRun } from './core/checkpoint.mjs';
import { redact } from './core/redact.mjs';
import {
  buildStructuralFixtureCorpus, buildStructuralFixtureQueriesMap, buildStructuralFixtureQrels,
} from './fixtures/structural-fixture.mjs';

export const SUITE_ID = 'structural';

function toMarkdown(doc) {
  return doc.text;
}

export async function runStructuralSuite({ smoke = false, resume = false, restart = false, resumeCheck = false, cudaRequested = false, log = console.log } = {}) {
  if (resumeCheck) {
    const path = checkpointPathFor(SUITE_ID, { smoke });
    const checkpoint = loadCheckpointIfExists(path);
    if (!checkpoint) { log(`No checkpoint at ${path}.`); return null; }
    for (const [profileId, block] of Object.entries(checkpoint.profiles ?? {})) {
      log(`${profileId}: ${isCompletedProfileRun(block, {}) ? 'COMPLETE' : 'INCOMPLETE'}`);
    }
    return checkpoint;
  }

  // The structural fixture is already tiny (1 doc + 3 distractors, 3
  // queries) — --smoke here means the same thing as full, minus
  // distractors, for the fastest possible pipeline-validation loop.
  const corpus = buildStructuralFixtureCorpus();
  const queries = buildStructuralFixtureQueriesMap();
  const qrels = buildStructuralFixtureQrels();

  const adapter = createStorageAdapter();
  const { state } = await runSuiteAcrossProfiles({
    suiteId: SUITE_ID,
    datasetFingerprint: 'structural-fixture-v1',
    corpus, queries, qrels, toMarkdown,
    smoke, resume, restart, cudaRequested,
    adapter, runIndexer, queryOne,
    log: (msg) => log(redact(msg)),
  });
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

  const state = await runStructuralSuite({ smoke, resume, restart, resumeCheck, cudaRequested });
  if (state) console.log(`\nverdict: ${state.verdict}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
