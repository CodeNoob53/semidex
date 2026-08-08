// Typed settings definitions — the single source of truth for every
// exposed runtime setting's key/category/type/default/validation/env
// mapping/application-timing/reindex-or-backfill impact. Pure data, no I/O.
// src/core/settings/service.js is the only module that resolves/writes
// values against these definitions; consuming modules (chunk.js, rerank.js,
// etc.) call the shared SettingsService, never this file directly, so a
// definition change here is felt everywhere at once — this is what makes
// the registry a real source of truth rather than a display-only copy.
//
// parseExternal(raw): converts an always-string env/dotenv value into the
//   field's real type, preserving each field's pre-existing invalid-value
//   fallback+warning behavior verbatim (same message text/prefix the
//   original envInt/envFloat/envEnum call already used).
// validate(value): validates an already-typed value (from settings.json or
//   a PATCH body) — returns { ok: true } or { ok: false, error }.
// serialize(value): value -> JSON-safe value for settings.json (identity
//   for every current type; exists as one place to extend later).

import { ONNX_DENSE_MODEL_ID } from '../../shared/core/onnx-paths.js';
import { QDRANT_CLOUD_DENSE_MODELS, QDRANT_CLOUD_SPARSE_MODELS, findDenseModel } from '../embedding-profile/qdrant-cloud-models.js';

function warnInvalid(prefix, name, raw, fallback) {
  console.warn(`${prefix}${name}="${raw}" is invalid — using default ${fallback}`);
}

function intField({ envVar, defaultVal, min, max, warnPrefix = '' }) {
  return {
    default: defaultVal,
    min,
    max,
    parseExternal(raw) {
      const v = parseInt(raw ?? '', 10);
      if (!Number.isFinite(v) || v < min || v > max) {
        if (raw !== undefined) warnInvalid(warnPrefix, envVar, raw, defaultVal);
        return defaultVal;
      }
      return v;
    },
    validate(value) {
      if (!Number.isInteger(value) || value < min || value > max) {
        return { ok: false, error: `${envVar} must be an integer between ${min} and ${max}.` };
      }
      return { ok: true };
    },
    serialize: (value) => value,
  };
}

function floatField({ envVar, defaultVal, min, max, warnPrefix = '' }) {
  return {
    default: defaultVal,
    min,
    max,
    parseExternal(raw) {
      const v = parseFloat(raw ?? '');
      if (!Number.isFinite(v) || v < min || v > max) {
        if (raw !== undefined) warnInvalid(warnPrefix, envVar, raw, defaultVal);
        return defaultVal;
      }
      return v;
    },
    validate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        return { ok: false, error: `${envVar} must be a number between ${min} and ${max}.` };
      }
      return { ok: true };
    },
    serialize: (value) => value,
  };
}

function boolField({ envVar, defaultVal }) {
  return {
    default: defaultVal,
    parseExternal(raw) {
      if (raw === undefined) return defaultVal;
      return raw === '1' || raw === 'true';
    },
    validate(value) {
      if (typeof value !== 'boolean') return { ok: false, error: `${envVar} must be a boolean.` };
      return { ok: true };
    },
    serialize: (value) => value,
  };
}

function stringField({ envVar, defaultVal, allowEmpty = false }) {
  return {
    default: defaultVal,
    allowEmpty,
    parseExternal(raw) {
      if (raw === undefined || raw === '') return defaultVal;
      return raw;
    },
    validate(value) {
      if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
        return { ok: false, error: `${envVar} must be a non-empty string.` };
      }
      return { ok: true };
    },
    serialize: (value) => value,
  };
}

function enumField({ envVar, defaultVal, allowed, warnPrefix = '' }) {
  return {
    default: defaultVal,
    options: allowed.map((value) => ({ value, label: value })),
    parseExternal(raw) {
      if (raw === undefined) return defaultVal;
      if (!allowed.includes(raw)) {
        warnInvalid(warnPrefix, envVar, raw, defaultVal);
        return defaultVal;
      }
      return raw;
    },
    validate(value) {
      if (!allowed.includes(value)) {
        return { ok: false, error: `${envVar} must be one of: ${allowed.join(', ')}.` };
      }
      return { ok: true };
    },
    serialize: (value) => value,
  };
}

// key -> { category, label, type, envVar, secret, appliesAt, requiresReindex,
//          requiresBackfill, readOnlyReason, ...typeHelperFields }
export const DEFINITIONS = {
  // ── indexing (chunking + skeleton) ────────────────────────────────────
  MAX_CHUNK_TOKENS: {
    category: 'indexing', label: 'Max chunk tokens', type: 'number', envVar: 'MAX_CHUNK_TOKENS',
    description: 'Maximum tokens per chunk before splitting.', advanced: false,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...intField({ envVar: 'MAX_CHUNK_TOKENS', defaultVal: 512, min: 1, max: 100000, warnPrefix: '[chunk] ' }),
  },
  MIN_CHUNK_TOKENS: {
    category: 'indexing', label: 'Min chunk tokens', type: 'number', envVar: 'MIN_CHUNK_TOKENS',
    description: 'Minimum tokens per chunk before merging with a neighbor.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...intField({ envVar: 'MIN_CHUNK_TOKENS', defaultVal: 160, min: 0, max: 100000, warnPrefix: '[chunk] ' }),
  },
  CHUNK_OVERLAP_TOKENS: {
    category: 'indexing', label: 'Chunk overlap tokens', type: 'number', envVar: 'CHUNK_OVERLAP_TOKENS',
    description: 'Number of tokens repeated between adjacent chunks for context continuity.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...intField({ envVar: 'CHUNK_OVERLAP_TOKENS', defaultVal: 80, min: 0, max: 100000, warnPrefix: '[chunk] ' }),
  },
  OVERLAP_SENTENCES: {
    category: 'indexing', label: 'Overlap sentences (legacy)', type: 'number', envVar: 'OVERLAP_SENTENCES',
    description: 'Legacy sentence-based overlap count, used only by the older chunking path.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...intField({ envVar: 'OVERLAP_SENTENCES', defaultVal: 2, min: 0, max: 100, warnPrefix: '[chunk] ' }),
  },
  LLM_BATCH_SIZE: {
    category: 'indexing', label: 'LLM batch size', type: 'number', envVar: 'LLM_BATCH_SIZE',
    description: 'Number of chunks processed together per LLM call during indexing.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'LLM_BATCH_SIZE', defaultVal: 3, min: 1, max: 64, warnPrefix: '[indexer] ' }),
  },
  // SKELETON_CHUNKING, SKELETON_NAV, and SKELETON_CONTEXT were removed —
  // skeleton-first chunking, navigation-point generation, and deterministic
  // structural context are now unconditional architecture for Markdown, not
  // configurable behavior. See docs/skeleton-first-production-invariant-*.md.
  SKELETON_SUMMARY: {
    category: 'indexing', label: 'Skeleton summary mode', type: 'enum', envVar: 'SKELETON_SUMMARY',
    description: 'How skeleton node summaries are generated: deterministic rules or an LLM pass.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...enumField({ envVar: 'SKELETON_SUMMARY', defaultVal: 'deterministic', allowed: ['deterministic', 'llm'], warnPrefix: '[indexer] ' }),
  },
  SKELETON_CARRYOVER_CHARS: {
    category: 'indexing', label: 'Skeleton carryover chars', type: 'number', envVar: 'SKELETON_CARRYOVER_CHARS',
    description: 'Maximum characters of trailing context carried over between skeleton sections.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...intField({ envVar: 'SKELETON_CARRYOVER_CHARS', defaultVal: 500, min: 0, max: 100000, warnPrefix: '[skeleton-chunk] ' }),
  },
  SUMMARY_LANG: {
    category: 'indexing', label: 'Summary language override', type: 'string', envVar: 'SUMMARY_LANG',
    description: 'Force generated summaries to a specific language, or "auto" to detect from content.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...stringField({ envVar: 'SUMMARY_LANG', defaultVal: 'auto', allowEmpty: false }),
  },

  // ── ai (generation / tagging) ──────────────────────────────────────────
  TAG_GEN: {
    category: 'ai', label: 'Generate tags', type: 'boolean', envVar: 'TAG_GEN',
    description: 'Generate topical tags for each chunk during indexing.', advanced: false,
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: true,
    ...boolField({ envVar: 'TAG_GEN', defaultVal: false }),
  },
  TAG_PROVIDER: {
    category: 'ai', label: 'Tag provider', type: 'enum', envVar: 'TAG_PROVIDER',
    description: 'Model backend used to generate tags: Ollama or a local ONNX model.', advanced: false,
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: true,
    ...enumField({ envVar: 'TAG_PROVIDER', defaultVal: 'ollama', allowed: ['ollama', 'onnx'], warnPrefix: '[tag] ' }),
  },
  TAG_MODEL: {
    category: 'ai', label: 'Tag model', type: 'string', envVar: 'TAG_MODEL',
    description: 'Ollama model name used for tag generation.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: true,
    visibleWhen: { key: 'TAG_PROVIDER', equals: 'ollama' },
    dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    ...stringField({ envVar: 'TAG_MODEL', defaultVal: 'gemma3:4b' }),
  },
  TAG_ONNX_MODEL: {
    category: 'ai', label: 'ONNX tag model', type: 'string', envVar: 'TAG_ONNX_MODEL',
    description: 'ONNX model identifier used for tag generation when the ONNX provider is selected.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: true,
    visibleWhen: { key: 'TAG_PROVIDER', equals: 'onnx' },
    ...stringField({ envVar: 'TAG_ONNX_MODEL', defaultVal: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct' }),
  },
  TAG_ONNX_THREADS: {
    category: 'ai', label: 'ONNX tag worker threads', type: 'number', envVar: 'TAG_ONNX_THREADS',
    description: 'Number of CPU threads used by the ONNX tag worker.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    visibleWhen: { key: 'TAG_PROVIDER', equals: 'onnx' },
    ...intField({ envVar: 'TAG_ONNX_THREADS', defaultVal: 1, min: 1, max: 64, warnPrefix: '[tag-onnx] ' }),
  },
  TAG_ONNX_ALLOW_DOWNLOAD: {
    category: 'ai', label: 'Allow ONNX tag model download', type: 'boolean', envVar: 'TAG_ONNX_ALLOW_DOWNLOAD',
    description: 'Allow automatically downloading the ONNX tag model if it is not already cached locally.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    visibleWhen: { key: 'TAG_PROVIDER', equals: 'onnx' },
    ...boolField({ envVar: 'TAG_ONNX_ALLOW_DOWNLOAD', defaultVal: false }),
  },

  // ── ai (generation) ─────────────────────────────────────────────────────
  SEMIDEX_GENERATION_BACKEND: {
    category: 'ai', label: 'Generation backend', type: 'enum', envVar: 'SEMIDEX_GENERATION_BACKEND',
    description: 'The generation backend semidex uses for Ask answers: a local Ollama model or the Gemini API.', advanced: false,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'SEMIDEX_GENERATION_BACKEND', defaultVal: 'ollama', allowed: ['ollama', 'gemini'] }),
  },
  // ASK_MODEL's valid values come from whichever backend is currently
  // selected — 'generation_models' (not the Ollama-only 'ollama_models'
  // source TAG_MODEL/CONTEXT_MODEL/EMBED_MODEL still use) tells the UI to
  // resolve options against GET /api/generation/models?backend=<the
  // CURRENTLY STAGED SEMIDEX_GENERATION_BACKEND value>, re-fetching and
  // re-rendering whenever the staged backend changes — so an Ollama model
  // name can never silently pass as configured for Gemini or vice versa
  // (task requirement). See global-settings-view.js's isFieldVisible/
  // dynamicOptions handling for the resolution logic.
  ASK_MODEL: {
    category: 'ai', label: 'Ask answer model', type: 'string', envVar: 'ASK_MODEL',
    description: 'Model used to generate answers for the Ask feature. Available models depend on the selected generation backend.', advanced: false,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    dynamicOptions: { source: 'generation_models', capability: 'generation' },
    ...stringField({ envVar: 'ASK_MODEL', defaultVal: 'gemma3:4b' }),
  },
  ASK_NUM_CTX: {
    category: 'ai', label: 'Ask context size', type: 'number', envVar: 'ASK_NUM_CTX',
    description: 'Context window size (tokens) requested from the model for Ask answers. Capped by the provider model’s real input-token limit when known.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'ASK_NUM_CTX', defaultVal: 8192, min: 256, max: 1_000_000 }),
  },
  OLLAMA_URL: {
    category: 'ai', label: 'Ollama URL', type: 'string', envVar: 'OLLAMA_URL',
    description: 'Base URL of the Ollama server used for generation and tagging.', advanced: false,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    // Ollama-only concept — a cloud API has no local base URL. Hidden from
    // the UI entirely when SEMIDEX_GENERATION_BACKEND=gemini (task: "show
    // Ollama URL only for Ollama"). Still independently readable/writable
    // via direct PATCH regardless of backend — TAG_MODEL/CONTEXT_MODEL/
    // EMBED_MODEL discovery all still depend on it even when Ask itself
    // runs on Gemini, so it must never become read-only or disappear from
    // settings.json, only from this one field's own visibility.
    visibleWhen: { key: 'SEMIDEX_GENERATION_BACKEND', equals: 'ollama' },
    ...stringField({ envVar: 'OLLAMA_URL', defaultVal: 'http://localhost:11434' }),
  },
  GENERATION_DEVICE: {
    category: 'ai', label: 'Generation device policy', type: 'enum', envVar: 'GENERATION_DEVICE',
    description: 'Hardware device policy for local generation. Currently only automatic selection is supported.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    // Local-inference-only concept — no meaning for a cloud API. Hidden for
    // Gemini (task: "hide local generation device controls for Gemini").
    visibleWhen: { key: 'SEMIDEX_GENERATION_BACKEND', equals: 'ollama' },
    ...enumField({ envVar: 'GENERATION_DEVICE', defaultVal: 'auto', allowed: ['auto'] }),
  },
  GEMINI_API_KEY: {
    category: 'ai', label: 'Gemini API key', type: 'secret', envVar: 'GEMINI_API_KEY',
    description: 'API key used to authenticate with the Gemini API. Environment-only — never persisted or displayed.', advanced: false,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    writable: false, secret: true, readOnlyReason: 'Secrets are environment-only and never persisted or displayed.',
    visibleWhen: { key: 'SEMIDEX_GENERATION_BACKEND', equals: 'gemini' },
    default: undefined,
    parseExternal(raw) { return raw; },
    validate() { return { ok: false, error: 'GEMINI_API_KEY is a secret and cannot be written.' }; },
    serialize: (value) => value,
  },
  CONTEXT_MODEL: {
    category: 'ai', label: 'Context generation model', type: 'string', envVar: 'CONTEXT_MODEL',
    description: 'Ollama model name used to generate chunk context summaries during indexing.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    dynamicOptions: { source: 'ollama_models', capability: 'generation' },
    ...stringField({ envVar: 'CONTEXT_MODEL', defaultVal: 'gemma3:4b' }),
  },
  // CONTEXT_MODE=deterministic skips the per-chunk LLM context call
  // entirely for legacy (non-skeleton — PDF/Pandoc/plain-text) chunks,
  // building context from source_file/section instead (zero Ollama calls).
  // Skeleton (Markdown) chunks already always use deterministic context
  // regardless of this setting. Default 'llm' preserves today's behavior;
  // Semidex Lite pins 'deterministic' so cloud-only indexing never
  // contacts a local Ollama server.
  CONTEXT_MODE: {
    category: 'ai', label: 'Legacy chunk context mode', type: 'enum', envVar: 'CONTEXT_MODE',
    description: 'How context is generated for legacy (non-Markdown) chunks: an LLM call (Ollama) or deterministic heading/section text with zero LLM calls.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...enumField({ envVar: 'CONTEXT_MODE', defaultVal: 'llm', allowed: ['llm', 'deterministic'] }),
  },
  COMBINED_LLM: {
    category: 'ai', label: 'Combined context+tags LLM pass', type: 'boolean', envVar: 'COMBINED_LLM',
    description: 'Generate chunk context and tags in a single combined LLM call instead of two separate calls.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...boolField({ envVar: 'COMBINED_LLM', defaultVal: false }),
  },
  // Last-resort fallback ONLY for the device-aware bounded indexing
  // pipeline's generation resource identity (shared/indexer/device/
  // resource-identity.js) — the primary signal is a real, verified read
  // of Ollama's GET /api/ps (size/size_vram VRAM placement). This override
  // is consulted ONLY when that real signal is unavailable for EVERY
  // active model (model not yet loaded — typically the first file of a
  // run — /api/ps unreachable, or the model was idle-unloaded); the
  // instant even one active model resolves a real signal, this override
  // is never consulted at all — a real read always wins over it, never
  // the reverse. When it IS consulted, it is treated as an explicit,
  // informed operator assertion — verified:true, but source:'manual'
  // forever (never upgraded to look like a real 'ollama-api' read in any
  // diagnostic/log) — so it genuinely CAN unlock generation/embedding
  // overlap starting from file 1, at the operator's own risk of a wrong
  // overlap decision if the claim about where Ollama actually runs turns
  // out to be incorrect. Distinct from the pre-existing GENERATION_DEVICE
  // field, which governs Ask/query-time generation backend policy, not
  // indexing-time scheduling.
  GENERATION_DEVICE_OVERRIDE: {
    category: 'ai', label: 'Generation device override (indexing)', type: 'enum', envVar: 'GENERATION_DEVICE_OVERRIDE',
    description: 'Manual, explicit assertion of where the Ollama generation model runs (CPU/GPU), used by the indexer\'s device-aware scheduler ONLY when Ollama\'s real VRAM placement cannot yet be verified (e.g. the first file of a run). A real verified signal always takes priority over this setting; setting this can unlock generation/embedding overlap before a real signal exists, at your own risk if the assertion is wrong.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    visibleWhen: { key: 'SEMIDEX_GENERATION_BACKEND', equals: 'ollama' },
    ...enumField({ envVar: 'GENERATION_DEVICE_OVERRIDE', defaultVal: 'unknown', allowed: ['unknown', 'cpu', 'gpu'] }),
  },

  // ── embeddings & hardware ───────────────────────────────────────────────
  // EMBEDDING_BACKEND is a synthetic, derived field — not env-backed (no
  // envVar, no settings.json key of its own). Its configuredValue/
  // activeValue/source are resolved by the same shared provider resolver as
  // the indexer, including the legacy ONNX_EMBED shorthand. A PATCH to this
  // key is expanded into a combined DENSE_PROVIDER+SPARSE_PROVIDER write
  // before the normal validate/write loop runs (see service.js's setMany()).
  // This makes an invalid dense/sparse combination unreachable through this
  // UI-facing control; direct writes to the underlying keys are also
  // cross-validated by the service.
  EMBEDDING_BACKEND: {
    category: 'embeddings', label: 'Embedding backend', type: 'enum',
    description: 'Which embedding provider is used for new collections. Determines dense and sparse vector generation together.',
    advanced: false, appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    options: [
      { value: 'ollama', label: 'Ollama' },
      { value: 'bge-m3-onnx', label: 'BGE-M3 (ONNX)' },
      { value: 'qdrant-cloud', label: 'Qdrant Cloud Inference' },
    ],
    default: 'ollama',
    parseExternal() { throw new Error('EMBEDDING_BACKEND is derived, not env-backed.'); },
    validate(value) {
      return ['ollama', 'bge-m3-onnx', 'qdrant-cloud'].includes(value)
        ? { ok: true }
        : { ok: false, error: 'EMBEDDING_BACKEND must be "ollama", "bge-m3-onnx", or "qdrant-cloud".' };
    },
    serialize: (value) => value,
  },
  EMBED_MODEL: {
    category: 'embeddings', label: 'Embedding model (Ollama)', type: 'string', envVar: 'EMBED_MODEL',
    description: 'Ollama model name used to generate embeddings for new collections.', advanced: false,
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'ollama' },
    dynamicOptions: { source: 'ollama_models', capability: 'embedding' },
    ...stringField({ envVar: 'EMBED_MODEL', defaultVal: 'bge-m3' }),
  },
  DENSE_MODEL: {
    category: 'embeddings', label: 'Dense model', type: 'string', envVar: 'DENSE_MODEL',
    description: 'Model identifier used for dense embeddings when the ONNX provider is selected.', advanced: true,
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
    derivedWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx', value: ONNX_DENSE_MODEL_ID },
    ...stringField({ envVar: 'DENSE_MODEL', defaultVal: 'bge-m3' }),
  },
  // Static catalog-backed selector (src/cloud/embedding/qdrant-cloud-catalog.js)
  // — NOT dynamicOptions/live discovery. No model-discovery API exists for
  // Qdrant Cloud Inference (a confirmed spike finding); pretending a static
  // list is live discovery would misrepresent what this control actually
  // does. Options are filtered to status:'supported' only — a
  // status:'planned' entry (e.g. mxbai/embed-large, dedicated-cluster-tier
  // gated) is EXCLUDED from options entirely (never offered as a
  // selectable choice) rather than shown-disabled, since it is not a real
  // choice for a free-tier cluster today.
  QDRANT_CLOUD_DENSE_MODEL: {
    category: 'embeddings', label: 'Dense model (Qdrant Cloud)', type: 'enum', envVar: 'QDRANT_CLOUD_DENSE_MODEL',
    description: 'Qdrant Cloud Inference dense embedding model used for new collections.', advanced: false,
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' },
    options: QDRANT_CLOUD_DENSE_MODELS
      .filter((m) => m.status === 'supported')
      .map((m) => ({ value: m.id, label: `${m.displayName} (${m.dimensions}d, ${m.contextWindow} tokens)` })),
    default: QDRANT_CLOUD_DENSE_MODELS.find((m) => m.status === 'supported')?.id ?? null,
    ...stringField({ envVar: 'QDRANT_CLOUD_DENSE_MODEL', defaultVal: QDRANT_CLOUD_DENSE_MODELS.find((m) => m.status === 'supported')?.id ?? '' }),
  },
  // Read-only — exactly one sparse model has status:'supported' today
  // (BM25); a second real, live-verified model (SPLADE++) exists in the
  // catalog but is status:'planned' (dedicated-cluster-tier gated, no
  // per-cluster tier detection yet — see qdrant-cloud-models.js's own
  // comment). Filtered by status, NEVER by array position/index — a
  // positional QDRANT_CLOUD_SPARSE_MODELS[0] lookup would silently break
  // (or silently return a non-supported model) the moment the catalog's
  // ordering changes, which is exactly what adding the SPLADE entry above
  // this one in a future edit could do. This field auto-upgrades to a real
  // writable enum selector (mirroring QDRANT_CLOUD_DENSE_MODEL above) the
  // moment a second status:'supported' entry exists — flipping `writable`
  // to `true` and adding an `options` list here is the ONLY change needed;
  // fieldRow()'s UI dispatch (global-settings-view.js) already prioritizes
  // `writable` over `derivedWhen` generically.
  QDRANT_SPARSE_MODEL: {
    category: 'embeddings', label: 'Sparse model (Qdrant Cloud)', type: 'string', envVar: 'QDRANT_SPARSE_MODEL',
    description: 'Qdrant Cloud Inference sparse model. BM25 is currently the only sparse model supported by this Semidex build.', advanced: true,
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' },
    derivedWhen: {
      key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud',
      value: QDRANT_CLOUD_SPARSE_MODELS.find((m) => m.status === 'supported')?.id ?? null,
    },
    writable: false,
    readOnlyReason: 'BM25 is currently the only sparse model supported by this Semidex build.',
    ...stringField({
      envVar: 'QDRANT_SPARSE_MODEL',
      defaultVal: QDRANT_CLOUD_SPARSE_MODELS.find((m) => m.status === 'supported')?.id ?? '',
    }),
  },
  VECTOR_SIZE: {
    category: 'embeddings', label: 'Vector size', type: 'number', envVar: 'VECTOR_SIZE',
    description: 'Detected output dimensionality of the selected embedding model.', advanced: true,
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    derivedWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx', value: 1024 },
    dynamicDerived: {
      key: 'EMBEDDING_BACKEND',
      equals: 'ollama',
      source: 'ollama_models',
      modelKey: 'EMBED_MODEL',
      property: 'embeddingDimension',
    },
    // catalogDerived: a third data source for VECTOR_SIZE's read-only
    // rendering path (global-settings-view.js's fieldRow()), alongside the
    // existing derivedWhen/dynamicDerived cases above — dimensions are
    // looked up from the STATIC catalog by the staged QDRANT_CLOUD_DENSE_MODEL
    // value, never probed live (fixed per model ID, no network call needed).
    catalogDerived: {
      key: 'EMBEDDING_BACKEND',
      equals: 'qdrant-cloud',
      modelKey: 'QDRANT_CLOUD_DENSE_MODEL',
      lookup: (modelId) => findDenseModel(modelId)?.dimensions ?? null,
    },
    writable: false,
    readOnlyReason: 'Detected from the embedding model; it cannot be entered manually.',
    ...intField({ envVar: 'VECTOR_SIZE', defaultVal: 1024, min: 1, max: 100000 }),
  },
  // DENSE_PROVIDER/SPARSE_PROVIDER stay uiHidden — EMBEDDING_BACKEND is the
  // one user-facing control that expands to both together (see
  // service.js's setMany() combined write). Showing them separately would
  // be exactly the kind of raw internal field the redesign is meant to
  // remove, and would let a user create an invalid dense/sparse
  // combination that EMBEDDING_BACKEND's own validation prevents.
  DENSE_PROVIDER: {
    category: 'embeddings', label: 'Dense provider', type: 'enum', envVar: 'DENSE_PROVIDER',
    description: 'Backend used to compute dense embedding vectors for new collections. Internal compatibility key — use "Embedding backend" instead.',
    advanced: true, uiHidden: true,
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'DENSE_PROVIDER', defaultVal: 'ollama', allowed: ['ollama', 'bge-m3-onnx', 'qdrant-cloud'] }),
  },
  SPARSE_PROVIDER: {
    category: 'embeddings', label: 'Sparse provider', type: 'enum', envVar: 'SPARSE_PROVIDER',
    description: 'Backend used to compute sparse embedding vectors for new collections. Internal compatibility key — use "Embedding backend" instead.',
    advanced: true, uiHidden: true,
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'SPARSE_PROVIDER', defaultVal: 'hashed-tf', allowed: ['hashed-tf', 'bge-m3-onnx', 'qdrant-cloud'] }),
  },
  ONNX_EXECUTION_PROVIDER: {
    category: 'embeddings', label: 'ONNX execution provider', type: 'enum', envVar: 'ONNX_EXECUTION_PROVIDER',
    description: 'Hardware execution provider used for local ONNX embedding models. Selecting a value here configures it — it does not by itself prove that provider is actually loading. Use the Admin CUDA probe ("Test CUDA configuration") or npm run doctor to verify the effective provider.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
    ...enumField({ envVar: 'ONNX_EXECUTION_PROVIDER', defaultVal: 'cpu', allowed: ['cpu', 'dml', 'cuda'] }),
  },
  // DML-only: production batching (local/core/onnx-embed.js's embedOnnxBatch())
  // is used by the indexer only for the dml provider today — cpu/cuda both
  // process one item at a time in the current implementation, so this
  // field has no effect for them and would be misleading to show.
  ONNX_BATCH_SIZE: {
    category: 'embeddings', label: 'ONNX batch size', type: 'number', envVar: 'ONNX_BATCH_SIZE',
    description: 'Number of chunks embedded together per ONNX batch during indexing. Only used for the DirectML (dml) execution provider.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    visibleWhen: [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'dml' },
    ],
    ...intField({ envVar: 'ONNX_BATCH_SIZE', defaultVal: 4, min: 1, max: 64, warnPrefix: '[onnx] ' }),
  },
  // CUDA-only: this setting has no effect unless CUDA is the requested
  // execution provider (local/core/onnx-embed.js's strict-mode branch only runs
  // when providers[0] === 'cuda') — shown only alongside CUDA to avoid
  // implying it does anything for cpu/dml.
  ONNX_CUDA_STRICT: {
    category: 'embeddings', label: 'Strict CUDA (fail instead of CPU fallback)', type: 'boolean', envVar: 'ONNX_CUDA_STRICT',
    description: 'Fail instead of silently falling back to CPU when CUDA is requested but unavailable.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    visibleWhen: [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'cuda' },
    ],
    ...boolField({ envVar: 'ONNX_CUDA_STRICT', defaultVal: false }),
  },
  // CUDA-only. The npm-installed onnxruntime-node prebuilt binding ships
  // with CPU and DirectML execution providers only — it has no CUDA
  // execution provider compiled in. A compatible custom onnxruntime-node
  // build (with CUDA support) is required to actually run
  // ONNX_EXECUTION_PROVIDER=cuda; this field points local/core/onnx-runtime.js's
  // loadOnnxRuntime() at that build instead of the npm package. Empty
  // means "use the default npm package" (which will not have a CUDA
  // execution provider). CUDA Toolkit/cuDNN themselves are OS-level
  // prerequisites this setting does not install or manage.
  ONNXRUNTIME_NODE_PATH: {
    category: 'embeddings', label: 'Custom ONNX Runtime module path (CUDA)', type: 'string', envVar: 'ONNXRUNTIME_NODE_PATH',
    description: 'Filesystem path to a compatible custom onnxruntime-node build with a CUDA execution provider. The standard npm-installed package supports CPU/DirectML only, not CUDA. Leave empty to use the default npm package. Selecting this does not prove CUDA loaded — use the Admin CUDA probe or npm run doctor to verify.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    visibleWhen: [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'cuda' },
    ],
    pathPicker: true,
    ...stringField({ envVar: 'ONNXRUNTIME_NODE_PATH', defaultVal: '', allowEmpty: true }),
  },
  // CUDA-only. Selects a managed CUDA runtime previously installed by
  // scripts/install-onnxruntime-cuda-windows.ps1 into SEMIDEX_HOME (see
  // local/core/semidex-home.js), identified by its validated
  // `<ortVersion>-cuda<cudaMajor>` id (local/core/managed-runtime-id.js).
  // Kept fully independent of ONNXRUNTIME_NODE_PATH at the storage layer —
  // selecting one never writes/clears the other; precedence between them
  // is resolved at load time by local/core/onnx-runtime-source-resolution.js
  // (explicit ONNXRUNTIME_NODE_PATH > this managed selection > default npm
  // package), never here. Empty means "no managed runtime selected."
  // Re-validated (format + on-disk integrity) on every read — this field
  // is never trusted blindly from settings.json alone.
  ONNX_MANAGED_RUNTIME: {
    category: 'embeddings', label: 'Managed CUDA runtime', type: 'string', envVar: 'ONNX_MANAGED_RUNTIME',
    description: 'Select a CUDA-enabled onnxruntime-node build previously installed via scripts/install-onnxruntime-cuda-windows.ps1. Ignored while a custom runtime path is set above. Selecting this does not prove CUDA loaded — use the Admin CUDA probe or npm run doctor to verify.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    visibleWhen: [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'cuda' },
    ],
    dynamicOptions: { source: 'managed_onnx_runtimes' },
    ...stringField({ envVar: 'ONNX_MANAGED_RUNTIME', defaultVal: '', allowEmpty: true }),
  },

  // ── retrieval & ranking ─────────────────────────────────────────────────
  RERANK_ENABLED: {
    category: 'retrieval', label: 'Deterministic rerank enabled', type: 'boolean', envVar: 'RERANK_ENABLED',
    description: 'Apply rule-based reranking (boosts/penalties) to search results after retrieval.', advanced: false,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...boolField({ envVar: 'RERANK_ENABLED', defaultVal: false }),
  },
  RERANK_CE_ENABLED: {
    category: 'retrieval', label: 'Cross-encoder rerank enabled', type: 'boolean', envVar: 'RERANK_CE_ENABLED',
    description: 'Apply a cross-encoder model to rerank top search results for improved relevance.', advanced: false,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...boolField({ envVar: 'RERANK_CE_ENABLED', defaultVal: false }),
  },
  HYBRID_PREFETCH_LIMIT: {
    category: 'retrieval', label: 'Hybrid prefetch multiplier', type: 'number', envVar: 'HYBRID_PREFETCH_LIMIT',
    description: 'How many extra candidates to fetch per branch before merging dense/sparse hybrid results.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'HYBRID_PREFETCH_LIMIT', defaultVal: 2, min: 1, max: 100, warnPrefix: '[qdrant] ' }),
  },
  RRF_K: {
    category: 'retrieval', label: 'RRF K constant', type: 'number', envVar: 'RRF_K',
    description: 'Smoothing constant used when combining dense and sparse rankings via Reciprocal Rank Fusion.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RRF_K', defaultVal: 60, min: 1, max: 10000, warnPrefix: '[qdrant] ' }),
  },
  RERANK_PREFETCH_MULT: {
    category: 'retrieval', label: 'Rerank prefetch multiplier', type: 'number', envVar: 'RERANK_PREFETCH_MULT',
    description: 'How many extra candidates to fetch before reranking narrows results down.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_PREFETCH_MULT', defaultVal: 4, min: 1, max: 100 }),
  },
  RERANK_BOOST_SOURCE_FILE: {
    category: 'retrieval', label: 'Rerank boost: source file', type: 'number', envVar: 'RERANK_BOOST_SOURCE_FILE',
    description: 'Score boost applied to results sharing the same source file as a top candidate.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BOOST_SOURCE_FILE', defaultVal: 0.08, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_BOOST_SECTION: {
    category: 'retrieval', label: 'Rerank boost: section', type: 'number', envVar: 'RERANK_BOOST_SECTION',
    description: 'Score boost applied to results sharing the same document section as a top candidate.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BOOST_SECTION', defaultVal: 0.06, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_BOOST_TAGS: {
    category: 'retrieval', label: 'Rerank boost: tags', type: 'number', envVar: 'RERANK_BOOST_TAGS',
    description: 'Score boost applied to results sharing tags with the query or top candidates.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BOOST_TAGS', defaultVal: 0.05, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_BOOST_TEXT: {
    category: 'retrieval', label: 'Rerank boost: text', type: 'number', envVar: 'RERANK_BOOST_TEXT',
    description: 'Score boost applied for exact-token text overlap with the query.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BOOST_TEXT', defaultVal: 0.01, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_BASE_WEIGHT: {
    category: 'retrieval', label: 'Rerank base weight', type: 'number', envVar: 'RERANK_BASE_WEIGHT',
    description: 'Weight given to the original hybrid search score before boosts/penalties are applied.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BASE_WEIGHT', defaultVal: 1.00, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_PROTECT_TOP1_DELTA: {
    category: 'retrieval', label: 'Rerank top-1 protection delta', type: 'number', envVar: 'RERANK_PROTECT_TOP1_DELTA',
    description: 'Score margin protecting the original top result from being displaced by reranking.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_PROTECT_TOP1_DELTA', defaultVal: 0.05, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_BOOST_TEXT_LEAD: {
    category: 'retrieval', label: 'Rerank boost: text lead-in', type: 'number', envVar: 'RERANK_BOOST_TEXT_LEAD',
    description: 'Score boost applied for query-term overlap within a chunk\'s leading text window.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BOOST_TEXT_LEAD', defaultVal: 0.00, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_TEXT_LEAD_CHARS: {
    category: 'retrieval', label: 'Rerank text lead-in window (chars)', type: 'number', envVar: 'RERANK_TEXT_LEAD_CHARS',
    description: 'Number of leading characters considered for the text lead-in boost.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_TEXT_LEAD_CHARS', defaultVal: 200, min: 1, max: 10000, warnPrefix: '[rerank] ' }),
  },
  RERANK_PENALTY_INTRO_CHUNK: {
    category: 'retrieval', label: 'Rerank intro-chunk penalty', type: 'number', envVar: 'RERANK_PENALTY_INTRO_CHUNK',
    description: 'Score penalty applied to generic introductory chunks with few technical terms.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_PENALTY_INTRO_CHUNK', defaultVal: 0.02, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_INTRO_CHUNK_TECH_MIN: {
    category: 'retrieval', label: 'Rerank intro-chunk technical-token minimum', type: 'number', envVar: 'RERANK_INTRO_CHUNK_TECH_MIN',
    description: 'Minimum technical-token count below which the intro-chunk penalty applies.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_INTRO_CHUNK_TECH_MIN', defaultVal: 2, min: 1, max: 100, warnPrefix: '[rerank] ' }),
  },
  RERANK_CE_MODEL: {
    category: 'retrieval', label: 'Cross-encoder model', type: 'string', envVar: 'RERANK_CE_MODEL',
    description: 'Cross-encoder model used for cross-encoder reranking.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'RERANK_CE_MODEL', defaultVal: 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1' }),
  },
  RERANK_CE_DEVICE: {
    category: 'retrieval', label: 'Cross-encoder device', type: 'enum', envVar: 'RERANK_CE_DEVICE',
    description: 'Hardware device used to run the cross-encoder reranking model.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'RERANK_CE_DEVICE', defaultVal: 'cpu', allowed: ['cpu', 'dml', 'cuda'], warnPrefix: '[ce-rerank] ' }),
  },
  RERANK_CE_CACHE_DIR: {
    category: 'retrieval', label: 'Cross-encoder model cache dir', type: 'string', envVar: 'RERANK_CE_CACHE_DIR',
    description: 'Local directory where the cross-encoder model files are cached.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'RERANK_CE_CACHE_DIR', defaultVal: './models' }),
  },
  RERANK_CE_WARMUP: {
    category: 'retrieval', label: 'Preload cross-encoder at startup', type: 'boolean', envVar: 'RERANK_CE_WARMUP',
    description: 'Load the cross-encoder model at startup instead of on first use, to avoid a slow first search.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...boolField({ envVar: 'RERANK_CE_WARMUP', defaultVal: false }),
  },
  RERANK_CE_INPUT: {
    category: 'retrieval', label: 'Cross-encoder passage format', type: 'enum', envVar: 'RERANK_CE_INPUT',
    description: 'How much metadata is included alongside chunk text when scoring with the cross-encoder.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'RERANK_CE_INPUT', defaultVal: 'text+meta', allowed: ['text', 'text+section', 'text+meta'], warnPrefix: '[ce-rerank] ' }),
  },
  RERANK_CE_TOP_N: {
    category: 'retrieval', label: 'Cross-encoder candidate count', type: 'number', envVar: 'RERANK_CE_TOP_N',
    description: 'Number of top candidates passed to the cross-encoder for reranking.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_CE_TOP_N', defaultVal: 40, min: 1, max: 500 }),
  },
  RERANK_CE_TIMEOUT_MS: {
    category: 'retrieval', label: 'Cross-encoder timeout (ms)', type: 'number', envVar: 'RERANK_CE_TIMEOUT_MS',
    description: 'Maximum time allowed for a cross-encoder reranking call before it is abandoned.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_CE_TIMEOUT_MS', defaultVal: 10000, min: 100, max: 120000 }),
  },
  RERANK_CE_BATCH_SIZE: {
    category: 'retrieval', label: 'Cross-encoder batch size', type: 'number', envVar: 'RERANK_CE_BATCH_SIZE',
    description: 'Number of candidate passages scored together per cross-encoder batch.', advanced: true,
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_CE_BATCH_SIZE', defaultVal: 16, min: 1, max: 256 }),
  },

  // ── storage & databases ─────────────────────────────────────────────────
  // No defaultVal: core/qdrant/client.js has no fallback of its own — it
  // deliberately throws "QDRANT_URL is not set" when the var is absent
  // (tests/unit/core/qdrant-lazy.test.js pins this as a regression guard:
  // "pre-migration qdrant.js threw at import time; this is the core
  // regression guard" — silently defaulting to localhost:6333 could
  // connect to the wrong/nonexistent instance in a dev environment running
  // multiple Qdrant instances, so the throw is intentional, not an
  // oversight). A registry default of 'http://localhost:6333' would be
  // dishonest — it doesn't match what the real client actually does when
  // unset — and applyEnvWriteBack()'s "skip default-sourced values" rule
  // (service.js) depends on every field's registry default matching its
  // consumer's own real fallback; QDRANT_URL was the one exception (code
  // review finding, P1). Leaving `default` undefined here makes
  // getActiveValue()/the UI correctly report "not configured" instead of a
  // value nothing in the real system would actually use.
  QDRANT_URL: {
    category: 'storage', label: 'Qdrant URL', type: 'string', envVar: 'QDRANT_URL',
    description: 'URL of the Qdrant instance semidex connects to.', advanced: false,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'QDRANT_URL', defaultVal: undefined, allowEmpty: false }),
  },
  QDRANT_KEY: {
    category: 'storage', label: 'Qdrant API key', type: 'secret', envVar: 'QDRANT_KEY',
    description: 'API key used to authenticate with the Qdrant instance, if required.', advanced: false,
    appliesAt: null, requiresReindex: false, requiresBackfill: false,
    writable: false, secret: true, readOnlyReason: 'Secrets are environment-only and never persisted or displayed.',
    default: undefined,
    parseExternal(raw) { return raw; },
    validate() { return { ok: false, error: 'QDRANT_KEY is a secret and cannot be written.' }; },
    serialize: (value) => value,
  },
  SEMIDEX_STORAGE_BACKEND: {
    category: 'storage', label: 'Storage backend', type: 'enum', envVar: 'SEMIDEX_STORAGE_BACKEND',
    description: 'The vector storage backend semidex uses.', advanced: false,
    appliesAt: null, requiresReindex: false, requiresBackfill: false,
    writable: false, readOnlyReason: 'Only one storage backend ("qdrant") is implemented.',
    ...enumField({ envVar: 'SEMIDEX_STORAGE_BACKEND', defaultVal: 'qdrant', allowed: ['qdrant'] }),
  },

  // ── system & diagnostics ────────────────────────────────────────────────
  ADMIN_HOST: {
    category: 'system', label: 'Admin bind host', type: 'string', envVar: 'ADMIN_HOST',
    description: 'Network address the admin server binds to.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'ADMIN_HOST', defaultVal: '127.0.0.1' }),
  },
  ADMIN_PORT: {
    category: 'system', label: 'Admin bind port', type: 'number', envVar: 'ADMIN_PORT',
    description: 'Network port the admin server listens on.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'ADMIN_PORT', defaultVal: 8642, min: 1, max: 65535 }),
  },
  ADMIN_ALLOW_REMOTE: {
    category: 'system', label: 'Allow non-loopback bind', type: 'boolean', envVar: 'ADMIN_ALLOW_REMOTE',
    description: 'Allow the admin server to bind to a non-localhost address, exposing it beyond this machine.', advanced: true,
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...boolField({ envVar: 'ADMIN_ALLOW_REMOTE', defaultVal: false }),
  },
  TOKEN_COUNT: {
    category: 'system', label: 'Token counting mode', type: 'enum', envVar: 'TOKEN_COUNT',
    description: 'Method used to count tokens when sizing chunks: model tokenizer or a fast heuristic.', advanced: true,
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    // Hidden (not just inert) when the active embedding backend is Qdrant
    // Cloud — resolveTokenCountMode() (core/token-count.js) never consults
    // this setting for a qdrant-cloud profile; it always uses the ACTIVE
    // dense model's own tokenizer (see QDRANT_CLOUD_TOKENIZER below).
    // Showing an "active-looking" BGE-M3/heuristic control that silently
    // controls nothing for the current backend was the exact UX bug this
    // hiddenWhen exists to fix — see isFieldVisible()'s own header comment
    // (global-settings-view.js) for the general mechanism.
    hiddenWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' },
    ...enumField({ envVar: 'TOKEN_COUNT', defaultVal: 'bge-m3', allowed: ['bge-m3', 'heuristic'] }),
  },
  // Read-only — shown ONLY for EMBEDDING_BACKEND==='qdrant-cloud' (the one
  // case TOKEN_COUNT above is hidden for), so the UI always shows exactly
  // one true statement about which tokenizer is actually in effect: either
  // TOKEN_COUNT's own bge-m3/heuristic choice (other backends), or this
  // row naming the real, model-scoped cloud tokenizer identity
  // (core/token-count.js's resolveTokenCountMode() returns
  // `qdrant-cloud:<model-id>` for a cloud profile — this row surfaces just
  // the `<model-id>` part, since "qdrant-cloud:" is redundant with the
  // active backend already being shown elsewhere on this page).
  // No envVar (matches EMBEDDING_BACKEND's own synthetic-field convention
  // — see service.js's header comment on that field) — these two rows are
  // ALWAYS 100% derived from the selected dense model, never independently
  // configurable via env/dotenv/settings.json, so there is no external
  // source to parse and no write-back to skip explicitly (service.js's
  // applyEnvWriteBack() already unconditionally skips any field with
  // `!def.envVar`).
  QDRANT_CLOUD_TOKENIZER: {
    category: 'embeddings', label: 'Tokenizer', type: 'string',
    description: 'The real tokenizer used to size chunks for the selected Qdrant Cloud dense model — always matches that model exactly, never a separate choice.',
    advanced: false, appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' },
    catalogDerived: {
      key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud',
      modelKey: 'QDRANT_CLOUD_DENSE_MODEL', property: 'id',
      unknownWarning: 'Select a dense model to see its tokenizer.',
    },
    default: '',
    allowEmpty: true,
    parseExternal() { throw new Error('QDRANT_CLOUD_TOKENIZER is derived, not env-backed.'); },
    validate() { return { ok: true }; },
    serialize: (value) => value,
    writable: false,
    readOnlyReason: 'Determined entirely by the selected dense model.',
  },
  QDRANT_CLOUD_DENSE_CONTEXT_WINDOW: {
    category: 'embeddings', label: 'Context window', type: 'number',
    description: 'Maximum input tokens the selected dense model accepts per embedding call. Chunking automatically stays within this budget.',
    advanced: false, appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    visibleWhen: { key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud' },
    catalogDerived: {
      key: 'EMBEDDING_BACKEND', equals: 'qdrant-cloud',
      modelKey: 'QDRANT_CLOUD_DENSE_MODEL', property: 'contextWindow',
      unknownWarning: 'Select a dense model to see its context window.',
    },
    default: 0,
    min: 0,
    max: 1000000,
    parseExternal() { throw new Error('QDRANT_CLOUD_DENSE_CONTEXT_WINDOW is derived, not env-backed.'); },
    validate() { return { ok: true }; },
    serialize: (value) => value,
    writable: false,
    readOnlyReason: 'Determined entirely by the selected dense model.',
  },
};

// Every definition is writable by default unless explicitly marked
// `writable: false` above (secrets, derived values, and
// single-implementation enums).
for (const def of Object.values(DEFINITIONS)) {
  if (def.writable === undefined) def.writable = true;
  if (def.secret === undefined) def.secret = false;
  if (def.readOnlyReason === undefined) def.readOnlyReason = null;
}

export const CATEGORIES = Object.freeze([
  { id: 'status', label: 'Runtime status' },
  { id: 'storage', label: 'Storage & databases' },
  { id: 'ai', label: 'AI providers' },
  { id: 'embeddings', label: 'Embeddings & hardware' },
  { id: 'indexing', label: 'Indexing & document processing' },
  { id: 'retrieval', label: 'Retrieval & ranking' },
  { id: 'system', label: 'System & diagnostics' },
]);

export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
