// Pure-data Qdrant Cloud Inference model catalog — zero dependencies (no
// fs, no fetch, no tokenizer). Split out of qdrant-cloud-catalog.js
// specifically so the Admin Settings UI (browser bundle, built via Vite)
// can import the catalog data + coarse compatibility check WITHOUT pulling
// in qdrant-cloud-tokenizer.js's Node-only fs/fetch code and the native
// @huggingface/tokenizers package — those stay server-only, reachable
// through qdrant-cloud-catalog.js's checkEmbedInputFits(), never through
// this file. This is the ONE source of truth for model
// ID/dimensions/context window/status; qdrant-cloud-catalog.js re-exports
// everything here unchanged.
//
// Every entry's `id`/`dimensions`/`contextWindow`/tier-gating behavior was
// live-verified against a real Qdrant Cloud cluster (disposable
// collections, created+deleted) on 2026-08-01 — see
// docs/design/qdrant-cloud-inference-model-research-2026-08-01.md for the
// exact probe transcripts and sources. Do not add or modify a model ID in
// this file without the same live verification: Qdrant's own public docs
// do not enumerate the full model list (the docs point at the Cloud
// Console UI instead), so `costLabel`/`reason` text and `id` casing here
// are not safely guessable from documentation alone.
//
// `costTier`/`availabilityTier`/`languageNotes` are ADDITIVE fields (added
// alongside the pre-existing `costLabel`/`reason`, not renamed) — `reason`
// has two real production read sites (availability.js, embeddings.js)
// plus direct test assertions; renaming it mid-task for a cosmetic shape
// match was rejected as unnecessary risk for zero behavioral benefit.
export const QDRANT_CLOUD_DENSE_MODELS = Object.freeze([
  Object.freeze({
    id: 'intfloat/multilingual-e5-small',
    displayName: 'Multilingual E5 Small',
    vectorType: 'dense',
    modality: 'text',
    dimensions: 384,
    contextWindow: 512,
    costLabel: 'Free',
    costTier: 'free',
    availabilityTier: 'free',
    languageNotes: 'Multilingual (100+ languages, incl. Ukrainian).',
    status: 'supported',
    reason: null,
  }),
  Object.freeze({
    id: 'sentence-transformers/all-minilm-l6-v2',
    displayName: 'All MiniLM L6 v2',
    vectorType: 'dense',
    modality: 'text',
    dimensions: 384,
    contextWindow: 256,
    costLabel: 'Free',
    costTier: 'free',
    availabilityTier: 'free',
    languageNotes: 'English-tuned; usable but not optimized for other languages.',
    status: 'supported',
    // Previously excluded for a 256-token context window vs. the default
    // 512-token chunk budget — but chunking has been profile-aware ever
    // since resolveEmbeddingBudget() (qdrant-cloud-catalog.js) started
    // sizing chunks against the ACTIVE model's own contextWindow, not a
    // fixed global constant. A 256-token model is fully usable; it simply
    // produces smaller chunks. See isCatalogCompatibleWithChunking() below
    // for the (now near-universally-true) settings-time compatibility
    // check this reason text used to fail.
    reason: null,
  }),
  // status: 'planned' — real, live-confirmed model IDs (see the research
  // note), but gated to Qdrant Cloud's dedicated/paid cluster tier; a live
  // probe against a free-tier cluster returns HTTP 401 with a message
  // naming the model and stating the tier restriction explicitly (distinct
  // from an "unsupported model" 400 — see
  // cloud/admin/qdrant-cloud-system.js's classifyInferenceProbeError()). Never
  // returned by isDenseModelSupported()/any status==='supported' filter;
  // never selectable in the Settings UI. Promote to 'supported' only after
  // adding real per-cluster tier detection (out of scope for this task —
  // see the implementation report's "open limitations").
  Object.freeze({
    id: 'mixedbread-ai/mxbai-embed-large-v1',
    displayName: 'Mixedbread Embed Large v1',
    vectorType: 'dense',
    modality: 'text',
    dimensions: 1024,
    contextWindow: null, // not confirmed by this research pass — dedicated-tier only, not selectable regardless
    costLabel: 'Dedicated cluster required',
    costTier: 'dedicated',
    availabilityTier: 'dedicated',
    languageNotes: 'English-tuned; Matryoshka-truncatable to lower dimensions (not exposed by Semidex).',
    status: 'planned',
    reason: 'Requires a Qdrant Cloud dedicated/paid cluster tier — confirmed via a live probe (HTTP 401: "not allowed in free tier"). Not yet selectable: Semidex does not detect per-cluster tier.',
  }),
]);

export const QDRANT_CLOUD_SPARSE_MODELS = Object.freeze([
  Object.freeze({
    id: 'qdrant/bm25',
    displayName: 'BM25 (Qdrant-hosted)',
    vectorType: 'sparse',
    modality: 'text',
    dimensions: null,
    contextWindow: null,
    costLabel: 'Free',
    costTier: 'free',
    availabilityTier: 'free',
    languageNotes: 'Language-configurable stopwords/stemming (English default).',
    status: 'supported',
    reason: null,
    modifier: 'idf',
  }),
  // status: 'planned' — see the dense mxbai entry's comment above; same
  // dedicated-tier gating, same live-confirmed model ID and error shape.
  Object.freeze({
    id: 'prithivida/Splade_PP_en_v1',
    displayName: 'SPLADE++ EN v1',
    vectorType: 'sparse',
    modality: 'text',
    dimensions: null,
    contextWindow: 128, // doc sequence length (query is 24, asymmetric) — see research note
    costLabel: 'Dedicated cluster required',
    costTier: 'dedicated',
    availabilityTier: 'dedicated',
    languageNotes: 'English only.',
    status: 'planned',
    reason: 'Requires a Qdrant Cloud dedicated/paid cluster tier — confirmed via a live probe (HTTP 401: "not allowed in free tier"). Not yet selectable: Semidex does not detect per-cluster tier.',
  }),
]);

export function findDenseModel(id) {
  return QDRANT_CLOUD_DENSE_MODELS.find((m) => m.id === id) ?? null;
}

export function findSparseModel(id) {
  return QDRANT_CLOUD_SPARSE_MODELS.find((m) => m.id === id) ?? null;
}

export function isDenseModelSupported(id) {
  const model = findDenseModel(id);
  return model !== null && model.status === 'supported';
}

/**
 * Coarse, settings-time compatibility check: does this model's context
 * window fit Semidex's chunk budget in the best case (ignoring the
 * heading-path/skeleton-summary context that gets prepended at embed
 * time)? This can only ever rule OUT hopeless models (e.g. MiniLM's 256
 * tokens vs. a 512-token chunk budget) — it can never certify that every
 * future chunk will fit, since it never sees real chunk text. The real,
 * exact gate is checkEmbedInputFits() (qdrant-cloud-catalog.js), run per
 * chunk at embed time against the actual assembled string.
 * @param {{contextWindow: number|null}} model
 * @param {{maxChunkTokens: number}} opts
 * @returns {boolean}
 */
export function isCatalogCompatibleWithChunking(model, { maxChunkTokens }) {
  return model.contextWindow == null || model.contextWindow >= maxChunkTokens;
}
