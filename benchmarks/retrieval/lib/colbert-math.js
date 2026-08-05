// Pure ColBERT math helpers — no model load, no I/O, no side effects.
// Used by bge-m3-colbert-probe.js and tested by src/smoke/sections/20-colbert-math.js.

// bge-m3 sentencepiece special token IDs — same set as src/local/core/onnx-embed.js
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

// ── Token extraction ──────────────────────────────────────────────────────────
//
// The aapot/bge-m3-onnx model strips CLS from colbert_vecs output:
//   colbert seq_len = input_ids.length - 1  (CLS removed, EOS kept)
//   colbert row t  → inputIds[t + 1]        (offset = 1)
//
// Two token policies are supported:
//   'official'  — keep EOS (2); filter only CLS/pad/unk/mask (not EOS)
//   'no-eos'    — also filter EOS (2); matches SPECIAL_TOKENS set
//
// Shape variants handled:
//   seq_len == inputIds.length - 1  → offset = 1 (CLS stripped by model)
//   seq_len == inputIds.length      → offset = 0 (raw hidden states, no stripping)
//   anything else                   → throws

// Special tokens to always exclude (CLS=0, bos=1, pad=0, unk=3, mask=250001).
// EOS (2) is excluded only in 'no-eos' policy.
const SPECIAL_NO_EOS = new Set([0, 1, 3, 250001]);   // keep EOS
const SPECIAL_WITH_EOS = SPECIAL_TOKENS;              // also remove EOS (alias for clarity)

// Extract per-token vectors from a colbert_vecs tensor, handling CLS offset.
// colbertTensor: { dims: [batch, seq_len, dim], data: Float32Array }
// inputIds: number[]  — full tokeniser output including CLS
// attnMask:  number[] — full attention mask including CLS position
// tokenPolicy: 'official' (keep EOS) | 'no-eos' (filter EOS)
//
// Returns Float32Array[] — one slice per live token.
export function extractTokenVecsBGE(colbertTensor, inputIds, attnMask, tokenPolicy = 'official') {
  const [, seqLen, dim] = colbertTensor.dims;
  const flat = colbertTensor.data;

  const offset = inputIds.length - seqLen;
  if (offset !== 0 && offset !== 1) {
    throw new Error(
      `colbert_vecs shape mismatch: seq_len=${seqLen} vs inputIds.length=${inputIds.length} ` +
      `(offset=${offset}; expected 0 or 1)`
    );
  }

  const excluded = tokenPolicy === 'official' ? SPECIAL_NO_EOS : SPECIAL_WITH_EOS;
  const vecs = [];

  for (let t = 0; t < seqLen; t++) {
    const idxInIds = t + offset;           // position in inputIds / attnMask
    if (attnMask[idxInIds] === 0) continue;
    if (excluded.has(inputIds[idxInIds])) continue;
    vecs.push(flat.slice(t * dim, (t + 1) * dim));
  }
  return vecs;
}

// Legacy extractor — assumes seq_len == inputIds.length (offset = 0).
// Kept for smoke test compatibility with synthetic tensors.
// For real bge-m3-onnx inference, use extractTokenVecsBGE instead.
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
