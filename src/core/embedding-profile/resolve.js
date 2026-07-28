// Embedding profile precedence resolution — the ONE place this logic
// lives. Two entry points, deliberately asymmetric:
//
//   resolveExistingCollectionProfile(adapter, name) — READ-ONLY. Never
//   scans point payloads, never writes anything, never calls
//   adapter.migrateEmbeddingProfile(). Every read-path caller (search, Ask,
//   MCP, Admin API/MCP collection-detail assembly) calls this and this
//   alone. config.json plays NO role in this function at all — it is never
//   read here for identity purposes.
//
//   resolveNewCollectionProfile(envDefaults) — the one legitimate place
//   resolveEnvProviders()-derived global/env defaults are used. Builds a
//   fresh profile for a collection that does not exist in Qdrant yet.
//   config.json plays no role here either — it is written AFTER this
//   resolution succeeds, as a cache of the result, never consulted as an
//   input.
//
// Migration (recovering an unambiguous profile from legacy point payloads)
// is a SEPARATE, explicitly-invoked write operation
// (adapter.migrateEmbeddingProfile) run only from sync.js or the indexer's
// own preflight — never implicitly from either function in this file.
import { buildEmbeddingProfile } from './schema.js';
import { assertProviderCombo } from '../env.js';
import { ONNX_DENSE_MODEL_ID } from '../onnx-paths.js';

/**
 * @param {import('../storage/adapter.js').StorageAdapter} adapter
 * @param {string} name
 * @returns {Promise<
 *   | { resolved: true, profile: Object }
 *   | { resolved: false, reason: 'legacy_unmigrated' }
 *   | { resolved: false, reason: 'invalid', errors: string[] }
 *   | { resolved: false, reason: 'unsupported_schema_version', found: number }
 *   | { resolved: false, reason: 'schema_mismatch', mismatches: Array }
 * >}
 */
export async function resolveExistingCollectionProfile(adapter, name) {
  const result = await adapter.getEmbeddingProfile(name);
  switch (result.state) {
    case 'valid':
      return { resolved: true, profile: result.profile };
    case 'missing':
      return { resolved: false, reason: 'legacy_unmigrated' };
    case 'invalid':
      return { resolved: false, reason: 'invalid', errors: result.errors };
    case 'unsupported_schema_version':
      return { resolved: false, reason: 'unsupported_schema_version', found: result.found };
    case 'schema_mismatch':
      // A shape-valid profile that disagrees with the collection's REAL
      // live vector schema — never resolved, and deliberately NOT mapped to
      // 'legacy_unmigrated' (the previous unhandled-state default): running
      // migration against this would be wrong, since a profile already
      // exists — it's simply describing the wrong vector space. This must
      // surface as its own distinct, more serious problem.
      return { resolved: false, reason: 'schema_mismatch', mismatches: result.mismatches };
    default:
      // Should be unreachable given getEmbeddingProfile()'s typed states —
      // kept as a defensive fallback, never silently treated as resolved.
      return { resolved: false, reason: 'legacy_unmigrated' };
  }
}

/**
 * Resolves the profile for a BRAND-NEW collection from global/env defaults.
 * `envDefaults` is the result of core/config.js's resolveEnvProviders() —
 * { denseProvider, denseModel, sparseProvider }. `vectorSize` is the
 * caller-resolved dense dimension (e.g. from a live Ollama probe, or the
 * fixed ONNX dimension) — this function does not probe anything itself.
 *
 * @param {{ denseProvider: string, denseModel: string, sparseProvider: string }} envDefaults
 * @param {{ vectorSize: number, embeddingSchemaVersion: number }} opts
 * @returns {Object} a fully-built, validated-shape embedding profile
 */
export function resolveNewCollectionProfile(envDefaults, { vectorSize, embeddingSchemaVersion }) {
  assertProviderCombo(envDefaults.denseProvider, envDefaults.sparseProvider);

  const isOnnx = envDefaults.denseProvider === 'bge-m3-onnx';
  const dense = {
    provider: envDefaults.denseProvider,
    model: isOnnx ? ONNX_DENSE_MODEL_ID : envDefaults.denseModel,
    vectorName: 'dense',
    dimensions: vectorSize,
    distance: 'Cosine',
    execution: 'client',
  };
  const sparse = {
    provider: envDefaults.sparseProvider,
    model: envDefaults.sparseProvider, // hashed-tf/bge-m3-onnx: provider name doubles as the model id, no separate sparse model registry exists yet
    vectorName: 'sparse',
    execution: 'client',
    modifier: null,
  };

  return buildEmbeddingProfile({ dense, sparse, embeddingSchemaVersion });
}
