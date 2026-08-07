export default async function ({ ok }) {
  console.log('\n[24] dml-batching-gate — pure config helpers');

  const { shouldUseOnnxBatching, resolveOnnxBatchSize }
    = await import('../../shared/core/embeddings.js');

  // 24a–24g: shouldUseOnnxBatching
  ok('shouldUseOnnxBatching({}) === false',
    shouldUseOnnxBatching({}) === false);

  ok('ONNX_EMBED=1, no provider === false',
    shouldUseOnnxBatching({ ONNX_EMBED: '1' }) === false);

  ok('ONNX_EMBED=1, cpu === false',
    shouldUseOnnxBatching({ ONNX_EMBED: '1', ONNX_EXECUTION_PROVIDER: 'cpu' }) === false);

  ok('ONNX_EMBED=1, dml === true',
    shouldUseOnnxBatching({ ONNX_EMBED: '1', ONNX_EXECUTION_PROVIDER: 'dml' }) === true);

  ok('ONNX_EMBED=1, DML (uppercase) === true',
    shouldUseOnnxBatching({ ONNX_EMBED: '1', ONNX_EXECUTION_PROVIDER: 'DML' }) === true);

  ok('ONNX_EMBED=1, cuda === false',
    shouldUseOnnxBatching({ ONNX_EMBED: '1', ONNX_EXECUTION_PROVIDER: 'cuda' }) === false);

  ok('ONNX_EMBED=0, dml === false',
    shouldUseOnnxBatching({ ONNX_EMBED: '0', ONNX_EXECUTION_PROVIDER: 'dml' }) === false);

  // 24h–24o: resolveOnnxBatchSize
  ok('resolveOnnxBatchSize({}) === 4',
    resolveOnnxBatchSize({}) === 4);

  ok('resolveOnnxBatchSize("1") === 1',
    resolveOnnxBatchSize({ ONNX_BATCH_SIZE: '1' }) === 1);

  ok('resolveOnnxBatchSize("4") === 4',
    resolveOnnxBatchSize({ ONNX_BATCH_SIZE: '4' }) === 4);

  ok('resolveOnnxBatchSize("8") === 8',
    resolveOnnxBatchSize({ ONNX_BATCH_SIZE: '8' }) === 8);

  ok('resolveOnnxBatchSize("64") === 64',
    resolveOnnxBatchSize({ ONNX_BATCH_SIZE: '64' }) === 64);

  ok('resolveOnnxBatchSize("0") === 4 (invalid)',
    resolveOnnxBatchSize({ ONNX_BATCH_SIZE: '0' }) === 4);

  ok('resolveOnnxBatchSize("65") === 4 (out of range)',
    resolveOnnxBatchSize({ ONNX_BATCH_SIZE: '65' }) === 4);

  ok('resolveOnnxBatchSize("abc") === 4 (non-numeric)',
    resolveOnnxBatchSize({ ONNX_BATCH_SIZE: 'abc' }) === 4);
}
