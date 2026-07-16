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

/**
 * The single source of truth for "which embedding backend is actually
 * active" — used by BOTH core/config.js's resolveEnvProviders() (the real
 * indexer/sync/collection-creation path) and core/settings/service.js's
 * EMBEDDING_BACKEND resolution (the Settings UI's read-side view). Exists
 * specifically so these two callers can never drift apart again: before
 * this function existed, service.js's EMBEDDING_BACKEND only ever
 * consulted DENSE_PROVIDER's own registry entry, silently ignoring the
 * legacy ONNX_EMBED=1 shorthand that resolveEnvProviders() itself already
 * treats as a valid, real way of selecting bge-m3-onnx — so a real .env
 * with ONNX_EMBED=1 and no DENSE_PROVIDER made Settings report "ollama"
 * while the indexer actually ran ONNX. This function encodes the same
 * three-tier precedence resolveEnvProviders() already implements (explicit
 * DENSE_PROVIDER wins > ONNX_EMBED=1 legacy shorthand > default 'ollama'),
 * parameterized over a generic raw-string lookup so each caller can supply
 * its own notion of "read this env var" (config.js: plain process.env;
 * service.js: the same os_env/dotenv/config_json/default tier resolution
 * every other registry field already goes through).
 *
 * @param {(name: string) => string | undefined} readRaw — returns the raw
 *   (unparsed, string) value of an env-style variable name from whatever
 *   tiered source the caller wants consulted, or undefined/empty if unset
 *   at every tier that caller cares about.
 * @returns {{ denseProvider: 'ollama'|'bge-m3-onnx', sparseProvider: 'hashed-tf'|'bge-m3-onnx', via: 'DENSE_PROVIDER'|'ONNX_EMBED'|'default' }}
 *   `via` reports WHICH tier of the precedence actually decided the
 *   result — callers that need to know provenance (e.g. the Settings UI,
 *   to show whether EMBEDDING_BACKEND is really "just the default" or
 *   driven by the legacy shorthand) read this instead of re-deriving it.
 */
export function resolveEffectiveEmbeddingBackend(readRaw) {
  const rawDenseProvider = readRaw('DENSE_PROVIDER');
  if (rawDenseProvider !== undefined && rawDenseProvider !== '') {
    const denseProvider = rawDenseProvider;
    const rawSparseProvider = readRaw('SPARSE_PROVIDER');
    const sparseProvider = rawSparseProvider !== undefined && rawSparseProvider !== '' ? rawSparseProvider : 'hashed-tf';
    return { denseProvider, sparseProvider, via: 'DENSE_PROVIDER' };
  }
  const rawOnnxEmbed = readRaw('ONNX_EMBED');
  if (rawOnnxEmbed === '1') {
    return { denseProvider: 'bge-m3-onnx', sparseProvider: 'bge-m3-onnx', via: 'ONNX_EMBED' };
  }
  return { denseProvider: 'ollama', sparseProvider: 'hashed-tf', via: 'default' };
}
