#!/usr/bin/env node
// Emits evaluation.manifest.json — the single record that ties a custom-50
// v4 run's inputs together for reproducibility (audit 2026-09-06, B:
// "Додай manifest: corpus/query/qrel hashes, chunking/indexing/profile
// versions, config, runtime/code identity і точний шлях виконання").
//
// It references corpus.manifest.json (built by build-corpus.mjs) rather
// than duplicating it, and adds the query-set / qrel-set hashes plus the
// exact commands.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function gitHead() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim(); }
  catch { return null; }
}

const corpusManifest = JSON.parse(readFileSync(resolve(__dirname, 'corpus.manifest.json'), 'utf8'));
const v4 = JSON.parse(readFileSync(resolve(__dirname, 'queries.v4.json'), 'utf8'));

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),

  corpus: {
    ref: 'corpus.manifest.json',
    corpusHash: corpusManifest.corpusHash,
    chunkingModel: corpusManifest.chunkingModel,
    totalChunks: corpusManifest.totalChunks,
    embeddingProfile: corpusManifest.embeddingProfile,
    deterministicIndexEnv: corpusManifest.deterministicIndexEnv,
  },

  queries: {
    file: 'queries.v4.json',
    fileHash: sha256File(resolve(__dirname, 'queries.v4.json')),
    schemaVersion: v4.schemaVersion,
    count: v4.queries.length,
    corpusHashInQrels: v4.corpusHash,
    verdictCounts: v4.queries.reduce((m, q) => { m[q.reviewVerdict] = (m[q.reviewVerdict] ?? 0) + 1; return m; }, {}),
    correctedQueries: v4.queries.filter((q) => q.reviewVerdict === 'corrected').map((q) => q.id),
    multiEvidenceQueries: v4.queries.filter((q) => q.requiredEvidence).map((q) => q.id),
  },

  reviewArtifacts: {
    reviewScript: 'qrels-review.mjs',
    reviewScriptHash: sha256File(resolve(__dirname, 'qrels-review.mjs')),
    reviewTable: 'review-table.md',
    reviewTableHash: sha256File(resolve(__dirname, 'review-table.md')),
    negativeFixtures: 'negative-fixtures.json',
    negativeFixturesHash: sha256File(resolve(__dirname, 'negative-fixtures.json')),
  },

  metrics: {
    module: 'metrics-v4.mjs',
    moduleHash: sha256File(resolve(__dirname, 'metrics-v4.mjs')),
    naming: {
      'hit@K': 'was v3 "chunkRecall@K" — at least one rel>=3 chunk in top K',
      'recall@K': 'genuinely |retrieved ∩ relevant| / |relevant| at rel>=3',
      'gradedNDCG@K': 'gain(rel) = 2^rel - 1, discount = 1/log2(rank+1)',
      'requiredEvidenceCoverage@K': 'every requiredEvidence group has a member in top K',
      'negativeTokenAbsence@1': 'token-absence at rank 1 — NOT abstention/no-answer quality',
    },
    compatibilityAliases: { 'chunkRecallAtK': 'exact alias of hitAtK; never present as "recall"' },
  },

  validation: {
    module: 'validate-qrels.mjs',
    moduleHash: sha256File(resolve(__dirname, 'validate-qrels.mjs')),
    checks: [
      'every qrel chunkId exists in corpus.frozen.json',
      'every qrel contentHash still equals the frozen chunk contentHash (content corruption at a stable chunkId fails)',
      'qrels.corpusHash == corpus.manifest corpusHash',
      'skip-index run: live collection per-file content-hash sequence == frozen corpus (else refuse)',
    ],
  },

  runtimeCodeIdentity: {
    gitHead: gitHead(),
    node: process.version,
    platform: process.platform,
    corpusBuiltAtGitHead: corpusManifest.indexerCodeIdentity?.gitHead,
    corpusBuildDirtyPaths: corpusManifest.indexerCodeIdentity?.dirtyPaths,
  },

  executionPaths: {
    buildCorpus: 'node benchmarks/retrieval/custom-50/build-corpus.mjs   # rebuild + freeze corpus (real indexer CLI)',
    checkCorpus: 'node benchmarks/retrieval/custom-50/build-corpus.mjs --check',
    review: 'node benchmarks/retrieval/custom-50/qrels-review.mjs   # regenerate queries.v4.json + review-table.md',
    validate: 'node benchmarks/retrieval/custom-50/validate-qrels.mjs',
    run: 'node benchmarks/retrieval/custom-50/run-v4.mjs [--reindex] [--json] [--top=K]   # npm run bench:custom50',
    legacyV3: 'node benchmarks/retrieval/custom-50/run-v3.js   # npm run bench:custom50:v3-legacy — kept for archival only',
  },

  scope: 'Regression / tuning set. NOT an independent held-out benchmark. The 2026-09-06 audit diagnostic matrix used the legacy-chunker corpus and its numbers are not a baseline for this corpus. A new quality baseline requires a run recorded with this manifest.',
};

writeFileSync(resolve(__dirname, 'evaluation.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.error('wrote evaluation.manifest.json');
