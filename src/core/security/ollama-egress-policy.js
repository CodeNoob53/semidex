// Instance-scoped Ollama egress URL policy. Same shape as
// qdrant-egress-policy.js, deliberately a separate factory/instance rather
// than a shared singleton — Ollama has no credential to protect, so this
// policy owns a strictly smaller concern than Qdrant's, and instance
// separation means a future Ollama-specific carve-out never has to reason
// about Qdrant's credential-bearing case (or vice versa). No module-scope
// mutable state: every createOllamaEgressPolicy() call closes only over its
// own `allowMetadataAddresses` argument.
import { evaluateEgressUrl, EgressPolicyError } from './network-egress-policy.js';

/**
 * @param {{ allowMetadataAddresses?: boolean }} [opts]
 * @returns {{
 *   checkUrl: (url: string) => { ok: true } | { ok: false, reason: string },
 *   assertAllowed: (url: string) => { ok: true },
 * }}
 */
export function createOllamaEgressPolicy({ allowMetadataAddresses = false } = {}) {
  return {
    checkUrl(url) {
      return evaluateEgressUrl(url, { allowMetadataAddresses });
    },
    /**
     * Throws a typed, sanitized EgressPolicyError (never echoes the
     * rejected URL) when `url` is blocked. Call this before any network
     * call — local/core/ollama.js calls this at the top of every exported
     * function that performs a fetch().
     */
    assertAllowed(url) {
      const verdict = evaluateEgressUrl(url, { allowMetadataAddresses });
      if (!verdict.ok) throw new EgressPolicyError({ capability: 'Ollama', reason: verdict.reason });
      return verdict;
    },
  };
}
