// Instance-scoped Qdrant egress URL policy. Wraps the shared, pure
// evaluateEgressUrl() check in its own factory — a separate instance
// from ollama-egress-policy.js's, never a shared singleton, matching the
// composition pattern already used for other instance-scoped security/
// capability factories in this codebase (createOnnxEmbeddingCapability(),
// createRequestSecurityPolicy(), createAllowedRootsGuard()). No module-scope
// mutable state: every createQdrantEgressPolicy() call returns an object
// that only closes over its own `allowMetadataAddresses` argument, so two
// policy instances (e.g. two composition roots constructed in the same
// process, as the test suite exercises) can never influence one another.
import { evaluateEgressUrl, EgressPolicyError } from './network-egress-policy.js';

/**
 * @param {{ allowMetadataAddresses?: boolean }} [opts]
 * @returns {{
 *   checkUrl: (url: string) => { ok: true } | { ok: false, reason: string },
 *   assertAllowed: (url: string) => { ok: true },
 * }}
 */
export function createQdrantEgressPolicy({ allowMetadataAddresses = false } = {}) {
  return {
    checkUrl(url) {
      return evaluateEgressUrl(url, { allowMetadataAddresses });
    },
    /**
     * Throws a typed, sanitized EgressPolicyError (never echoes the
     * rejected URL) when `url` is blocked. Call this before constructing a
     * QdrantClient and before any network call.
     */
    assertAllowed(url) {
      const verdict = evaluateEgressUrl(url, { allowMetadataAddresses });
      if (!verdict.ok) throw new EgressPolicyError({ capability: 'Qdrant', reason: verdict.reason });
      return verdict;
    },
  };
}
