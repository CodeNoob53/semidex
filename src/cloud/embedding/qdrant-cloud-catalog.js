// Server-side Qdrant Cloud Inference catalog helpers — the tokenizer-
// dependent pieces (checkEmbedInputFits) and the pure query-descriptor
// builder (buildCloudQueryInputs) that are NOT safe to bundle into the
// Admin Settings UI (browser code). The catalog DATA itself
// (QDRANT_CLOUD_DENSE_MODELS/SPARSE_MODELS, findDenseModel/findSparseModel,
// isDenseModelSupported, isCatalogCompatibleWithChunking) is genuinely
// neutral, zero-dependency typed metadata — not a cloud-provider
// IMPLEMENTATION (no network call, no SDK, no tokenizer I/O) — and lives
// in src/core/embedding-profile/qdrant-cloud-models.js, a shared contract
// module, re-exported here unchanged so every existing server-side caller
// of THIS file keeps working without a second import path. No
// model-discovery API exists (a live-spike finding — see
// benchmarks/results/2026-07-21-qdrant-cloud-inference-live-spike.md), so
// the catalog itself is a hand-maintained list, confirmed against the
// Qdrant Cloud Console for one account on 2026-07-21.
import { heuristicTokenCount } from '../../shared/core/token-count.js';
import { loadQdrantCloudTokenizer, qdrantCloudTokenCount } from './qdrant-cloud-tokenizer.js';
import { findDenseModel } from '../../core/embedding-profile/qdrant-cloud-models.js';

export {
  QDRANT_CLOUD_DENSE_MODELS,
  QDRANT_CLOUD_SPARSE_MODELS,
  findDenseModel,
  findSparseModel,
  isDenseModelSupported,
  isCatalogCompatibleWithChunking,
} from '../../core/embedding-profile/qdrant-cloud-models.js';

/**
 * Real per-embed input check — the exact, embed-time gate. Uses a REAL
 * tokenizer for the specific model (never the heuristic, which is
 * English-biased and can understate Ukrainian/Cyrillic/code token counts
 * badly enough to wrongly report a fit). Async because loading/caching the
 * tokenizer is I/O. A model with no context window (e.g. BM25, sparse)
 * always fits — nothing to tokenize against.
 *
 * @param {{id: string, contextWindow: number|null}} model
 * @param {string} embedText the FULL assembled embed input (context+text),
 *   never chunk.text alone
 * @returns {Promise<
 *   | { fits: true, tokenCount: number|null, contextWindow: number|null }
 *   | { fits: false, code: 'TOKENIZER_UNAVAILABLE', message: string }
 *   | { fits: false, code: 'EMBEDDING_INPUT_TOO_LONG', tokenCount: number, contextWindow: number }
 * >}
 */
export async function checkEmbedInputFits(model, embedText) {
  if (model.contextWindow == null) return { fits: true, tokenCount: null, contextWindow: null };

  let tokenizer;
  try {
    tokenizer = await loadQdrantCloudTokenizer(model.id);
  } catch (err) {
    return { fits: false, code: 'TOKENIZER_UNAVAILABLE', message: err.message };
  }

  const tokenCount = qdrantCloudTokenCount(tokenizer, embedText);
  if (tokenCount > model.contextWindow) {
    return { fits: false, code: 'EMBEDDING_INPUT_TOO_LONG', tokenCount, contextWindow: model.contextWindow };
  }
  return { fits: true, tokenCount, contextWindow: model.contextWindow };
}

/**
 * Reserves room for `context` inside a model's context window by trimming
 * it (never `text` — `text` is the actual indexed chunk body; silently
 * shortening it would drop indexed evidence, which this task forbids).
 * `context` is LLM-generated recall-assisting metadata (1-2 sentences,
 * src/indexer/phases/context.js) — trimming what's SENT to the embedder
 * here does not touch the untrimmed context Semidex still stores in the
 * point payload, so no indexed data is lost, only what this one over-budget
 * embed call includes.
 *
 * Binary search on character boundaries against the REAL target-model
 * tokenizer (never the heuristic) — same technique
 * core/token-count.js's takeLastTokens() uses for BGE-M3, generalized to
 * an arbitrary Qdrant Cloud model. Trims from the FRONT of `context`
 * (keeps the tail — the most specific, most recently-relevant part of a
 * heading-path/skeleton-summary context) down to the token budget left
 * over after reserving room for `text` at its own real token count, plus
 * the `\n\n` join separator. Returns null (no fit possible) if `text`
 * ALONE already exceeds the window — this function only ever trims
 * `context`, never `text`.
 *
 * @param {{id: string, contextWindow: number|null}} model
 * @param {string} context
 * @param {string} text
 * @returns {Promise<{ context: string, tokenCount: number } | null>}
 */
export async function fitContextToBudget(model, context, text) {
  if (model.contextWindow == null) return { context, tokenCount: 0 };

  let tokenizer;
  try {
    tokenizer = await loadQdrantCloudTokenizer(model.id);
  } catch (err) {
    return null;
  }

  const SEPARATOR = '\n\n';
  const count = (s) => qdrantCloudTokenCount(tokenizer, s);

  const textOnlyCount = count(`${SEPARATOR}${text}`);
  if (textOnlyCount > model.contextWindow) return null; // text alone can't fit — never trim text itself

  const fullCount = count(`${context}${SEPARATOR}${text}`);
  if (fullCount <= model.contextWindow) return { context, tokenCount: fullCount };

  // Binary search the smallest character offset from the start of `context`
  // such that the suffix (kept tail) + separator + text fits the window.
  let lo = 0;
  let hi = context.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = context.slice(mid);
    const candidateCount = count(`${candidate}${SEPARATOR}${text}`);
    if (candidateCount <= model.contextWindow) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const trimmedContext = context.slice(lo);
  return { context: trimmedContext, tokenCount: count(`${trimmedContext}${SEPARATOR}${text}`) };
}

/**
 * Synchronous, advisory-only estimate — backed by heuristicTokenCount(),
 * never used as a production safety gate (see checkEmbedInputFits() above
 * for that). Exists for any server-side caller that wants a cheap estimate
 * without loading a tokenizer; the Admin UI itself uses the pure
 * isCatalogCompatibleWithChunking() (qdrant-cloud-models.js) instead, since
 * it has no real chunk text to estimate against at settings-time anyway.
 * @param {{contextWindow: number|null}} model
 * @param {string} sampleText
 * @returns {{ fits: boolean, estimatedTokens: number|null, contextWindow: number|null }}
 */
export function estimateEmbedInputFitsForUi(model, sampleText) {
  if (model.contextWindow == null) return { fits: true, estimatedTokens: null, contextWindow: null };
  const estimatedTokens = heuristicTokenCount(sampleText);
  return { fits: estimatedTokens <= model.contextWindow, estimatedTokens, contextWindow: model.contextWindow };
}

/**
 * Builds the {denseQuery, sparseQuery} inference-descriptor pair for a
 * CLOUD query — pure data assembly from an already-resolved profile, no
 * embedding call, no network call. Deliberately NOT part of
 * src/core/embeddings.js: embedForSearch() stays client-only, so nothing
 * that returns a {text, model} descriptor shares a name or call site with
 * the function that returns real vector arrays for search.
 *
 * No `options`/`modifier` on either descriptor — BM25's `modifier: 'idf'`
 * is collection-schema metadata (set once at createCollection time via
 * buildQdrantVectorSchemaFromProfile()), never a per-request inference
 * parameter. Mirrors embedForIndexCloud()'s index-time descriptor shape
 * exactly.
 *
 * @param {Object} profile a resolved embedding profile
 * @param {string} query
 * @returns {{ denseQuery: {text: string, model: string}, sparseQuery: {text: string, model: string}|null }}
 */
export function buildCloudQueryInputs(profile, query) {
  const denseModel = profile.embedding.dense.model;
  const sparseModel = profile.embedding.sparse?.model;
  return {
    denseQuery: { text: query, model: denseModel },
    sparseQuery: sparseModel ? { text: query, model: sparseModel } : null,
  };
}

/**
 * Resolves the generic { maxInputTokens, countTokens } budget the indexing
 * coordinator (src/indexer/run.js) passes into structural chunk
 * finalization (entity-split.js, via chunkFromSkeleton) — the chunker
 * itself must never know provider names or the full embedding profile, so
 * this is the ONE place that translates a resolved profile into that
 * generic shape.
 *
 * Returns null for a client-execution profile (or any non-qdrant-cloud
 * execution) — the local path preserves today's whole-entity behavior
 * exactly, no splitting, since a local model (e.g. BGE-M3, 8192 tokens)
 * has never needed it.
 *
 * maxInputTokens reserves only the context/text join separator, not any
 * fixed amount for `context` itself — embedForIndexCloud's own
 * fitContextToBudget() can already trim context down to empty at embed
 * time (never the fragment body), so a fragment that fits alone within
 * this budget is GUARANTEED to embed successfully after that retry, with
 * no need for entity-split.js to guess how much context room to leave.
 *
 * @param {Object} profile a resolved embedding profile
 * @returns {{ maxInputTokens: number, countTokens: (text: string) => Promise<number> }|null}
 */
export function resolveEmbeddingBudget(profile) {
  if (profile?.embedding?.dense?.execution !== 'qdrant-cloud') return null;

  const denseModelId = profile.embedding.dense.model;
  const denseCatalog = findDenseModel(denseModelId);
  if (!denseCatalog || denseCatalog.contextWindow == null) return null;

  const SEPARATOR = '\n\n';

  return {
    maxInputTokens: denseCatalog.contextWindow,
    // Measures `SEPARATOR + text` rather than `text` alone — this is what
    // reserves room for the join separator without a hardcoded guess at
    // its token count (real tokenizers don't tokenize 1:1 with characters,
    // so "2 chars = N tokens" would be exactly the estimate this module
    // exists to avoid). A fragment whose measured count fits this budget
    // is guaranteed embeddable: embedForIndexCloud's fitContextToBudget()
    // can trim `context` down to empty at embed time, at which point the
    // real assembled string is exactly `${''}${SEPARATOR}${fragmentText}`.
    countTokens: async (text) => {
      const tokenizer = await loadQdrantCloudTokenizer(denseCatalog.id);
      return qdrantCloudTokenCount(tokenizer, `${SEPARATOR}${text}`);
    },
  };
}
