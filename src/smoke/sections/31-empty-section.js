export default async function ({ ok }) {
  console.log('\n[31] empty-section chunk helpers');

  const {
    isEmptySectionChunk,
    finalizeEmptySectionChunk,
    partitionChunks,
    reassembleChunks,
  } = await import('../../indexer/phases/empty-section.js');

  // --- isEmptySectionChunk ---
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

  // --- finalizeEmptySectionChunk ---
  const base = {
    text: '(empty section: Intro)',
    section: 'Intro',
    source_file: 'docs/guide.md',
    chunk_index: 3,
    extra_field: 'preserved',
  };
  const finalized = finalizeEmptySectionChunk(base);

  ok('31g: finalizeEmptySectionChunk sets tags to []',
    Array.isArray(finalized.tags) && finalized.tags.length === 0);

  ok('31h: finalizeEmptySectionChunk sets deterministic context',
    finalized.context === 'Empty section placeholder for "Intro".');

  ok('31i: finalizeEmptySectionChunk preserves source_file',
    finalized.source_file === 'docs/guide.md');

  ok('31j: finalizeEmptySectionChunk preserves chunk_index',
    finalized.chunk_index === 3);

  ok('31k: finalizeEmptySectionChunk preserves section',
    finalized.section === 'Intro');

  ok('31l: finalizeEmptySectionChunk preserves extra fields',
    finalized.extra_field === 'preserved');

  // unknown section fallback
  const noSection = finalizeEmptySectionChunk({ text: '(empty section: X)' });
  ok('31m: finalizeEmptySectionChunk falls back to "unknown" when section missing',
    noSection.context === 'Empty section placeholder for "unknown".');

  // --- partitionChunks + reassembleChunks ---
  const chunks = [
    { text: '(empty section: A)', chunk_index: 0 },
    { text: 'normal chunk',       chunk_index: 1 },
    { text: '(empty section: B)', chunk_index: 2 },
  ];

  const { normal, empty } = partitionChunks(chunks);

  ok('31n: partitionChunks: 1 normal chunk',  normal.length === 1);
  ok('31o: partitionChunks: 2 empty chunks',  empty.length  === 2);
  ok('31p: normal chunk __origIndex is 1',    normal[0].__origIndex === 1);
  ok('31q: empty[0] __origIndex is 0',        empty[0].__origIndex  === 0);
  ok('31r: empty[1] __origIndex is 2',        empty[1].__origIndex  === 2);

  // Simulate LLM processing normal, finalize empty, then reassemble
  const processedNormal   = normal.map(c => ({ ...c, context: 'ctx', tags: ['t'] }));
  const finalizedEmpties  = empty.map(finalizeEmptySectionChunk);
  const result            = reassembleChunks(processedNormal, finalizedEmpties);

  ok('31s: reassembleChunks preserves total length', result.length === 3);
  ok('31t: result[0] is finalized empty (A)',
    result[0].context === 'Empty section placeholder for "unknown".' && result[0].chunk_index === 0);
  ok('31u: result[1] is processed normal',
    result[1].context === 'ctx' && result[1].chunk_index === 1);
  ok('31v: result[2] is finalized empty (B)',
    result[2].context === 'Empty section placeholder for "unknown".' && result[2].chunk_index === 2);
  ok('31w: __origIndex stripped from output',
    !('__origIndex' in result[0]) && !('__origIndex' in result[1]) && !('__origIndex' in result[2]));
}
