// Stage-2 smoke: adaptive summary source selection + semantic nav summaries
// with a stubbed LLM. Pure — no Ollama, no Qdrant.

export default async function ({ ok }) {
  console.log('\n[51] skeleton summary — adaptive window rule + stubbed LLM');

  const { estTokens, chooseSource, summaryWindowTokens, generateNavSummaries, buildCollectionSummary, sanitizeSummary } =
    await import('../../indexer/phases/skeleton-summary.js');
  const { parseSkeleton } = await import('../../indexer/phases/skeleton.js');
  const { chunkFromSkeleton } = await import('../../indexer/phases/skeleton-chunk.js');
  const { buildFileSkeleton } = await import('../../indexer/phases/skeleton-index.js');

  // ── window budget env ────────────────────────────────────────────────────────
  ok('default window 8000', summaryWindowTokens({}) === 8000);
  ok('env override respected', summaryWindowTokens({ SUMMARY_WINDOW_TOKENS: '4000' }) === 4000);
  ok('invalid env falls back', summaryWindowTokens({ SUMMARY_WINDOW_TOKENS: 'huge' }) === 8000);

  // ── chooseSource: «найточніше джерело, що влазить у вікно» ──────────────────
  const small = 'x'.repeat(400);          // ~100 tokens
  const big   = 'x'.repeat(40000);        // ~10k tokens
  const parts = ['p'.repeat(400), 'q'.repeat(400)]; // ~200 tokens total

  ok('full fits → full',  chooseSource(small, parts, 8000).mode === 'full');
  ok('full too big, parts fit → parts', chooseSource(big, parts, 8000).mode === 'parts');

  // «Війна і мир»-кейс: навіть parts не влазять → batched hierarchical reduce
  const manyParts = Array.from({ length: 300 }, () => 's'.repeat(240)); // ~60 tok each ≈ 18k
  const batched = chooseSource(big, manyParts, 8000);
  ok('huge parts → batched', batched.mode === 'batched');
  ok('batches respect budget', batched.batches.every(b =>
     b.reduce((s, p) => s + estTokens(p), 0) <= 8000));
  ok('no part lost in batching',
     batched.batches.flat().length === manyParts.length);

  // ── generateNavSummaries with stubbed LLM ────────────────────────────────────
  const DOC = '# Guide\n\nThis document explains how to deploy the service safely.\n\n## Setup\n\nInstall the runtime and configure the unit before starting.\n';
  const nodes = parseSkeleton(DOC, { sourceFile: 'g.md' });
  const chunks = chunkFromSkeleton(nodes, { sourceFile: 'g.md' });
  const { navPoints } = buildFileSkeleton(nodes, { sourceFile: 'g.md' });

  let calls = 0;
  const stubLlm = async (model, prompt) => { calls++; return `SEMANTIC[${prompt.includes('Setup') ? 'setup' : 'other'}]`; };

  const enriched = await generateNavSummaries(navPoints, chunks, {
    generateFn: stubLlm, model: 'stub', windowTokens: 8000,
  });

  ok('input navPoints not mutated', navPoints.every(n => !n.summary.startsWith('SEMANTIC')));
  ok('every nav node got a semantic summary', enriched.every(n => n.summary.startsWith('SEMANTIC')));
  ok('inventory preserved alongside', enriched.every(n =>
     typeof n.inventory === 'string' && /paragraph|section/.test(n.inventory)));
  ok('order preserved (file first)', enriched[0].node_type === 'file');
  ok('one LLM call per nav node (small doc, full mode)', calls === navPoints.length);

  // section used its OWN content (full mode → sectionPrompt contains section text)
  const promptsSeen = [];
  await generateNavSummaries(navPoints, chunks, {
    generateFn: async (m, p) => { promptsSeen.push(p); return 's'; },
    windowTokens: 8000,
  });
  ok('section prompt carries section content',
     promptsSeen.some(p => p.includes('Install the runtime')));
  ok('file prompt carries full document content',
     promptsSeen.some(p => p.includes('deploy the service safely') && p.includes('Install the runtime')));
  // gemma calibration: content first, trailing instructions with SUMMARY: cue
  ok('rules trail the content (content-first prompt)',
     promptsSeen.every(p => p.trimEnd().endsWith('SUMMARY:')));

  // LLM failure → inventory kept, indexing never breaks
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  const failed = await generateNavSummaries(navPoints, chunks, {
    generateFn: async () => { throw new Error('ollama down'); }, windowTokens: 8000,
  });
  process.stderr.write = origWrite;
  ok('LLM failure keeps inventory summary', failed.every(n => /paragraph|section/.test(n.summary)));

  // ── sanitizeSummary: gemma calibration guards (live-run failure modes) ──────
  ok('clean summary passes', sanitizeSummary('Документ описує налаштування retrieval.') === 'Документ описує налаштування retrieval.');
  ok('SUMMARY: echo stripped', sanitizeSummary('SUMMARY: It works.') === 'It works.');
  ok('wrapping quotes stripped', sanitizeSummary('"Описує конфігурацію."') === 'Описує конфігурацію.');
  ok('newlines collapsed', sanitizeSummary('Line one.\nLine two.') === 'Line one. Line two.');
  ok('"This document..." opener allowed', sanitizeSummary('This document explains deployment.') !== null);
  ok('conversational EN rejected', sanitizeSummary("Okay, here's a breakdown of the file:") === null);
  ok('conversational "Here is" rejected', sanitizeSummary('Here is a summary of the content.') === null);
  ok('conversational UA rejected', sanitizeSummary('Звичайно! Ось короткий огляд.') === null);
  ok('markdown list answer rejected', sanitizeSummary('- item one\n- item two') === null);
  ok('markdown bold answer rejected', sanitizeSummary('**Overview:** the doc covers setup.') === null);
  ok('over-length blow-up rejected', sanitizeSummary('w '.repeat(400)) === null);
  ok('degenerate loop rejected', sanitizeSummary('npm run sync '.repeat(20)) === null);
  ok('empty/garbage rejected', sanitizeSummary('   ') === null && sanitizeSummary(null) === null);

  // Integration: broken LLM output never lands — nav keeps inventory.
  const errs = [];
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  const rejected = await generateNavSummaries(navPoints, chunks, {
    generateFn: async () => "Okay, here's what I found in this section:", windowTokens: 8000,
  });
  const colRejected = await buildCollectionSummary('col', [{ source_file: 'a.md', summary: 's.' }], {
    llm: true, generateFn: async () => '## Analysis\n\n- bullet',
  });
  process.stderr.write = origWrite;
  ok('rejected output keeps inventory summary', rejected.every(n => /paragraph|section/.test(n.summary)));
  ok('rejection logged per node', errs.some(s => s.includes('rejected by sanitizer')));
  ok('collection rejection falls back to inventory', colRejected.summary === 'col — 1 file');

  // ── collection summary ───────────────────────────────────────────────────────
  const fileNodes = [
    { source_file: 'a.md', summary: 'About deployment.' },
    { source_file: 'b.md', summary: 'About configuration.' },
  ];
  const inv = await buildCollectionSummary('col', fileNodes, { llm: false });
  ok('inventory mode: count summary', inv.summary === 'col — 2 files');
  ok('children point to file nodes', JSON.stringify(inv.children) === JSON.stringify(['a.md#file', 'b.md#file']));

  const sem = await buildCollectionSummary('col', fileNodes, {
    llm: true, generateFn: async (m, p) => `COLLECTION[${p.includes('a.md') && p.includes('b.md')}]`,
  });
  ok('llm mode: roll-up from file summaries', sem.summary === 'COLLECTION[true]');

  const empty = await buildCollectionSummary('col', [], { llm: true, generateFn: async () => 'x' });
  ok('empty collection → inventory, no LLM call', empty.summary === 'col — 0 files');
}
