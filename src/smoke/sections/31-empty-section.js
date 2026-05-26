export default async function ({ ok }) {
  console.log('\n[31] empty-section suppression');

  const { chunkFile } = await import('../../indexer/phases/chunk.js');
  const { isEmptySectionChunk } = await import('../../indexer/phases/empty-section.js');

  // --- isEmptySectionChunk (still used as defensive guard in index.js) ---
  ok('31a: exact placeholder → true',
    isEmptySectionChunk({ text: '(empty section: Djent)' }) === true);

  ok('31b: surrounding whitespace → true',
    isEmptySectionChunk({ text: '  (empty section: Djent)  ' }) === true);

  ok('31c: normal text → false',
    isEmptySectionChunk({ text: 'Some normal chunk text' }) === false);

  ok('31d: phrase embedded in longer text → false',
    isEmptySectionChunk({ text: 'See also (empty section: Foo) for details' }) === false);

  ok('31e: empty string → false',
    isEmptySectionChunk({ text: '' }) === false);

  ok('31f: missing text field → false',
    isEmptySectionChunk({}) === false);

  // --- chunkFile: heading-only section produces no chunk ---
  const headingOnly = [
    '## Benchmark Tiers',
    '',
    '### 21-query regression benchmark',
    'Text A. It is long enough to exceed the minimum token threshold for sure.',
    '',
    '### 50-query quality benchmark',
    'Text B. It is also long enough to exceed the minimum token threshold for sure.',
  ].join('\n');

  const chunks = chunkFile('test.md', headingOnly, 'test.md');

  ok('31g: heading-only parent produces no chunk',
    !chunks.some(c => c.section === 'Benchmark Tiers'));

  ok('31h: no (empty section: ...) text in any chunk',
    !chunks.some(c => (c.text ?? '').startsWith('(empty section:')));

  ok('31i: child chunk A exists',
    chunks.some(c => c.section === '21-query regression benchmark'));

  ok('31j: child chunk B exists',
    chunks.some(c => c.section === '50-query quality benchmark'));

  ok('31k: exactly 2 chunks total (no empty parent)',
    chunks.length === 2);

  // --- chunk_index is contiguous over real chunks only ---
  ok('31l: chunkIndex values are 0-based contiguous',
    chunks.every((c, i) => c.chunkIndex === i));

  ok('31m: totalChunks equals real chunk count',
    chunks.every(c => c.totalChunks === chunks.length));

  // --- non-empty short section still preserved ---
  const withShort = [
    '## Intro',
    'Short but real content here.',
    '',
    '## Next',
    'More content follows here in this section.',
  ].join('\n');

  const shortChunks = chunkFile('test2.md', withShort, 'test2.md');
  ok('31n: non-empty short section is preserved',
    shortChunks.some(c => c.section === 'Intro' && c.text.includes('Short but real')));

  // --- multiple empty headings in a row produce no chunks ---
  const multiEmpty = [
    '## A',
    '',
    '## B',
    '',
    '## C',
    'Real content here. Long enough to pass the minimum token count.',
  ].join('\n');

  const multiChunks = chunkFile('test3.md', multiEmpty, 'test3.md');
  ok('31o: multiple empty headings produce no chunks',
    multiChunks.every(c => c.section === 'C') && multiChunks.length === 1);
}
