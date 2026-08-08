// Device-aware bounded indexing pipeline — resource identity resolvers
// (plan: recursive-roaming-anchor.md §1). Pure, dependency-free: no
// imports of local/core/*, no I/O, no direct process.env reads inside
// the resolver functions themselves — every resolver takes plain
// data/env-shaped input and returns a ResourceIdentity, never throws.
// Keeps this module usable from both Full and Lite compositions and
// trivially unit-testable.
//
// The one async function in this file, buildResourceIdentityInputs(),
// is the single place real I/O (the Ollama /api/ps calls, via the
// injected OllamaDiscoveryCapability) is sequenced — everything else
// here is synchronous.

/**
 * @typedef {Object} ResourceIdentity
 * @property {'cpu'|'gpu'|'mixed'|'remote'|'unknown'} kind
 * @property {string} backend
 * @property {string|null} deviceId
 * @property {boolean} verified
 * @property {'ollama-api'|'onnx-runtime'|'manual'|'structural'|null} source
 */

// VRAM classification tolerance for Ollama's /api/ps size/size_vram
// ratio — a tuning constant (plan §11), not a correctness one. Real
// VRAM accounting can carry small non-zero overhead even for a fully
// CPU-resident model, so 0 would be too strict.
const VRAM_TOLERANCE_BYTES = 64 * 1024 * 1024;

/**
 * @param {{
 *   onnxExecutionProvider?: string,
 *   onnxProviderState?: {requested:string, effective:string, fellBackToCpu:boolean}|null,
 *   denseExecution?: 'client'|'qdrant-cluster'|'qdrant-cloud',
 *   denseProvider?: string,
 * }} input
 * @returns {ResourceIdentity}
 */
export function resolveEmbeddingResourceIdentity({ onnxExecutionProvider, onnxProviderState, denseExecution, denseProvider } = {}) {
  // Server-side execution (Qdrant Cloud inference, or a future
  // Qdrant-cluster-side compute lane) does zero local CPU/GPU work for
  // this process — it is a real, independent (network) resource, always
  // safe to overlap with local generation. This must be checked BEFORE
  // the ONNX-shaped branches below: a collection embedding via Qdrant
  // Cloud has no onnxProviderState/onnxExecutionProvider concept at all,
  // and must never be silently misclassified as onnx-cpu (the resolver's
  // previous default) just because those fields are absent/unset.
  if (denseExecution && denseExecution !== 'client') {
    return { kind: 'remote', backend: `qdrant-${denseExecution === 'qdrant-cloud' ? 'cloud' : 'cluster'}`, deviceId: null, verified: true, source: 'manual' };
  }
  // Client-execution dense provider 'ollama' is a local Ollama HTTP call,
  // not ONNX — a genuinely different resource than the ONNX branches
  // below (and structurally the SAME physical resource as generation
  // itself, when both go through the same Ollama instance). Treat as
  // unknown rather than guessing a device: this resolver has no /api/ps
  // signal for it (that machinery is generation-specific, keyed by
  // model name, not "the embedding model"), so honestly reporting
  // unknown (-> conservative sequential) is correct until a real signal
  // is added, rather than silently reusing the ONNX classification below
  // for a request that never touches ONNX at all.
  if (denseProvider === 'ollama') {
    return { kind: 'unknown', backend: 'ollama', deviceId: null, verified: false, source: null };
  }

  if (onnxProviderState) {
    const { effective } = onnxProviderState;
    if (effective === 'cpu') {
      return { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: true, source: 'onnx-runtime' };
    }
    if (effective === 'dml') {
      // DirectML has no stable enumerable device id via this API —
      // deviceId:null is honest, not a fabricated '0'.
      return { kind: 'gpu', backend: 'onnx-dml', deviceId: null, verified: true, source: 'onnx-runtime' };
    }
    if (effective === 'cuda') {
      // The current CUDA integration is always single-device — no
      // multi-GPU device-index selection exists anywhere in the
      // codebase today. 'cuda:0' asserts only "the one CUDA device
      // this process can see," not a real multi-device enumeration —
      // a future multi-GPU feature must not read this as a real index.
      return { kind: 'gpu', backend: 'onnx-cuda', deviceId: 'cuda:0', verified: true, source: 'onnx-runtime' };
    }
    // Unrecognized effective value — fall through to the settings-intent path below.
  }

  const val = (onnxExecutionProvider ?? '').trim().toLowerCase();
  if (val === 'dml') return { kind: 'gpu', backend: 'onnx-dml', deviceId: null, verified: false, source: 'manual' };
  if (val === 'cuda') return { kind: 'gpu', backend: 'onnx-cuda', deviceId: null, verified: false, source: 'manual' };
  // '', 'cpu', or anything unrecognized — resolveOnnxExecutionProviders()'s own default is 'cpu'.
  return { kind: 'cpu', backend: 'onnx-cpu', deviceId: null, verified: false, source: 'manual' };
}

/**
 * @param {{ active: boolean }} input
 * @returns {ResourceIdentity}
 */
export function resolveTagOnnxResourceIdentity({ active } = {}) {
  if (!active) return { kind: 'unknown', backend: 'unknown', deviceId: null, verified: false, source: null };
  // verified:true here is honest: tag-onnx.js's own worker has no
  // execution-provider concept at all — no code path in that module
  // can ever run on GPU. This is a structural fact, not a probed value.
  return { kind: 'cpu', backend: 'onnx-unknown', deviceId: null, verified: true, source: 'structural' };
}

/**
 * Classifies one Ollama /api/ps result by its VRAM placement ratio —
 * the same signal `ollama ps`'s own PROCESSOR column is built from.
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
 * @returns {ResourceIdentity}
 */
export function resolveGenerationResourceIdentity({ runningModels, generationDeviceOverride = null } = {}) {
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
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function resolveActiveGenerationModels(env) {
  const contextModel = env.CONTEXT_MODEL || 'gemma3:4b';
  const tagModel = env.TAG_MODEL || env.CONTEXT_MODEL || 'gemma3:4b';
  const combinedEnabled = env.COMBINED_LLM === '1';
  const genTags = env.TAG_GEN === '1';
  const tagViaOnnx = env.TAG_PROVIDER === 'onnx';
  const deterministicContext = env.CONTEXT_MODE === 'deterministic';

  const models = [];

  if (combinedEnabled) {
    // COMBINED_LLM=1: single model for both context+tags — TAG_MODEL
    // is explicitly ignored in this mode (doctor-checks.js's own logic).
    models.push(contextModel);
  } else if (deterministicContext) {
    // CONTEXT_MODE=deterministic: context itself never calls Ollama.
    // Tags still run normally if enabled and not ONNX-routed.
    if (genTags && !tagViaOnnx) models.push(tagModel);
  } else if (tagViaOnnx && genTags) {
    // ONNX-parallel branch: tags go to ONNX, only context calls Ollama.
    models.push(contextModel);
  } else {
    // Plain default branch (also covers the skeleton-deterministic
    // per-file case conservatively — see module header note below):
    // context always calls Ollama; tags call Ollama too unless ONNX-routed.
    models.push(contextModel);
    if (genTags && !tagViaOnnx) models.push(tagModel);
  }

  // Skeleton-deterministic chunk shape is a per-file, data-dependent
  // fact this env-only function cannot know in advance — for a mixed
  // collection (some skeleton files, some legacy files), the
  // non-deterministic default branch's CONTEXT_MODEL call may still be
  // reachable even when CONTEXT_MODE=deterministic is unset. That case
  // is already covered by the `else` branch above. When
  // CONTEXT_MODE=deterministic IS set, deterministic context is
  // guaranteed for every file (isDeterministicContextMode short-circuits
  // before the skeleton branch is ever reached), so CONTEXT_MODEL is
  // correctly excluded there.

  // Nav summaries (SKELETON_SUMMARY=llm) unconditionally add CONTEXT_MODEL.
  if (env.SKELETON_SUMMARY === 'llm') models.push(contextModel);

  return [...new Set(models)];
}

/**
 * The one place process.env and real network calls (via the injected
 * OllamaDiscoveryCapability) are touched — sequences the per-model
 * /api/ps lookups and shapes the result for resolveGenerationResourceIdentity.
 *
 * getRunningModel() is DOCUMENTED (local/core/ollama.js) to never throw —
 * but that contract is only as strong as every implementation of
 * OllamaDiscoveryCapability actually honoring it, and at least one real
 * composition does not: Semidex Lite's unavailableOllamaCapability()
 * (indexer/index-lite.js) throws for EVERY method, including
 * getRunningModel, by design (there is no local Ollama in Lite at all).
 * A run whose env happens to make resolveActiveGenerationModels(env)
 * non-empty in that composition (e.g. SKELETON_SUMMARY=llm set directly
 * via env, bypassing the settings-UI exclusion, which is a write-policy
 * guard, not a runtime guard) would otherwise have this reject and take
 * the whole indexing run down before stageB ever runs — a scheduling
 * signal must never be able to do that. Each call is therefore wrapped
 * defensively: a rejected/throwing getRunningModel() is treated exactly
 * like its own documented null return (this model's placement is simply
 * unverifiable), never propagated.
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   onnxProviderState: {requested:string, effective:string, fellBackToCpu:boolean} | null,
 *   taggingActive: boolean,
 *   ollamaDiscovery: import('../../../core/generation/ollama-capability.js').OllamaDiscoveryCapability | null,
 *   denseExecution?: 'client'|'qdrant-cluster'|'qdrant-cloud',
 *   denseProvider?: string,
 * }} input
 * @returns {Promise<{ generation: ResourceIdentity, embedding: ResourceIdentity, tagging: ResourceIdentity }>}
 */
export async function buildResourceIdentityInputs({ env, onnxProviderState, taggingActive, ollamaDiscovery, denseExecution, denseProvider }) {
  const embedding = resolveEmbeddingResourceIdentity({
    onnxExecutionProvider: env.ONNX_EXECUTION_PROVIDER,
    onnxProviderState,
    denseExecution,
    denseProvider,
  });
  const tagging = resolveTagOnnxResourceIdentity({ active: taggingActive });

  const activeModels = resolveActiveGenerationModels(env);
  let runningModels = [];
  if (activeModels.length > 0 && ollamaDiscovery) {
    const baseUrl = env.OLLAMA_URL || 'http://localhost:11434';
    // Promise.resolve().then(() => ...) — NOT
    // ollamaDiscovery.getRunningModel(...).catch(...) — because the
    // latter requires the call to already have returned a Promise
    // before .catch() can attach. A capability implementation that
    // throws SYNCHRONOUSLY (a plain function, not declared `async`, or
    // any code path that throws before its own `async` boundary is
    // reached) would escape .catch() entirely and crash this whole
    // function, and by extension recomputePolicy() and the run. Routing
    // the call through an already-settled Promise's .then() guarantees
    // the call happens inside a Promise executor, so ANY throw —
    // synchronous or asynchronous — becomes a normal rejection this
    // module's own .catch() below can see.
    const results = await Promise.all(
      activeModels.map((model) =>
        Promise.resolve().then(() => ollamaDiscovery.getRunningModel(model, baseUrl)).catch(() => null)
      )
    );
    runningModels = activeModels.map((model, i) => {
      const r = results[i];
      return r ? { model, size: r.size, size_vram: r.size_vram } : { model, runningModel: null };
    });
  }

  const generation = resolveGenerationResourceIdentity({
    runningModels,
    generationDeviceOverride: env.GENERATION_DEVICE_OVERRIDE || null,
  });

  return { generation, embedding, tagging };
}
