export default async function ({ ok, throws }) {
  console.log('\n[20] ColBERT math — pure helpers (no model load)');

  const { l2Norm, dot, maxSimScore, extractTokenVecs, extractTokenVecsBGE, SPECIAL_TOKENS } = await import(
    '../../../benchmarks/retrieval/lib/colbert-math.js'
  );

  const unit = (i, d) => Float32Array.from({ length: d }, (_, j) => j === i ? 1 : 0);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
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
  ok('MaxSim non-norm parallel = 1',       Math.abs(maxSimScore([v2], [v2], false) - 1) < 1e-6);
  ok('MaxSim non-norm anti-parallel = -1', Math.abs(maxSimScore([v2], [vn], false) + 1) < 1e-6);

  // ── extractTokenVecs (legacy, offset=0) — synthetic tensor ──────────────────
  // shape [1, 5, 2]; seq_len == inputIds.length → offset = 0.
  // Tokens: [CLS=1, hello=100, world=200, PAD=0/masked, SEP=2]
  // Expected live: hello and world only (CLS, SEP special; PAD masked).
  const seqLen = 5;
  const vdim   = 2;
  const flatData = Float32Array.of(
    0.1, 0.2,   // CLS  (id=1, special → filtered)
    0.3, 0.4,   // hello (id=100, live)
    0.5, 0.6,   // world (id=200, live)
    0.7, 0.8,   // PAD  (mask=0 → filtered)
    0.9, 1.0,   // SEP  (id=2, special → filtered)
  );
  const fakeTensor0 = { dims: [1, seqLen, vdim], data: flatData };
  const ids0        = [1, 100, 200, 0, 2];
  const mask0       = [1,   1,   1, 0, 1];

  const vecs0 = extractTokenVecs(fakeTensor0, ids0, mask0);
  ok('extractTokenVecs(off=0): 2 live tokens',         vecs0.length === 2);
  ok('extractTokenVecs(off=0): first vec = hello',     near(vecs0[0][0], 0.3) && near(vecs0[0][1], 0.4));
  ok('extractTokenVecs(off=0): second vec = world',    near(vecs0[1][0], 0.5) && near(vecs0[1][1], 0.6));
  ok('extractTokenVecs(off=0): all-special → empty',
    extractTokenVecs({ dims: [1, 3, 2], data: Float32Array.of(0.1,0.2,0.3,0.4,0.5,0.6) }, [1,2,3], [1,1,1]).length === 0);
  ok('extractTokenVecs(off=0): all-padding → empty',
    extractTokenVecs({ dims: [1, 3, 2], data: Float32Array.of(0.1,0.2,0.3,0.4,0.5,0.6) }, [100,200,300], [0,0,0]).length === 0);

  // ── extractTokenVecsBGE — offset=1 (CLS stripped by model) ─────────────────
  // Simulates aapot/bge-m3-onnx: inputIds has 6 tokens [CLS, a, b, c, d, EOS],
  // colbert output has 5 rows (CLS stripped), mapped as row t → inputIds[t+1].
  // inputIds:  [0=CLS, 100=a, 200=b, 300=c, 0=PAD, 2=EOS]
  // attnMask:  [1,     1,     1,     1,     0,     1    ]
  // colbert rows map: 0→100(a), 1→200(b), 2→300(c), 3→0(PAD/masked), 4→2(EOS)
  // 'official' policy excludes: CLS(0), bos(1), unk(3), mask(250001) — keeps EOS(2)
  // 'no-eos'   policy also excludes EOS(2)
  const ids1   = [0, 100, 200, 300, 0, 2];   // inputIds (length 6, includes CLS at [0])
  const mask1  = [1,   1,   1,   1, 0, 1];   // attnMask (matches inputIds positions)
  const flat1  = Float32Array.of(
    0.1, 0.2,   // colbert row 0 → inputIds[1]=100 (a, live)
    0.3, 0.4,   // colbert row 1 → inputIds[2]=200 (b, live)
    0.5, 0.6,   // colbert row 2 → inputIds[3]=300 (c, live)
    0.7, 0.8,   // colbert row 3 → inputIds[4]=0   (PAD, mask=0 → filtered)
    0.9, 1.0,   // colbert row 4 → inputIds[5]=2   (EOS)
  );
  // seq_len=5, inputIds.length=6 → offset=1
  const fakeTensor1 = { dims: [1, 5, vdim], data: flat1 };

  const vecsOfficial = extractTokenVecsBGE(fakeTensor1, ids1, mask1, 'official');
  ok('extractTokenVecsBGE(off=1, official): 4 live tokens (a,b,c,EOS)', vecsOfficial.length === 4);
  ok('extractTokenVecsBGE(off=1, official): first = a',    near(vecsOfficial[0][0], 0.1) && near(vecsOfficial[0][1], 0.2));
  ok('extractTokenVecsBGE(off=1, official): EOS kept',     near(vecsOfficial[3][0], 0.9) && near(vecsOfficial[3][1], 1.0));

  const vecsNoEos = extractTokenVecsBGE(fakeTensor1, ids1, mask1, 'no-eos');
  ok('extractTokenVecsBGE(off=1, no-eos): 3 live tokens (a,b,c)', vecsNoEos.length === 3);
  ok('extractTokenVecsBGE(off=1, no-eos): last = c',       near(vecsNoEos[2][0], 0.5) && near(vecsNoEos[2][1], 0.6));

  // offset=0 path: seq_len == inputIds.length (no stripping)
  // inputIds: [100, 200, 300]  attnMask: [1,1,1]  seq_len=3 → offset=0
  const flat0x = Float32Array.of(0.1, 0.2,  0.3, 0.4,  0.5, 0.6);
  const vecsOff0 = extractTokenVecsBGE({ dims: [1, 3, vdim], data: flat0x }, [100, 200, 300], [1, 1, 1], 'official');
  ok('extractTokenVecsBGE(off=0): 3 live tokens', vecsOff0.length === 3);

  // shape mismatch (offset=2) → throws
  throws(
    'extractTokenVecsBGE: shape mismatch throws',
    () => extractTokenVecsBGE({ dims: [1, 3, vdim], data: flat0x }, [100, 200, 300, 400, 500], [1,1,1,1,1], 'official'),
    'shape mismatch'
  );

  // ── SPECIAL_TOKENS exported and matches production values ────────────────────
  ok('SPECIAL_TOKENS contains pad(0)',        SPECIAL_TOKENS.has(0));
  ok('SPECIAL_TOKENS contains bos(1)',        SPECIAL_TOKENS.has(1));
  ok('SPECIAL_TOKENS contains eos(2)',        SPECIAL_TOKENS.has(2));
  ok('SPECIAL_TOKENS contains mask(250001)',  SPECIAL_TOKENS.has(250001));
  ok('SPECIAL_TOKENS excludes normal id',     !SPECIAL_TOKENS.has(100));
}
