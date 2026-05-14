export default async function ({ ok, throwsAsync, withConfig }) {
  console.log('\n[4] Invalid provider combo — embedForSearch runtime guard');

  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
  delete process.env.ONNX_EMBED;

  const embMod = await import('../../core/embeddings.js');
  ok('SCHEMA_VERSION is 2', embMod.SCHEMA_VERSION === 2);

  const badConfig = {
    collections: {
      '__smoke_bad__': {
        denseProvider:  'ollama',
        sparseProvider: 'bge-m3-onnx',  // invalid combo
        denseModel:     'bge-m3',
        embeddingSchemaVersion: 2,
        vectorSize: 1024,
      },
    },
  };

  await withConfig(badConfig, async () => {
    await throwsAsync(
      'embedForSearch with bad config combo throws',
      () => embMod.embedForSearch('__smoke_bad__', 'test query'),
      'Unsupported provider combination'
    );
  });
}
