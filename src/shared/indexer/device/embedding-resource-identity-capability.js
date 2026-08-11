// Device-aware bounded indexing pipeline — embedding resource identity
// wrapper capability. Instance-scoped: takes the RESOLVED embedding
// profile as a constructor parameter, never reads module-scope state (the
// same anti-pattern this codebase's own run.js header comment already
// rejected for a module-scope EMBEDDING_PROFILE snapshot — see run.js's
// own history there).
//
// This wrapper still internally branches on profile.embedding.dense.
// execution/.provider (it has to — that's its whole job: translating a
// resolved profile into a call to the right underlying backend), but every
// backend it delegates to exposes the identical getResourceIdentity({env})
// shape, so this file never has to know the INTERNAL shape of any backend
// it calls. The one deliberate, scoped exception is calling
// getEmbeddingResourceIdentity({env, model}) on the injected Ollama
// capability — contained entirely inside this file; every capability THIS
// wrapper itself exposes to resolvePipelineResourceIdentities (its own
// getResourceIdentity({env})) and every capability it receives as onnxEmbed
// still follows the fully uniform shape.

export const REQUIRED_EMBEDDING_RESOURCE_IDENTITY_CAPABILITY_METHODS = ['getResourceIdentity'];

/**
 * @param {Object} capability
 * @throws {Error} with an actionable message naming the missing piece
 */
export function validateEmbeddingResourceIdentityCapability(capability) {
  if (typeof capability !== 'object' || capability === null) {
    throw new Error('validateEmbeddingResourceIdentityCapability: capability must be a non-null object');
  }
  const missing = REQUIRED_EMBEDDING_RESOURCE_IDENTITY_CAPABILITY_METHODS.filter(m => typeof capability[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(`validateEmbeddingResourceIdentityCapability: capability is missing required method(s): ${missing.join(', ')}`);
  }
  return true;
}

/**
 * @param {{
 *   profile: Object,                // RESOLVED embedding profile — passed in, never read from module scope
 *   onnxEmbed: Object,               // has getResourceIdentity({env}) — used when provider is local ONNX
 *   ollamaResourceIdentity: Object|null, // has getEmbeddingResourceIdentity({env, model}) — used when provider is 'ollama'; null in compositions without Ollama (Lite)
 * }} deps
 * @returns {{ getResourceIdentity: (context?: {env?: NodeJS.ProcessEnv}) => Promise<import('./resource-identity.js').ResourceIdentity> }}
 */
export function createEmbeddingResourceIdentityCapability({ profile, onnxEmbed, ollamaResourceIdentity }) {
  return {
    async getResourceIdentity({ env } = {}) {
      const { execution, provider, model } = profile.embedding.dense;
      if (execution && execution !== 'client') {
        // Server-side execution (Qdrant Cloud/cluster) — zero local
        // compute for this process, a real remote resource, always
        // independent of any local lane.
        return { kind: 'remote', backend: `qdrant-${execution === 'qdrant-cloud' ? 'cloud' : 'cluster'}`, deviceId: null, verified: true, source: 'manual' };
      }
      if (provider === 'ollama') {
        if (!ollamaResourceIdentity) return { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null };
        return ollamaResourceIdentity.getEmbeddingResourceIdentity({ env, model });
      }
      if (onnxEmbed && typeof onnxEmbed.getResourceIdentity === 'function') {
        return onnxEmbed.getResourceIdentity({ env });
      }
      return { kind: 'unknown', backend: provider ?? 'unknown', deviceId: null, verified: false, source: null };
    },
  };
}
