# Qdrant Cloud Inference — live capability spike (2026-07-21)

> Scope: capability/compatibility spike, not a production integration and not
> a retrieval-quality benchmark. It verifies that the API contract the two
> research docs describe
> (`docs/qdrant-cloud-inference-nodejs-research-2026-07-21.md`,
> `docs/sparse-retrieval-multilingual-fusion-research-2026-07-21.md`) actually
> works against a real Qdrant Cloud cluster through the installed
> `@qdrant/js-client-rest`.
>
> **The Recall@5 numbers below are NOT a quality result and do NOT name a
> winner.** The fixture is a handful of short synthetic documents built to make
> the API exercise each lane; it is far too small and too separable to
> differentiate configurations. Any winner claim requires the external,
> controlled benchmark the research docs specify.

## Artifacts and directory choice

| Artifact | Path |
|---|---|
| Spike script | `benchmarks/spikes/qdrant-cloud-inference-spike.mjs` |
| Synthetic fixture | `benchmarks/fixtures/qdrant-cloud-inference-spike.json` |
| This report | `benchmarks/results/2026-07-21-qdrant-cloud-inference-live-spike.md` |
| Machine-readable summary (account-anonymous) | `benchmarks/results/2026-07-21-qdrant-cloud-inference-live-spike.summary.json` |

The task named `benchmarks/spikes/`, `benchmarks/fixtures/`, `benchmarks/results/`.
The repo already has `benchmarks/retrieval/fixtures/` and
`benchmarks/retrieval/results/`, but those belong to the retrieval benchmark
suite (custom-50/150/large corpora, qrels, ranking matrices). This is a one-off
Cloud-API spike, not a retrieval benchmark, so the task-named top-level
directories were created rather than mixing spike output into the retrieval
suite.

## Environment

The spike stores **no account-specific endpoint**. The cluster ID label is
masked and only non-identifying facts are kept.

| Field | Value |
|---|---|
| Endpoint configured | yes |
| Scheme | https |
| Cloud provider | aws |
| Region | eu-central-1-0 |
| Masked host | `<cluster-id>.eu-central-1-0.aws.cloud.qdrant.io` |
| Data API key | configured (boolean; length not recorded) |
| Qdrant server version | **1.17.1** |
| `@qdrant/js-client-rest` | **1.18.0** |
| Dense model ID | `intfloat/multilingual-e5-small` |
| Dense vector size | **384** |
| Distance | Cosine |

Dense model facts supplied for the report (from the cluster's Inference tab;
this spike does not read a model-discovery API — none is exposed):

- **Cost:** Free
- **Vector type:** dense
- **Modality:** text
- **Context window:** **512 tokens**

### ⚠ 512-token context window — must-check for the future benchmark

`intfloat/multilingual-e5-small` truncates input at **512 tokens**. Semidex's
current `MAX_CHUNK_TOKENS` default allows a body chunk up to 512 tokens, and the
embedding text can additionally carry structural context (skeleton headings,
section context). That combined text can exceed 512 tokens, in which case Qdrant
Cloud Inference will silently truncate it — the token budget stays Semidex's
responsibility. This spike used short synthetic documents, so **no truncation
was triggered here**. A model-aware chunk-budget test and an explicit truncation
test are required in the real benchmark before adopting this dense model; both
are out of scope for a capability spike.

## Method

- Env (`QDRANT_URL`/`QDRANT_KEY`) via Semidex's own `bootstrapEnv()`; no `.env`
  change.
- Client built mirroring `src/core/qdrant/client.js`'s url/port/prefix parsing;
  no production code imported for behavior, only the pure `sanitiseErrorMessage`
  redaction helper — no provider abstraction.
- Dense config came **only** from `QDRANT_SPIKE_DENSE_MODEL` /
  `QDRANT_SPIKE_DENSE_SIZE`; nothing was guessed.
- One unique temporary collection `semidex-lite-spike-<iso-ts>-<random-hex>`;
  deleted in `finally`, guarded to only ever delete a name starting with
  `semidex-lite-spike-`.
- Fixed retrieval params for every mode: `top=5`, prefetch `limit=10`,
  no filters, `with_payload:false`.
- Fixed hybrid prefetch lane order: **[dense, bm25_multilingual]**; weighted-RRF
  weights map positionally to that order.
- All error text passes through redaction before console or report; no raw key,
  URL, cluster ID, or auth header appears in any artifact (verified).

### Two design corrections made during the spike

1. **`upsert` replaces a point's entire named-vector set** (verified directly
   against the cluster): re-upserting the same ID with only one named vector
   *drops* the others. The first run wrote one lane per pass over the same IDs
   and so wiped earlier lanes. Fixed by probing each lane on its **own**
   throwaway point (so a failure isolates exactly which lane broke — dense and
   bm25_multilingual now have **separate** probes), then writing every corpus
   point **once** carrying all supported vectors together. Reusable finding for
   future Semidex Lite indexing: write all named vectors for a point in a single
   upsert.
2. **Genuine update/delete verification.** The earlier version "added" a token a
   doc already contained and deleted a doc unrelated to the search term —
   neither proved anything. Now each check uses a **unique sentinel token**
   present in exactly one point, with before/after presence assertions.

## Capability matrix

| Capability | Result | Notes |
|---|:--:|---|
| Cluster reachable (`service.root`) | ✅ | server 1.17.1 |
| Create collection (named dense + 3 sparse lanes) | ✅ | 221 ms |
| Server-side dense inference on upsert (`{text, model}`) | ✅ | isolated dense probe, 558 ms |
| Server-side `qdrant/bm25` on upsert | ✅ | all three lanes, separate probes |
| `modifier: idf` on sparse vectors | ✅ | all three sparse lanes |
| BM25 `language:none`, `tokenizer:multilingual` | ✅ | accepted on upsert and query |
| BM25 `tokenizer:word` (language-neutral) | ✅ | accepted |
| BM25 `tokenizer:whitespace` (language-neutral) | ✅ | accepted |
| Dense query by text | ✅ | `using:'dense'` |
| Sparse query by text (each lane) | ✅ | `using:'bm25_*'` |
| Hybrid prefetch + RRF fusion | ✅ | dense + bm25_multilingual |
| RRF custom `k` (`k=2`, `k=60`) | ✅ | both accepted, scores differ (below) |
| Weighted RRF (`weights:[…]`) | ✅ | accepted; measurable effect (below) |
| Update one point — **verified** with sentinel token | ✅ | old token gone, new token present after |
| Delete one point — **verified** with sentinel token | ✅ | token matched before, absent after |
| Re-query after `wait:true` | ✅ | deleted sentinel absent |
| IDF-shift after delete (measured, not asserted) | ⚠ measured | see IDF section — score did **not** change here |
| Model discovery API | ❌ | none exposed — matches research |
| Secret / account-endpoint leakage | ✅ none | key boolean, cluster ID masked, no URL creds |

Total request errors during the run: **0**.

## Query results (rank of the expected doc)

Recall@5 over the 10 synthetic queries. A rank of 2 still counts as a top-5 hit
(hence Recall 10/10 for whitespace despite one rank-2 cell). **These are
contract-exercise numbers on a separable toy fixture, not quality signal.**

| Query | dense | bm25_ml | bm25_word | bm25_ws | hyb k2 | hyb k60 | hyb w[1,1] | hyb w[1,2] |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| q1 «Як налаштувати сервер?» | 1 | 1 | 1 | **2** | 1 | 1 | 1 | 1 |
| q2 «налаштування серверів» | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| q3 `QDRANT_URL` | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| q4 `MAX_CHUNK_TOKENS` | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| q5 `src/core/qdrant/store.js` | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| q6 `@qdrant/js-client-rest` | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| q7 `v1.17.1` | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| q8 `token-budgeted` | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| q9 «як виконати npm run sync» | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| q10 «налаштування Qdrant …» | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| **Recall@5** | 10/10 | 10/10 | 10/10 | **10/10** | 10/10 | 10/10 | 10/10 | 10/10 |

The single non-perfect *rank* (whitespace q1 = rank 2) is a tokenizer
observation, not a recall miss — see Tokenizer observations.

## Latency (per-query, ms; EU cluster, single client, single run)

| Mode | min | p50 | p95 | max |
|---|--:|--:|--:|--:|
| dense_only | 56 | 66 | 73 | 73 |
| bm25_multilingual_only | 47 | 57 | 60 | 60 |
| bm25_word_only | 44 | 49 | 63 | 63 |
| bm25_whitespace_only | 46 | 49 | 61 | 61 |
| hybrid_rrf_k2 | 57 | 60 | 66 | 66 |
| hybrid_rrf_k60 | 56 | 60 | 64 | 64 |
| hybrid_rrf_weighted_1_1 | 56 | 61 | 70 | 70 |
| hybrid_rrf_weighted_1_2 | 54 | 61 | 77 | 77 |

Write-path single-call latency: create collection 221 ms; isolated dense probe
(first server-side inference call) 558 ms; sparse probes ~50 ms; full corpus
write with all lanes 850 ms. Indicative single-sample numbers from one region /
one run, not a latency benchmark.

## RRF k=2 vs k=60

Same query (q3 `QDRANT_URL`), fused from identical prefetch lists — **identical
ranking, different fused-score magnitude**, exactly as Qdrant's zero-based
weighted-RRF formula predicts:

| Variant | top-1 fused score | ordering |
|---|--:|---|
| `rrf:{k:2}` | **1.0** | 4, 5, 15, 7, 8 |
| `rrf:{k:60}` | **0.0333** | 4, 5, 15, 7, 8 |

Confirms the research point that Semidex's `RRF_K=60` is **not** equivalent to
Qdrant's default `k=2`: on this fixture the ordering was identical but absolute
fused scores differ by ~30×. Whether k changes *ordering* (not just magnitude)
is dataset-dependent and must be measured on the real benchmark, not inferred
from this toy corpus where the target was unambiguous in both lanes. Absolute
RRF score is not treated as confidence anywhere.

## Weighted RRF

Same q3, prefetch order [dense, bm25_multilingual]:

| Weights [dense, bm25] | top-1 fused score |
|---|--:|
| `[1, 1]` | 1.0 |
| `[1, 2]` | **1.1667** |

Increasing the bm25 lane's weight measurably raised the fused score
(1.0 → 1.1667), confirming weighted RRF is honored through SDK 1.18.0 against a
1.17.1 server and applies in prefetch order. No incompatibility error.

## Update / delete observations (verified)

- **Delete** (point 101, unique token `ZZDELSENTINEL9137`, `wait:true`): the
  token matched point 101 **before** the delete and matched **nothing after** —
  `verified:true`, 47 ms.
- **Update** (point 102, `wait:true`): before-token `ZZUPDBEFORE4471` matched
  102 before and **not** after; after-token `ZZUPDAFTER8829` matched **nothing**
  before and matched 102 **after** — all four checks passed, `verified:true`,
  225 ms.
- **Re-query after `wait:true`**: the deleted sentinel token matched nothing —
  consistent.

## IDF-shift after delete (measured — the earlier claim was unproven)

The previous report asserted BM25 IDF statistics "adjusted after the delete
without re-embedding"; the script did not actually compare scores, so that claim
was removed. It is now **measured**: a shared token `ZZIDFSHARED5566` is present
in three docs (201, 202, 203); one (203) is deleted, and the **same surviving
doc (201)** is re-scored for the **same query** before and after.

| Field | Value |
|---|--:|
| Document frequency before delete | 3 |
| Document frequency after delete | 2 |
| Survivor (201) BM25 score before | 2.9513085 |
| Survivor (201) BM25 score after | 2.9513085 |
| Score changed | **no** (delta 0) |

**Honest reading:** the document frequency did drop (3 → 2), but the surviving
doc's returned BM25 score for the same query was **identical** immediately after
the delete within the same `wait:true` window. So this run does **not**
demonstrate an observable IDF recomputation in the returned scores — the
opposite of the earlier unproven claim. This may reflect index/statistics
refresh timing on this server version rather than a definitive statement that
IDF never recomputes; establishing that would need a dedicated timing/consistency
test. Reported as measured, no conclusion asserted beyond the numbers.

## Tokenizer observations

Identifier queries (q3–q8) all resolved at rank 1 in every BM25 lane and in
dense — including punctuation-heavy `src/core/qdrant/store.js`,
`@qdrant/js-client-rest`, `v1.17.1`, `token-budgeted`. On this small fixture the
exact-token lanes handled `/`, `@`, `-`, `.`, `_` well enough to top-rank the
intended doc over its close distractor.

The single non-perfect cell: for the natural-language q1 «Як налаштувати
сервер?», the **whitespace** tokenizer put the target (doc 1) at **rank 2**,
placing the client-side distractor (doc 3) at rank 1 — the two share «налаштувати»
and whitespace tokenization keeps surface forms more literally than the
multilingual tokenizer, which ranked doc 1 first. A real, reproducible tokenizer
difference; **not** evidence any tokenizer is better overall on such a small
fixture.

Ukrainian morphology (q2 «налаштування серверів», inflected plural) resolved at
rank 1 in every lane here, but the corpus is too small/separable to say anything
about real Ukrainian inflection recall — that stays a `HYPOTHESIS` for the
external benchmark.

## Errors and limitations

- No request errors (0).
- No model-discovery API — model ID/size/context window come from the Cloud
  Console, confirming the research finding.
- Server is **1.17.1**; weighted RRF (needs ≥1.17) worked. Older clusters could
  reject weighted RRF or custom `k` (≥1.16) — untested here.
- IDF recomputation was **not** observed in returned scores in this run (above);
  not a general conclusion.
- Single region, single client, single run; latency figures are indicative
  only. No concurrency, batch-size, or rate-limit (429) probing — out of scope,
  not run in parallel.
- The 512-token dense context window was not stress-tested (short synthetic
  docs); see the caveat.
- Only server-side `qdrant/bm25` was tested; no hosted learned-sparse model.

## Cleanup confirmation

Temporary collection
`semidex-lite-spike-2026-07-21T13-31-14-674Z-c7bcce29` was created and then
**deleted** in the `finally` block (guard: name starts with
`semidex-lite-spike-`). Console reported `cleanup: deleted`. No spike collection
remains.

Cleanup success now also **gates the verdict itself**, not just the process
exit code: `computeVerdict()` requires `cleanup.attempted && cleanup.deleted &&
!cleanup.error` as part of the full contract. A run where retrieval worked but
`deleteCollection()` failed can no longer report `ACCEPT` (previously it could
— the exit-code check and the recorded verdict were two independent, unlinked
signals). Verified by simulating a failed-cleanup summary against the same
gating expression: it correctly downgrades away from ACCEPT. Similarly,
`requery_after_wait` now requires `deletedTokenStillMatches === false`, not
just that the query call itself returned without error.

## Verdict

**`QDRANT_CLOUD_INFERENCE_SPIKE_ACCEPT`**

The verdict logic now requires the **full** claimed contract before ACCEPT (a
weaker rule previously allowed ACCEPT with a partially broken contract). ACCEPT
requires, all together:

- dense-only, bm25_multilingual-only, both hybrid `k` variants, **and** both
  weighted-RRF variants, each **fully run across every query** (ran = 10/10,
  not merely "ran > 0");
- **verified** update and **verified** delete (sentinel before/after);
- a re-query after `wait:true` that actually confirms the deleted sentinel is
  gone (`deletedTokenStillMatches === false`), not just that the query call
  itself succeeded;
- **zero** recorded request errors;
- **guaranteed cleanup** — the temporary collection was actually deleted, with
  no cleanup error. A leaked collection can never report ACCEPT, regardless of
  how well retrieval itself performed.

All held on this run. **ACCEPT means the contract works, not that the Lite stack
is better than local BGE-M3.** Naming a retrieval winner requires the external
controlled benchmark (identical corpus, chunking, qrels, filters, candidate
limits, metrics; BEIR/MIRACL controls; a dedicated Ukrainian technical set) from
the research docs — and, before adopting `intfloat/multilingual-e5-small`, an
explicit 512-token truncation / model-aware chunk-budget test.

## Reproduce

```bash
QDRANT_SPIKE_DENSE_MODEL='intfloat/multilingual-e5-small' \
QDRANT_SPIKE_DENSE_SIZE=384 \
node benchmarks/spikes/qdrant-cloud-inference-spike.mjs
```

Requires `QDRANT_URL` and `QDRANT_KEY` in the environment / `.env`. Omitting the
dense variables runs the BM25/sparse lanes standalone; the dense/hybrid contract
is then legitimately N/A, so the verdict is capped at
`QDRANT_CLOUD_INFERENCE_SPIKE_PARTIAL`.
