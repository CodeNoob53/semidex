// Local Ollama capability factory (Phase 8B Step 8 — replaces the
// transitional core/ollama-lazy.js dynamic-loader wrapper, now removed).
// The one place in the codebase that statically imports local/core/ollama.js
// — every Full-only composition root (admin/bootstrap.js,
// admin/server-full.js, indexer/index-full.js, backfill-tags.js,
// mcp/server.js) imports THIS file instead, never local/core/ollama.js
// directly, so a future consumer never has to remember that ollama.js
// itself carries a static `import 'dotenv/config'` side effect that must
// not leak into Lite's module graph.
//
// Unlike local/core/onnx-embed.js/local/indexer/phases/tag-onnx.js (which
// own real session/worker lifecycle and need instance-scoped state), plain
// function exports in ollama.js hold no mutable state at all — there is
// nothing to isolate between two independently-constructed capabilities,
// so most of these factories are simple object literals, not closures over
// private state. Each one returns only the narrow method subset its own
// contract (src/core/generation/ollama-capability.js) declares — never the
// full ollama.js namespace — so a consumer can never accidentally reach a
// method outside what it declared it needs.
//
// createOllamaResourceIdentityCapability() is the ONE exception among these
// five factories: it genuinely needs private per-instance state (an
// in-flight-call dedup cache for /api/ps — see its own doc comment below),
// so it alone is a real closure factory, matching local/core/onnx-embed.js's/
// local/indexer/phases/tag-onnx.js's existing closure-per-instance style
// rather than this file's own otherwise-uniform stateless-object-literal one.
import {
  generate, embed, getModelContextLength, isThinkingModel, getOllamaEmbeddingDimension,
  isOllamaReachable, listOllamaModels, validateOllamaModels, generateStream, getRunningModel,
} from './ollama.js';
// local/ -> shared/ is an allowed import direction (only shared/ -> local/
// is forbidden) — imported, not re-implemented, so resolveActiveGenerationModels()
// below can never drift from stageB's own real CONTEXT_MODE=deterministic
// check again (code review finding, P1 — see that function's own header).
import { isDeterministicContextMode } from '../../shared/indexer/phases/context.js';

/** @returns {import('../../core/generation/ollama-capability.js').OllamaGenerateCapability} */
export function createOllamaGenerateCapability() {
  return { generate };
}

/** @returns {import('../../core/generation/ollama-capability.js').OllamaSummaryCapability} */
export function createOllamaSummaryCapability() {
  return { generate, getModelContextLength, isThinkingModel };
}

/** @returns {import('../../core/generation/ollama-capability.js').OllamaEmbedCapability} */
export function createOllamaEmbedCapability() {
  return { embed, getOllamaEmbeddingDimension };
}

/** @returns {import('../../core/generation/ollama-capability.js').OllamaDiscoveryCapability} */
export function createOllamaDiscoveryCapability() {
  return { isOllamaReachable, listOllamaModels, validateOllamaModels, getRunningModel };
}

// generateStream has no capability contract of its own (see
// core/generation/ollama-capability.js's own header comment — its one real
// consumer, core/generation/ollama-provider.js, already has its own
// separate per-method DI unrelated to these contracts) — re-exported here,
// individually, for admin/bootstrap.js's own generationRuntime wiring,
// which needs it alongside three OllamaDiscoveryCapability-shaped methods
// but is not itself consuming a single bundled capability object.
export { generateStream, isOllamaReachable, listOllamaModels, validateOllamaModels, getModelContextLength };

// ── Resource identity (device-aware bounded pipeline) ──────────────────────
// Relocated here in full from the formerly-shared
// device/resource-identity.js (which is now fully provider-agnostic and
// must never import anything Ollama-specific) — this is the ONE place
// Ollama's real /api/ps VRAM-placement signal is read and classified.

// VRAM classification tolerance for Ollama's /api/ps size/size_vram
// ratio — a tuning constant, not a correctness one. Real VRAM accounting
// can carry small non-zero overhead even for a fully CPU-resident model,
// so 0 would be too strict.
const VRAM_TOLERANCE_BYTES = 64 * 1024 * 1024;

/**
 * Classifies one Ollama /api/ps result by its VRAM placement ratio — the
 * same signal `ollama ps`'s own PROCESSOR column is built from.
 * @param {{ size: number, size_vram: number }} entry
 * @returns {'cpu'|'gpu'|'mixed'}
 */
function classifyRunningModel({ size, size_vram }) {
  if (size_vram <= VRAM_TOLERANCE_BYTES) return 'cpu';
  if (size_vram >= size - VRAM_TOLERANCE_BYTES) return 'gpu';
  return 'mixed';
}

function isValidRunningModelEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const { size, size_vram } = entry;
  return Number.isFinite(size) && size > 0 && Number.isFinite(size_vram) && size_vram >= 0 && size_vram <= size;
}

/**
 * @param {{
 *   runningModels?: Array<{ model: string, size?: number, size_vram?: number, runningModel?: null }>,
 *   generationDeviceOverride?: 'cpu'|'gpu'|null,
 * }} input
 * @returns {import('../../shared/indexer/device/resource-identity.js').ResourceIdentity}
 */
function resolveGenerationResourceIdentity({ runningModels, generationDeviceOverride = null } = {}) {
  const list = Array.isArray(runningModels) ? runningModels : [];

  if (list.length === 0) {
    // Empty is "irrelevant this run" (generation never happens), not
    // "unverifiable" — never consult the override for this case.
    return { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null };
  }

  const classifications = list.map((entry) => (isValidRunningModelEntry(entry) ? classifyRunningModel(entry) : 'unknown'));
  const allUnknown = classifications.every((c) => c === 'unknown');

  if (allUnknown) {
    // The override is consulted ONLY when every active model's real
    // /api/ps read came back unresolved (allUnknown) — a real signal on
    // even ONE model always wins; this branch is never reached otherwise.
    // Once here, an explicit operator assertion IS treated as
    // verified:true — the operator is making a real, informed claim
    // about their own deployment topology (which model runs where) and
    // consciously accepting the risk of an incorrect overlap decision if
    // that claim is wrong. This is a deliberate exception to "no
    // unverified identity ever unlocks overlap": source:'manual' keeps
    // it forever distinguishable in diagnostics/logs from a genuine
    // 'ollama-api' runtime read, so a wrong overlap decision traced back
    // to this path is always attributable to the operator's own
    // configuration, never mistaken for a scheduler bug.
    if (generationDeviceOverride === 'cpu' || generationDeviceOverride === 'gpu') {
      return { kind: generationDeviceOverride, backend: 'ollama', deviceId: null, verified: true, source: 'manual' };
    }
    return { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null };
  }

  const distinct = new Set(classifications);
  if (distinct.size === 1) {
    const [kind] = distinct;
    return { kind, backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' };
  }

  // Differing classifications (including a mix of resolved + unknown
  // entries) collapse to 'mixed' — the same conservative bucket used
  // for a single model's partial VRAM offload. Never silently ignore
  // an unresolved model just because another one succeeded.
  return { kind: 'mixed', backend: 'ollama', deviceId: null, verified: true, source: 'ollama-api' };
}

/**
 * Returns the distinct set of Ollama model names stageB will actually
 * call THIS run, given env/settings — mirrors stageB's own branch
 * selection (context.js/tag.js/combined.js model resolution) without
 * duplicating its control flow (this only asks "which model names",
 * never runs a prompt). Pure, synchronous, zero I/O.
 *
 * Branch priority MUST match stageB's real if/else-if order in
 * run.js — code review finding (P1): an earlier version of this function
 * checked COMBINED_LLM=1 before CONTEXT_MODE=deterministic, but stageB
 * itself does the opposite (run.js's own CONTEXT_MODE=deterministic
 * branch runs first and explicitly WARNS that COMBINED_LLM=1 is ignored
 * — "deterministic context owns the context phase"). For
 * CONTEXT_MODE=deterministic + COMBINED_LLM=1 + TAG_GEN=1 +
 * TAG_PROVIDER=ollama, the old order reported only CONTEXT_MODEL, while
 * stageB actually calls TAG_MODEL for tags — the scheduler was checking
 * a model that's never called and never checking the one that is. Fixed
 * by mirroring stageB's real precedence: deterministic context first
 * (context.js's own isDeterministicContextMode — imported, not
 * re-implemented, so this can never drift from stageB's own check again),
 * THEN combined, THEN the ONNX-parallel branch, THEN the plain default.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function resolveActiveGenerationModels(env) {
  const contextModel = env.CONTEXT_MODEL || 'gemma3:4b';
  const tagModel = env.TAG_MODEL || env.CONTEXT_MODEL || 'gemma3:4b';
  const combinedEnabled = env.COMBINED_LLM === '1';
  const genTags = env.TAG_GEN === '1';
  const tagViaOnnx = env.TAG_PROVIDER === 'onnx';
  const deterministicContext = isDeterministicContextMode(env);

  const models = [];

  if (deterministicContext) {
    // CONTEXT_MODE=deterministic: context itself never calls Ollama, and
    // stageB explicitly ignores COMBINED_LLM=1 in this mode (warns and
    // falls through to its own plain per-file tag call) — so this branch
    // must take priority over combinedEnabled, not the reverse. Tags
    // still run normally if enabled and not ONNX-routed.
    if (genTags && !tagViaOnnx) models.push(tagModel);
  } else if (combinedEnabled) {
    // COMBINED_LLM=1: single model for both context+tags — TAG_MODEL
    // is explicitly ignored in this mode (doctor-checks.js's own logic).
    models.push(contextModel);
  } else if (tagViaOnnx && genTags) {
    // ONNX-parallel branch: tags go to ONNX, only context calls Ollama.
    models.push(contextModel);
  } else {
    // Plain default branch (also covers the skeleton-deterministic
    // per-file case conservatively — see below): context always calls
    // Ollama; tags call Ollama too unless ONNX-routed.
    models.push(contextModel);
    if (genTags && !tagViaOnnx) models.push(tagModel);
  }

  // Skeleton-deterministic chunk shape is a per-file, data-dependent fact
  // this env-only function cannot know in advance (code review finding,
  // P2). Concretely: a pure-skeleton (Markdown-only) collection, ONNX
  // tags, no nav summaries (SKELETON_SUMMARY unset) makes ZERO Ollama
  // calls of any kind for context — stageB's skeletonDeterministic branch
  // never calls CONTEXT_MODEL unless SKELETON_SUMMARY=llm — yet the
  // `tagViaOnnx && genTags` branch above still unconditionally reports
  // CONTEXT_MODEL as active. This is a KNOWN, deliberate over-report,
  // not fixed here: for a MIXED collection (some skeleton files, some
  // legacy PDF/Pandoc/plain-text files in the same run), the legacy
  // files' own non-deterministic default-branch stageB call DOES call
  // CONTEXT_MODEL, and this function has no way to know from env alone
  // whether the file set is purely skeleton or mixed — only a per-file
  // resolution (threading actual chunk/file data into resource-identity,
  // a materially larger contract change than this scheduling-signal
  // function owns — see resolvePipelineResourceIdentities()'s own header
  // comment on staying env-only) could resolve that precisely.
  //
  // Practical effect of the over-report, so it isn't mistaken for a
  // correctness bug: CONTEXT_MODEL is included in the /api/ps probe set,
  // but since it was never actually loaded in this ONNX-tags-only-run
  // scenario, the probe legitimately returns "not found" for it. With
  // CONTEXT_MODEL as the only entry in the active-model list,
  // resolveGenerationResourceIdentity() treats this as the "every active
  // model unresolved" case (allUnknown, just above) — not `mixed` (that
  // bucket only applies when at least one model DID resolve while another
  // didn't) — so the result is `unknown`/unverified unless
  // GENERATION_DEVICE_OVERRIDE is explicitly set, in which case the
  // override genuinely DOES apply here and unlocks overlap. Net result:
  // this specific pure-skeleton + ONNX-tags scenario resolves
  // conservatively unverified by default and blocks otherwise-safe
  // overlap — one extra harmless /api/ps lookup, never a missed device
  // signal, never a wrong overlap decision in the dangerous direction —
  // and an operator who knows their deployment topology can already
  // unblock it today via GENERATION_DEVICE_OVERRIDE.
  //
  // When CONTEXT_MODE=deterministic IS set, deterministic context is
  // guaranteed for every file (isDeterministicContextMode short-circuits
  // before the skeleton branch is ever reached), so CONTEXT_MODEL is
  // correctly excluded there regardless.

  // Nav summaries (SKELETON_SUMMARY=llm) unconditionally add CONTEXT_MODEL.
  if (env.SKELETON_SUMMARY === 'llm') models.push(contextModel);

  return [...new Set(models)];
}

/**
 * @returns {import('../../core/generation/ollama-capability.js').OllamaResourceIdentityCapability}
 */
export function createOllamaResourceIdentityCapability() {
  // Request-scoped-in-effect /api/ps dedup: an IN-FLIGHT-ONLY cache (never
  // a resolved-value cache with any staleness window) — two concurrent
  // calls to getResourceIdentity/getEmbeddingResourceIdentity on THIS
  // instance that both need the same model+baseUrl share the one in-flight
  // Promise; the entry is removed the instant it settles (.finally()), so
  // the NEXT call always issues a fresh real request. No TTL, no manual
  // eviction, no possibility of a stale answer surviving into a later
  // round — self-clearing by construction. Fully private to this closure;
  // resolvePipelineResourceIdentities() and run.js's own recomputePolicy()
  // are completely unaware this optimization exists.
  const _inFlight = new Map(); // key: `${model}::${baseUrl}` -> Promise<{size,size_vram}|null>

  function getRunningModelDeduped(model, baseUrl) {
    const key = `${model}::${baseUrl}`;
    if (_inFlight.has(key)) return _inFlight.get(key);
    const p = Promise.resolve().then(() => getRunningModel(model, baseUrl)).catch(() => null)
      .finally(() => { _inFlight.delete(key); });
    _inFlight.set(key, p);
    return p;
  }

  async function resolveViaRunningModels(models, { baseUrl, override }) {
    if (models.length === 0) {
      return { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null };
    }
    const results = await Promise.all(models.map((model) => getRunningModelDeduped(model, baseUrl)));
    const runningModels = models.map((model, i) => {
      const r = results[i];
      return r ? { model, size: r.size, size_vram: r.size_vram } : { model, runningModel: null };
    });
    return resolveGenerationResourceIdentity({ runningModels, generationDeviceOverride: override });
  }

  // Generation identity: reports on the model set stageB will actually
  // call this run (mirrors stageB's own CONTEXT_MODEL/TAG_MODEL/
  // COMBINED_LLM/SKELETON_SUMMARY branch selection). The capability
  // resolves its OWN active-model list internally — the caller supplies
  // nothing beyond env.
  async function getResourceIdentity({ env } = {}) {
    const usedEnv = env ?? process.env;
    const models = resolveActiveGenerationModels(usedEnv);
    return resolveViaRunningModels(models, {
      baseUrl: usedEnv.OLLAMA_URL || 'http://localhost:11434',
      // GENERATION_DEVICE_OVERRIDE is a generation-only manual fallback —
      // its own settings visibleWhen already scopes it to Ollama
      // generation — never consulted by getEmbeddingResourceIdentity below.
      override: usedEnv.GENERATION_DEVICE_OVERRIDE || null,
    });
  }

  // Embedding identity: reports on ONE named model — the caller (run.js,
  // via device/embedding-resource-identity-capability.js) supplies the
  // model name, since only run.js knows the resolved embedding profile's
  // dense.model field; this capability has no independent way to discover
  // "the embedding model" the way it can self-discover "the active
  // generation models." Closes the gap where Ollama-backed embedding was
  // permanently unknown — same real /api/ps-verified signal generation
  // already gets, same underlying primitive, zero new low-level API surface.
  async function getEmbeddingResourceIdentity({ env, model } = {}) {
    const usedEnv = env ?? process.env;
    return resolveViaRunningModels(model ? [model] : [], {
      baseUrl: usedEnv.OLLAMA_URL || 'http://localhost:11434',
      override: null, // embedding never consults GENERATION_DEVICE_OVERRIDE
    });
  }

  return { getResourceIdentity, getEmbeddingResourceIdentity };
}
