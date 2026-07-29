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
  const { chunks } = await chunkFromSkeleton(nodes, { sourceFile: 'g.md' });
  const { navPoints } = buildFileSkeleton(nodes, { sourceFile: 'g.md' });

  let calls = 0;
  const stubLlm = async (model, prompt) => { calls++; return `SEMANTIC summary of the ${prompt.includes('Setup') ? 'setup section' : 'whole document'}.`; };

  const enriched = await generateNavSummaries(navPoints, chunks, {
    generateFn: stubLlm, model: 'stub', windowTokens: 8000,
  });

  ok('input navPoints not mutated', navPoints.every(n => !n.summary.startsWith('SEMANTIC summary')));
  ok('every nav node got a semantic summary', enriched.every(n => n.summary.startsWith('SEMANTIC summary')));
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
  ok('english content never gets a Ukrainian rule',
     promptsSeen.every(p => !p.includes('Write in Ukrainian')));
  ok('long english content → explicit English rule',
     promptsSeen.some(p => p.includes('Write in English')));
  ok('short content falls back to generic same-language rule',
     promptsSeen.some(p => p.includes('SAME LANGUAGE')));

  // LLM failure → inventory kept, indexing never breaks
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  const failed = await generateNavSummaries(navPoints, chunks, {
    generateFn: async () => { throw new Error('ollama down'); }, windowTokens: 8000,
  });
  process.stderr.write = origWrite;
  ok('LLM failure keeps inventory summary', failed.every(n => /paragraph|section/.test(n.summary)));

  // ── estTokens: script-aware (cyrillic ≈ 2 chars/token, latin ≈ 4) ──────────
  ok('latin estimate unchanged (chars/4)', estTokens('x'.repeat(400)) === 100);
  ok('cyrillic estimated ~2x denser',
     estTokens('п'.repeat(400)) === 200 && estTokens('п'.repeat(400)) > estTokens('x'.repeat(400)));
  ok('mixed text lands between', (() => {
    const t = estTokens('п'.repeat(200) + 'x'.repeat(200));
    return t > 100 && t < 200;
  })());

  // ── oversized section → batched reduce over its OWN chunks (not lead-only) ──
  {
    const bigBody = Array.from({ length: 8 }, (_, i) =>
      `Розділ містить детальний опис інструмента номер ${i} з прикладами використання та поясненнями налаштувань для проєкту.`).join(' ');
    const BIGDOC = `# Менеджер\n\n${bigBody}\n\n${bigBody}\n\n${bigBody}\n\n${bigBody}\n`;
    const bnodes = parseSkeleton(BIGDOC, { sourceFile: 'b.md' });
    const { chunks: bchunks } = await chunkFromSkeleton(bnodes, { sourceFile: 'b.md' });
    const bnav = buildFileSkeleton(bnodes, { sourceFile: 'b.md' }).navPoints;
    const seen = [];
    await generateNavSummaries(bnav, bchunks, {
      generateFn: async (m, p2) => { seen.push(p2); return 'Достатньо довге семантичне резюме секції конспекту.'; },
      windowTokens: 500, // tiny window → full does not fit
    });
    ok('oversized section prompts carry real chunk content',
       seen.some(p2 => p2.includes('інструмента номер')));
    ok('ukrainian content → explicit Ukrainian language rule',
       seen.filter(p2 => p2.includes('інструмента'))
           .every(p2 => p2.includes('Write in Ukrainian')));
    ok('short roll-up notes fall back to generic rule (no false lang)',
       seen.every(p2 => !p2.includes('Write in English')));

    // SUMMARY_LANG override: explicit beats detection, free-form accepted.
    const { resolveForcedLang } = await import('../../indexer/phases/skeleton-summary.js');
    ok('SUMMARY_LANG=en forces English', resolveForcedLang({ SUMMARY_LANG: 'en' }) === 'English');
    ok('SUMMARY_LANG=ukr ISO-3 accepted', resolveForcedLang({ SUMMARY_LANG: 'ukr' }) === 'Ukrainian');
    ok('SUMMARY_LANG free-form (excluded from auto whitelist) accepted',
       resolveForcedLang({ SUMMARY_LANG: 'belarusian' }) === 'Belarusian');
    ok('SUMMARY_LANG=auto → detection', resolveForcedLang({ SUMMARY_LANG: 'auto' }) === null
       && resolveForcedLang({}) === null);

    const prevLang = process.env.SUMMARY_LANG;
    process.env.SUMMARY_LANG = 'en';
    try {
      const forcedSeen = [];
      await generateNavSummaries(bnav, bchunks, {
        generateFn: async (m, p3) => { forcedSeen.push(p3); return 'Достатньо довге семантичне резюме секції конспекту.'; },
        windowTokens: 500,
      });
      ok('forced language overrides detection on ukrainian content',
         forcedSeen.every(p3 => p3.includes('Write in English') && !p3.includes('Write in Ukrainian')));
    } finally {
      if (prevLang === undefined) delete process.env.SUMMARY_LANG;
      else process.env.SUMMARY_LANG = prevLang;
    }
    ok('oversized section never collapses to inventory-only prompt',
       !seen.some(p2 => /Notes describing[\s\S]*paragraphs(?![\s\S]*інструмента)/.test(p2) && !p2.includes('інструмента')));
  }

  // ── sanitizeSummary: gemma calibration guards (live-run failure modes) ──────
  ok('clean summary passes', sanitizeSummary('Документ описує налаштування retrieval.') === 'Документ описує налаштування retrieval.');
  ok('SUMMARY: echo stripped', sanitizeSummary('SUMMARY: This module handles authentication.') === 'This module handles authentication.');
  ok('wrapping quotes stripped', sanitizeSummary('"Описує конфігурацію системи збірки."') === 'Описує конфігурацію системи збірки.');
  ok('newlines collapsed', sanitizeSummary('Line one explains setup.\nLine two covers teardown.') === 'Line one explains setup. Line two covers teardown.');
  ok('"This document..." opener allowed', sanitizeSummary('This document explains deployment.') !== null);
  ok('conversational EN rejected', sanitizeSummary("Okay, here's a breakdown of the file:") === null);
  ok('conversational "Here is" rejected', sanitizeSummary('Here is a summary of the content.') === null);
  ok('conversational UA rejected', sanitizeSummary('Звичайно! Ось короткий огляд.') === null);
  ok('markdown list answer rejected', sanitizeSummary('- item one\n- item two') === null);
  ok('markdown bold answer rejected', sanitizeSummary('**Overview:** the doc covers setup.') === null);
  ok('over-length blow-up rejected', sanitizeSummary('w '.repeat(400)) === null);
  ok('degenerate loop rejected', sanitizeSummary('npm run sync '.repeat(20)) === null);
  ok('empty/garbage rejected', sanitizeSummary('   ') === null && sanitizeSummary(null) === null);
  ok('too-short output rejected (single word like "uv")', sanitizeSummary('uv') === null);
  ok('too-short output rejected (< 20 chars)', sanitizeSummary('Short text.') === null);
  ok('20-char boundary passes', sanitizeSummary('A'.repeat(20)) !== null);

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
  ok('rejection logged per node', errs.some(s => s.includes('rejected')));
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
    llm: true, generateFn: async (m, p) => `Collection covers deployment and configuration topics. Files: ${p.includes('a.md') && p.includes('b.md')}`,
  });
  ok('llm mode: roll-up from file summaries', sem.summary.includes('Files: true'));

  const empty = await buildCollectionSummary('col', [], { llm: true, generateFn: async () => 'x' });
  ok('empty collection → inventory, no LLM call', empty.summary === 'col — 0 files');
}
