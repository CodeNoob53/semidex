// One-shot model compatibility probe for cross-encoder candidates.
// Tests AutoTokenizer + AutoModelForSequenceClassification load path,
// runs a numLabels probe, and scores one (query, passage) pair.
//
// Usage:
//   CE_MODEL=<model-id> [CE_DTYPE=fp32|q4|int8] node benchmarks/retrieval/custom-50/ce-probe.js
//
// Example (BGE q4):
//   CE_MODEL=ONNX-community/bge-reranker-v2-m3-ONNX CE_DTYPE=q4 node benchmarks/retrieval/custom-50/ce-probe.js

import 'dotenv/config';
import { AutoTokenizer, AutoModelForSequenceClassification, env as hfEnv } from '@huggingface/transformers';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
hfEnv.cacheDir = resolve(__dirname, '../../../models');

const MODEL    = process.env.CE_MODEL  ?? 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1';
const CE_DTYPE = process.env.CE_DTYPE  ?? 'fp32';

process.stdout.write(`\n=== CE probe: ${MODEL} ===\n`);
process.stdout.write(`CE_DTYPE  : ${CE_DTYPE}\n`);
process.stdout.write(`Cache dir : ${hfEnv.cacheDir}\n\n`);

const t0 = Date.now();

let tokenizer, model, numLabels;

try {
  process.stdout.write('[1/3] Loading tokenizer...\n');
  tokenizer = await AutoTokenizer.from_pretrained(MODEL);
  process.stdout.write(`  OK (${Date.now() - t0}ms)\n`);
} catch (err) {
  process.stdout.write(`  FAILED: ${err.message}\n`);
  process.exit(1);
}

try {
  process.stdout.write(`[2/3] Loading model (dtype=${CE_DTYPE})...\n`);
  const t1 = Date.now();
  model = await AutoModelForSequenceClassification.from_pretrained(MODEL, { dtype: CE_DTYPE });
  process.stdout.write(`  OK (${Date.now() - t1}ms, total ${Date.now() - t0}ms)\n`);
} catch (err) {
  process.stdout.write(`  FAILED: ${err.message}\n`);
  process.exit(1);
}

try {
  process.stdout.write('[3/3] numLabels probe...\n');
  const probe = tokenizer(['test query'], {
    text_pair: ['test passage'],
    truncation: true, max_length: 16,
    return_tensors: 'pt', padding: true,
  });
  const { logits } = await model(probe);
  numLabels = logits.dims[1];
  process.stdout.write(`  logits.dims: [${logits.dims.join(', ')}]  numLabels=${numLabels}\n`);
  if (numLabels === 1) {
    process.stdout.write('  → regression head: use logits[:,0] as relevance score\n');
  } else if (numLabels === 2) {
    process.stdout.write('  → binary classification: use logits[:,1] as relevance score\n');
  } else {
    process.stdout.write(`  → UNSUPPORTED: numLabels=${numLabels} (expected 1 or 2)\n`);
  }
} catch (err) {
  process.stdout.write(`  FAILED: ${err.message}\n`);
  process.exit(1);
}

try {
  process.stdout.write('\n[bonus] Scoring one real (query, passage) pair...\n');
  const QUERY   = 'chunkFile splitSentences parseMarkdown location in source';
  const PASSAGE = '[project-structure.md § src/indexer/phases/chunk.js] Exports `chunkFile(filePath, text, sourceFile)`. Returns an array of chunk objects with `text`, `section`, `chunkIndex`, `totalChunks`.';
  const inputs = tokenizer([QUERY], {
    text_pair: [PASSAGE],
    truncation: true, max_length: 512,
    return_tensors: 'pt', padding: true,
  });
  const { logits } = await model(inputs);
  const col   = numLabels === 2 ? 1 : 0;
  const score = logits.data[col];
  process.stdout.write(`  query:   "${QUERY.slice(0, 60)}"\n`);
  process.stdout.write(`  passage: "${PASSAGE.slice(0, 80)}..."\n`);
  process.stdout.write(`  score:   ${score.toFixed(6)} (col ${col})\n`);
} catch (err) {
  process.stdout.write(`  FAILED: ${err.message}\n`);
}

const totalMs = Date.now() - t0;
process.stdout.write(`\nTotal probe time: ${totalMs}ms\n`);
process.stdout.write(`Compatible with cross-encoder-bench.js: ${numLabels === 1 || numLabels === 2 ? 'YES' : 'NO'}\n\n`);
