export default async function ({ ok }) {
  console.log('\n[11] recursiveChunkText (no Qdrant)');

  const { recursiveChunkText, getChunkingConfig } = await import('../../indexer/phases/chunk.js');

  const TOKEN_CHARS = 4;
  const { maxTokens: MAX } = getChunkingConfig();
  const bigWord = 'A'.repeat(MAX * TOKEN_CHARS + 4);

  // 11a. PDF page markers are stripped.
  {
    const text = 'First paragraph.\n\n-- 1 of 50 --\n\nSecond paragraph.';
    const chunks = recursiveChunkText(text, { stripPageMarkers: true });
    ok('page markers stripped — no chunk contains "of 50"',
      chunks.every(c => !c.includes('of 50')));
    ok('page markers stripped — both paragraphs present',
      chunks.some(c => c.includes('First')) && chunks.some(c => c.includes('Second')));
  }

  // 11b. Paragraphs are packed without crossing MAX_TOKENS.
  {
    const paraTokens = Math.floor(MAX / 2);
    const para = 'B'.repeat(paraTokens * TOKEN_CHARS);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = recursiveChunkText(text);
    ok('three half-MAX paragraphs → at least 2 chunks', chunks.length >= 2);
    ok('no chunk exceeds MAX_TOKENS + join overhead', chunks.every(c => Math.ceil(c.length / TOKEN_CHARS) <= MAX + 1));
  }

  // 11c. Oversized paragraph falls back to sentence splitting.
  {
    const sentTokens = Math.floor(MAX / 2);
    const sent = 'C'.repeat(sentTokens * TOKEN_CHARS) + '.';
    const text = `${sent} ${sent} ${sent}`;
    const chunks = recursiveChunkText(text);
    ok('oversized paragraph split by sentences → ≥ 2 chunks', chunks.length >= 2);
    ok('sentence-split chunks within MAX_TOKENS', chunks.every(c => Math.ceil(c.length / TOKEN_CHARS) <= MAX));
  }

  // 11d. Oversized single sentence falls back to word splitting.
  {
    const targetChars = Math.ceil(MAX * 1.2) * TOKEN_CHARS;
    const wordCount = Math.ceil(targetChars / 6);
    const words = Array.from({ length: wordCount }, (_, i) => `word${i}`).join(' ');
    const chunks = recursiveChunkText(words);
    ok('oversized no-sentence text split by words → ≥ 2 chunks', chunks.length >= 2);
    ok('word-split chunks within MAX_TOKENS', chunks.every(c => Math.ceil(c.length / TOKEN_CHARS) <= MAX));
  }

  // 11e. Tiny final chunk is preserved.
  {
    const big = 'D'.repeat(MAX * TOKEN_CHARS - 4);
    const text = `${big}\n\ntiny final`;
    const chunks = recursiveChunkText(text);
    ok('tiny final chunk preserved', chunks.some(c => c.includes('tiny final')));
  }

  // 11f. Empty input returns [].
  {
    ok('empty string → []', recursiveChunkText('').length === 0);
    ok('whitespace-only → []', recursiveChunkText('   \n\n  ').length === 0);
  }

  // 11g. Text within MAX_TOKENS returned as single chunk.
  {
    const short = 'Short text that fits in one chunk.';
    const chunks = recursiveChunkText(short);
    ok('short text → exactly 1 chunk', chunks.length === 1);
    ok('short text chunk content preserved', chunks[0] === short);
  }

  // 11h. stripPageMarkers=false (default) — markers not stripped.
  {
    const text = 'Para one.\n\n-- 3 of 10 --\n\nPara two.';
    const chunks = recursiveChunkText(text);
    ok('stripPageMarkers=false — marker text preserved',
      chunks.some(c => c.includes('3 of 10')));
  }

  // 11i. Unsplittable single word exceeding MAX_TOKENS is returned as-is.
  {
    const chunks = recursiveChunkText(bigWord);
    ok('unsplittable oversized word returned as-is (not dropped)', chunks.length === 1);
    ok('unsplittable word content intact', chunks[0] === bigWord);
  }

  // 11j. Markdown chunking.
  {
    const { chunkFile } = await import('../../indexer/phases/chunk.js');
    const md = `# Section A\nSentence one. Sentence two.\n\n# Section B\nSentence three.`;
    const result = chunkFile('doc.md', md, 'doc.md');
    ok('markdown: section A chunk exists', result.some(c => c.section === 'Section A'));
    ok('markdown: section B chunk exists', result.some(c => c.section === 'Section B'));
    ok('markdown: no cross-section bleed',
      result.filter(c => c.section === 'Section B').every(c => !c.text.includes('Sentence one')));
  }

  // 11k. .txt preserves page markers.
  {
    const { chunkFile } = await import('../../indexer/phases/chunk.js');
    const txtWithMarker = 'Some text.\n\n-- 7 of 100 --\n\nMore text.';
    const result = chunkFile('notes.txt', txtWithMarker, 'notes.txt');
    ok('.txt: PDF page marker preserved (not on recursive PDF path)',
      result.some(c => c.text.includes('7 of 100')));
  }

  // 11l. parseMarkdown handles H1–H6 headings (#{1,6}).
  {
    const { chunkFile } = await import('../../indexer/phases/chunk.js');

    const r4 = chunkFile('doc.md', `#### Deep Section\nContent under H4 heading.`, 'doc.md');
    ok('H4 (####) becomes section name', r4.some(c => c.section === 'Deep Section'));

    const r5 = chunkFile('doc.md', `##### Subsection\nContent under H5 heading.\n\n##### Another Sub\nMore content.`, 'doc.md');
    ok('H5 (#####) becomes section name', r5.some(c => c.section === 'Subsection'));
    ok('two H5 sections are distinct', r5.some(c => c.section === 'Another Sub'));

    const r6 = chunkFile('doc.md', `###### Leaf\nLeaf content here.`, 'doc.md');
    ok('H6 (######) becomes section name', r6.some(c => c.section === 'Leaf'));

    const rMixed = chunkFile('doc.md', `# Top\nH1 body.\n\n## Mid\nH2 body.\n\n### Sub\nH3 body.`, 'doc.md');
    ok('H1 still works after #{1,6} expansion', rMixed.some(c => c.section === 'Top'));
    ok('H2 still works after #{1,6} expansion', rMixed.some(c => c.section === 'Mid'));
    ok('H3 still works after #{1,6} expansion', rMixed.some(c => c.section === 'Sub'));
  }

  // 11m. PDF routing: hasPdfStructure.
  {
    const { hasPdfStructure, chunkFile } = await import('../../indexer/phases/chunk.js');

    const mdWith3Headings = `# Title\nbody\n\n## Section A\ncontent A\n\n## Section B\ncontent B`;
    const mdWith2Headings = `# Title\nbody\n\n## Section A\ncontent A`;
    const mdNoHeadings    = `Just plain text with no headings at all.`;

    ok('3 headings → hasPdfStructure true',  hasPdfStructure(mdWith3Headings));
    ok('2 headings → hasPdfStructure false', !hasPdfStructure(mdWith2Headings));
    ok('no headings → hasPdfStructure false', !hasPdfStructure(mdNoHeadings));
    ok('null input → hasPdfStructure false',  !hasPdfStructure(null));
    ok('regression guard: hasPdfStructure true for 3 headings (was false before /gm fix)',
      hasPdfStructure(mdWith3Headings) === true);

    const pdf2mdOutput = `<!-- PAGE_BREAK -->\n## Chapter 1\nContent here.\n\n<!-- PAGE_BREAK -->\n## Chapter 2\nMore content.\n\n<!-- PAGE_BREAK -->\n## Chapter 3\nEven more.`;
    const cleaned = pdf2mdOutput.replace(/<!-- PAGE_BREAK -->/g, '\n').replace(/\n{3,}/g, '\n\n');
    ok('pdf2md PAGE_BREAK cleanup preserves structure', hasPdfStructure(cleaned));
    const chunks = chunkFile('book.md', cleaned, 'book.pdf');
    ok('cleaned pdf2md output → sections assigned', chunks.some(c => c.section === 'Chapter 1'));
    ok('cleaned pdf2md output → multiple distinct sections', new Set(chunks.map(c => c.section)).size >= 3);
  }
}
