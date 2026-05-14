export default async function ({ ok }) {
  console.log('\n[2] ONNX_EMBED=1 shorthand');

  process.env.ONNX_EMBED = '1';
  const { resolveEnvProviders } = await import('../../core/config.js');
  const p = resolveEnvProviders();
  ok('denseProvider = bge-m3-onnx',    p.denseProvider  === 'bge-m3-onnx');
  ok('sparseProvider = bge-m3-onnx',   p.sparseProvider === 'bge-m3-onnx');
  ok('denseModel = aapot/bge-m3-onnx', p.denseModel     === 'aapot/bge-m3-onnx');
  delete process.env.ONNX_EMBED;
}
