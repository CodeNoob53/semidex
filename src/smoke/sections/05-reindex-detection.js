export default async function ({ ok }) {
  console.log('\n[5] Reindex detection — storedMeta mismatch');

  const embedCfg   = { denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'hashed-tf', schemaVersion: 2 };
  const vectorSize = 1024;
  const chunkingSchemaVersion = 1;
  const tokenCountMode = 'bge-m3';

  function wouldSkip(storedMeta, forceReindex = false) {
    return (
      !forceReindex &&
      storedMeta.hash                   === 'abc123' &&
      storedMeta.denseProvider          === embedCfg.denseProvider &&
      storedMeta.denseModel             === embedCfg.denseModel &&
      storedMeta.sparseProvider         === embedCfg.sparseProvider &&
      storedMeta.embeddingSchemaVersion === embedCfg.schemaVersion &&
      storedMeta.chunkingSchemaVersion  === chunkingSchemaVersion &&
      storedMeta.tokenCountMode         === tokenCountMode &&
      (storedMeta.vectorSize ?? vectorSize) === vectorSize
    );
  }

  // Mirrors the indexer's pre-delete guard: delete runs when storedHash is set
  // AND SKIP_PRE_DELETE is not set.
  function wouldPreDelete(storedMeta, skipPreDelete = false) {
    return !!storedMeta.hash && !skipPreDelete;
  }

  const base = { hash: 'abc123', denseProvider: 'ollama', denseModel: 'bge-m3', sparseProvider: 'hashed-tf', embeddingSchemaVersion: 2, vectorSize: 1024, chunkingSchemaVersion: 1, tokenCountMode: 'bge-m3' };

  ok('identical meta → skip',            wouldSkip(base));
  ok('denseProvider changed → reindex',  !wouldSkip({ ...base, denseProvider: 'bge-m3-onnx', denseModel: 'aapot/bge-m3-onnx', sparseProvider: 'bge-m3-onnx' }));
  ok('denseModel changed → reindex',     !wouldSkip({ ...base, denseModel: 'snowflake-arctic-embed2' }));
  ok('sparseProvider changed → reindex', !wouldSkip({ ...base, sparseProvider: 'bge-m3-onnx' }));
  ok('schemaVersion changed → reindex',  !wouldSkip({ ...base, embeddingSchemaVersion: 1 }));
  ok('missing chunkingSchemaVersion → reindex', !wouldSkip({ ...base, chunkingSchemaVersion: null }));
  ok('chunkingSchemaVersion changed → reindex', !wouldSkip({ ...base, chunkingSchemaVersion: 0 }));
  ok('missing tokenCountMode → reindex', !wouldSkip({ ...base, tokenCountMode: null }));
  ok('tokenCountMode changed → reindex', !wouldSkip({ ...base, tokenCountMode: 'heuristic' }));
  ok('vectorSize changed → reindex',     !wouldSkip({ ...base, vectorSize: 768 }));
  ok('file hash changed → reindex',      !wouldSkip({ ...base, hash: 'different' }));
  ok('null vectorSize in stored → treated as current → skip', wouldSkip({ ...base, vectorSize: null }));
  ok('FORCE_REINDEX=true bypasses unchanged skip',            !wouldSkip(base, true));

  // SKIP_PRE_DELETE guard — used by safe-mode repair so the file is never deleted
  // before the reindex completes. The repair script handles orphan cleanup itself.
  ok('storedHash present → pre-delete would run without flag', wouldPreDelete(base));
  ok('SKIP_PRE_DELETE=true → pre-delete suppressed',           !wouldPreDelete(base, true));
  ok('no storedHash (new file) → pre-delete skipped regardless', !wouldPreDelete({ ...base, hash: null }));
}
