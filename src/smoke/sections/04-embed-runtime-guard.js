export default async function ({ ok, throwsAsync }) {
  console.log('\n[4] Invalid provider combo — embedForSearch runtime guard');

  const embMod = await import('../../shared/core/embeddings.js');
  ok('SCHEMA_VERSION is 2', embMod.SCHEMA_VERSION === 2);

  // embedForSearch now takes an already-resolved embedding profile
  // directly (Part E of the native-metadata task) — it no longer reads
  // config.json/env itself, so the invalid-combo guard is exercised by
  // constructing a profile with a mismatched dense/sparse provider pair
  // directly, rather than via a bad config.json entry.
  const badProfile = {
    schemaVersion: 1,
    managedBy: 'semidex',
    embedding: {
      dense: {
        provider: 'ollama', model: 'bge-m3', vectorName: 'dense',
        dimensions: 1024, distance: 'Cosine', execution: 'client',
      },
      sparse: {
        provider: 'bge-m3-onnx', model: 'aapot/bge-m3-onnx', vectorName: 'sparse',
        execution: 'client', // invalid combo: ollama dense + bge-m3-onnx sparse
      },
    },
    embeddingSchemaVersion: 2,
  };

  await throwsAsync(
    'embedForSearch with an invalid dense/sparse provider combo throws',
    () => embMod.embedForSearch(badProfile, 'test query'),
    'Invalid provider combination'
  );
}
