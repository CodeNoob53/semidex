export default async function ({ ok }) {
  console.log('\n[12] resolveOnnxExecutionProviders (no model load)');

  const saved = process.env.ONNX_EXECUTION_PROVIDER;
  delete process.env.ONNX_EXECUTION_PROVIDER;

  const { resolveOnnxExecutionProviders } = await import('../../core/onnx-embed.js');

  ok('unset → [cpu]',       resolveOnnxExecutionProviders(undefined).join(',') === 'cpu');
  ok('empty string → [cpu]', resolveOnnxExecutionProviders('').join(',') === 'cpu');
  ok("'cpu' → [cpu]",       resolveOnnxExecutionProviders('cpu').join(',') === 'cpu');

  {
    const r = resolveOnnxExecutionProviders('dml');
    ok("'dml' → includes dml",           r[0] === 'dml');
    ok("'dml' → includes cpu fallback",  r.includes('cpu'));
  }

  {
    const r = resolveOnnxExecutionProviders('cuda');
    ok("'cuda' → [cuda]", r.length === 1 && r[0] === 'cuda');
  }

  ok("invalid value → [cpu]",      resolveOnnxExecutionProviders('webgpu').join(',') === 'cpu');
  ok("'DML' uppercase → includes dml", resolveOnnxExecutionProviders('DML')[0] === 'dml');

  if (saved !== undefined) process.env.ONNX_EXECUTION_PROVIDER = saved;
}
