// CE reranker smoke tests — stubbed, no network, no model download.
// Covers the four cases from docs/en/ce-rerank-design.md §7:
//   1. stub path ordering (CE sort flips candidates by mocked logits)
//   2. timeout fallback (withCETimeout returns pre-CE results fast)
//   3. model load failure fallback (CE disabled for session, logged once)
//   4. numLabels fail-fast (unsupported head layout rejected at load)

export default async function ({ ok }) {
  console.log('\n[41] CE rerank — stubbed path, timeout, load-failure, numLabels');

  const { ceRerank, loadCEModel, buildPassage, withCETimeout, __test } =
    await import('../../core/ce-rerank.js');

  const cand = (file, text) => ({
    score: 0.03,
    payload: { source_file: file, chunk_index: 0, section: 'sec', text },
  });
  const candidates = [cand('alpha.md', 'alpha text'), cand('beta.md', 'beta text')];

  // Stub tokenizer: passes batch size and passages through to the stub model.
  const stubTokenizer = (queries, opts) => ({
    __batch: queries.length,
    __passages: opts?.text_pair ?? [],
  });

  // Stub model factory: numLabels columns; positive logit 0.9 for passages
  // mentioning "beta", 0.1 otherwise. Row-major [batch, numLabels].
  const stubModel = (numLabels) => async (inputs) => {
    const rows = inputs.__batch;
    const data = new Float32Array(rows * numLabels);
    for (let r = 0; r < rows; r++) {
      const s = String(inputs.__passages[r] ?? '').includes('beta') ? 0.9 : 0.1;
      if (numLabels === 1) data[r] = s;
      else { data[r * numLabels] = 1 - s; data[r * numLabels + 1] = s; }
    }
    return { logits: { dims: [rows, numLabels], data } };
  };

  // Temporarily capture stderr; returns captured text.
  const captureStderr = async (fn) => {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    try { await fn(); } finally { process.stderr.write = orig; }
    return captured;
  };

  // ── buildPassage formats ─────────────────────────────────────────────────────
  const pay = { source_file: 'a.md', section: 'Install', text: 'body' };
  ok('passage text',         buildPassage(pay, 'text') === 'body');
  ok('passage text+section', buildPassage(pay, 'text+section') === 'Install\nbody');
  ok('passage text+meta',    buildPassage(pay, 'text+meta') === 'a.md Install\nbody');
  ok('passage null payload safe', buildPassage(null, 'text') === '');

  // ── 1. Stub path ordering ────────────────────────────────────────────────────
  __test.reset();
  __test.setLoadImpl(() => __test.initFromPair(stubTokenizer, stubModel(2)));
  await captureStderr(async () => {
    const out = await ceRerank(candidates, 'find beta', { finalLimit: 2 });
    ok('CE flips order by mocked scores', out[0].payload.source_file === 'beta.md');
    ok('CE score attached',               out[0].score > out[1].score);
    ok('numLabels=2 detected',            __test.state().numLabels === 2);
  });

  // numLabels=1 regression head also accepted.
  __test.reset();
  __test.setLoadImpl(() => __test.initFromPair(stubTokenizer, stubModel(1)));
  await captureStderr(async () => {
    const out = await ceRerank(candidates, 'find beta', { finalLimit: 2 });
    ok('numLabels=1 path works', out[0].payload.source_file === 'beta.md');
  });

  // Empty pool short-circuits without load.
  __test.reset();
  __test.setLoadImpl(async () => { throw new Error('must not be called'); });
  ok('empty pool → [] without load', (await ceRerank([], 'q', {})).length === 0);

  // ── 2. Timeout fallback ──────────────────────────────────────────────────────
  {
    // withCETimeout unrefs its sentinel timer (correct for the long-lived MCP
    // server); in this short-lived test we must keep the event loop alive
    // ourselves or Node exits before the race resolves.
    const keepalive = setTimeout(() => {}, 10000);
    const slow = new Promise(res => {
      const t = setTimeout(() => res(['late']), 20000);
      if (typeof t.unref === 'function') t.unref();
    });
    const t0 = Date.now();
    let fb = null;
    await captureStderr(async () => {
      fb = await withCETimeout(slow, 100, () => candidates.slice(0, 2));
    });
    clearTimeout(keepalive);
    const elapsed = Date.now() - t0;
    ok('timeout resolves fast (<1000ms)',     elapsed < 1000);
    ok('timeout returns pre-CE candidates',   fb.length === 2 && fb[0].payload.source_file === 'alpha.md');
  }
  {
    const fast = Promise.resolve(['ce-result']);
    const out = await withCETimeout(fast, 5000, () => ['fallback']);
    ok('fast path wins the race', out[0] === 'ce-result');
  }

  // ── 3. Model load failure fallback ──────────────────────────────────────────
  __test.reset();
  __test.setLoadImpl(async () => { throw new Error('network unavailable and model not cached'); });
  {
    const logged = await captureStderr(async () => {
      const out1 = await ceRerank(candidates, 'q', { finalLimit: 2 });
      const out2 = await ceRerank(candidates, 'q', { finalLimit: 2 });
      ok('load failure returns pre-CE list (1st)', out1[0].payload.source_file === 'alpha.md');
      ok('load failure returns pre-CE list (2nd)', out2[0].payload.source_file === 'alpha.md');
    });
    ok('_ceModelFailed set after load failure', __test.state().failed === true);
    const occurrences = logged.split('model load failed:').length - 1;
    ok('failure logged exactly once (no retry)', occurrences === 1);
  }

  // ── 4. numLabels fail-fast ──────────────────────────────────────────────────
  __test.reset();
  __test.setLoadImpl(() => __test.initFromPair(stubTokenizer, stubModel(3)));
  {
    let threw = null;
    await captureStderr(async () => {
      try { await loadCEModel(); } catch (e) { threw = e; }
    });
    ok('numLabels=3 rejected at load',        threw !== null && threw.message.includes('unsupported numLabels=3'));
    ok('_ceModelFailed set on bad numLabels', __test.state().failed === true);
    await captureStderr(async () => {
      const out = await ceRerank(candidates, 'q', { finalLimit: 2 });
      ok('subsequent ceRerank returns pre-CE list', out[0].payload.source_file === 'alpha.md');
    });
  }

  // Restore module state for any later section.
  __test.reset();
}
