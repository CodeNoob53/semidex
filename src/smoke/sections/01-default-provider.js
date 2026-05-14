export default async function ({ ok }) {
  console.log('\n[1] Default provider (no env overrides)');

  delete process.env.DENSE_PROVIDER;
  delete process.env.SPARSE_PROVIDER;
  delete process.env.ONNX_EMBED;
  delete process.env.EMBED_MODEL;

  const { resolveEnvProviders } = await import('../../core/config.js');
  const p = resolveEnvProviders();
  ok('denseProvider = ollama',     p.denseProvider  === 'ollama');
  ok('sparseProvider = hashed-tf', p.sparseProvider === 'hashed-tf');
  ok('denseModel = bge-m3',        p.denseModel     === 'bge-m3');
}
