# Qdrant Cloud Inference — model contract research note

Date verified: 2026-08-01. Methodology: web documentation search (official
Qdrant docs, blog, tutorial) **plus live empirical probing against the
user's real dev Qdrant Cloud cluster** (disposable collections, created
and deleted immediately) — the live probe is the higher-confidence source
wherever it conflicts with documentation, since Qdrant's official docs
explicitly state the authoritative model list "depends on a provider" and
is only fully enumerated in the Cloud Console UI, not in static docs.

## Key finding: official docs do not enumerate the full model list

`https://qdrant.tech/documentation/cloud/inference/` explicitly states:
"You can see the list of supported models in the Inference tab of the
Cluster Detail page in the Qdrant Cloud Console" — the static docs
describe *categories* (dense/sparse/multimodal) and give a few *example*
model names, not an exhaustive, versioned catalog. The launch blog post
(`qdrant.tech/blog/qdrant-cloud-inference-launch/`) states Qdrant shipped
"six curated models at launch": two dense (`all-MiniLM-L6-v2`,
`mxbai/embed-large-v1`), two sparse (`splade-pp-en-v1`, `bm25`), and
CLIP-style models for image+text. **`intfloat/multilingual-e5-small` is
not mentioned in any documentation source found** — but it IS live and
working on the real cluster (see below), so either (a) it was added after
the "six curated models" launch post, or (b) it's available but
undocumented. Either way, this is decisive live evidence and the existing
codebase's claim that E5 is supported is correct, not a bug.

## JS client (`@qdrant/js-client-rest@1.18.0`) contract — confirmed from installed types

`node_modules/@qdrant/js-client-rest/dist/types/openapi/generated_schema.d.ts`:

```ts
Document: {
  text: string;      // input text for the embedding model
  model: string;      // "Name of the model used to generate the vector.
                       //  List of available models depends on a provider."
                       // @example "jinaai/jina-embeddings-v2-base-en"
  options?: DocumentOptions | Record<string, unknown> | null;
};
DocumentOptions: Record<string, unknown> | Bm25Config;
Bm25Config: { k?, b?, avg_len?, tokenizer?, language?, lowercase?,
              ascii_folding?, stopwords?, stemmer?, min_token_len?,
              max_token_len? };  // BM25-specific options only take
                                  // effect when model === 'qdrant/bm25'
```

Vector fields accept a `Document`/`Image`/`InferenceObject` union directly
in place of a raw number array — this is the exact mechanism
`qdrant-cloud-catalog.js`/`store.js` already use. The schema still marks
`Document`/`Image` as `"WARN: Work-in-progress, unimplemented"` in its own
doc comment (a stale annotation — live probing confirms `Document` with a
dense model is fully implemented and working for real inference).

## Confirmed models (live probe against real Qdrant Cloud cluster, 2026-08-01)

Method: `createCollection` with the target vector size, then `upsert` one
point with `vector: { <name>: { text: '...', model: '<id>' } }`. A
dimension-mismatch error on a deliberately wrong size confirms the model
ID is valid and reports the real output size; a clean upsert at the
correct size confirms end-to-end success; a `401`/`400` from the
inference service (not Qdrant's own point-shape validation) distinguishes
"real model, tier-gated" from "unrecognized model ID."

| Model ID (exact, case-sensitive) | Type | Result | Dimensions | Tier |
|---|---|---|---|---|
| `intfloat/multilingual-e5-small` | dense | ✅ works | 384 (confirmed via dimension-mismatch error) | free |
| `sentence-transformers/all-minilm-l6-v2` | dense | ✅ works | 384 (confirmed) | free |
| `qdrant/bm25` | sparse | ✅ works | n/a (sparse) | free |
| `mixedbread-ai/mxbai-embed-large-v1` | dense | ⚠️ real model, rejected | 1024 (per HF model card, Matryoshka-truncatable) | **dedicated only** — live 401: `"This model: mixedbread-ai/mxbai-embed-large-v1 is not allowed in free tier"` |
| `prithivida/Splade_PP_en_v1` | sparse | ⚠️ real model, rejected | n/a (sparse, ~30522-dim BERT vocab space per HF card) | **dedicated only** — live 401: `"This model: prithivida/Splade_PP_en_v1 is not allowed in free tier"` |
| `Qdrant/Splade_PP_en_v1` (alternate casing/namespace) | sparse | ❌ NOT a valid ID | — | live 400: `"Unsupported model: qdrant/splade_pp_en_v1"` — confirms the correct namespace is the original HuggingFace one (`prithivida/...`), not a Qdrant-remapped one |

The `mixedbread-ai/mxbai-embed-large-v1` and `prithivida/Splade_PP_en_v1`
401 responses are genuinely distinguishable from "unrecognized model" —
Qdrant's own error message names the exact model and states the tier
restriction, versus the `Qdrant/Splade_PP_en_v1` case, which got a
different error shape entirely (`"Bad request: ... Unsupported model:
..."`) with no tier language. This is the concrete evidence behind the
task's requirement to "not treat 403/400 as absence without normalizing
the Qdrant error contract" — the two failure modes are already
structurally different in the API's own response, not just in casing.

## Context windows (from official model cards, not from Qdrant docs, which don't state this per-model)

| Model | Max sequence length (tokens) | Source |
|---|---|---|
| `intfloat/multilingual-e5-small` | 512 | intfloat's own HF model card: "Long texts will be truncated to at most 512 tokens." |
| `sentence-transformers/all-minilm-l6-v2` | 256 | sentence-transformers' own HF model card / SentenceTransformer's own reported `Max Sequence Length: 256` |
| `prithivida/Splade_PP_en_v1` | 128 (doc) / 24 (query) — asymmetric | model author's own README: differs from official SPLADE++, uses separate doc(128)/query(24) sequence lengths |
| `mixedbread-ai/mxbai-embed-large-v1` | not confirmed in this research pass (not in current implementation scope) | — |

No live probe can determine context window empirically without access to
truncation-detection (embedding two texts that differ only past N tokens
and checking for identical output) — out of scope for this research pass
given free-tier-only access; the documented values above are used as-is,
matching how the existing codebase already records E5's 512 and (now)
MiniLM's 256.

## Document/query descriptor format

Confirmed identical for both roles (embedding a stored chunk vs. embedding
a search query) — `{text, model, options?}`; no separate "query" vs.
"document" descriptor type exists in the schema (unlike some embedding
APIs that require an `input_type` field). BM25's `options` accepts
`Bm25Config` (k/b/avg_len/tokenizer/language/etc.) only when
`model === 'qdrant/bm25'`; other models accept an opaque
`Record<string, unknown>` passed through to the provider as-is — no
provider API key is required from the Semidex side for any of the models
tested (Qdrant Cloud's own API key is the only credential involved; the
inference service itself is proxied/hosted by Qdrant).

## Sources

- [Qdrant Cloud Inference docs](https://qdrant.tech/documentation/cloud/inference/) — category overview, states the full model list lives in the Console UI only.
- [Introducing Qdrant Cloud Inference (blog)](https://qdrant.tech/blog/qdrant-cloud-inference-launch/) — "six curated models at launch," free-tier token quotas (5M text, 1M image, unlimited BM25).
- [Hybrid Search Using Qdrant Cloud Inference (tutorial)](https://qdrant.tech/documentation/tutorials-basics/cloud-inference-hybrid-search/) — exact code snippets confirming `sentence-transformers/all-minilm-l6-v2` and `qdrant/bm25` as the tutorial's own dense/sparse model IDs, consistent across every language SDK shown.
- `node_modules/@qdrant/js-client-rest/dist/types/openapi/generated_schema.d.ts` (installed v1.18.0) — `Document`/`Image`/`InferenceObject`/`Bm25Config` type definitions.
- [intfloat/multilingual-e5-small (HF)](https://huggingface.co/intfloat/multilingual-e5-small) — 512-token max sequence length, 384 dimensions.
- [sentence-transformers/all-MiniLM-L6-v2 (HF)](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) — 256-token max sequence length, 384 dimensions.
- [mixedbread-ai/mxbai-embed-large-v1 (HF)](https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1) — 1024 dimensions, Matryoshka-truncatable.
- [prithivida/Splade_PP_en_v1 (HF)](https://huggingface.co/prithivida/Splade_PP_en_v1) — doc(128)/query(24) asymmetric sequence lengths, bert-base-uncased-initialized (30522 vocab).
- Live probes against the user's real dev Qdrant Cloud cluster (2026-08-01, this session) — see table above; each probe created and deleted a disposable collection, never touched an existing collection.
