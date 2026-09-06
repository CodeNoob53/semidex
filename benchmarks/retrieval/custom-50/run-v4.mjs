#!/usr/bin/env node
// custom-50 v4 quality benchmark runner (audit 2026-09-06 remediation, Stage B).
//
// What changed from run-v3.js
// ---------------------------
//  - Judges against queries.v4.json (semantically reviewed qrels) whose
//    relevant chunks carry a content hash + evidence span, against
//    corpus.frozen.json (the CURRENT skeleton chunker corpus).
//  - Skip-index (default here — there is no in-process indexing) VALIDATES
//    the live bench-retrieval-custom-50 collection against the frozen
//    corpus per-file content hashes and REFUSES to run on a mismatch
//    (audit: "Skip-index повинен відхиляти несумісний корпус").
//  - Metrics are named to their formulas: Hit@K (was "chunkRecall@K"),
//    Recall@K (genuinely fraction-of-all-relevant), gradedNDCG@K
//    (gain 2^rel-1), MRR@10, requiredEvidenceCoverage@K for multi-evidence
//    queries. The token-absence negative signal is reported as
//    negativeTokenAbsence@1 and explicitly NOT called abstention quality.
//  - Composes real embedding capabilities via createBenchmarkQueryEmbedder
//    (Stage A) and runs the production runHybridSearch() path.
//
// This is a REGRESSION/TUNING set, not an independent held-out benchmark,
// and the old audit diagnostic numbers are not a baseline for it.
//
// Usage:
//   node benchmarks/retrieval/custom-50/run-v4.mjs [--json] [--top=K] [--no-validate]
//   (requires QDRANT_URL/QDRANT_KEY and the bench-retrieval-custom-50
//    collection to already hold the frozen corpus — build it with
//    build-corpus.mjs's env against COLLECTION=bench-retrieval-custom-50,
//    or run --reindex here.)
//   node benchmarks/retrieval/custom-50/run-v4.mjs --reindex   # (re)build the bench collection from fixtures first
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { runHybridSearch } from '../../../src/core/retrieval/search.js';
import { resolveExistingCollectionProfile } from '../../../src/core/embedding-profile/resolve.js';
import { getFileChunks } from '../../../src/core/qdrant/store.js';
import { createBenchmarkQueryEmbedder } from '../../lib/embedding-capabilities.mjs';

import {
  hitAtK, recallAtK, requiredEvidenceCoverageAtK, gradedNdcgAtK, mrrAtK,
  negativeTokenAbsenceAtRank1, resultChunkId,
} from './metrics-v4.mjs';
import {
  loadFrozenCorpus, loadV4Qrels, validateQrelsAgainstFrozenCorpus,
  validateLiveCollectionMatchesFrozen,
} from './validate-qrels.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLLECTION = 'bench-retrieval-custom-50';

const ARGS = process.argv.slice(2);
const JSON_MODE = ARGS.includes('--json');
const NO_VALIDATE = ARGS.includes('--no-validate');
const TOP = Number((ARGS.find((a) => a.startsWith('--top=')) ?? '--top=10').split('=')[1]);
const REINDEX = ARGS.includes('--reindex');

const log = (...a) => (JSON_MODE ? process.stderr.write(a.join(' ') + '\n') : console.log(...a));

function qrelMap(relevantChunks) {
  return new Map((relevantChunks ?? []).map((rc) => [rc.chunkId, rc.relevance]));
}

async function reindexFromFixtures(adapter) {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, copyFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FIXTURE_FILES } = await import('./build-corpus.mjs');
  const manifest = JSON.parse(readFileSync(resolve(__dirname, 'corpus.manifest.json'), 'utf8'));

  const workDir = mkdtempSync(join(tmpdir(), 'custom50-v4-reindex-'));
  for (const { name, dir } of FIXTURE_FILES) copyFileSync(resolve(dir, name), join(workDir, name));

  // Drop any prior collection so the rebuild is byte-for-byte the same as
  // build-corpus.mjs's fresh-collection build (no stale points, no
  // provider-mismatch reindex path).
  try { await adapter.deleteCollection(COLLECTION); log(`[run-v4] deleted existing ${COLLECTION} before rebuild`); } catch { /* absent */ }

  const REPO_ROOT = resolve(__dirname, '../../..');
  const env = { ...process.env, ...manifest.deterministicIndexEnv, COLLECTION, SOURCE_ROOT: workDir };
  log(`[run-v4] reindexing ${COLLECTION} from fixtures (deterministic env)...`);
  await new Promise((res, rej) => {
    const child = spawn(process.execPath, [resolve(REPO_ROOT, 'src/indexer/index.js'), workDir], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (c) => (c === 0 ? res() : rej(new Error(`indexer exit ${c}\n${err}`))));
  });
  rmSync(workDir, { recursive: true, force: true });
}

async function main() {
  if (!process.env.QDRANT_URL || !process.env.QDRANT_KEY) {
    log('LIVE_BLOCKED: QDRANT_URL/QDRANT_KEY not set.');
    process.exitCode = 1;
    return;
  }

  // 1. Static qrel <-> frozen corpus validation (structural + content hash).
  const staticVal = validateQrelsAgainstFrozenCorpus();
  if (!staticVal.ok) {
    for (const e of staticVal.errors) log(`  ${e}`);
    log(`\n[run-v4] ${staticVal.errors.length} qrel/corpus validation error(s) — refusing to run.`);
    process.exitCode = 1;
    return;
  }

  const adapter = createStorageAdapter();
  const { corpus } = loadFrozenCorpus();
  const v4 = loadV4Qrels();

  if (REINDEX) await reindexFromFixtures(adapter);

  // 2. Live collection <-> frozen corpus content-hash guard.
  const existing = await adapter.getCollection(COLLECTION);
  if (!existing) {
    log(`[run-v4] collection ${COLLECTION} does not exist — run with --reindex to build it from fixtures.`);
    process.exitCode = 1;
    return;
  }
  if (!NO_VALIDATE) {
    const liveVal = await validateLiveCollectionMatchesFrozen({
      corpus,
      getFileChunksFn: (sourceFile) => getFileChunks(COLLECTION, sourceFile),
    });
    if (!liveVal.ok) {
      for (const e of liveVal.errors) log(`  ${e}`);
      log('\n[run-v4] live collection does not match the frozen corpus — the qrels were not reviewed for this index.');
      log('        Rebuild with --reindex, or pass --no-validate to run anyway (results are NOT comparable).');
      process.exitCode = 1;
      return;
    }
    log('[run-v4] live collection matches the frozen corpus (per-file content hashes).');
  }

  const resolution = await resolveExistingCollectionProfile(adapter, COLLECTION);
  if (!resolution.resolved) {
    log(`[run-v4] ${COLLECTION} has no resolvable embedding profile: ${resolution.reason}`);
    process.exitCode = 1;
    return;
  }

  const embedder = createBenchmarkQueryEmbedder();
  const perQuery = [];
  try {
    for (const q of v4.queries) {
      const result = await runHybridSearch({
        adapter, collection: COLLECTION, query: q.query, top: TOP,
        embedQuery: embedder.embedQuery, cloudEmbed: embedder.cloudEmbed,
      });
      if (result.error) {
        perQuery.push({ id: q.id, error: `${result.error}: ${result.message}` });
        continue;
      }
      const ranked = result.hits ?? [];
      const qr = qrelMap(q.relevantChunks);
      const isNeg = q.shouldHaveNoStrongHit === true;
      perQuery.push({
        id: q.id,
        type: q.type,
        verdict: q.reviewVerdict,
        isNegative: isNeg,
        hitAt1: isNeg ? null : hitAtK(ranked, qr, 1),
        hitAt3: isNeg ? null : hitAtK(ranked, qr, 3),
        hitAt5: isNeg ? null : hitAtK(ranked, qr, 5),
        hitAt10: isNeg ? null : hitAtK(ranked, qr, 10),
        recallAt5: isNeg ? null : recallAtK(ranked, qr, 5),
        recallAt10: isNeg ? null : recallAtK(ranked, qr, 10),
        supportHitAt10: isNeg ? null : hitAtK(ranked, qr, 10, 2),
        ndcgAt10: isNeg ? null : gradedNdcgAtK(ranked, qr, 10),
        mrrAt10: isNeg ? null : mrrAtK(ranked, qr, 10),
        requiredEvidenceCoverageAt10: q.requiredEvidence ? requiredEvidenceCoverageAtK(ranked, q.requiredEvidence, 10) : null,
        negativeTokenAbsenceAt1: isNeg ? negativeTokenAbsenceAtRank1(ranked, q.expectedTokens ?? []) : null,
        top5: ranked.slice(0, 5).map((h) => ({ chunkId: resultChunkId(h), relevance: qr.get(resultChunkId(h)) ?? 0, score: h.score })),
      });
    }
  } finally {
    await embedder.shutdown();
  }

  const agg = aggregate(perQuery);
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({
      schemaVersion: 4,
      corpusHash: v4.corpusHash,
      chunkingModel: v4.chunkingModel,
      top: TOP,
      note: 'Regression/tuning set. Not an independent held-out benchmark. Old audit diagnostic numbers are not a baseline for this corpus.',
      aggregate: agg,
      perQuery,
    }, null, 2) + '\n');
  } else {
    printSummary(agg, perQuery);
  }

  const errored = perQuery.filter((r) => r.error);
  if (errored.length) {
    log(`\n[run-v4] ${errored.length} query error(s) — nonzero exit.`);
    process.exitCode = 1;
  }
}

function mean(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function rate(xs) {
  const v = xs.filter((x) => x === true || x === false);
  return v.length ? v.filter(Boolean).length / v.length : null;
}

function aggregate(perQuery) {
  const pos = perQuery.filter((r) => !r.isNegative && !r.error);
  const neg = perQuery.filter((r) => r.isNegative && !r.error);
  const withReq = pos.filter((r) => r.requiredEvidenceCoverageAt10 !== null);
  return {
    nPositive: pos.length,
    nNegative: neg.length,
    nError: perQuery.filter((r) => r.error).length,
    'hit@1': rate(pos.map((r) => r.hitAt1)),
    'hit@3': rate(pos.map((r) => r.hitAt3)),
    'hit@5': rate(pos.map((r) => r.hitAt5)),
    'hit@10': rate(pos.map((r) => r.hitAt10)),
    'recall@5': mean(pos.map((r) => r.recallAt5)),
    'recall@10': mean(pos.map((r) => r.recallAt10)),
    'supportHit@10': rate(pos.map((r) => r.supportHitAt10)),
    'gradedNDCG@10': mean(pos.map((r) => r.ndcgAt10)),
    'MRR@10': mean(pos.map((r) => r.mrrAt10)),
    'requiredEvidenceCoverage@10': withReq.length ? { n: withReq.length, rate: rate(withReq.map((r) => r.requiredEvidenceCoverageAt10)) } : null,
    'negativeTokenAbsence@1': {
      n: neg.length,
      rate: rate(neg.map((r) => r.negativeTokenAbsenceAt1)),
      caveat: 'token-absence only — NOT abstention/no-answer quality (needs a live-generation Ask eval)',
    },
  };
}

function printSummary(agg, perQuery) {
  log('\n=== custom-50 v4 quality benchmark ===');
  log(`Corpus       : skeleton-v1, ${JSON.parse(readFileSync(resolve(__dirname, 'corpus.manifest.json'), 'utf8')).totalChunks} chunks`);
  log(`Queries      : ${agg.nPositive} positive, ${agg.nNegative} negative, ${agg.nError} error`);
  log('');
  log(`Hit@1  (>=1 rel-3 chunk at rank 1)   : ${pct(agg['hit@1'])}`);
  log(`Hit@3                                : ${pct(agg['hit@3'])}`);
  log(`Hit@5                                : ${pct(agg['hit@5'])}`);
  log(`Hit@10                               : ${pct(agg['hit@10'])}`);
  log(`Recall@5  (frac of ALL rel-3 chunks) : ${num(agg['recall@5'])}`);
  log(`Recall@10                            : ${num(agg['recall@10'])}`);
  log(`supportHit@10 (>=1 rel>=2 chunk)     : ${pct(agg['supportHit@10'])}`);
  log(`gradedNDCG@10 (gain 2^rel-1)         : ${num(agg['gradedNDCG@10'])}`);
  log(`MRR@10                               : ${num(agg['MRR@10'])}`);
  if (agg['requiredEvidenceCoverage@10']) {
    log(`requiredEvidenceCoverage@10 (n=${agg['requiredEvidenceCoverage@10'].n}) : ${pct(agg['requiredEvidenceCoverage@10'].rate)}`);
  }
  log(`negativeTokenAbsence@1 (n=${agg['negativeTokenAbsence@1'].n})       : ${pct(agg['negativeTokenAbsence@1'].rate)}  [token-absence only, NOT abstention quality]`);
  log('');
  const misses = perQuery.filter((r) => !r.isNegative && !r.error && r.hitAt10 === false);
  if (misses.length) log(`Hit@10 misses: ${misses.map((r) => r.id).join(', ')}`);
}

function pct(v) { return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`; }
function num(v) { return v === null ? 'n/a' : v.toFixed(4); }

main().catch((err) => { console.error(err); process.exitCode = 1; });
