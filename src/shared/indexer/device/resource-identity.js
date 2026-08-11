// Device-aware bounded indexing pipeline — provider-agnostic resource
// identity core (plan: recursive-roaming-anchor.md, "Provider-agnostic
// device-aware indexing scheduler" section). This file contains ZERO
// provider-specific knowledge — no Ollama, no ONNX, no Qdrant Cloud, no
// vocabulary tied to any concrete backend. It exists only to define the
// shared ResourceIdentity shape and to compose whatever capabilities are
// injected into it, generically.
//
// Every provider's own identity-detection logic lives inside THAT
// provider's own capability implementation (local/core/ollama-capability.js,
// local/core/onnx-embed.js, local/indexer/phases/tag-onnx.js) — each one
// exposes a getResourceIdentity({env}) method. This module never imports
// any of them.

/**
 * @typedef {Object} ResourceIdentity
 * @property {'cpu'|'gpu'|'mixed'|'remote'|'unknown'} kind
 * @property {string} backend
 * @property {string|null} deviceId
 * @property {boolean} verified
 * @property {string|null} source
 *   Known values in use today: 'ollama-api'|'onnx-runtime'|'manual'|'structural'.
 *   Widened from a closed enum to a plain string so new capabilities can
 *   introduce new source tokens (diagnostics/attribution only — see
 *   scheduling-policy.js's own invariant that `source`/`backend` are never
 *   read by any overlap decision) without ever touching this typedef again.
 */

function isValidResourceIdentity(x) {
  if (!x || typeof x !== 'object') return false;
  if (!['cpu', 'gpu', 'mixed', 'remote', 'unknown'].includes(x.kind)) return false;
  if (typeof x.backend !== 'string') return false;
  if (x.deviceId !== null && typeof x.deviceId !== 'string') return false;
  if (typeof x.verified !== 'boolean') return false;
  return true;
}

/**
 * Generic aggregate resolver. Calls each capability's own
 * getResourceIdentity({env}) — the SAME uniform, zero-provider-vocabulary
 * shape for all three slots (generation/embedding/tagging). Never imports,
 * names, or special-cases any provider. Never substitutes one capability's
 * result for another's. Normalizes a missing capability / malformed result /
 * thrown error / rejected promise to `unknown` — a scheduling signal must
 * never be able to crash a run. Any request-scoped dedup a capability wants
 * (e.g. Ollama's /api/ps in-flight dedup) is entirely that capability's own
 * private business — this function has no memoization of its own and no
 * opinion on whether one exists downstream.
 * @param {{
 *   generationCapability: {getResourceIdentity: (ctx: {env?: NodeJS.ProcessEnv}) => Promise<ResourceIdentity>} | null,
 *   embeddingCapability: {getResourceIdentity: (ctx: {env?: NodeJS.ProcessEnv}) => Promise<ResourceIdentity>} | null,
 *   taggingCapability: {getResourceIdentity: (ctx: {env?: NodeJS.ProcessEnv}) => Promise<ResourceIdentity>} | null,
 *   env?: NodeJS.ProcessEnv,
 * }} params
 * @returns {Promise<{ generation: ResourceIdentity, embedding: ResourceIdentity, tagging: ResourceIdentity }>}
 */
export async function resolvePipelineResourceIdentities({
  generationCapability, embeddingCapability, taggingCapability, env,
}) {
  const UNKNOWN = { kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null };

  async function safeResolve(capability) {
    if (!capability || typeof capability.getResourceIdentity !== 'function') return UNKNOWN;
    try {
      const result = await Promise.resolve().then(() => capability.getResourceIdentity({ env }));
      return isValidResourceIdentity(result) ? result : UNKNOWN;
    } catch {
      return UNKNOWN;
    }
  }

  const [generation, embedding, tagging] = await Promise.all([
    safeResolve(generationCapability),
    safeResolve(embeddingCapability),
    safeResolve(taggingCapability),
  ]);
  return { generation, embedding, tagging };
}
