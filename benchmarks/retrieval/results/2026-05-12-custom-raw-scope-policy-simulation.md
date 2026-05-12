# custom-raw Scope Policy Simulation
**Date:** 2026-05-12  
**Source data:** 2026-05-12-clean-live-agent-review.md + custom-raw/queries.json  
**No MCP calls made. All judgements derived from existing live-review findings.**

---

## Policy Under Test

> If the query names a specific scope/entity/environment/model (staging, prod, OpenAI, GPT-4, ColBERT, git, metrics storage), answer only if retrieved evidence explicitly matches that same scope. If evidence is about a different scope, say "scope mismatch" and decline.

---

## Results

| ID | Query | Before policy | After policy | Pass/Fail | Reason | Query status |
|---|---|---|---|---|---|---|
| raw-neg-01 | What is the Qdrant timeout for the **staging** cluster? | FAIL — naive agent answers "5000ms" from prod evidence | PASS — policy triggers on "staging"; retrieved evidence references "qdrant-prod-svc", not staging; agent declines | **PASS** | Hard-scope-fail is the exact scenario the policy targets: query scope (staging) is absent from corpus, retrieved scope (prod) is present and named. Policy fires correctly. | Keep as-is — best test of the policy |
| raw-neg-02 | How to configure **ColBERT** late interaction? | PASS — no ColBERT token in top-5; agent already rejects | PASS — policy also triggers on "ColBERT"; no retrieved evidence mentions ColBERT; agent declines | **PASS** | Clean negative passes both with and without policy; policy adds an explicit label ("scope mismatch") but changes no outcome. | Keep as-is |
| raw-neg-03 | How to build a graph in **production**? | AMBIGUOUS — forbidden token "будови графа" present in rank-1 chunk (OOM crash trace); naive agent may answer | PARTIAL — policy triggers on "production"; corpus contains "semidex-prod" and "qdrant-prod-svc" so evidence does reference a production-scope token; policy may not fire | **FAIL** | The production scope term appears in the corpus (prod service names), so the policy condition "evidence matches that same scope" is satisfied by vocabulary overlap, not genuine relevance. Policy does not reliably prevent the false positive. | Rewrite recommended — the query is too broad; add corpusScopeTerms and tighten forbiddenTokens |
| raw-neg-04 | What is the token limit of **OpenAI GPT-4**? | PASS — no GPT-4 or "8k" token anywhere in top-5; agent already rejects | PASS — policy triggers on "OpenAI" / "GPT-4"; no retrieved evidence references either; agent declines | **PASS** | Clean negative; policy adds an explicit rejection label but does not change the outcome. | Keep as-is |
| raw-neg-05 | How to reindex using **git status**? | PASS — no "git" or "reindex" token in top-5; agent already rejects | PASS — policy triggers on "git"; no retrieved evidence references git; agent declines | **PASS** | Clean negative; same as raw-neg-02 and raw-neg-04. | Keep as-is |
| raw-neg-06 | Where are the **metrics** stored? | AMBIGUOUS — config-dump#0 contains "metrics.internal" in a telemetry push endpoint; naive agent may surface it | PARTIAL — policy triggers on "metrics storage"; retrieved evidence does contain "metrics.internal" (TELEMETRY_ENDPOINT); policy sees a scope match and may not fire | **FAIL** | The forbidden token "metrics.internal" appears in the corpus as a push endpoint URL, not a storage location. The policy cannot distinguish endpoint from storage without reading context — it pattern-matches the scope term and passes the evidence through. | Rewrite recommended — change query to "Where is the Prometheus metrics database hosted?" to eliminate the telemetry-endpoint overlap |

---

## Summary

| Outcome | Count | IDs |
|---|---|---|
| PASS (policy prevents false positive or confirms correct rejection) | 4 | raw-neg-01, raw-neg-02, raw-neg-04, raw-neg-05 |
| FAIL (policy does not reliably prevent false positive) | 2 | raw-neg-03, raw-neg-06 |

**The policy fully resolves the one hard live failure (raw-neg-01).** It has no effect on clean negatives (02, 04, 05) beyond adding an explicit label. It does not resolve the two ambiguous queries (03, 06) because both have scope-term vocabulary overlap in the corpus — the policy fires on the term match, not on genuine scope presence.

**Conclusion:** The scope policy is sufficient for the confirmed FAIL_FALSE_POSITIVE case. The two remaining soft failures require query rewrites, not policy changes.
