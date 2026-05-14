export default async function ({ ok }) {
  console.log('\n[8] Compact window chunk formatting (no Qdrant)');

  const { assembleWindowChunks } = await import('../../mcp/tools/search.js');

  const MATCH_IDX = 5;
  const matchText = 'Payload Indexes: source_file is indexed as keyword for fast filter lookups. getStoredMeta is the primary caller.';
  const neighborText = 'Fields: file_hash, dense_provider, dense_model, sparse_provider, embedding_schema_version, vector_size. getStoredMeta scrolls one point matching source_file and returns these six reindex discriminator fields from its payload.';

  const syntheticPoints = [
    { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX,     section: 'Payload Indexes', text: matchText    } },
    { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX + 1, section: 'getStoredMeta',   text: neighborText } },
  ];

  // ── 8a: compact mode ──
  const compact = assembleWindowChunks(syntheticPoints, MATCH_IDX, 'compact');

  ok('compact: two window chunks returned',             compact.length === 2);
  ok('compact: matched chunk is_match=true',            compact[0].is_match === true);
  ok('compact: neighbor chunk is_match=false',          compact[1].is_match === false);
  ok('compact: matched chunk has text_snippet',         typeof compact[0].text_snippet === 'string');
  ok('compact: neighbor chunk has text_snippet',        typeof compact[1].text_snippet === 'string');
  ok('compact: matched chunk has no .text field',       !Object.prototype.hasOwnProperty.call(compact[0], 'text'));
  ok('compact: neighbor has no .text field',            !Object.prototype.hasOwnProperty.call(compact[1], 'text'));

  ok('compact: neighbor snippet ≤ 153 chars (150 + "...")', compact[1].text_snippet.length <= 153);
  ok('compact: neighbor snippet ends with "..."',            compact[1].text_snippet.endsWith('...'));

  const snippet = compact[1].text_snippet;
  ok('compact: neighbor snippet contains file_hash',                 snippet.includes('file_hash'));
  ok('compact: neighbor snippet contains dense_provider',            snippet.includes('dense_provider'));
  ok('compact: neighbor snippet contains dense_model',               snippet.includes('dense_model'));
  ok('compact: neighbor snippet contains sparse_provider',           snippet.includes('sparse_provider'));
  ok('compact: neighbor snippet contains embedding_schema_version',  snippet.includes('embedding_schema_version'));
  ok('compact: neighbor snippet contains vector_size',               snippet.includes('vector_size'));

  // ── 8b: full mode ──
  const full = assembleWindowChunks(syntheticPoints, MATCH_IDX, 'full');

  ok('full: neighbor has .text field',             Object.prototype.hasOwnProperty.call(full[1], 'text'));
  ok('full: neighbor .text is untruncated',        full[1].text === neighborText);
  ok('full: neighbor has no text_snippet field',   !Object.prototype.hasOwnProperty.call(full[1], 'text_snippet'));

  // ── 8c: empty input ──
  const noPoints = assembleWindowChunks([], MATCH_IDX, 'compact');
  ok('assembleWindowChunks: empty input → empty array', noPoints.length === 0);

  // ── 8d: deduplication ──
  const dup = assembleWindowChunks([
    { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX,     section: 'Payload Indexes', text: matchText    } },
    { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX + 1, section: 'getStoredMeta',   text: neighborText } },
    { payload: { source_file: 'qdrant.md', chunk_index: MATCH_IDX + 1, section: 'getStoredMeta',   text: neighborText } }, // duplicate
  ], MATCH_IDX, 'compact');
  ok('deduplication: duplicate non-match neighbor emitted once', dup.length === 2);
}
