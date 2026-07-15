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

function warnInvalid(prefix, name, raw, fallback) {
  console.warn(`${prefix}${name}="${raw}" is invalid — using default ${fallback}`);
}

function intField({ envVar, defaultVal, min, max, warnPrefix = '' }) {
  return {
    default: defaultVal,
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
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...intField({ envVar: 'MAX_CHUNK_TOKENS', defaultVal: 512, min: 1, max: 100000, warnPrefix: '[chunk] ' }),
  },
  MIN_CHUNK_TOKENS: {
    category: 'indexing', label: 'Min chunk tokens', type: 'number', envVar: 'MIN_CHUNK_TOKENS',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...intField({ envVar: 'MIN_CHUNK_TOKENS', defaultVal: 160, min: 0, max: 100000, warnPrefix: '[chunk] ' }),
  },
  CHUNK_OVERLAP_TOKENS: {
    category: 'indexing', label: 'Chunk overlap tokens', type: 'number', envVar: 'CHUNK_OVERLAP_TOKENS',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...intField({ envVar: 'CHUNK_OVERLAP_TOKENS', defaultVal: 80, min: 0, max: 100000, warnPrefix: '[chunk] ' }),
  },
  OVERLAP_SENTENCES: {
    category: 'indexing', label: 'Overlap sentences (legacy)', type: 'number', envVar: 'OVERLAP_SENTENCES',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...intField({ envVar: 'OVERLAP_SENTENCES', defaultVal: 2, min: 0, max: 100, warnPrefix: '[chunk] ' }),
  },
  LLM_BATCH_SIZE: {
    category: 'indexing', label: 'LLM batch size', type: 'number', envVar: 'LLM_BATCH_SIZE',
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'LLM_BATCH_SIZE', defaultVal: 3, min: 1, max: 64, warnPrefix: '[indexer] ' }),
  },
  SKELETON_CHUNKING: {
    category: 'indexing', label: 'Skeleton-first chunking', type: 'boolean', envVar: 'SKELETON_CHUNKING',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...boolField({ envVar: 'SKELETON_CHUNKING', defaultVal: false }),
  },
  SKELETON_NAV: {
    category: 'indexing', label: 'Skeleton nav points', type: 'boolean', envVar: 'SKELETON_NAV',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    default: true,
    // Kill-switch semantics: env value '0' disables, anything else (incl.
    // unset) is on — mirrors `process.env.SKELETON_NAV === '0'` at
    // index.js:154 exactly (inverse of a normal boolField).
    parseExternal(raw) { return raw !== '0'; },
    validate(value) { return typeof value === 'boolean' ? { ok: true } : { ok: false, error: 'SKELETON_NAV must be a boolean.' }; },
    serialize: (value) => value,
  },
  SKELETON_CONTEXT: {
    category: 'indexing', label: 'Skeleton context mode', type: 'enum', envVar: 'SKELETON_CONTEXT',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...enumField({ envVar: 'SKELETON_CONTEXT', defaultVal: 'deterministic', allowed: ['deterministic', 'llm'], warnPrefix: '[indexer] ' }),
  },
  SKELETON_SUMMARY: {
    category: 'indexing', label: 'Skeleton summary mode', type: 'enum', envVar: 'SKELETON_SUMMARY',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...enumField({ envVar: 'SKELETON_SUMMARY', defaultVal: 'deterministic', allowed: ['deterministic', 'llm'], warnPrefix: '[indexer] ' }),
  },
  SKELETON_CARRYOVER_CHARS: {
    category: 'indexing', label: 'Skeleton carryover chars', type: 'number', envVar: 'SKELETON_CARRYOVER_CHARS',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...intField({ envVar: 'SKELETON_CARRYOVER_CHARS', defaultVal: 500, min: 0, max: 100000, warnPrefix: '[skeleton-chunk] ' }),
  },
  SUMMARY_LANG: {
    category: 'indexing', label: 'Summary language override', type: 'string', envVar: 'SUMMARY_LANG',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...stringField({ envVar: 'SUMMARY_LANG', defaultVal: 'auto', allowEmpty: false }),
  },

  // ── ai (generation / tagging) ──────────────────────────────────────────
  TAG_GEN: {
    category: 'ai', label: 'Generate tags', type: 'boolean', envVar: 'TAG_GEN',
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: true,
    ...boolField({ envVar: 'TAG_GEN', defaultVal: false }),
  },
  TAG_PROVIDER: {
    category: 'ai', label: 'Tag provider', type: 'enum', envVar: 'TAG_PROVIDER',
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: true,
    ...enumField({ envVar: 'TAG_PROVIDER', defaultVal: 'ollama', allowed: ['ollama', 'onnx'], warnPrefix: '[tag] ' }),
  },
  TAG_MODEL: {
    category: 'ai', label: 'Tag model', type: 'string', envVar: 'TAG_MODEL',
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: true,
    ...stringField({ envVar: 'TAG_MODEL', defaultVal: 'gemma3:4b' }),
  },
  TAG_ONNX_MODEL: {
    category: 'ai', label: 'ONNX tag model', type: 'string', envVar: 'TAG_ONNX_MODEL',
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: true,
    ...stringField({ envVar: 'TAG_ONNX_MODEL', defaultVal: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct' }),
  },
  TAG_ONNX_THREADS: {
    category: 'ai', label: 'ONNX tag worker threads', type: 'number', envVar: 'TAG_ONNX_THREADS',
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'TAG_ONNX_THREADS', defaultVal: 1, min: 1, max: 64, warnPrefix: '[tag-onnx] ' }),
  },
  TAG_ONNX_ALLOW_DOWNLOAD: {
    category: 'ai', label: 'Allow ONNX tag model download', type: 'boolean', envVar: 'TAG_ONNX_ALLOW_DOWNLOAD',
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    ...boolField({ envVar: 'TAG_ONNX_ALLOW_DOWNLOAD', defaultVal: false }),
  },
  COMBINED_LLM: {
    category: 'ai', label: 'Combined context+tags LLM pass', type: 'boolean', envVar: 'COMBINED_LLM',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...boolField({ envVar: 'COMBINED_LLM', defaultVal: false }),
  },
  CONTEXT_MODEL: {
    category: 'ai', label: 'Context generation model', type: 'string', envVar: 'CONTEXT_MODEL',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...stringField({ envVar: 'CONTEXT_MODEL', defaultVal: 'gemma3:4b' }),
  },
  SEMIDEX_GENERATION_BACKEND: {
    category: 'ai', label: 'Generation backend', type: 'enum', envVar: 'SEMIDEX_GENERATION_BACKEND',
    appliesAt: null, requiresReindex: false, requiresBackfill: false,
    writable: false, readOnlyReason: 'Only one generation backend ("ollama") is implemented.',
    ...enumField({ envVar: 'SEMIDEX_GENERATION_BACKEND', defaultVal: 'ollama', allowed: ['ollama'] }),
  },
  ASK_MODEL: {
    category: 'ai', label: 'Ask answer model', type: 'string', envVar: 'ASK_MODEL',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'ASK_MODEL', defaultVal: 'gemma3:4b' }),
  },
  OLLAMA_URL: {
    category: 'ai', label: 'Ollama URL', type: 'string', envVar: 'OLLAMA_URL',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'OLLAMA_URL', defaultVal: 'http://localhost:11434' }),
  },
  ASK_NUM_CTX: {
    category: 'ai', label: 'Ask context size', type: 'number', envVar: 'ASK_NUM_CTX',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'ASK_NUM_CTX', defaultVal: 8192, min: 256, max: 1_000_000 }),
  },
  GENERATION_DEVICE: {
    category: 'ai', label: 'Generation device policy', type: 'enum', envVar: 'GENERATION_DEVICE',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'GENERATION_DEVICE', defaultVal: 'auto', allowed: ['auto'] }),
  },

  // ── embeddings & hardware ───────────────────────────────────────────────
  EMBED_MODEL: {
    category: 'embeddings', label: 'Embedding model (Ollama)', type: 'string', envVar: 'EMBED_MODEL',
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'EMBED_MODEL', defaultVal: 'bge-m3' }),
  },
  DENSE_PROVIDER: {
    category: 'embeddings', label: 'Dense provider', type: 'enum', envVar: 'DENSE_PROVIDER',
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'DENSE_PROVIDER', defaultVal: 'ollama', allowed: ['ollama', 'bge-m3-onnx'] }),
  },
  SPARSE_PROVIDER: {
    category: 'embeddings', label: 'Sparse provider', type: 'enum', envVar: 'SPARSE_PROVIDER',
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'SPARSE_PROVIDER', defaultVal: 'hashed-tf', allowed: ['hashed-tf', 'bge-m3-onnx'] }),
  },
  DENSE_MODEL: {
    category: 'embeddings', label: 'Dense model', type: 'string', envVar: 'DENSE_MODEL',
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'DENSE_MODEL', defaultVal: 'bge-m3' }),
  },
  VECTOR_SIZE: {
    category: 'embeddings', label: 'Vector size', type: 'number', envVar: 'VECTOR_SIZE',
    appliesAt: 'new_collection', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'VECTOR_SIZE', defaultVal: 1024, min: 1, max: 100000 }),
  },
  ONNX_EXECUTION_PROVIDER: {
    category: 'embeddings', label: 'ONNX execution provider', type: 'enum', envVar: 'ONNX_EXECUTION_PROVIDER',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'ONNX_EXECUTION_PROVIDER', defaultVal: 'cpu', allowed: ['cpu', 'dml', 'cuda'] }),
  },
  ONNX_BATCH_SIZE: {
    category: 'embeddings', label: 'ONNX batch size', type: 'number', envVar: 'ONNX_BATCH_SIZE',
    appliesAt: 'next_index_job', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'ONNX_BATCH_SIZE', defaultVal: 4, min: 1, max: 64, warnPrefix: '[onnx] ' }),
  },
  ONNX_CUDA_STRICT: {
    category: 'embeddings', label: 'Strict CUDA (fail instead of CPU fallback)', type: 'boolean', envVar: 'ONNX_CUDA_STRICT',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...boolField({ envVar: 'ONNX_CUDA_STRICT', defaultVal: false }),
  },

  // ── retrieval & ranking ─────────────────────────────────────────────────
  HYBRID_PREFETCH_LIMIT: {
    category: 'retrieval', label: 'Hybrid prefetch multiplier', type: 'number', envVar: 'HYBRID_PREFETCH_LIMIT',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'HYBRID_PREFETCH_LIMIT', defaultVal: 2, min: 1, max: 100, warnPrefix: '[qdrant] ' }),
  },
  RRF_K: {
    category: 'retrieval', label: 'RRF K constant', type: 'number', envVar: 'RRF_K',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RRF_K', defaultVal: 60, min: 1, max: 10000, warnPrefix: '[qdrant] ' }),
  },
  RERANK_ENABLED: {
    category: 'retrieval', label: 'Deterministic rerank enabled', type: 'boolean', envVar: 'RERANK_ENABLED',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...boolField({ envVar: 'RERANK_ENABLED', defaultVal: false }),
  },
  RERANK_CE_ENABLED: {
    category: 'retrieval', label: 'Cross-encoder rerank enabled', type: 'boolean', envVar: 'RERANK_CE_ENABLED',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...boolField({ envVar: 'RERANK_CE_ENABLED', defaultVal: false }),
  },
  RERANK_PREFETCH_MULT: {
    category: 'retrieval', label: 'Rerank prefetch multiplier', type: 'number', envVar: 'RERANK_PREFETCH_MULT',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_PREFETCH_MULT', defaultVal: 4, min: 1, max: 100 }),
  },
  RERANK_BOOST_SOURCE_FILE: {
    category: 'retrieval', label: 'Rerank boost: source file', type: 'number', envVar: 'RERANK_BOOST_SOURCE_FILE',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BOOST_SOURCE_FILE', defaultVal: 0.08, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_BOOST_SECTION: {
    category: 'retrieval', label: 'Rerank boost: section', type: 'number', envVar: 'RERANK_BOOST_SECTION',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BOOST_SECTION', defaultVal: 0.06, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_BOOST_TAGS: {
    category: 'retrieval', label: 'Rerank boost: tags', type: 'number', envVar: 'RERANK_BOOST_TAGS',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BOOST_TAGS', defaultVal: 0.05, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_BOOST_TEXT: {
    category: 'retrieval', label: 'Rerank boost: text', type: 'number', envVar: 'RERANK_BOOST_TEXT',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BOOST_TEXT', defaultVal: 0.01, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_BASE_WEIGHT: {
    category: 'retrieval', label: 'Rerank base weight', type: 'number', envVar: 'RERANK_BASE_WEIGHT',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BASE_WEIGHT', defaultVal: 1.00, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_PROTECT_TOP1_DELTA: {
    category: 'retrieval', label: 'Rerank top-1 protection delta', type: 'number', envVar: 'RERANK_PROTECT_TOP1_DELTA',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_PROTECT_TOP1_DELTA', defaultVal: 0.05, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_BOOST_TEXT_LEAD: {
    category: 'retrieval', label: 'Rerank boost: text lead-in', type: 'number', envVar: 'RERANK_BOOST_TEXT_LEAD',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_BOOST_TEXT_LEAD', defaultVal: 0.00, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_TEXT_LEAD_CHARS: {
    category: 'retrieval', label: 'Rerank text lead-in window (chars)', type: 'number', envVar: 'RERANK_TEXT_LEAD_CHARS',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_TEXT_LEAD_CHARS', defaultVal: 200, min: 1, max: 10000, warnPrefix: '[rerank] ' }),
  },
  RERANK_PENALTY_INTRO_CHUNK: {
    category: 'retrieval', label: 'Rerank intro-chunk penalty', type: 'number', envVar: 'RERANK_PENALTY_INTRO_CHUNK',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...floatField({ envVar: 'RERANK_PENALTY_INTRO_CHUNK', defaultVal: 0.02, min: 0, max: 10, warnPrefix: '[rerank] ' }),
  },
  RERANK_INTRO_CHUNK_TECH_MIN: {
    category: 'retrieval', label: 'Rerank intro-chunk technical-token minimum', type: 'number', envVar: 'RERANK_INTRO_CHUNK_TECH_MIN',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_INTRO_CHUNK_TECH_MIN', defaultVal: 2, min: 1, max: 100, warnPrefix: '[rerank] ' }),
  },
  RERANK_CE_MODEL: {
    category: 'retrieval', label: 'Cross-encoder model', type: 'string', envVar: 'RERANK_CE_MODEL',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'RERANK_CE_MODEL', defaultVal: 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1' }),
  },
  RERANK_CE_DEVICE: {
    category: 'retrieval', label: 'Cross-encoder device', type: 'enum', envVar: 'RERANK_CE_DEVICE',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'RERANK_CE_DEVICE', defaultVal: 'cpu', allowed: ['cpu', 'dml', 'cuda'], warnPrefix: '[ce-rerank] ' }),
  },
  RERANK_CE_CACHE_DIR: {
    category: 'retrieval', label: 'Cross-encoder model cache dir', type: 'string', envVar: 'RERANK_CE_CACHE_DIR',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'RERANK_CE_CACHE_DIR', defaultVal: './models' }),
  },
  RERANK_CE_WARMUP: {
    category: 'retrieval', label: 'Preload cross-encoder at startup', type: 'boolean', envVar: 'RERANK_CE_WARMUP',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...boolField({ envVar: 'RERANK_CE_WARMUP', defaultVal: false }),
  },
  RERANK_CE_INPUT: {
    category: 'retrieval', label: 'Cross-encoder passage format', type: 'enum', envVar: 'RERANK_CE_INPUT',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...enumField({ envVar: 'RERANK_CE_INPUT', defaultVal: 'text+meta', allowed: ['text', 'text+section', 'text+meta'], warnPrefix: '[ce-rerank] ' }),
  },
  RERANK_CE_TOP_N: {
    category: 'retrieval', label: 'Cross-encoder candidate count', type: 'number', envVar: 'RERANK_CE_TOP_N',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_CE_TOP_N', defaultVal: 40, min: 1, max: 500 }),
  },
  RERANK_CE_TIMEOUT_MS: {
    category: 'retrieval', label: 'Cross-encoder timeout (ms)', type: 'number', envVar: 'RERANK_CE_TIMEOUT_MS',
    appliesAt: 'next_search', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'RERANK_CE_TIMEOUT_MS', defaultVal: 10000, min: 100, max: 120000 }),
  },
  RERANK_CE_BATCH_SIZE: {
    category: 'retrieval', label: 'Cross-encoder batch size', type: 'number', envVar: 'RERANK_CE_BATCH_SIZE',
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
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'QDRANT_URL', defaultVal: undefined, allowEmpty: false }),
  },
  QDRANT_KEY: {
    category: 'storage', label: 'Qdrant API key', type: 'secret', envVar: 'QDRANT_KEY',
    appliesAt: null, requiresReindex: false, requiresBackfill: false,
    writable: false, secret: true, readOnlyReason: 'Secrets are environment-only and never persisted or displayed.',
    default: undefined,
    parseExternal(raw) { return raw; },
    validate() { return { ok: false, error: 'QDRANT_KEY is a secret and cannot be written.' }; },
    serialize: (value) => value,
  },
  SEMIDEX_STORAGE_BACKEND: {
    category: 'storage', label: 'Storage backend', type: 'enum', envVar: 'SEMIDEX_STORAGE_BACKEND',
    appliesAt: null, requiresReindex: false, requiresBackfill: false,
    writable: false, readOnlyReason: 'Only one storage backend ("qdrant") is implemented.',
    ...enumField({ envVar: 'SEMIDEX_STORAGE_BACKEND', defaultVal: 'qdrant', allowed: ['qdrant'] }),
  },

  // ── system & diagnostics ────────────────────────────────────────────────
  ADMIN_HOST: {
    category: 'system', label: 'Admin bind host', type: 'string', envVar: 'ADMIN_HOST',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...stringField({ envVar: 'ADMIN_HOST', defaultVal: '127.0.0.1' }),
  },
  ADMIN_PORT: {
    category: 'system', label: 'Admin bind port', type: 'number', envVar: 'ADMIN_PORT',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...intField({ envVar: 'ADMIN_PORT', defaultVal: 8642, min: 1, max: 65535 }),
  },
  ADMIN_ALLOW_REMOTE: {
    category: 'system', label: 'Allow non-loopback bind', type: 'boolean', envVar: 'ADMIN_ALLOW_REMOTE',
    appliesAt: 'next_restart', requiresReindex: false, requiresBackfill: false,
    ...boolField({ envVar: 'ADMIN_ALLOW_REMOTE', defaultVal: false }),
  },
  TOKEN_COUNT: {
    category: 'system', label: 'Token counting mode', type: 'enum', envVar: 'TOKEN_COUNT',
    appliesAt: 'next_index_job', requiresReindex: true, requiresBackfill: false,
    ...enumField({ envVar: 'TOKEN_COUNT', defaultVal: 'bge-m3', allowed: ['bge-m3', 'heuristic'] }),
  },
};

// Every definition is writable by default unless explicitly marked
// `writable: false` above (secrets and single-implementation enums).
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
