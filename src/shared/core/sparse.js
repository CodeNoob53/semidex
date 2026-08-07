// Hashed sparse TF encoder — produces Qdrant-compatible {indices, values}.
// Each token maps to a bucket index via djb2 hash (2^20 space).
// Score uses the BM25 TF saturation formula with IDF=1 (no corpus stats at
// encode time). This means common terms are NOT downweighted across documents —
// ranking is weaker than true BM25 but zero-dependency and fast.
// Upgrade path: replace with SPLADE for corpus-aware sparse encoding.

const K1 = 1.5;
const B  = 0.75;

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','shall','can','need',
  'that','this','these','those','it','its','i','you','he','she','we','they',
  'their','what','which','who','how','when','where','not','no','so','if',
  'as','by','from','up','about','into','than','then','also','just','more',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

// Stable integer bucket index for a token via djb2 hash.
function tokenIndex(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h) ^ token.charCodeAt(i);
  return Math.abs(h) % (1 << 20);
}

/**
 * Encode text into a Qdrant-compatible sparse vector.
 * avgDocLen is optional — omitting it sets dl=docLen (length normalization off).
 *
 * @param {string} text
 * @param {number} [avgDocLen]
 * @returns {{ indices: number[], values: number[] }}
 */
export function encode(text, avgDocLen) {
  const tokens = tokenize(text);
  const docLen = tokens.length;
  if (!docLen) return { indices: [], values: [] };

  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  const dl = avgDocLen ?? docLen;

  const buckets = new Map();
  for (const [token, freq] of tf) {
    const idx = tokenIndex(token);
    const score = (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * (docLen / dl)));
    buckets.set(idx, (buckets.get(idx) ?? 0) + score);
  }

  const indices = [...buckets.keys()];
  const values  = indices.map(i => buckets.get(i));
  return { indices, values };
}
