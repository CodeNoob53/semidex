import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { chunkFile } from '../../../src/indexer/phases/chunk.js';
import {
  listCollections, createCollection, deleteBySourceFile,
  upsertPoints, hybridSearch, scroll,
} from '../../../src/core/qdrant.js';
import { embedForIndex, embedForSearch, SCHEMA_VERSION } from '../../../src/core/embeddings.js';
import { loadConfig, saveConfig, resolveEnvProviders } from '../../../src/core/config.js';

if (process.argv.includes('--help')) {
  process.stdout.write(`semidex custom-raw benchmark\n`);
  process.exit(0);
}

if (process.env.ONNX_EMBED !== '1') {
  process.stderr.write(`Error: Must run with ONNX_EMBED=1\n`);
  process.exit(1);
}

const __dirname   = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures/docs');
const QUERIES_PATH = resolve(__dirname, 'queries.json');
const RESULTS_DIR  = resolve(__dirname, '../results');

const COLLECTION  = 'bench-retrieval-custom-raw';
const TOP_K       = parseInt(process.env.BENCH_TOP_K || '5', 10);
const BENCH_CONTEXT_WINDOW = parseInt(process.env.BENCH_CONTEXT_WINDOW || '1', 10);
const SKIP_INDEX  = process.env.BENCH_SKIP_INDEX === '1';

const FIXTURE_FILES = [
  'raw-mixed-incident-log.txt',
  'raw-agent-notes.txt',
  'raw-config-dump.txt',
];

const ANCHOR_RE = /\[\[BENCH_ANCHOR:\s*(\w+)\]\]/g;

function approxTokens(text) {
  return Math.round((text.match(/\S+/g) ?? []).length * 1.3);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
}

async function ensureCollection() {
  const cols = await listCollections();
  if (!cols.includes(COLLECTION)) {
    await createCollection(COLLECTION, 1024);
  }
  const { denseProvider, denseModel, sparseProvider } = resolveEnvProviders();
  const cfg = loadConfig();
  cfg.collections ??= {};
  cfg.collections[COLLECTION] = {
    denseProvider, denseModel, sparseProvider,
    embeddingSchemaVersion: SCHEMA_VERSION,
    vectorSize: 1024,
    description: 'custom-raw stress benchmark — auto-managed',
  };
  saveConfig(cfg);
  return { denseProvider, sparseProvider };
}

async function fetchStoredProvider() {
  const points = await scroll(COLLECTION, undefined, 1, ['dense_provider', 'sparse_provider']);
  const p = points[0]?.payload;
  if (!p) return null;
  return { denseProvider: p.dense_provider ?? null, sparseProvider: p.sparse_provider ?? null };
}

async function indexFixtures() {
  const chunkData = [];
  const lengths = [];
  let sectionlessCount = 0;
  let oversizedChunkCount = 0;

  for (const name of FIXTURE_FILES) {
    const filePath   = resolve(FIXTURES_DIR, name);
    const text       = readFileSync(filePath, 'utf8');
    const sourceFile = name;

    await deleteBySourceFile(COLLECTION, sourceFile);

    const chunks = chunkFile(filePath, text, sourceFile);
    const points = [];
    for (const chunk of chunks) {
      const toks = approxTokens(chunk.text ?? '');
      lengths.push(toks);
      if (toks > 400) oversizedChunkCount++;
      if (!chunk.section || chunk.section.trim() === '') sectionlessCount++;

      chunkData.push({
        sourceFile,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text ?? '',
      });

      const { dense, sparse, meta } = await embedForIndex(COLLECTION, chunk.text);
      points.push({
        id: randomUUID(),
        vector: { dense, sparse },
        payload: {
          text:         chunk.text,
          section:      chunk.section,
          source_file:  sourceFile,
          chunk_index:  chunk.chunkIndex,
          total_chunks: chunk.totalChunks,
          file_hash:    'bench-raw',
          vector_size:  1024,
          ...meta,
        },
      });
    }
    await upsertPoints(COLLECTION, points);
  }

  return { chunkData, lengths, sectionlessCount, oversizedChunkCount };
}

async function fetchChunkData() {
  const points = await scroll(COLLECTION, undefined, 5000,
    ['source_file', 'chunk_index', 'text', 'section']);
  const chunkData = [];
  for (const p of points) {
    if (p.payload?.source_file != null && p.payload?.chunk_index != null) {
      chunkData.push({
        sourceFile: p.payload.source_file,
        chunkIndex: p.payload.chunk_index,
        text: p.payload.text ?? '',
      });
    }
  }
  return chunkData;
}

function buildAnchorMap(chunkData) {
  const anchorMap = new Map();
  for (const c of chunkData) {
    const chunkId = `${c.sourceFile}#${c.chunkIndex}`;
    const matches = [...c.text.matchAll(ANCHOR_RE)];
    for (const m of matches) {
      anchorMap.set(m[1], chunkId);
    }
  }
  return anchorMap;
}

function resolveAnchors(queries, anchorMap) {
  const errors = [];
  const resolved = [];
  for (const q of queries) {
    if (q.shouldHaveNoStrongHit) {
      resolved.push({ ...q, qrels: new Map() });
      continue;
    }
    const qrels = new Map();
    for (const ea of (q.expectedAnchors ?? [])) {
      const chunkId = anchorMap.get(ea.anchor);
      if (!chunkId) {
        errors.push(`anchor "${ea.anchor}" missing`);
      } else {
        qrels.set(chunkId, ea.relevance ?? 3);
      }
    }
    resolved.push({ ...q, qrels });
  }
  if (errors.length) {
    process.stderr.write(`Error missing anchors: ${errors.join(', ')}\n`);
    process.exit(1);
  }
  return resolved;
}

function resultChunkId(r) {
  return `${r.payload?.source_file}#${r.payload?.chunk_index}`;
}

function parseChunkId(chunkId) {
  if (!chunkId) return null;
  const hash = chunkId.lastIndexOf('#');
  if (hash < 0) return null;
  return {
    sourceFile: chunkId.slice(0, hash),
    chunkIndex: parseInt(chunkId.slice(hash + 1), 10),
  };
}

function windowRecallHit(results, qrels, k, window) {
  if (!qrels.size) return null;
  const exactIds = [...qrels.keys()];
  const topK = results.slice(0, k);
  if (topK.some(r => exactIds.includes(resultChunkId(r)))) return true;
  for (const exactId of exactIds) {
    const ep = parseChunkId(exactId);
    if (!ep) continue;
    if (topK.some(r => {
      const rp = parseChunkId(resultChunkId(r));
      return rp && rp.sourceFile === ep.sourceFile &&
             Math.abs(rp.chunkIndex - ep.chunkIndex) <= window;
    })) return true;
  }
  return false;
}

function tokenise(str) {
  return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

async function main() {
  const raw = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const { denseProvider, sparseProvider } = resolveEnvProviders();
  
  await ensureCollection();
  
  let chunkData, lengths = [], sectionlessCount = 0, oversizedChunkCount = 0;
  if (SKIP_INDEX) {
    chunkData = await fetchChunkData();
    for (const c of chunkData) {
      const toks = approxTokens(c.text);
      lengths.push(toks);
      if (toks > 400) oversizedChunkCount++;
    }
  } else {
    const res = await indexFixtures();
    chunkData = res.chunkData;
    lengths = res.lengths;
    sectionlessCount = res.sectionlessCount;
    oversizedChunkCount = res.oversizedChunkCount;
  }

  const anchorMap = buildAnchorMap(chunkData);
  const queries = resolveAnchors(raw.queries, anchorMap);

  const queryResults = [];
  const latencies = [];

  for (const q of queries) {
    const t0 = Date.now();
    const { dense, sparse } = await embedForSearch(COLLECTION, q.query);
    const results = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
    const latency = Date.now() - t0;
    latencies.push(latency);
    queryResults.push({ query: q, results, latency });
  }

  // Metrics
  let fileRecall5 = 0, fRecallCount = 0;
  let contextRecall5 = 0, ctxRecallCount = 0;
  let tokenHit5 = 0, tokenHitCount = 0;
  let negPass = 0, negCount = 0;

  const typeStats = {};

  for (const r of queryResults) {
    const { query, results } = r;
    const type = query.type || 'unknown';
    if (!typeStats[type]) typeStats[type] = { total: 0, pass: 0 };
    typeStats[type].total++;

    let passed = false;

    if (query.shouldHaveNoStrongHit) {
      negCount++;
      const topK = results.slice(0, TOP_K);
      const forbidden = query.forbiddenTokens?.map(t => t.toLowerCase()) || [];
      let hasForbidden = false;
      for (const res of topK) {
        const text = (res.payload?.text || '').toLowerCase();
        for (const ft of forbidden) {
          if (text.includes(ft)) hasForbidden = true;
        }
      }
      
      if (!hasForbidden) {
        negPass++;
        passed = true;
      }
    } else {
      ctxRecallCount++;
      if (windowRecallHit(results, query.qrels, 5, BENCH_CONTEXT_WINDOW)) {
        contextRecall5++;
        passed = true;
      }
      
      if (query.expectedFiles?.length) {
        fRecallCount++;
        const files = new Set(results.slice(0, 5).map(x => x.payload?.source_file));
        if (query.expectedFiles.some(f => files.has(f))) fileRecall5++;
      }
      
      if (query.expectedTokens?.length) {
        tokenHitCount++;
        const top5Text = results.slice(0, 5).map(x => x.payload?.text).join(' ').toLowerCase();
        if (query.expectedTokens.some(t => top5Text.includes(t.toLowerCase()))) tokenHit5++;
      }
    }

    if (passed) typeStats[type].pass++;
  }

  const p50Chunk = percentile(lengths.sort((a,b)=>a-b), 50);
  const p95Chunk = percentile(lengths.sort((a,b)=>a-b), 95);
  const avgChunk = lengths.reduce((a,b)=>a+b, 0) / lengths.length;

  const p50Lat = percentile(latencies.sort((a,b)=>a-b), 50);
  const p95Lat = percentile(latencies.sort((a,b)=>a-b), 95);
  
  const pct = (num, den) => den === 0 ? 'n/a' : (num / den * 100).toFixed(1) + '%';

  const date = new Date().toISOString().slice(0, 10);
  const outPath = resolve(RESULTS_DIR, `${date}-custom-raw-baseline.txt`);

  const lines = [
    `=== semidex custom-raw benchmark — ${date} ===`,
    `Provider: ${denseProvider}/${sparseProvider}`,
    `Top-K: ${TOP_K}  Context Window: +-${BENCH_CONTEXT_WINDOW}`,
    '',
    '--- Retrieval Metrics ---',
    `contextRecall@5   : ${pct(contextRecall5, ctxRecallCount)}`,
    `tokenHit@5        : ${pct(tokenHit5, tokenHitCount)}`,
    `fileRecall@5      : ${pct(fileRecall5, fRecallCount)}`,
    `negativePassRate  : ${pct(negPass, negCount)}`,
    `Latency p50/p95   : ${p50Lat}ms / ${p95Lat}ms`,
    '',
    '--- Per-Type Breakdown ---',
    ...Object.entries(typeStats).map(([t, s]) => 
      `${t.padEnd(20)}: ${pct(s.pass, s.total)} (${s.pass}/${s.total})`
    ),
    '',
    '--- Chunking Metrics ---',
    `totalChunks       : ${chunkData.length}`,
    `oversizedChunks   : ${oversizedChunkCount}`,
    `sectionlessRate   : ${pct(sectionlessCount, chunkData.length)}`,
    `avgChunkTokens    : ${Math.round(avgChunk)} approx`,
    `p50ChunkTokens    : ${p50Chunk} approx`,
    `p95ChunkTokens    : ${p95Chunk} approx`,
  ];

  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(lines.join('\n'));
  console.log(`\nResult saved to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
