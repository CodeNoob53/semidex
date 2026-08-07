// Failure analysis for custom-50 quality benchmark.
//
// Reads BENCH_JSON=1 output from run-v3.js and, for each chunkRecall@5 miss,
// fetches the expected chunk(s) from Qdrant and shows:
//   - failure category summary (rank 6-10 / window hit / support-only / total miss)
//   - expected chunks: chunkId, relevance, section, text snippet
//   - top-K returned chunks: rank, chunkId, relevance, score
//   - ±window check: whether expected chunk is adjacent to any returned chunk
//
// Usage:
//   BENCH_JSON=1 BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 npm run bench:custom50 \
//     | node benchmarks/retrieval/custom-50/analyze-failures.js
//
//   # or from a saved result file:
//   node benchmarks/retrieval/custom-50/analyze-failures.js < result.json
//
//   # write full analysis to file:
//   BENCH_JSON=1 BENCH_PROVIDER=onnx BENCH_SKIP_INDEX=1 npm run bench:custom50\
//     | node benchmarks/retrieval/custom-50/analyze-failures.js \
//     > benchmarks/retrieval/results/$(date +%F)-custom50-failure-analysis.txt

if (process.argv.includes('--help')) {
  process.stdout.write(`custom-50 failure analysis

Usage:
  BENCH_JSON=1 [bench options] npm run bench:custom50 \\
    | node benchmarks/retrieval/custom-50/analyze-failures.js

  node benchmarks/retrieval/custom-50/analyze-failures.js < saved-result.json

Options (env vars):
  FAIL_WINDOW=<n>    Adjacency window for ±N check (default: 1)
  FAIL_SNIPPET=<n>   Max chars of chunk text to show (default: 200)
  FAIL_TOP_K=<n>     How many returned chunks to show per query (default: 10)

Failure categories:
  rank6-10      Expected chunk found at rank 6-10 (just outside top-5)
  window        Expected chunk not in top-K but a ±window neighbor is
  support-only  No exact (rel≥3) hit but a supporting (rel≥2) chunk was found
  total-miss    No exact, no window, no support hit in top-K

Output: category summary then detailed per-query analysis.
Prerequisites: QDRANT_URL and QDRANT_KEY in .env or environment.
`);
  process.exit(0);
}

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { scroll } from '../../../src/shared/core/qdrant.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = resolve(__dirname, 'queries.json');

const WINDOW   = envInt('FAIL_WINDOW',  1, 0, 10);
const SNIPPET  = envInt('FAIL_SNIPPET', 200, 0, 2000);
const SHOW_TOP = envInt('FAIL_TOP_K',   10, 1, 100);

function envInt(name, def, min, max) {
  const v = parseInt(process.env[name] ?? '');
  if (!Number.isFinite(v) || v < min || v > max) return def;
  return v;
}

// ── Qdrant helpers ────────────────────────────────────────────────────────────

// Cache of all chunks per source_file to avoid repeated Qdrant calls.
// chunk_index has no payload index, so we fetch all chunks for a file at once
// and filter locally.
const fileChunkCache = new Map();

async function getAllChunksForFile(collection, sourceFile) {
  if (fileChunkCache.has(sourceFile)) return fileChunkCache.get(sourceFile);
  const points = await scroll(
    collection,
    { must: [{ key: 'source_file', match: { value: sourceFile } }] },
    500,
    true
  );
  fileChunkCache.set(sourceFile, points);
  return points;
}

// Fetch a single chunk by source_file + chunk_index from Qdrant.
async function fetchChunk(collection, sourceFile, chunkIndex) {
  const all = await getAllChunksForFile(collection, sourceFile);
  return all.find(p => p.payload?.chunk_index === chunkIndex) ?? null;
}

// Fetch chunks with chunk_index in [lo, hi] for ±window lookup.
async function fetchChunkRange(collection, sourceFile, lo, hi) {
  const all = await getAllChunksForFile(collection, sourceFile);
  return all.filter(p => {
    const ci = p.payload?.chunk_index;
    return ci >= lo && ci <= hi;
  });
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseChunkId(chunkId) {
  const hash = chunkId.lastIndexOf('#');
  if (hash < 0) return null;
  const sourceFile  = chunkId.slice(0, hash);
  const chunkIndex  = parseInt(chunkId.slice(hash + 1), 10);
  if (!sourceFile || !Number.isFinite(chunkIndex)) return null;
  return { sourceFile, chunkIndex };
}

function snippet(text, maxLen) {
  if (!text) return '(no text)';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen) + '…';
}

function pad(s, n)  { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

// ── Window check ──────────────────────────────────────────────────────────────

// Returns true if any returned chunk is within ±WINDOW index positions of the
// expected chunk (same source_file, |returnedIdx - expectedIdx| <= WINDOW).
function isInWindow(returnedChunks, expectedSourceFile, expectedIdx, window) {
  return returnedChunks.some(r => {
    const sf = r.payload?.source_file;
    const ci = r.payload?.chunk_index;
    return sf === expectedSourceFile && Math.abs(ci - expectedIdx) <= window;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Read JSON from stdin.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = chunks.join('');

  // Find the JSON line (last line starting with '{').
  const jsonLine = raw.trim().split('\n').reverse().find(l => l.trimStart().startsWith('{'));
  if (!jsonLine) {
    process.stderr.write('Error: no JSON found on stdin. Run with BENCH_JSON=1.\n');
    process.exit(1);
  }

  let benchResult;
  try {
    benchResult = JSON.parse(jsonLine);
  } catch (e) {
    process.stderr.write(`Error: failed to parse JSON: ${e.message}\n`);
    process.exit(1);
  }

  const { provider, denseProvider, sparseProvider, searchMode, topK, queryResults } = benchResult;
  const collection = 'bench-retrieval-custom-50';

  // Load queries.json for relevantChunks (not included in JSON output per-query).
  const rawQueries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const qrelMap = new Map(
    rawQueries.queries.map(q => [q.id, q.relevantChunks ?? []])
  );

  // Identify failures: positive queries where chunkRecall@5 is false or null.
  // Analyzing from chunkRecall@5 (not @10) keeps rank6-10 cases visible — those
  // are queries where the exact chunk appeared at rank 6-topK and would be missed
  // by a top-5 agent call but not by a wider search.
  const positives = queryResults.filter(r => !r.isNegative);
  const failures = positives.filter(r => r.chunkRecall5 !== true);

  const sep  = '═'.repeat(80);
  const sep2 = '─'.repeat(80);

  process.stdout.write(`\n${sep}\n`);
  process.stdout.write(`  custom-50 failure analysis\n`);
  process.stdout.write(`  Provider : ${provider}  (${denseProvider}/${sparseProvider})\n`);
  process.stdout.write(`  Search   : ${searchMode}   Top-K: ${topK}\n`);
  process.stdout.write(`  Failures : ${failures.length} / ${positives.length} positive queries (chunkRecall@5)\n`);
  process.stdout.write(`  Window   : ±${WINDOW} chunk positions\n`);
  process.stdout.write(`${sep}\n\n`);

  if (failures.length === 0) {
    process.stdout.write(`No chunkRecall@5 failures. All exact-answer chunks found in top-5.\n\n`);
    return;
  }

  // ── Category summary ─────────────────────────────────────────────────────────

  // For each failure, classify into the most specific category:
  //   rank6-10    : exact chunk at rank 6–topK (found but below top-5)
  //   window      : exact chunk not in top-K but ±WINDOW neighbor is
  //   support-only: no exact hit, no window hit, but a rel≥2 chunk found in top-K
  //   total-miss  : nothing useful in top-K

  function classifyFailure(qr) {
    const relevantChunks = qrelMap.get(qr.id) ?? [];
    const exactIds = new Set(relevantChunks.filter(rc => rc.relevance >= 3).map(rc => rc.chunkId));
    const returnedChunks = qr.topChunks ?? [];

    // rank6-10: exact chunk in returned list but rank > 5
    const rank6to10 = returnedChunks.slice(5).some(c => exactIds.has(c.chunkId));
    if (rank6to10) return 'rank6-10';

    // window hit (±WINDOW neighbor in top-K)
    const windowHit = [...exactIds].some(exactId => {
      const ep = parseChunkIdLocal(exactId);
      if (!ep) return false;
      return returnedChunks.some(c => {
        const rp = parseChunkIdLocal(c.chunkId);
        if (!rp) return false;
        return rp.sourceFile === ep.sourceFile && Math.abs(rp.chunkIndex - ep.chunkIndex) <= WINDOW;
      });
    });
    if (windowHit) return 'window';

    // support-only: rel≥2 chunk in top-K
    const supportIds = new Set(relevantChunks.filter(rc => rc.relevance >= 2).map(rc => rc.chunkId));
    const supportHit = returnedChunks.some(c => supportIds.has(c.chunkId));
    if (supportHit) return 'support-only';

    return 'total-miss';
  }

  function parseChunkIdLocal(chunkId) {
    if (!chunkId) return null;
    const hash = chunkId.lastIndexOf('#');
    if (hash < 0) return null;
    return { sourceFile: chunkId.slice(0, hash), chunkIndex: parseInt(chunkId.slice(hash + 1), 10) };
  }

  const categories = { 'rank6-10': [], 'window': [], 'support-only': [], 'total-miss': [] };
  for (const qr of failures) {
    categories[classifyFailure(qr)].push(qr.id);
  }

  process.stdout.write(`Category summary (${failures.length} failures):\n`);
  process.stdout.write(`  rank6-10     : ${categories['rank6-10'].length}  ${categories['rank6-10'].join(', ')}\n`);
  process.stdout.write(`  window (±${WINDOW})  : ${categories['window'].length}  ${categories['window'].join(', ')}\n`);
  process.stdout.write(`  support-only : ${categories['support-only'].length}  ${categories['support-only'].join(', ')}\n`);
  process.stdout.write(`  total-miss   : ${categories['total-miss'].length}  ${categories['total-miss'].join(', ')}\n`);
  process.stdout.write(`\n`);

  for (const qr of failures) {
    const relevantChunks = qrelMap.get(qr.id) ?? [];
    const exactChunks    = relevantChunks.filter(rc => rc.relevance >= 3);

    // Find query text from rawQueries.
    const rawQ = rawQueries.queries.find(q => q.id === qr.id);

    const cat = classifyFailure(qr);
    process.stdout.write(`${sep2}\n`);
    process.stdout.write(`Query    : [${qr.id}] ${rawQ?.query ?? '?'}\n`);
    process.stdout.write(`Type     : ${qr.type ?? '?'}    Note: ${rawQ?.note ?? ''}\n`);
    process.stdout.write(`Category : ${cat}\n`);
    process.stdout.write(`nDCG     : ${qr.ndcg?.toFixed(3) ?? 'n/a'}    MRR: ${qr.mrr10?.toFixed(3) ?? 'n/a'}    supportRecall: ${qr.supportRecall ? '✓' : '✗'}\n`);
    process.stdout.write(`\n`);

    // ── Expected chunks (rel≥3) ──────────────────────────────────────────────
    process.stdout.write(`Expected chunks (rel≥3):\n`);
    for (const rc of exactChunks) {
      const parsed = parseChunkId(rc.chunkId);
      let chunkData = null;
      if (parsed) {
        chunkData = await fetchChunk(collection, parsed.sourceFile, parsed.chunkIndex);
      }
      const section = chunkData?.payload?.section ?? '?';
      const text    = chunkData?.payload?.text    ?? null;
      process.stdout.write(`  ${rc.chunkId}  [rel=${rc.relevance}]  section: "${section}"\n`);
      if (text) process.stdout.write(`  text: ${snippet(text, SNIPPET)}\n`);
    }

    // ── Top-K returned chunks ────────────────────────────────────────────────
    process.stdout.write(`\nTop-${Math.min(SHOW_TOP, topK)} returned chunks:\n`);

    // Build qrel lookup for this query.
    const qrels = new Map(relevantChunks.map(rc => [rc.chunkId, rc.relevance]));

    const returnedChunks = qr.topChunks ?? [];
    const showChunks = returnedChunks.slice(0, SHOW_TOP);

    for (let i = 0; i < showChunks.length; i++) {
      const c       = showChunks[i];
      const cid     = c.chunkId ?? '?';
      const rel     = qrels.get(cid) ?? 0;
      const relStr  = rel > 0 ? `rel=${rel}` : 'irrel';
      const hitMark = rel >= 3 ? ' ✓' : rel >= 2 ? ' ~' : '';
      process.stdout.write(
        `  #${lpad(i + 1, 2)}  ${pad(cid, 28)}  [${pad(relStr, 6)}]  score=${c.score?.toFixed(4) ?? '?'}${hitMark}\n`
      );
    }

    // ── Window analysis ──────────────────────────────────────────────────────
    process.stdout.write(`\n±${WINDOW} window analysis:\n`);
    for (const rc of exactChunks) {
      const parsed = parseChunkId(rc.chunkId);
      if (!parsed) { process.stdout.write(`  ${rc.chunkId}: cannot parse\n`); continue; }

      const { sourceFile, chunkIndex } = parsed;
      const inWindow = isInWindow(
        returnedChunks.map(c => ({
          payload: {
            source_file: c.chunkId?.slice(0, c.chunkId.lastIndexOf('#')),
            chunk_index: parseInt(c.chunkId?.slice(c.chunkId.lastIndexOf('#') + 1), 10),
          },
        })),
        sourceFile,
        chunkIndex,
        WINDOW
      );

      if (inWindow) {
        // Find the actual neighbor returned.
        const neighbor = returnedChunks.find(c => {
          const sf = c.chunkId?.slice(0, c.chunkId.lastIndexOf('#'));
          const ci = parseInt(c.chunkId?.slice(c.chunkId.lastIndexOf('#') + 1), 10);
          return sf === sourceFile && Math.abs(ci - chunkIndex) <= WINDOW;
        });
        const neighborRank = returnedChunks.indexOf(neighbor) + 1;
        const delta = parseInt(neighbor?.chunkId?.slice(neighbor.chunkId.lastIndexOf('#') + 1), 10) - chunkIndex;
        const dir   = delta === 0 ? 'exact' : delta > 0 ? `+${delta}` : `${delta}`;
        process.stdout.write(`  ${rc.chunkId}: IN WINDOW (rank #${neighborRank}, neighbor ${neighbor?.chunkId} [${dir}])\n`);
      } else {
        // Fetch surrounding chunks to show what's adjacent.
        const lo = Math.max(0, chunkIndex - WINDOW);
        const hi = chunkIndex + WINDOW;
        let adjacent = [];
        try {
          adjacent = await fetchChunkRange(collection, sourceFile, lo, hi);
        } catch (_) { /* range filter may not be supported on older Qdrant */ }

        const adjIds = adjacent.map(p => `${p.payload?.source_file}#${p.payload?.chunk_index}`);
        const inTop  = adjIds.some(id => returnedChunks.some(c => c.chunkId === id));
        process.stdout.write(`  ${rc.chunkId}: NOT in window — adjacent IDs: [${adjIds.join(', ') || 'none'}]`);
        process.stdout.write(inTop ? ' (adjacent chunk IS in top results)\n' : '\n');
      }
    }
    process.stdout.write(`\n`);
  }

  process.stdout.write(`${sep}\n`);
  process.stdout.write(`Total failures analysed: ${failures.length}\n`);

  // Summary table.
  process.stdout.write(`\nSummary:\n`);
  process.stdout.write(`  ${pad('ID', 5)}  ${pad('Query (truncated)', 44)}  ${pad('Category', 12)}  suppRecall  nDCG\n`);
  process.stdout.write(`  ${'-'.repeat(84)}\n`);
  for (const qr of failures) {
    const rawQ = rawQueries.queries.find(q => q.id === qr.id);
    const cat = classifyFailure(qr);
    process.stdout.write(
      `  ${pad(qr.id, 5)}  ${pad((rawQ?.query ?? '').slice(0, 43), 44)}  ` +
      `${pad(cat, 12)}  ` +
      `${pad(qr.supportRecall ? '✓' : '✗', 11)} ` +
      `${qr.ndcg?.toFixed(3) ?? 'n/a'}\n`
    );
  }
  process.stdout.write(`\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
