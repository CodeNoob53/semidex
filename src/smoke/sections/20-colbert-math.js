export default async function ({ ok }) {
  console.log('\n[20] ColBERT math — pure helpers (no model load)');

  const { l2Norm, dot, maxSimScore, extractTokenVecs, SPECIAL_TOKENS } = await import(
    '../../../benchmarks/retrieval/lib/colbert-math.js'
  );

  const unit = (i, d) => Float32Array.from({ length: d }, (_, j) => j === i ? 1 : 0);
  const dim = 4;

  // ── l2Norm ──────────────────────────────────────────────────────────────────
  ok('l2Norm unit vector = 1',  Math.abs(l2Norm(unit(0, dim)) - 1) < 1e-6);
  ok('l2Norm zero vector = 0',  l2Norm(new Float32Array(dim)) === 0);
  ok('l2Norm [3,4] = 5',        Math.abs(l2Norm(Float32Array.of(3, 4)) - 5) < 1e-6);

  // ── dot ─────────────────────────────────────────────────────────────────────
  ok('dot orthogonal = 0',      dot(unit(0, dim), unit(1, dim)) === 0);
  ok('dot same unit = 1',       dot(unit(0, dim), unit(0, dim)) === 1);

  // ── maxSimScore — pre-normalised path ────────────────────────────────────────
  const q0 = [unit(0, dim)];
  const dA = [unit(0, dim)];
  const dB = [unit(1, dim)];

  ok('MaxSim identical = 1',       Math.abs(maxSimScore(q0, dA, true) - 1) < 1e-6);
  ok('MaxSim orthogonal = 0',      Math.abs(maxSimScore(q0, dB, true) - 0) < 1e-6);

  // Query 2 tokens (ax0, ax1), doc 2 tokens (ax0, ax2): (1+0)/2 = 0.5
  const q2 = [unit(0, dim), unit(1, dim)];
  const d2 = [unit(0, dim), unit(2, dim)];
  ok('MaxSim avg 2 query tokens',  Math.abs(maxSimScore(q2, d2, true) - 0.5) < 1e-6);

  const scoreRel   = maxSimScore([unit(0, dim)], [unit(0, dim)], true);
  const scoreIrrel = maxSimScore([unit(0, dim)], [unit(1, dim)], true);
  ok('relevant > off-topic',        scoreRel > scoreIrrel);

  ok('empty query returns 0',       maxSimScore([], dA, true) === 0);
  ok('empty doc returns 0',         maxSimScore(q0, [], true) === 0);

  // ── maxSimScore — non-normalised path ────────────────────────────────────────
  const v2 = Float32Array.of(2, 0, 0, 0);
  const vn = Float32Array.of(-2, 0, 0, 0);
  ok('MaxSim non-norm parallel = 1',      Math.abs(maxSimScore([v2], [v2], false) - 1) < 1e-6);
  ok('MaxSim non-norm anti-parallel = -1', Math.abs(maxSimScore([v2], [vn], false) + 1) < 1e-6);

  // ── extractTokenVecs — synthetic tensor ─────────────────────────────────────
  // Build a fake colbert_vecs tensor with shape [1, 5, 2].
  // Tokens: [CLS=1, "hello"=100, "world"=200, PAD=0, SEP=2]
  // attnMask: [1, 1, 1, 0, 1]
  // Expected live tokens: only indices 1 and 2 (CLS and SEP are special; PAD masked out).
  const seqLen = 5;
  const vdim   = 2;
  const flatData = Float32Array.of(
    0.1, 0.2,   // token 0: CLS  (id=1, special → filtered)
    0.3, 0.4,   // token 1: hello (id=100, live)
    0.5, 0.6,   // token 2: world (id=200, live)
    0.7, 0.8,   // token 3: PAD  (mask=0 → filtered)
    0.9, 1.0,   // token 4: SEP  (id=2, special → filtered)
  );

  const fakeTensor = { dims: [1, seqLen, vdim], data: flatData };
  const inputIds   = [1, 100, 200, 0, 2];
  const attnMask   = [1,   1,   1, 0, 1];

  const vecs = extractTokenVecs(fakeTensor, inputIds, attnMask);

  ok('extractTokenVecs: 2 live tokens (hello, world)', vecs.length === 2);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  ok('extractTokenVecs: first live token = hello vec',
     near(vecs[0][0], 0.3) && near(vecs[0][1], 0.4));
  ok('extractTokenVecs: second live token = world vec',
     near(vecs[1][0], 0.5) && near(vecs[1][1], 0.6));

  // All-special sequence → zero live tokens.
  const allSpecial = extractTokenVecs(
    { dims: [1, 3, 2], data: Float32Array.of(0.1, 0.2, 0.3, 0.4, 0.5, 0.6) },
    [1, 2, 3],   // CLS, SEP, unk — all in SPECIAL_TOKENS
    [1, 1, 1],
  );
  ok('extractTokenVecs: all-special → empty', allSpecial.length === 0);

  // All-padding sequence → zero live tokens.
  const allPad = extractTokenVecs(
    { dims: [1, 3, 2], data: Float32Array.of(0.1, 0.2, 0.3, 0.4, 0.5, 0.6) },
    [100, 200, 300],
    [0, 0, 0],   // all masked
  );
  ok('extractTokenVecs: all-padding → empty', allPad.length === 0);

  // SPECIAL_TOKENS set is exported and matches production onnx-embed.js values.
  ok('SPECIAL_TOKENS contains pad(0)',    SPECIAL_TOKENS.has(0));
  ok('SPECIAL_TOKENS contains bos(1)',    SPECIAL_TOKENS.has(1));
  ok('SPECIAL_TOKENS contains eos(2)',    SPECIAL_TOKENS.has(2));
  ok('SPECIAL_TOKENS contains mask(250001)', SPECIAL_TOKENS.has(250001));
  ok('SPECIAL_TOKENS excludes normal id', !SPECIAL_TOKENS.has(100));
}
