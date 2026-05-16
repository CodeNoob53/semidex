// Shared cross-encoder model loader and scorer for CE routing benchmarks.

import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';

let _tok = null, _model = null, _numLabels = null;

export function buildPassage(p, inputMode) {
  if (inputMode === 'text+section') return `${p.section ?? ''}\n${p.text ?? ''}`;
  if (inputMode === 'text+meta')    return `${p.source_file ?? ''} ${p.section ?? ''}\n${p.text ?? ''}`;
  return p.text ?? '';
}

export async function loadCEModel({ modelId, dtype, logPrefix = '[ce]' }) {
  if (_model) return;
  process.stderr.write(`${logPrefix} Loading ${modelId} dtype=${dtype}...\n`);
  _tok   = await AutoTokenizer.from_pretrained(modelId);
  _model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype });
  const probe = _tok(['probe'], { text_pair: ['probe'], truncation: true,
    max_length: 16, return_tensors: 'pt', padding: true });
  const { logits: pl } = await _model(probe);
  _numLabels = pl.dims[1];
  if (_numLabels !== 1 && _numLabels !== 2) {
    process.stderr.write(`${logPrefix} Error: numLabels=${_numLabels} — only 1 or 2 supported.\n`);
    process.exit(1);
  }
  process.stderr.write(`${logPrefix} Ready. numLabels=${_numLabels}\n`);
}

function extractScores(logits, n) {
  const col  = _numLabels === 2 ? 1 : 0;
  const data = logits.data;
  const out  = [];
  for (let i = 0; i < n; i++) out.push(data[i * _numLabels + col]);
  return out;
}

export async function scoreCrossEncoder(query, candidates, { inputMode, batchSize }) {
  const rawScores = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch    = candidates.slice(i, i + batchSize);
    const passages = batch.map(r => buildPassage(r.payload, inputMode));
    const queries  = Array(batch.length).fill(query);
    const inputs   = _tok(queries, {
      text_pair: passages, truncation: true, max_length: 512,
      return_tensors: 'pt', padding: true,
    });
    const { logits } = await _model(inputs);
    for (const v of extractScores(logits, batch.length)) rawScores.push(v);
  }
  return candidates.map((r, i) => ({ result: r, ceScore: rawScores[i] }));
}
