// Rank-1 analysis for custom-50.
//
// This diagnostic targets MRR@10 directly. The existing failure analysis starts
// from chunkRecall@5 misses; this script starts from every positive query whose
// exact-answer chunk is not rank 1 and explains what beat it.
//
// Usage:
//   npm run bench:custom50:rank1
//   BENCH_SKIP_INDEX=1 npm run bench:custom50:rank1
//   RERANK_ENABLED=1 RERANK_BASE_WEIGHT=0.5 npm run bench:custom50:rank1

if (process.argv.includes('--help')) {
  process.stdout.write(`custom-50 rank-1 analysis

Usage:
  npm run bench:custom50:rank1

Output:
  benchmarks/retrieval/results/YYYY-MM-DD-custom50-rank1-analysis.txt

Environment:
  BENCH_SKIP_INDEX=1          Reuse existing custom-50 collection
  RERANK_ENABLED=1            Evaluate reranked output
  RERANK_BASE_WEIGHT=<n>      Optional rerank rank-prior weight
  RERANK_PROTECT_TOP1_DELTA   Optional top-1 protection threshold

The report shows rank buckets and every non-rank-1 query with its top-1
competitor, expected best rank, same-file/window clues, and top-5 chunks.
`);
  process.exit(0);
}

import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_V3 = resolve(__dirname, 'run-v3.js');
const QUERIES_PATH = resolve(__dirname, 'queries.json');
const RESULTS = resolve(__dirname, '../results');
const WINDOW = parseInt(process.env.BENCH_WINDOW ?? '1', 10);

function today() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function runLabel() {
  const parts = [];
  parts.push(process.env.RERANK_ENABLED === '1' ? 'rerank' : 'hybrid');
  if (process.env.RERANK_BASE_WEIGHT !== undefined) {
    parts.push(`base${process.env.RERANK_BASE_WEIGHT.replace(/[^0-9A-Za-z]+/g, '_')}`);
  }
  if (process.env.RERANK_PROTECT_TOP1_DELTA !== undefined) {
    parts.push(`protect${process.env.RERANK_PROTECT_TOP1_DELTA.replace(/[^0-9A-Za-z]+/g, '_')}`);
  }
  return parts.join('-');
}

function pad(s, n) { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }
function pct(v, d = 1) { return `${(v * 100).toFixed(d)}%`; }
function f3(v) { return v == null ? 'n/a' : v.toFixed(3); }

function parseChunkId(chunkId) {
  if (!chunkId) return null;
  const hash = chunkId.lastIndexOf('#');
  if (hash < 0) return null;
  const sourceFile = chunkId.slice(0, hash);
  const chunkIndex = parseInt(chunkId.slice(hash + 1), 10);
  if (!sourceFile || !Number.isFinite(chunkIndex)) return null;
  return { sourceFile, chunkIndex };
}

function sameFile(a, b) {
  const ap = parseChunkId(a);
  const bp = parseChunkId(b);
  return !!ap && !!bp && ap.sourceFile === bp.sourceFile;
}

function inWindow(a, b, window) {
  const ap = parseChunkId(a);
  const bp = parseChunkId(b);
  return !!ap && !!bp && ap.sourceFile === bp.sourceFile &&
    Math.abs(ap.chunkIndex - bp.chunkIndex) <= window;
}

function bestExactRank(topChunks, exactIds) {
  for (let i = 0; i < topChunks.length; i++) {
    if (exactIds.has(topChunks[i].chunkId)) return i + 1;
  }
  return null;
}

function runBenchmark() {
  const env = { ...process.env };
  env.BENCH_JSON = '1';
  env.BENCH_PROVIDER = env.BENCH_PROVIDER ?? 'onnx';
  env.ONNX_EMBED = '1';
  delete env.DENSE_PROVIDER;
  delete env.SPARSE_PROVIDER;

  const out = execFileSync(process.execPath, [RUN_V3], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  const jsonLine = out.trim().split('\n').reverse().find(l => l.trimStart().startsWith('{'));
  if (!jsonLine) throw new Error('No JSON output from run-v3.js');
  return JSON.parse(jsonLine);
}

function buildReport(bench, rawQueries) {
  const queryMap = new Map(rawQueries.queries.map(q => [q.id, q]));
  const positives = bench.queryResults.filter(r => !r.isNegative);

  const rows = positives.map(r => {
    const q = queryMap.get(r.id);
    const relevant = q?.relevantChunks ?? [];
    const exactIds = new Set(relevant.filter(rc => rc.relevance >= 3).map(rc => rc.chunkId));
    const supportIds = new Set(relevant.filter(rc => rc.relevance >= 2).map(rc => rc.chunkId));
    const rank = bestExactRank(r.topChunks ?? [], exactIds);
    const top1 = r.topChunks?.[0];
    const firstExact = rank ? r.topChunks[rank - 1]?.chunkId : null;
    const top1Chunk = top1?.chunkId ?? null;
    const top1Rel = supportIds.has(top1Chunk) ? (exactIds.has(top1Chunk) ? 3 : 2) : 0;
    return {
      id: r.id,
      type: r.type,
      query: q?.query ?? r.id,
      exactIds,
      rank,
      top1Chunk,
      top1Rel,
      top1Score: top1?.score ?? null,
      firstExact,
      sameFile: firstExact ? sameFile(top1Chunk, firstExact) : false,
      window: firstExact ? inWindow(top1Chunk, firstExact, WINDOW) : false,
      topChunks: r.topChunks ?? [],
      mrr10: r.mrr10,
      ndcg: r.ndcg,
    };
  });

  const rank1 = rows.filter(r => r.rank === 1);
  const rank2to5 = rows.filter(r => r.rank != null && r.rank >= 2 && r.rank <= 5);
  const rank6to10 = rows.filter(r => r.rank != null && r.rank >= 6 && r.rank <= 10);
  const misses = rows.filter(r => r.rank == null);
  const nonRank1 = rows.filter(r => r.rank !== 1);

  const top1Support = nonRank1.filter(r => r.top1Rel === 2);
  const top1SameFile = nonRank1.filter(r => r.sameFile);
  const top1Window = nonRank1.filter(r => r.window);

  const lines = [];
  const SEP = '='.repeat(100);
  const SEP2 = '-'.repeat(100);

  lines.push(SEP);
  lines.push('  custom-50 rank-1 analysis');
  lines.push(`  Provider : ${bench.provider} (${bench.denseProvider}/${bench.sparseProvider})`);
  lines.push(`  Search   : ${bench.searchMode}${bench.rerankApplied ? ' +rerank' : ''}  top-${bench.topK}`);
  lines.push(`  Window   : +/-${WINDOW}`);
  lines.push(SEP);
  lines.push('');

  lines.push('Aggregate:');
  lines.push(`  MRR@10          : ${f3(bench.metrics.mrr10)}`);
  lines.push(`  nDCG@10         : ${f3(bench.metrics.ndcgK)}`);
  lines.push(`  rank1 exact     : ${rank1.length}/${positives.length} (${pct(rank1.length / positives.length)})`);
  lines.push(`  rank2-5 exact   : ${rank2to5.length}/${positives.length} (${pct(rank2to5.length / positives.length)})`);
  lines.push(`  rank6-10 exact  : ${rank6to10.length}/${positives.length} (${pct(rank6to10.length / positives.length)})`);
  lines.push(`  not in top-10   : ${misses.length}/${positives.length} (${pct(misses.length / positives.length)})`);
  lines.push('');
  lines.push('Top-1 competitor clues among non-rank-1 queries:');
  lines.push(`  top1 is support rel=2  : ${top1Support.length}/${nonRank1.length}`);
  lines.push(`  top1 same source file  : ${top1SameFile.length}/${nonRank1.length}`);
  lines.push(`  top1 within +/-window  : ${top1Window.length}/${nonRank1.length}`);
  lines.push('');

  lines.push('Non-rank-1 queries:');
  lines.push(SEP2);
  lines.push(
    pad('ID', 5) + '  ' +
    pad('type', 12) + '  ' +
    lpad('rank', 5) + '  ' +
    pad('top1 chunk', 28) + '  ' +
    lpad('rel', 3) + '  ' +
    lpad('same', 4) + '  ' +
    lpad('win', 3) + '  ' +
    pad('first exact', 28) + '  ' +
    'query'
  );
  lines.push(SEP2);

  for (const r of nonRank1) {
    lines.push(
      pad(r.id, 5) + '  ' +
      pad(r.type, 12) + '  ' +
      lpad(r.rank ? `#${r.rank}` : 'miss', 5) + '  ' +
      pad(r.top1Chunk ?? '-', 28) + '  ' +
      lpad(r.top1Rel, 3) + '  ' +
      lpad(r.sameFile ? 'Y' : 'n', 4) + '  ' +
      lpad(r.window ? 'Y' : 'n', 3) + '  ' +
      pad(r.firstExact ?? [...r.exactIds].join(','), 28) + '  ' +
      r.query.slice(0, 72)
    );
  }
  lines.push(SEP2);
  lines.push('');

  lines.push('Top-5 detail for non-rank-1 queries:');
  lines.push(SEP2);
  for (const r of nonRank1) {
    lines.push(`[${r.id}] ${r.query}`);
    lines.push(`  exact rank: ${r.rank ? `#${r.rank}` : 'not in top-10'} | MRR=${f3(r.mrr10)} nDCG=${f3(r.ndcg)}`);
    for (let i = 0; i < Math.min(5, r.topChunks.length); i++) {
      const c = r.topChunks[i];
      const rel = r.exactIds.has(c.chunkId) ? 3 : (c.relevance ?? 0);
      lines.push(`  #${i + 1} ${pad(c.chunkId, 28)} rel=${rel} score=${f3(c.score)}`);
    }
    lines.push('');
  }
  lines.push(SEP);

  return lines.join('\n');
}

const rawQueries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
const bench = runBenchmark();
const report = buildReport(bench, rawQueries);

process.stdout.write(report + '\n');
mkdirSync(RESULTS, { recursive: true });
const outPath = resolve(RESULTS, `${today()}-custom50-rank1-analysis-${runLabel()}.txt`);
writeFileSync(outPath, report + '\n', 'utf8');
process.stderr.write(`\nSaved: ${outPath}\n`);
