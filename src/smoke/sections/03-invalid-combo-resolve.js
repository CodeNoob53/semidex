export default async function ({ ok, throws }) {
  console.log('\n[3] Invalid provider combo — resolveEnvProviders');

  const { resolveEnvProviders } = await import('../../core/config.js');

  process.env.DENSE_PROVIDER  = 'ollama';
  process.env.SPARSE_PROVIDER = 'bge-m3-onnx';
  throws('ollama + bge-m3-onnx throws', () => resolveEnvProviders(), 'Invalid provider combination');

  process.env.DENSE_PROVIDER  = 'bge-m3-onnx';
  process.env.SPARSE_PROVIDER = 'hashed-tf';
  throws('bge-m3-onnx + hashed-tf throws', () => resolveEnvProviders(), 'Invalid provider combination');

  process.env.DENSE_PROVIDER  = 'unknown-provider';
  process.env.SPARSE_PROVIDER = 'hashed-tf';
  throws('unknown denseProvider throws', () => resolveEnvProviders(), 'Invalid provider combination');

  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
}
