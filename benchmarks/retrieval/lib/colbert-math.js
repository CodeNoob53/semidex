// Pure ColBERT math helpers — no model load, no I/O, no side effects.
// Used by bge-m3-colbert-probe.js and tested by src/smoke/sections/20-colbert-math.js.

// bge-m3 sentencepiece special token IDs — same set as src/core/onnx-embed.js
export const SPECIAL_TOKENS = new Set([0, 1, 2, 3, 250001]);

export function l2Norm(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  return Math.sqrt(sum);
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// MaxSim between a query token matrix and a document token matrix.
// score = mean over query tokens of max cosine(q_token, d_token).
// Pass alreadyNormalised=true when vectors are already L2-normalised (cosine = dot).
export function maxSimScore(queryVecs, docVecs, alreadyNormalised = false) {
  if (queryVecs.length === 0 || docVecs.length === 0) return 0;

  const qNorms = alreadyNormalised ? null : queryVecs.map(l2Norm);
  const dNorms = alreadyNormalised ? null : docVecs.map(l2Norm);

  let total = 0;
  for (let qi = 0; qi < queryVecs.length; qi++) {
    let best = -Infinity;
    for (let di = 0; di < docVecs.length; di++) {
      let similarity = dot(queryVecs[qi], docVecs[di]);
      if (!alreadyNormalised) {
        const denom = (qNorms[qi] || 1) * (dNorms[di] || 1);
        similarity /= denom;
      }
      if (similarity > best) best = similarity;
    }
    total += best;
  }
  return total / queryVecs.length;
}

// Extract per-token vectors from a colbert_vecs ONNX tensor with shape [batch, seq_len, dim].
// Filters padding positions (attn_mask == 0) and special tokens (CLS/SEP/pad/unk/mask).
// Returns Float32Array[] — one slice per live token.
export function extractTokenVecs(colbertTensor, inputIds, attnMask) {
  const [, seqLen, dim] = colbertTensor.dims;
  const flat = colbertTensor.data;
  const vecs = [];

  for (let t = 0; t < seqLen; t++) {
    if (attnMask[t] === 0) continue;
    if (SPECIAL_TOKENS.has(inputIds[t])) continue;
    vecs.push(flat.slice(t * dim, (t + 1) * dim));
  }
  return vecs;
}
