export function envInt(name, defaultVal, min, max, prefix = '') {
  const v = parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(v) || v < min || v > max) {
    if (process.env[name] !== undefined)
      console.warn(`${prefix}${name}="${process.env[name]}" is invalid — using default ${defaultVal}`);
    return defaultVal;
  }
  return v;
}

export const VALID_PROVIDER_COMBOS = new Set(['ollama:hashed-tf', 'bge-m3-onnx:bge-m3-onnx']);

export function assertProviderCombo(denseProvider, sparseProvider) {
  if (!VALID_PROVIDER_COMBOS.has(`${denseProvider}:${sparseProvider}`)) {
    throw new Error(
      `Invalid provider combination: denseProvider="${denseProvider}", sparseProvider="${sparseProvider}". ` +
      `Valid combinations: ollama+hashed-tf, bge-m3-onnx+bge-m3-onnx.`
    );
  }
}
