export default async function ({ ok }) {
  console.log('\n[13] isSemidexPayload (pure, no Qdrant)');

  const { isSemidexPayload } = await import('../../core/qdrant.js');

  const FULL = {
    source_file: 'docs/readme.md',
    chunk_index: 0,
    file_hash: 'abc123',
    dense_provider: 'bge-m3-onnx',
    dense_model: 'aapot/bge-m3-onnx',
    sparse_provider: 'bge-m3-onnx',
    embedding_schema_version: 2,
    vector_size: 1024,
  };

  ok('full semidex payload → true', isSemidexPayload(FULL));

  const FIELDS = Object.keys(FULL);
  for (const field of FIELDS) {
    const partial = { ...FULL };
    delete partial[field];
    ok(`missing ${field} → false`, !isSemidexPayload(partial));
  }

  ok('null → false',      !isSemidexPayload(null));
  ok('undefined → false', !isSemidexPayload(undefined));
  ok('foreign payload without semidex fields → false',
    !isSemidexPayload({ text: 'hello', embedding: [0.1, 0.2] }));
  ok('empty object → false', !isSemidexPayload({}));
  ok('empty-payload sentinel {} → false (non-empty foreign with no payload)',
    !isSemidexPayload({}));
  ok('full payload still true after fixing return contract', isSemidexPayload(FULL));
}
