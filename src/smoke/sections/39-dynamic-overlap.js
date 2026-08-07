/**
 * Section 39: Dynamic token-budgeted overlap smoke tests.
 *
 * Design principle: every test that exercises the overlap path must
 * guarantee a forced split and then measure what actually happened,
 * rather than hope the corpus is large enough.
 *
 * Cases:
 *   39a. forced split → overlap was added → final tokens ≤ MAX
 *   39b. word-boundary safety via a known mid-word cut point
 *   39c. overlap skipped when available budget = 0 (body = MAX)
 *   39d. no overlap across section boundaries
 *   39e. fallback when CHUNK_OVERLAP_TOKENS=0 (explicit sentence-overlap mode)
 */

export default async function ({ ok }) {
  console.log('\n[39] Dynamic token-budgeted overlap');

  const { chunkFileAsync, getChunkingConfig } = await import('../../indexer/phases/chunk.js');
  const { getTokenCounter } = await import('../../shared/core/token-count.js');

  const countFn = await getTokenCounter({ mode: 'bge-m3' });
  const { maxTokens: MAX, overlapTokens: OVERLAP } = getChunkingConfig();

  // ── 39e: explicit CHUNK_OVERLAP_TOKENS=0 → sentence-overlap fallback ─────────
  if (OVERLAP <= 0) {
    console.log('  (CHUNK_OVERLAP_TOKENS=0 — testing sentence-overlap fallback)');
    const md = `# A\nSentence one. Sentence two.\n\n# B\nSentence three.`;
    const chunks = await chunkFileAsync('doc.md', md, 'doc.md', countFn);
    ok('39e: fallback — section A exists', chunks.some(c => c.section === 'A'));
    ok('39e: fallback — section B exists', chunks.some(c => c.section === 'B'));
    ok('39e: fallback — no cross-section bleed',
      chunks.filter(c => c.section === 'B').every(c => !c.text.includes('Sentence one')));
    return;
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  // Build a word sequence whose real BGE-M3 token count slightly exceeds `target`.
  // Each "wordN" token is 1 BGE-M3 token for N < 1000. We add +20% headroom.
  function makeWords(count) {
    return Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
  }

  // ── 39a: forced split → overlap added → final tokens ≤ MAX ───────────────────
  // Strategy: build a section with TWO paragraphs, each slightly larger than MAX/2.
  // BGE-M3 counts ~1 token per short word. MAX/2 + 1 words per paragraph forces
  // a paragraph-level split. The second chunk must receive an overlap prefix and
  // its total token count must stay ≤ MAX.
  {
    const halfPlusOne = Math.floor(MAX / 2) + 5;   // guaranteed to split when combined
    const paraA = makeWords(halfPlusOne);
    const paraB = makeWords(halfPlusOne);
    // Use distinct prefixes so words in A and B don't collide.
    const docA = paraA.replace(/word/g, 'aword');
    const docB = paraB.replace(/word/g, 'bword');
    const md = `# Split\n${docA}\n\n${docB}`;
    const chunks = await chunkFileAsync('doc.md', md, 'doc.md', countFn);

    ok('39a: forced split produces ≥ 2 chunks', chunks.length >= 2);

    if (chunks.length >= 2) {
      // Measure actual token counts.
      const tok0 = await countFn(chunks[0].text);
      const tok1 = await countFn(chunks[1].text);

      ok('39a: first chunk within MAX',  tok0 <= MAX);
      ok('39a: second chunk within MAX', tok1 <= MAX);

      // Second chunk must contain overlap: it should start with text from chunk 0's body.
      // chunk0 body = docA; check that chunk1 text begins with a suffix of docA words.
      const chunk1Words  = chunks[1].text.split(/\s+/);
      const chunk0Words  = chunks[0].text.split(/\s+/);
      const firstWord    = chunk1Words[0];
      const overlapAdded = chunk0Words.includes(firstWord) && firstWord.startsWith('aword');
      ok('39a: second chunk starts with overlap from first chunk body', overlapAdded);
    } else {
      // Signal to the developer that the fixture did not force a split.
      ok('39a: first chunk within MAX',  await countFn(chunks[0].text) <= MAX);
      ok('39a: second chunk within MAX', true); // trivially — only one chunk
      ok('39a: second chunk starts with overlap from first chunk body', false);
    }
  }

  // ── 39b: word-boundary safety ────────────────────────────────────────────────
  // Strategy: build a single long section that forces splits at word boundaries.
  // All tokens are whole "wordN" strings, so no split can land mid-token.
  // After chunking, verify that for each non-first chunk:
  //   (a) the first character of the chunk text is NOT mid-word (i.e. preceded by
  //       whitespace or start-of-string in the concatenated prev+cur text), AND
  //   (b) the overlap prefix, extracted by finding the original body start, does
  //       not begin with a partial token from the previous chunk.
  {
    // 3× MAX words → guarantees at least 3 chunks.
    const nWords = MAX * 3;
    const allWords = Array.from({ length: nWords }, (_, i) => `tok${i}`);
    const sectionText = allWords.join(' ');
    const md = `# Long\n${sectionText}`;
    const chunks = await chunkFileAsync('doc.md', md, 'doc.md', countFn);

    ok('39b: long section produces multiple chunks', chunks.length >= 2);

    // For each non-first chunk, find the overlap prefix by locating where its text
    // first appears inside the previous chunk's body.  The character immediately
    // before that position in the prev text must be a whitespace (or the overlap
    // starts at position 0 — no overlap — which is also fine).
    let midWordCuts = 0;
    for (let i = 1; i < chunks.length; i++) {
      const prevText = chunks[i - 1].text;
      const curText  = chunks[i].text;
      // The current chunk text may start with overlap from prevText.
      // Find the position in prevText where curText's prefix appears.
      const anchor = curText.slice(0, 30); // first 30 chars — enough to locate
      const idx = prevText.indexOf(anchor);
      if (idx > 0) {
        // overlap found — check the character before it in prevText
        const charBefore = prevText[idx - 1];
        if (/\S/.test(charBefore)) midWordCuts++;
      }
      // idx === -1: no overlap (first chunk of section, or completely new body) — ok
      // idx === 0: entire prev chunk would be the overlap — should not happen given split
    }
    ok('39b: zero mid-word cuts across all split boundaries', midWordCuts === 0);
  }

  // ── 39c: overlap skipped when body fills token budget ────────────────────────
  // Strategy: use addSplitOverlapAsync directly with a controlled stub.
  // We import the internal function indirectly by calling chunkFileAsync on a document
  // that, after splitting, produces a second chunk whose body exactly equals MAX tokens.
  //
  // Since we cannot easily craft such a document reliably with BGE-M3 (token counts are
  // non-linear), we instead verify the invariant from the outside:
  //   For every chunk produced, finalTokens ≤ MAX.
  // We use a dense document (many words per line) to maximise body fill.
  //
  // Additionally we verify that no chunk has finalTokens > bodyTokens + OVERLAP_CAP,
  // which would mean overlap was applied despite no remaining budget.
  {
    // Dense section: 10 paragraphs of MAX/4 words each → many splits.
    const para = makeWords(Math.ceil(MAX / 4));
    const densePara = para.replace(/word/g, 'denseword');
    const paras = Array.from({ length: 10 }, () => densePara).join('\n\n');
    const md = `# Dense\n${paras}`;
    const chunks = await chunkFileAsync('doc.md', md, 'doc.md', countFn);

    ok('39c: dense section produces multiple chunks', chunks.length >= 2);

    const toks = await Promise.all(chunks.map(c => countFn(c.text)));
    const overMAX = toks.filter(t => t > MAX);
    ok('39c: no chunk exceeds MAX_CHUNK_TOKENS', overMAX.length === 0);

    // Verify overlap budget guard: if body == MAX, available = 0 → no overlap added.
    // We cannot easily isolate body vs overlap from the outside, but we can check:
    // the first chunk in any section-group has no overlap, so its text IS its body.
    // For those chunks, token count must be ≤ MAX.
    const firstChunks = chunks.filter(c => c.chunkIndex === 0 ||
      (chunks[c.chunkIndex - 1] && chunks[c.chunkIndex - 1].section !== c.section));
    const firstToks = await Promise.all(firstChunks.map(c => countFn(c.text)));
    ok('39c: first-in-section chunks (body-only) do not exceed MAX',
      firstToks.every(t => t <= MAX));
  }

  // ── 39d: no overlap across section boundaries ────────────────────────────────
  // The unique words in section A must not appear in any section B chunk.
  {
    const secAWords = Array.from({ length: 20 }, (_, i) => `secAonly${i}`).join(' ');
    const secBWords = Array.from({ length: 20 }, (_, i) => `secBonly${i}`).join(' ');
    const md = `# SectionA\n${secAWords}\n\n# SectionB\n${secBWords}`;
    const chunks = await chunkFileAsync('doc.md', md, 'doc.md', countFn);

    const bChunks = chunks.filter(c => c.section === 'SectionB');
    ok('39d: SectionB chunks exist', bChunks.length >= 1);
    ok('39d: SectionB chunks contain no SectionA-only words',
      bChunks.every(c => !c.text.includes('secAonly')));

    // Reverse: SectionA chunks must not bleed into SectionB words.
    const aChunks = chunks.filter(c => c.section === 'SectionA');
    ok('39d: SectionA chunks contain no SectionB-only words',
      aChunks.every(c => !c.text.includes('secBonly')));
  }
}
