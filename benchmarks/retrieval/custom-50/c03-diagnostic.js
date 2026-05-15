// c03 regression diagnostic — BGE q4 vs mmarco.
// Query: "як увімкнути bge-m3-onnx без Ollama"
// Expected: providers.md#2 (rel=3) at rank <=3
// BGE result: rank=#4, displaced by config-env.md#2 and others.
//
// Requires: bench-retrieval-custom-50 collection already indexed.
//
// Run: ONNX_EMBED=1 CE_DTYPE=q4 node benchmarks/retrieval/custom-50/c03-diagnostic.js

import 'dotenv/config';
import { AutoTokenizer, AutoModelForSequenceClassification, env as hfEnv } from '@huggingface/transformers';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hybridSearch, scroll } from '../../../src/core/qdrant.js';
import { embedForSearch } from '../../../src/core/embeddings.js';
import { rerankResults } from '../../../src/core/rerank.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
hfEnv.cacheDir = resolve(__dirname, '../../../models');

const COLLECTION  = 'bench-retrieval-custom-50';
const QUERY       = 'як увімкнути bge-m3-onnx без Ollama';
const CE_MODEL    = process.env.CE_MODEL    ?? 'ONNX-community/bge-reranker-v2-m3-ONNX';
const CE_DTYPE    = process.env.CE_DTYPE    ?? 'q4';
const CE_INPUT    = process.env.CE_INPUT    ?? 'text+meta';
const TOP_K       = 10;
const MULT        = 4;

const TOKENS = ['bge', 'm3', 'onnx', 'ONNX_EMBED', 'onnx_embed', 'ollama', 'провайдер', 'provider',
                'увімкнути', 'без', 'bge-m3-onnx'];

function buildPassage(p) {
  if (CE_INPUT === 'text+section') return `${p.section ?? ''}\n${p.text ?? ''}`;
  if (CE_INPUT === 'text+meta')    return `${p.source_file ?? ''} ${p.section ?? ''}\n${p.text ?? ''}`;
  return p.text ?? '';
}

function tokenOverlap(p) {
  const hay = [p.source_file, p.section, p.text].join(' ').toLowerCase();
  return TOKENS.filter(t => hay.includes(t.toLowerCase()));
}

// Load CE model
process.stderr.write(`[c03-diag] Loading CE ${CE_MODEL} dtype=${CE_DTYPE}...\n`);
const tok   = await AutoTokenizer.from_pretrained(CE_MODEL);
const model = await AutoModelForSequenceClassification.from_pretrained(CE_MODEL, { dtype: CE_DTYPE });
const probe = tok(['q'], { text_pair: ['p'], truncation: true, max_length: 16, return_tensors: 'pt', padding: true });
const { logits: pl } = await model(probe);
const numLabels = pl.dims[1];
process.stderr.write(`[c03-diag] Ready. numLabels=${numLabels}\n`);

async function ceScoreAll(candidates) {
  const BATCH = 16;
  const scores = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch    = candidates.slice(i, i + BATCH);
    const queries  = batch.map(() => QUERY);
    const passages = batch.map(r => buildPassage(r.payload));
    const inputs   = tok(queries, { text_pair: passages, truncation: true, max_length: 512, return_tensors: 'pt', padding: true });
    const { logits } = await model(inputs);
    for (let j = 0; j < batch.length; j++) {
      const col = numLabels === 2 ? 1 : 0;
      scores.push(logits.data[j * numLabels + col]);
    }
  }
  return candidates.map((r, i) => ({ ...r, ceScore: scores[i] }));
}

process.stderr.write('[c03-diag] Embedding query...\n');
const { dense, sparse } = await embedForSearch(COLLECTION, QUERY);
const prefetchLimit = Math.max(TOP_K * MULT, TOP_K + 1);

const hybridTrue = await hybridSearch(COLLECTION, dense, sparse, TOP_K);
const pool       = await hybridSearch(COLLECTION, dense, sparse, prefetchLimit);
const detReranked = rerankResults(pool, QUERY, { finalLimit: TOP_K, collection: COLLECTION });

process.stderr.write('[c03-diag] Scoring with CE...\n');
const ceScored = (await ceScoreAll(pool)).sort((a, b) => b.ceScore - a.ceScore).slice(0, TOP_K);

function marker(p) {
  if (p.source_file === 'providers.md'  && p.chunk_index === 2) return ' <<< TARGET rel=3';
  if (p.source_file === 'providers.md'  && p.chunk_index === 3) return ' <<< rel=2';
  if (p.source_file === 'config-env.md' && p.chunk_index === 2) return ' <<< config-env#2 (blocker)';
  return '';
}

function printRanking(title, results, showCE) {
  process.stdout.write(`\n=== ${title} ===\n`);
  results.forEach((r, i) => {
    const p = r.payload;
    process.stdout.write(
      `  ${i + 1}. ${p.source_file}#${p.chunk_index}` +
      ` rrf=${r.score?.toFixed(5) ?? 'n/a'}` +
      (showCE ? ` ce=${r.ceScore?.toFixed(4)}` : '') +
      ` overlap=[${tokenOverlap(p).join(',')}]${marker(p)}\n`
    );
  });
}

printRanking(`hybrid-true  (query: "${QUERY}")`, hybridTrue, false);
printRanking('det-rerank', detReranked, false);
printRanking(`CE (${CE_INPUT}, ${CE_DTYPE})`, ceScored, true);

// Deep inspect: providers.md#2 vs config-env.md#2 and all chunks above target in CE ranking
process.stdout.write('\n\n=== CHUNK TEXTS ===\n');
const all = await scroll(COLLECTION, undefined, 200, ['source_file','chunk_index','section','text','tags']);

const targetRank = ceScored.findIndex(r => r.payload.source_file === 'providers.md' && r.payload.chunk_index === 2);
const above = ceScored.slice(0, Math.max(targetRank, 3));

const interesting = new Set([
  'providers.md#2', 'providers.md#3', 'config-env.md#2',
  ...above.map(r => `${r.payload.source_file}#${r.payload.chunk_index}`),
]);

for (const id of interesting) {
  const [sf, ci] = id.split('#');
  const p = all.find(x => x.payload?.source_file === sf && x.payload?.chunk_index === +ci);
  if (!p) { process.stdout.write(`\n--- ${id}: NOT FOUND ---\n`); continue; }
  const ceHit = ceScored.find(r => r.payload.source_file === sf && r.payload.chunk_index === +ci);
  const hybHit = hybridTrue.find(r => r.payload.source_file === sf && r.payload.chunk_index === +ci);
  process.stdout.write(
    `\n--- ${id} ---\n` +
    `section : ${p.payload.section}\n` +
    `rrf_rank: ${hybHit ? `#${hybridTrue.indexOf(hybHit)+1}` : 'outside top-10'}\n` +
    `ce_rank : ${ceHit ? `#${ceScored.indexOf(ceHit)+1}` : 'outside top-10'}\n` +
    `ce_score: ${ceHit?.ceScore?.toFixed(4) ?? 'n/a'}\n` +
    `overlap : [${tokenOverlap(p.payload).join(', ')}]\n` +
    `text    :\n${p.payload.text?.slice(0, 600)}\n`
  );
}
