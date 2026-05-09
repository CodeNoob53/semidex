// BM25 sparse vector encoder.
// Produces {indices, values} compatible with Qdrant sparse vector format.
// Vocabulary is built on-the-fly per call — no persistent state needed.

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
    .replace(/[^a-zа-яіїєґ0-9\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

// Stable integer index for a token via djb2 hash, capped to 2^20 bucket space.
function tokenIndex(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h) ^ token.charCodeAt(i);
  return Math.abs(h) % (1 << 20);
}

/**
 * Encode a single text into a Qdrant-compatible sparse vector.
 * avgDocLen is optional — pass the corpus average for better BM25 scores,
 * or omit to use the document length itself (equivalent to b=0 effect).
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
    // BM25 TF component (IDF=1 since we have no corpus stats at encode time)
    const score = (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * (docLen / dl)));
    buckets.set(idx, (buckets.get(idx) ?? 0) + score);
  }

  const indices = [...buckets.keys()];
  const values  = indices.map(i => buckets.get(i));
  return { indices, values };
}
