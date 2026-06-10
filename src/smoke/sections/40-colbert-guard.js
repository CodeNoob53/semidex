export default async function ({ ok }) {
  console.log('\n[40] ColBERT guard — blend, top-1 protection, trigger (pure helpers)');

  const { minMaxNormalize, guardedColbertOrder, hybridConfidenceGap, shouldTriggerColbert } =
    await import('../../../benchmarks/retrieval/lib/colbert-guard.js');

  const near = (a, b) => Math.abs(a - b) < 1e-9;
  // Candidate factory: id for identity tracking, score = raw ColBERT MaxSim.
  const cand = (id, score) => ({ id, score, payload: { source_file: `${id}.md`, chunk_index: 0 } });

  // ── minMaxNormalize ─────────────────────────────────────────────────────────
  ok('normalize empty → []',            minMaxNormalize([]).length === 0);
  ok('normalize constant → all 0.5',    minMaxNormalize([2, 2, 2]).every(v => v === 0.5));
  {
    const n = minMaxNormalize([0.4, 0.6, 0.8]);
    ok('normalize min → 0',             near(n[0], 0));
    ok('normalize mid → 0.5',           near(n[1], 0.5));
    ok('normalize max → 1',             near(n[2], 1));
  }

  // ── guardedColbertOrder: top-1 protection ───────────────────────────────────
  {
    // hybrid #1 has slightly lower ColBERT score than hybrid #3;
    // advantage 0.03 < protectDelta 0.05 → hybrid #1 must stay first.
    const pool = [cand('h1', 0.70), cand('h2', 0.50), cand('h3', 0.73)];
    const out = guardedColbertOrder(pool, { protectDelta: 0.05, blendAlpha: 1, topK: 3 });
    ok('protection keeps hybrid #1 when advantage < delta', out[0].id === 'h1');
  }
  {
    // advantage 0.20 >= protectDelta 0.05 → challenger displaces hybrid #1.
    const pool = [cand('h1', 0.50), cand('h2', 0.45), cand('h3', 0.70)];
    const out = guardedColbertOrder(pool, { protectDelta: 0.05, blendAlpha: 1, topK: 3 });
    ok('challenger wins when advantage >= delta', out[0].id === 'h3');
  }
  {
    // protectDelta 0 disables protection entirely.
    const pool = [cand('h1', 0.70), cand('h2', 0.50), cand('h3', 0.71)];
    const out = guardedColbertOrder(pool, { protectDelta: 0, blendAlpha: 1, topK: 3 });
    ok('protectDelta=0 disables protection', out[0].id === 'h3');
  }

  // ── guardedColbertOrder: blend ──────────────────────────────────────────────
  {
    // alpha=0 → pure hybrid order regardless of ColBERT scores.
    const pool = [cand('h1', 0.10), cand('h2', 0.90), cand('h3', 0.50)];
    const out = guardedColbertOrder(pool, { protectDelta: 0, blendAlpha: 0, topK: 3 });
    ok('alpha=0 reproduces hybrid order', out.map(c => c.id).join(',') === 'h1,h2,h3');
  }
  {
    // alpha=1, no protection → pure ColBERT order.
    const pool = [cand('h1', 0.10), cand('h2', 0.90), cand('h3', 0.50)];
    const out = guardedColbertOrder(pool, { protectDelta: 0, blendAlpha: 1, topK: 3 });
    ok('alpha=1 reproduces ColBERT order', out.map(c => c.id).join(',') === 'h2,h3,h1');
  }
  {
    // topK trims the output; original pool is not mutated.
    const pool = [cand('h1', 0.9), cand('h2', 0.8), cand('h3', 0.7)];
    const out = guardedColbertOrder(pool, { protectDelta: 0, blendAlpha: 1, topK: 2 });
    ok('topK trims output', out.length === 2);
    ok('input pool not mutated', pool[0].id === 'h1' && pool.length === 3);
    ok('output carries blend score, not raw MaxSim', out[0].score <= 1 && out[0].score >= 0);
  }
  ok('empty pool → []', guardedColbertOrder([], {}).length === 0);

  // ── hybridConfidenceGap ─────────────────────────────────────────────────────
  ok('gap null on short pool',     hybridConfidenceGap([cand('a', 0.03)]) === null);
  ok('gap null on zero score',     hybridConfidenceGap([cand('a', 0), cand('b', 0)]) === null);
  ok('gap computed correctly',     near(hybridConfidenceGap([cand('a', 0.030), cand('b', 0.024)]), 0.2));

  // ── shouldTriggerColbert ────────────────────────────────────────────────────
  // Typical RRF scores: 0.016–0.033 — thresholds expressed as relative gap.
  ok('low gap triggers rerank',        shouldTriggerColbert([cand('a', 0.030), cand('b', 0.029)], 0.10) === true);
  ok('high gap keeps hybrid order',    shouldTriggerColbert([cand('a', 0.030), cand('b', 0.020)], 0.10) === false);
  ok('unknown confidence triggers',    shouldTriggerColbert([cand('a', 0.030)], 0.10) === true);
}
