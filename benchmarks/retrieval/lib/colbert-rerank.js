// ColBERT reranker helper — benchmark-only, no production changes.
// Loads bge-m3-onnx once, extracts colbert_vecs by named output, and scores
// query vs candidate chunks using MaxSim from colbert-math.js.
//
// Call loadColBERTModel() once before the query loop, then scoreColBERT() per query.

import * as ort from 'onnxruntime-node';
import { AutoTokenizer } from '@huggingface/transformers';
import { existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveOnnxExecutionProviders } from '../../../src/local/core/onnx-embed.js';
import { extractTokenVecsBGE, maxSimScore } from './colbert-math.js';

const ROOT       = join(dirname(fileURLToPath(import.meta.url)), '../../../');
const MODEL_DIR  = join(ROOT, 'models', 'bge-m3-onnx');
const MODEL_FILE = join(MODEL_DIR, 'model.onnx');
const DATA_FILE  = join(MODEL_DIR, 'model.onnx.data');
const MODEL_ID   = 'aapot/bge-m3-onnx';

let _tokenizer = null;
let _session   = null;

// Load tokenizer and ONNX session (idempotent — safe to call multiple times).
export async function loadColBERTModel({ logPrefix = '[colbert]' } = {}) {
  if (_tokenizer && _session) return;

  const missing = [MODEL_FILE, DATA_FILE].filter(f => !existsSync(f));
  if (missing.length) {
    process.stderr.write(`${logPrefix} ONNX model not cached. Run ONNX_EMBED=1 indexing once.\n`);
    process.stderr.write(`  Missing: ${missing.map(f => f.replace(ROOT, '')).join(', ')}\n`);
    process.exit(1);
  }
  const dataGB = (statSync(DATA_FILE).size / 1e9).toFixed(2);
  process.stderr.write(`${logPrefix} model cache ok (${dataGB} GB)\n`);

  process.stderr.write(`${logPrefix} loading tokenizer...\n`);
  _tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);

  const providers = resolveOnnxExecutionProviders(process.env.ONNX_EXECUTION_PROVIDER);
  process.stderr.write(`${logPrefix} creating session (providers: ${providers.join(', ')})...\n`);
  const t0 = performance.now();
  _session = await ort.InferenceSession.create(MODEL_FILE, {
    executionProviders: providers,
    graphOptimizationLevel: 'all',
  });
  process.stderr.write(`${logPrefix} session ready in ${(performance.now() - t0).toFixed(0)} ms\n`);
  process.stderr.write(`${logPrefix} output names: ${_session.outputNames.join(', ')}\n`);

  if (!_session.outputNames.includes('colbert_vecs')) {
    process.stderr.write(`${logPrefix} BLOCKED: 'colbert_vecs' not in session outputs.\n`);
    process.exit(1);
  }
}

// Run one text through the ONNX model and return colbert token vectors.
// maxLength: max token length for this call (query vs doc may differ).
// Returns { vecs: Float32Array[], ms: number }.
async function encodeColBERT(text, maxLength) {
  const encoded = await _tokenizer(text, {
    padding: true,
    truncation: true,
    max_length: maxLength,
    return_tensors: 'np',
  });

  const dims    = encoded.input_ids.dims;
  const toInt64 = d => new ort.Tensor('int64',
    BigInt64Array.from(Array.from(d).map(BigInt)), dims);

  const feeds = {
    input_ids:      toInt64(encoded.input_ids.data),
    attention_mask: toInt64(encoded.attention_mask.data),
    token_type_ids: toInt64(
      encoded.token_type_ids?.data ?? new Array(encoded.input_ids.data.length).fill(0)
    ),
  };

  const t0      = performance.now();
  const outputs = await _session.run(feeds);
  const ms      = performance.now() - t0;

  const inputIds   = Array.from(encoded.input_ids.data).map(Number);
  const attnMask   = Array.from(encoded.attention_mask.data).map(Number);
  const policy     = process.env.COLBERT_TOKEN_POLICY ?? 'official';
  const vecs       = extractTokenVecsBGE(outputs['colbert_vecs'], inputIds, attnMask, policy);

  return { vecs, ms };
}

// Score query vs candidate list using ColBERT MaxSim.
// candidates: result[] from hybridSearch (up to topN).
// options:
//   queryMaxLength   — max token length for query encoding (default: 512)
//   docMaxLength     — max token length for doc encoding (default: COLBERT_MAX_LENGTH env or 512)
//   scoreMode        — 'mean' (default) or 'sum' (COLBERT_SCORE_MODE env)
//   topK             — final result count (default: candidates.length)
//
// Returns { scored: result[], ms: number }
//   scored: sorted by ColBERT score descending, top topK.
//   ms: total elapsed ms for query encode + all doc encodes + MaxSim.
export async function scoreColBERT(query, candidates, {
  queryMaxLength = 512,
  docMaxLength   = parseInt(process.env.COLBERT_MAX_LENGTH ?? '512', 10),
  scoreMode      = process.env.COLBERT_SCORE_MODE ?? 'mean',
  topK           = candidates.length,
} = {}) {
  const { allScored, ms } = await scoreColBERTAll(query, candidates, { queryMaxLength, docMaxLength, scoreMode });
  const sorted = [...allScored].sort((a, b) => b.score - a.score);
  return { scored: sorted.slice(0, topK), ms };
}

// Score query vs candidate list and return candidates in their ORIGINAL pool order,
// each enriched with a `.score` field.  No topK slicing or sort applied.
//
// Use this when you need to derive multiple result sets from one scoring pass:
//   const { allScored, ms } = await scoreColBERTAll(query, pool40, opts);
//   const top40 = [...allScored].sort(...).slice(0, K);   // ColBERT order over full pool
//   const top20 = allScored.slice(0, 20).sort(...).slice(0, K); // ColBERT order over hybrid-top-20 subset
//
// Returns { allScored: result[], ms: number }
//   allScored: one entry per input candidate, same order as `candidates`, each with `.score`.
//   ms: total elapsed ms for query encode + all doc encodes + MaxSim.
export async function scoreColBERTAll(query, candidates, {
  queryMaxLength = 512,
  docMaxLength   = parseInt(process.env.COLBERT_MAX_LENGTH ?? '512', 10),
  scoreMode      = process.env.COLBERT_SCORE_MODE ?? 'mean',
} = {}) {
  const t0 = performance.now();

  const { vecs: queryVecs } = await encodeColBERT(query, queryMaxLength);

  // BGE-M3 colbert_vecs are L2-normalised — cosine = dot product.
  const ALREADY_NORMED = true;

  const allScored = [];
  for (const cand of candidates) {
    const text = [
      cand.payload?.section ? `[${cand.payload.section}] ` : '',
      cand.payload?.text ?? '',
    ].join('').trim();

    const { vecs: docVecs } = await encodeColBERT(text, docMaxLength);

    let score = maxSimScore(queryVecs, docVecs, ALREADY_NORMED);
    if (scoreMode === 'sum') score *= queryVecs.length;

    allScored.push({ ...cand, score });
  }

  const ms = performance.now() - t0;
  return { allScored, ms };
}
