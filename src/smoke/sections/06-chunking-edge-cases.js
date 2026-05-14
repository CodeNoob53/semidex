export default async function ({ ok }) {
  console.log('\n[6] Chunking edge cases');

  const { chunkFile } = await import('../../indexer/phases/chunk.js');

  // 6a. Short .txt (1-2 sentences) must not return 0 chunks.
  const short1 = 'Hello world.';
  const r1 = chunkFile('x.txt', short1, 'x.txt');
  ok('1-sentence .txt → 1 chunk',   r1.length === 1);
  ok('1-sentence chunk has text',    r1[0]?.text === short1.trim());

  const short2 = 'First sentence. Second sentence.';
  const r2 = chunkFile('x.txt', short2, 'x.txt');
  ok('2-sentence .txt → 1 chunk',       r2.length === 1);
  ok('2-sentence chunk text unchanged', r2[0]?.text === 'First sentence. Second sentence.');

  // 6b. Trailing text without sentence terminator must not be dropped.
  const withTail = 'Complete sentence. trailing without dot';
  const r3 = chunkFile('x.txt', withTail, 'x.txt');
  ok('trailing text without dot preserved', r3.some(c => c.text.includes('trailing without dot')));

  // 6c. Markdown: sentences from section A must not appear in section B chunk.
  const md = `# Section A\nOnly sentence in A.\n\n# Section B\nOnly sentence in B.`;
  const r4 = chunkFile('x.md', md, 'x.md');
  const sectionBChunks = r4.filter(c => c.section === 'Section B');
  ok('section B has no text from section A', sectionBChunks.every(c => !c.text.includes('sentence in A')));

  // 6d. No overlap-only final chunk.
  const bigSentence = 'A'.repeat(1596) + '.'; // just under one chunk by itself
  const r5 = chunkFile('x.txt', `${bigSentence} Final.`, 'x.txt');
  ok('no overlap-only final chunk after full emit', r5.length <= 2);

  // 6e. No consecutive duplicate chunks.
  const medText = 'Alpha sentence. Beta sentence. Gamma sentence.';
  const r6 = chunkFile('x.txt', medText, 'x.txt');
  ok('no consecutive duplicate chunks', r6.every((c, i) => i === 0 || c.text !== r6[i - 1].text));

  // 6f. chunkIndex / totalChunks metadata is correct.
  ok('chunkIndex + totalChunks set correctly',
    r1[0].chunkIndex === 0 && r1[0].totalChunks === 1);
}
