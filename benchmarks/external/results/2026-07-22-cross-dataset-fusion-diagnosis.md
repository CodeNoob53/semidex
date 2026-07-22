# Cross-dataset fusion diagnosis — BEIR SciFact vs MIRACL Russian

Verdict: **FUSION_DATASET_DEPENDENT**

This is an **offline diagnostic analysis** of hybrid (RRF) fusion behavior,
built entirely from already-completed BEIR SciFact and MIRACL Russian
benchmark runs. No ONNX, no Qdrant, no network, no indexing ran to produce
this report — see `../fusion/README.md` for the strict offline guarantee
and why no RRF `k` value is reconstructed locally from saved TREC files
(the saved dense/sparse lanes are capped at top-100, while real Qdrant
hybrid requests used prefetch 200 — an incomplete-candidate-pool replay
would never be equivalent to what Qdrant actually returned). Every number
below comes from a `hybrid_k*` TREC file that a live Qdrant hybrid query
actually produced.

Every scope's recomputed aggregate metrics were checked against the
originally-committed JSON reports within a `1e-6` floating-point
tolerance — see `../fusion/analyze-fusion.test.mjs`'s "metric parity"
suite. All five scopes passed.

## Scopes analyzed (kept strictly separate)

| Scope | Queries | Modes available |
|---|---:|---|
| SciFact full — local BGE-M3 (common-512) | 300 | dense, sparse, hybrid_k60 |
| SciFact full — Qdrant Cloud E5+BM25 (common-512) | 300 | dense, sparse, hybrid_k2, hybrid_k60 |
| SciFact LOCAL MINI (100q/1000d pooled subset) — **not full SciFact** | 100 | dense, sparse, hybrid_k2, hybrid_k60 |
| MIRACL Russian pooled subset — local | 100 | dense, sparse, hybrid_k2, hybrid_k60 |
| MIRACL Russian pooled subset — cloud | 100 | dense, sparse, hybrid_k2, hybrid_k60 |

SciFact full local has no `hybrid_k2` row because the full BEIR harness
never ran the local profile at `k=2` — only the mini-set did. That gap in
the original data is preserved here, not filled in.

## Aggregate metrics

| Scope | Mode | nDCG@10 | MAP@100 | Recall@10 | Recall@100 | Precision@10 | MRR@10 |
|---|---|---:|---:|---:|---:|---:|---:|
| SciFact full local | dense | 0.6380 | 0.5958 | 0.7718 | 0.9070 | 0.0867 | 0.6044 |
| SciFact full local | sparse | 0.6344 | 0.5921 | 0.7663 | 0.9036 | 0.0853 | 0.6008 |
| SciFact full local | hybrid_k60 | **0.6778** | 0.6423 | 0.7919 | 0.9303 | 0.0890 | 0.6508 |
| SciFact full cloud | dense | 0.6785 | 0.6371 | 0.8066 | 0.9243 | 0.0903 | 0.6472 |
| SciFact full cloud | sparse | 0.6585 | 0.6169 | 0.7890 | 0.8852 | 0.0870 | 0.6225 |
| SciFact full cloud | hybrid_k2 | **0.7078** | 0.6641 | 0.8459 | 0.9537 | 0.0943 | 0.6717 |
| SciFact full cloud | hybrid_k60 | 0.6977 | 0.6601 | 0.8209 | 0.9550 | 0.0923 | 0.6658 |
| SciFact mini local | dense | 0.6748 | 0.6285 | 0.8260 | 0.9600 | 0.0980 | 0.6324 |
| SciFact mini local | sparse | 0.6836 | 0.6478 | 0.7980 | 0.9480 | 0.0950 | 0.6573 |
| SciFact mini local | hybrid_k2 | 0.6976 | 0.6662 | 0.8005 | 0.9580 | 0.0950 | 0.6747 |
| SciFact mini local | hybrid_k60 | 0.6931 | 0.6552 | 0.8155 | 0.9580 | 0.0970 | 0.6635 |
| MIRACL local | dense | **0.8995** | 0.8385 | 0.9851 | 1.0000 | 0.2830 | 0.9163 |
| MIRACL local | sparse | 0.7526 | 0.6794 | 0.8898 | 0.9817 | 0.2590 | 0.7466 |
| MIRACL local | hybrid_k2 | 0.8460 | 0.7705 | 0.9802 | 1.0000 | 0.2810 | 0.8283 |
| MIRACL local | hybrid_k60 | 0.8346 | 0.7602 | 0.9652 | 1.0000 | 0.2770 | 0.8278 |
| MIRACL cloud | dense | **0.8420** | 0.7630 | 0.9802 | 1.0000 | 0.2810 | 0.8323 |
| MIRACL cloud | sparse | 0.5696 | 0.4779 | 0.7373 | 0.8554 | 0.2150 | 0.5766 |
| MIRACL cloud | hybrid_k2 | 0.7613 | 0.6703 | 0.9522 | 1.0000 | 0.2690 | 0.7213 |
| MIRACL cloud | hybrid_k60 | 0.7130 | 0.6328 | 0.8604 | 1.0000 | 0.2470 | 0.7276 |

**Bold** marks the best-scoring mode in each scope. On every SciFact scope
(full local, full cloud, mini) the best mode is a hybrid. On both MIRACL
scopes the best mode is dense-only, by a wide margin.

## Paired bootstrap: dense vs sparse channel strength

This is the single most informative comparison in the whole analysis — it
measures whether the two channels are roughly evenly matched or whether
one dominates:

| Scope | meanDelta (sparse − dense) | 95% CI | Verdict |
|---|---:|---|---|
| SciFact full local | −0.0036 | [−0.0362, +0.0298] | **MIXED** (CI includes 0 — evenly matched) |
| SciFact full cloud | −0.0200 | [−0.0576, +0.0180] | **MIXED** (CI includes 0 — evenly matched) |
| SciFact mini local | +0.0088 | [−0.0491, +0.0629] | **MIXED** (CI includes 0 — evenly matched) |
| MIRACL local | **−0.1469** | [−0.1978, −0.0972] | **A_BETTER** (dense significantly stronger) |
| MIRACL cloud | **−0.2723** | [−0.3339, −0.2109] | **A_BETTER** (dense significantly stronger) |

On every SciFact scope, dense and sparse are statistically indistinguishable
in strength (CI straddles zero). On both MIRACL scopes, dense is far and
significantly stronger than sparse — the MIRACL cloud gap (−0.27 nDCG@10)
is roughly 7× the size of any SciFact dense/sparse gap and the CI does not
come close to zero.

## Relevant-document overlap (top-10, per scope, aggregated across queries)

| Scope | dense-only hits | sparse-only hits | both hits | neither hit |
|---|---:|---:|---:|---:|
| SciFact full local | 26 | 22 | 234 | 57 |
| SciFact full cloud | 36 | 26 | 235 | 42 |
| SciFact mini local | 8 | 5 | 90 | 15 |
| MIRACL local | **25** | **1** | 258 | 6 |
| MIRACL cloud | **72** | **6** | 209 | 3 |

Each row's four counts are **relevant document–query pairs** (a query with
3 qrels-positive passages contributes up to 3 to that row's total), not
query counts — MIRACL local's row sums to 290 such pairs (25+1+258+6),
MIRACL cloud's to the same 290 (same qrels, different TREC runs), SciFact
full local's to 339 (26+22+234+57), and so on.

On SciFact, `denseOnlyHits` and `sparseOnlyHits` are roughly the same
order of magnitude (26 vs 22, 36 vs 26, 8 vs 5) — sparse is finding a
meaningfully large set of relevant documents dense misses, and vice versa.
On MIRACL, `sparseOnlyHits` collapses to almost nothing (1 of 290 relevant
document–query pairs on local, 6 of 290 on cloud) while `denseOnlyHits`
stays large (25, 72) — sparse is contributing almost no relevant evidence
dense doesn't already have, while dense alone already covers nearly everything
sparse covers plus a large exclusive set of its own.

## Rescue vs harm counts (hybrid vs dense, per query, by nDCG@10)

| Scope | Hybrid mode | Rescue | Harm | Tie |
|---|---|---:|---:|---:|
| SciFact full local | hybrid_k60 | **70** | 32 | 198 |
| SciFact full cloud | hybrid_k2 | **57** | 50 | 193 |
| SciFact full cloud | hybrid_k60 | **65** | 49 | 186 |
| SciFact mini local | hybrid_k2 | **20** | 15 | 65 |
| SciFact mini local | hybrid_k60 | **23** | 12 | 65 |
| MIRACL local | hybrid_k2 | 15 | **43** | 42 |
| MIRACL local | hybrid_k60 | 17 | **43** | 40 |
| MIRACL cloud | hybrid_k2 | 18 | **60** | 22 |
| MIRACL cloud | hybrid_k60 | 16 | **59** | 25 |

Rescue exceeds harm on every SciFact scope/mode. Harm exceeds rescue by a
wide margin on every MIRACL scope/mode (roughly 3× on local, roughly 3.5×
on cloud).

## Oracle max(dense, sparse) upper bound — diagnostic only, never a target

| Scope | Best hybrid nDCG@10 achieved | Oracle max(dense, sparse) | Headroom vs best hybrid |
|---|---:|---:|---:|
| SciFact full local | 0.6778 | 0.7185 | +0.0407 |
| SciFact full cloud | 0.7078 | 0.7691 | +0.0613 |
| SciFact mini local | 0.6976 | 0.7583 | +0.0607 |
| MIRACL local | 0.8460 | 0.9172 | +0.0712 |
| MIRACL cloud | 0.7613 | 0.8631 | +0.1018 |

The oracle is an **unachievable upper bound** (it requires knowing, per
query, which channel will do better — no real fusion policy has that
information in advance). It is shown only to make one fact visible: on
MIRACL, dense ALONE (0.8995 local, 0.8420 cloud) already exceeds every
actually-achieved hybrid result, and even the oracle ceiling (which
requires per-query channel selection) is barely above dense-only on
MIRACL local (0.9172 vs 0.8995 dense) — there is very little headroom
sparse could contribute even in the best case. On SciFact the oracle
ceiling sits meaningfully above both dense-only and the best real hybrid,
consistent with sparse carrying real, currently-underexploited signal.

## Representative query-level cases

Query IDs and rank movement only — no passage text, no local paths.
"Best relevant rank" = the 1-based rank of the highest-ranked relevant
document in that mode's result list (`null` = no relevant document
appeared in the top-100 for that mode).

### Sparse rescues dense (hybrid nDCG@10 > dense nDCG@10)

| Scope | Query | Dense best relevant rank | Hybrid best relevant rank | nDCG@10 delta |
|---|---|---:|---:|---:|
| SciFact full local (hybrid_k60) | 532 | none in top-100 | 1 | +1.000 |
| SciFact full local (hybrid_k60) | 300 | 11 | 2 | +0.631 |
| SciFact full local (hybrid_k60) | 1200 | 19 | 2 | +0.631 |
| SciFact full cloud (hybrid_k2) | 294 | 90 | 1 | +1.000 |
| SciFact full cloud (hybrid_k60) | 70 | 4 | 1 | +0.656 |
| MIRACL local (hybrid_k2) | 1463 | 2 | 1 | +0.369 |
| MIRACL cloud (hybrid_k2) | 288 | 3 | 1 | +0.500 |

### Sparse causes hybrid to rank worse than dense (harm)

| Scope | Query | Dense best relevant rank | Hybrid best relevant rank | nDCG@10 delta |
|---|---|---:|---:|---:|
| SciFact full local (hybrid_k60) | 690 | 1 | 13 | −1.000 |
| SciFact full local (hybrid_k60) | 1088 | 1 | 7 | −0.667 |
| SciFact full cloud (hybrid_k60) | 800 | 1 | 16 | −1.000 |
| SciFact full cloud (hybrid_k60) | 1241 | 1 | 30 | −1.000 |
| MIRACL local (hybrid_k60) | 6532 | 1 | 4 | −0.704 |
| MIRACL local (hybrid_k60) | 630 | 1 | 8 | −0.685 |
| MIRACL cloud (hybrid_k60) | 2199 | 1 | 18 | −1.000 |
| MIRACL cloud (hybrid_k60) | 2523 | 1 | 20 | −1.000 |

The harm pattern on MIRACL is structurally different from SciFact: a
document already ranked **#1 by dense** (the highest possible confidence)
gets pushed to rank 4–20 by fusion. This is not "hybrid missed something
dense also missed" — it is fusion actively demoting a document dense was
already correct about, because RRF's rank-based fusion formula gives
sparse's (much noisier, on MIRACL) ranking real influence on the combined
score regardless of how much weaker that channel is in aggregate.

## Answers

### 1. Why hybrid helped or remained useful on SciFact

**FACT:** On every SciFact scope (full local, full cloud, mini), the best
mode is a hybrid mode, and rescue count exceeds harm count.
**FACT:** The paired dense-vs-sparse bootstrap comparison is `MIXED` (CI
includes zero) on every SciFact scope — dense and sparse are statistically
indistinguishable in aggregate strength there.
**FACT:** `denseOnlyHits` and `sparseOnlyHits` are the same order of
magnitude on SciFact (e.g. 26 vs 22 on full local) — sparse is
contributing a real, non-trivial set of relevant documents dense misses.

**INFERENCE:** When two channels are roughly evenly matched in strength
AND each contributes a meaningfully-sized set of relevant documents the
other misses, RRF fusion has genuine complementary signal to combine. The
representative rescue cases (queries 532, 300, 1200 on the **local
BGE-M3** profile; 294, 70 on the **Qdrant Cloud** profile — dense finds
nothing or ranks the relevant document very low, the sparse/hybrid lane
finds it at rank 1–2) show this mechanism directly, but the two profiles'
sparse lanes are **not the same algorithm** and should not be described
with one label:

- The **local** profile's sparse lane is BGE-M3's own learned lexical
  weights (`src/core/onnx-embed.js`), not BM25 — it is a neural
  term-importance model trained jointly with the dense encoder, not
  classic term-frequency lexical matching.
- The **cloud** profile's sparse lane is Qdrant's server-side `qdrant/bm25`
  — genuine classic BM25 term-frequency/exact-match scoring.

Both lanes show the same qualitative pattern on SciFact (roughly
dense-matched strength, real complementary relevant-document coverage),
but the *mechanism* by which each surfaces a document dense misses differs:
BM25 (cloud) plausibly benefits from literal term overlap on distinctive
query vocabulary; BGE-M3 learned sparse (local) is not doing raw term
matching, so its complementary hits more likely come from a different
inductive bias in its learned token-importance weighting rather than exact
lexical overlap. This report has not inspected actual term/token matches
per query to confirm the local-profile mechanism specifically — it is
inferred from the aggregate pattern, not directly observed.

### 2. Why dense beat hybrid on MIRACL

**FACT:** The dense-vs-sparse paired bootstrap comparison is `A_BETTER`
(dense significantly stronger, CI excludes zero) on both MIRACL scopes,
with a much larger effect size than any SciFact comparison (−0.147 local,
−0.272 cloud, vs at most ±0.02 on SciFact).
**FACT:** `sparseOnlyHits` collapses to nearly zero on MIRACL (1 of 290
relevant document–query pairs on local, 6 of 290 on cloud) while
`denseOnlyHits` stays large (25, 72 of the same 290) — sparse is not
contributing meaningfully-sized complementary relevant-document coverage
on this dataset.
**FACT:** Harm count exceeds rescue count by roughly 3× on every MIRACL
scope/mode, and the representative harm cases show documents already
ranked #1 by dense being pushed to rank 4–20 by fusion.

**INFERENCE:** RRF fusion combines two rankings using only their relative
rank positions, not their absolute confidence or quality. When one channel
(sparse, here) is both much weaker in aggregate AND rarely contributes
unique relevant documents, RRF still grants it real influence over the
combined ranking purely because it produces *a* ranking — and on MIRACL
that ranking is frequently wrong enough to actively demote correct dense
results. This dense-dominance pattern holds on **both** MIRACL profiles —
**local** (BGE-M3 learned sparse, `A_BETTER` at −0.147) and **cloud**
(Qdrant's `qdrant/bm25`, `A_BETTER` at −0.272, the larger of the two
effect sizes) — so it is not solely a BM25-specific artifact. For the
cloud profile specifically, one plausible contributing factor is
`qdrant/bm25`'s `tokenizer:multilingual` behavior on Cyrillic morphology
(untested here); for the local profile, the same weak-sparse-channel
pattern would instead implicate BGE-M3's learned lexical weights
specifically on Russian query/passage pairs, which is a different
mechanism with a different fix if confirmed. This report does not have
direct evidence isolating either tokenizer/model quality from
corpus/query characteristics as the specific cause on either profile —
that would require inspecting the actual per-query sparse-lane matches for
each profile separately, which is out of scope for this diagnosis (see
"additional evidence required" below).

### 3. Whether k=2 is consistently better than k=60

**FACT:** `k2_vs_k60` bootstrap results across all four (profile, dataset)
combinations that have both k values (`meanDelta = k2 − k60`; positive
means k2 scored higher):

| Scope | Verdict | meanDelta (k2 − k60) |
|---|---|---:|
| SciFact full cloud | MIXED | +0.0101 |
| SciFact mini local | MIXED | +0.0045 |
| MIRACL local | MIXED | +0.0115 |
| MIRACL cloud | **B_BETTER (k2)** | +0.0483 (i.e. k2 significantly better) |

**FACT:** Only MIRACL cloud shows a bootstrap-significant `k=2` advantage;
every other scope is `MIXED` (not bootstrap-distinguishable).

**No, k=2 is not consistently better than k=60 across scopes.** It is
significantly better in exactly one of the four measured scopes (MIRACL
cloud) and statistically indistinguishable from k=60 everywhere else. The
MIRACL cloud result is consistent with the same mechanism as answer #2:
`k=60` gives the weaker/noisier sparse channel comparatively more
influence on the fused rank than `k=2` does (larger `k` flattens the
rank-based weighting curve — see the RRF formula in the earlier Qdrant
Cloud Inference research), so on a scope where sparse actively drags
dense down, a smaller `k` (which limits sparse's rank-based leverage more
sharply) does less damage. That is a **HYPOTHESIS about mechanism**, not
confirmed by this analysis alone — it would need a controlled sweep over
more `k` values on real Qdrant hybrid queries to verify the shape of that
relationship, which this diagnosis does not attempt (per the task's
explicit prohibition on reconstructing arbitrary `k` values offline).

### 4. Whether sparse should stay enabled by default

**This report does not recommend changing the production `RRF_K` default,
and does not conclude sparse should be disabled.** The evidence is
genuinely dataset-dependent:

- On SciFact (English), sparse is roughly as strong as dense and
  contributes real complementary relevant-document coverage — disabling
  it would very likely cost real recall/nDCG on English-language content
  resembling SciFact.
- On MIRACL (Russian), sparse is dramatically weaker than dense and
  contributes almost no unique relevant coverage, while measurably
  dragging down an already-strong dense ranking through fusion — keeping
  hybrid enabled with the current fusion settings has a real, measured
  cost on this dataset.

**HYPOTHESIS:** the right lever may not be "sparse on/off" globally but
something dataset/language-aware (e.g. a different fusion constant or a
confidence-weighted fusion for languages where the sparse lane is known to
be weak) — but this analysis has not tested any such policy, only
observed the problem it would need to solve.

### 5. What exact additional evidence is required before changing production fusion

1. **A controlled RRF k sweep run live against Qdrant** (not reconstructed
   offline) across at least 3–4 k values on both MIRACL and a
   non-SciFact/non-MIRACL third dataset, to check whether the "smaller k
   limits sparse damage" pattern from answer #3 generalizes or is
   MIRACL-cloud-specific noise.
2. **Direct inspection of the MIRACL cloud profile's `qdrant/bm25`
   term-match quality** — e.g. whether the `tokenizer:multilingual`
   setting is under-tokenizing Cyrillic morphology, producing
   systematically noisy sparse rankings independent of corpus content —
   to distinguish a tokenizer/configuration problem (fixable) from an
   inherent dense-dominance-on-Russian-Wikipedia pattern (not fixable by
   retokenizing).
3. **A parallel inspection of the MIRACL local profile's BGE-M3 learned
   sparse weights** on the same queries — since the local profile shows
   the same dense-dominance pattern using a completely different sparse
   mechanism (no BM25 tokenizer involved), confirming or ruling out
   whether BGE-M3's learned lexical weighting is itself weaker on Russian
   than on English (its training-data language balance is a plausible but
   unconfirmed factor) is necessary before concluding the cloud-specific
   BM25 tokenizer explanation from point 2 is the primary cause rather
   than a secondary contributor.
4. **A second non-English, non-Russian dataset** (ideally the Ukrainian
   dataset this whole research program is ultimately for) to check whether
   the MIRACL pattern is Russian-specific, multilingual-in-general, or an
   artifact of this particular pooled-subset corpus's document
   distribution.
5. **A same-language, different-domain comparison** to separate "does
   sparse help on Russian" from "does sparse help on Russian Wikipedia
   specifically" — MIRACL's corpus is Wikipedia passages, and sparse-lane
   behavior (both BM25 and BGE-M3 learned sparse) can differ substantially
   on more technical/specialized text.
6. **Confirmation the rescue/harm asymmetry replicates on the full
   1252-query MIRACL dev split**, not just the 100-query pooled subset —
   this diagnosis's MIRACL scopes are both drawn from the same 100-query
   subset used in the original MIRACL benchmark, which is itself a subset
   of the full dev split (see `../miracl/README.md`).

## Interpretation limits

- FACT: every number in this report was recomputed fresh from committed
  TREC run files and matches the originally-reported JSON metrics within
  `1e-6`.
- FACT: no RRF k value in this report was reconstructed by locally
  replaying saved top-100 dense/sparse TREC files — every hybrid number
  comes from a TREC file a live Qdrant hybrid query actually produced.
- FACT: the SciFact "mini" scope is a 100-query/1000-document pooled
  subset, not the full 300-query SciFact benchmark — its numbers are
  never merged with or presented as full-SciFact results anywhere above.
- HYPOTHESIS: the proposed mechanism (RRF granting a weak sparse channel
  undue rank-based influence) is a reasonable explanation consistent with
  every measured fact above, but this report does not isolate it from
  alternative explanations (e.g. BM25 tokenizer misconfiguration
  specifically, or MIRACL Russian Wikipedia's document distribution
  specifically) — see "additional evidence required" above.
- This report does not recommend changing the production `RRF_K` default.
- No general Semidex-wide winner should be inferred from this analysis
  alone; it is diagnostic, not a benchmark verdict for either provider.
