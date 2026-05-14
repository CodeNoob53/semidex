export default async function ({ ok }) {
  console.log('\n[5] Reindex detection — storedMeta mismatch');

  const embedCfg   = { denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'hashed-tf', schemaVersion: 2 };
  const vectorSize = 1024;

  function wouldSkip(storedMeta) {
    return (
      storedMeta.hash                   === 'abc123' &&
      storedMeta.denseProvider          === embedCfg.denseProvider &&
      storedMeta.denseModel             === embedCfg.denseModel &&
      storedMeta.sparseProvider         === embedCfg.sparseProvider &&
      storedMeta.embeddingSchemaVersion === embedCfg.schemaVersion &&
      (storedMeta.vectorSize ?? vectorSize) === vectorSize
    );
  }

  const base = { hash: 'abc123', denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'hashed-tf', embeddingSchemaVersion: 2, vectorSize: 1024 };

  ok('identical meta → skip',            wouldSkip(base));
  ok('denseProvider changed → reindex',  !wouldSkip({ ...base, denseProvider: 'bge-m3-onnx', denseModel: 'aapot/bge-m3-onnx', sparseProvider: 'bge-m3-onnx' }));
  ok('denseModel changed → reindex',     !wouldSkip({ ...base, denseModel: 'snowflake-arctic-embed2' }));
  ok('sparseProvider changed → reindex', !wouldSkip({ ...base, sparseProvider: 'bge-m3-onnx' }));
  ok('schemaVersion changed → reindex',  !wouldSkip({ ...base, embeddingSchemaVersion: 1 }));
  ok('vectorSize changed → reindex',     !wouldSkip({ ...base, vectorSize: 768 }));
  ok('file hash changed → reindex',      !wouldSkip({ ...base, hash: 'different' }));
  ok('null vectorSize in stored → treated as current → skip', wouldSkip({ ...base, vectorSize: null }));
}
