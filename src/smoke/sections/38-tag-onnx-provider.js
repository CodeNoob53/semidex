export default async function ({ ok }) {
  console.log('\n[38] TAG_PROVIDER=onnx provider detection');

  const { isOnnxTagProvider } = await import('../../indexer/phases/tag-onnx.js');

  ok('onnx provider: TAG_PROVIDER=onnx → true',   isOnnxTagProvider({ TAG_PROVIDER: 'onnx' }) === true);
  ok('onnx provider: TAG_PROVIDER=ollama → false', isOnnxTagProvider({ TAG_PROVIDER: 'ollama' }) === false);
  ok('onnx provider: TAG_PROVIDER unset → false',  isOnnxTagProvider({}) === false);
  ok('onnx provider: TAG_PROVIDER=ONNX → false',   isOnnxTagProvider({ TAG_PROVIDER: 'ONNX' }) === false);
}
