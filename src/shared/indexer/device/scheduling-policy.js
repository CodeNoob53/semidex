// Device-aware bounded indexing pipeline — scheduling policy
// (plan: recursive-roaming-anchor.md §2). Pure function: takes the 3
// ResourceIdentity values (resource-identity.js) and returns the
// pairwise overlap decisions the bounded pipeline (pipeline/
// bounded-file-pipeline.js) and stageB() (run.js) both act on.
//
// `verified` is REQUIRED on both sides for ANY overlap decision — an
// unverified identity never unlocks overlap, regardless of its claimed
// `kind`. There is no principled reason to trust one unverified claim
// (e.g. an un-embedded-yet ONNX settings-intent fallback) more than
// another. The ONE deliberate exception: GENERATION_DEVICE_OVERRIDE
// (resource-identity.js's resolveGenerationResourceIdentity, consulted
// only when a real /api/ps read is unavailable for every active model)
// is treated as verified:true, source:'manual' — an explicit, informed
// operator assertion about their own deployment topology, not a passive
// settings-intent guess. It still carries source:'manual' forever (never
// upgraded to 'ollama-api'), so any overlap decision it drove is always
// traceable in reason/pairReasons back to a manual claim, never mistaken
// for a verified runtime read.

/**
 * @typedef {Object} SchedulingPolicy
 * @property {boolean} canOverlapGenerationAndEmbedding
 * @property {boolean} canOverlapGenerationAndTagging
 * @property {boolean} canOverlapTaggingAndEmbedding
 * @property {string[][]} serializedLaneGroups
 * @property {string} reason
 * @property {{ generationEmbedding: string, generationTagging: string, taggingEmbedding: string }} pairReasons
 */

/**
 * Pairwise overlap decision — the one matrix applied to every pair
 * among {generation, embedding, tagging}.
 * @param {import('./resource-identity.js').ResourceIdentity} a
 * @param {import('./resource-identity.js').ResourceIdentity} b
 * @returns {{ canOverlap: boolean, reason: string }}
 */
function manualNote(a, b) {
  const manualSides = [a, b].filter((x) => x.source === 'manual');
  if (manualSides.length === 0) return '';
  return ` (manually confirmed via GENERATION_DEVICE_OVERRIDE, not a verified runtime read, for: ${manualSides.map((x) => x.kind).join(', ')})`;
}

function decidePair(a, b) {
  if (a.kind === 'unknown' || b.kind === 'unknown') {
    return { canOverlap: false, reason: 'one side\'s resource identity is unknown — conservative sequential' };
  }
  if (a.kind === 'mixed' || b.kind === 'mixed') {
    return { canOverlap: false, reason: 'one side is a mixed CPU/GPU offload — not a clean independent lane, conservative sequential' };
  }
  if (!a.verified || !b.verified) {
    return { canOverlap: false, reason: 'one side\'s resource identity is not independently verified — conservative sequential regardless of claimed kind' };
  }
  if (a.kind === 'cpu' && b.kind === 'cpu') {
    return { canOverlap: false, reason: 'both sides verified on CPU — no independent compute lanes to overlap' };
  }
  if (a.kind === 'gpu' && b.kind === 'gpu') {
    if (a.deviceId && b.deviceId && a.deviceId !== b.deviceId) {
      return { canOverlap: true, reason: `verified distinct GPU devices (A vs B)${manualNote(a, b)}` };
    }
    return { canOverlap: false, reason: 'same GPU, or GPU device id not reliably distinguishable — sequential by default' };
  }
  // One verified cpu, one verified gpu (either order).
  return { canOverlap: true, reason: `verified on independent resource kinds (cpu/gpu) — parallel lanes${manualNote(a, b)}` };
}

/**
 * @param {{ generation: import('./resource-identity.js').ResourceIdentity, embedding: import('./resource-identity.js').ResourceIdentity, tagging: import('./resource-identity.js').ResourceIdentity }} identities
 * @returns {SchedulingPolicy}
 */
export function resolveIndexSchedulingPolicy({ generation, embedding, tagging }) {
  const genEmbed = decidePair(generation, embedding);
  const genTag = decidePair(generation, tagging);
  const tagEmbed = decidePair(tagging, embedding);

  const serializedLaneGroups = [];
  if (!genEmbed.canOverlap) serializedLaneGroups.push(['generation', 'embedding']);
  if (!genTag.canOverlap) serializedLaneGroups.push(['generation', 'tagging']);
  if (!tagEmbed.canOverlap) serializedLaneGroups.push(['tagging', 'embedding']);

  const parts = [];
  parts.push(`generation/embedding: ${genEmbed.canOverlap ? 'overlap allowed' : 'sequential'} (${genEmbed.reason})`);
  parts.push(`generation/tagging: ${genTag.canOverlap ? 'overlap allowed' : 'sequential'} (${genTag.reason})`);
  parts.push(`tagging/embedding: ${tagEmbed.canOverlap ? 'overlap allowed' : 'sequential'} (${tagEmbed.reason})`);

  return {
    canOverlapGenerationAndEmbedding: genEmbed.canOverlap,
    canOverlapGenerationAndTagging: genTag.canOverlap,
    canOverlapTaggingAndEmbedding: tagEmbed.canOverlap,
    serializedLaneGroups,
    reason: parts.join('; '),
    pairReasons: {
      generationEmbedding: genEmbed.reason,
      generationTagging: genTag.reason,
      taggingEmbedding: tagEmbed.reason,
    },
  };
}
