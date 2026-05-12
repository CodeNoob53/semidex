# custom-raw Distractor Discipline
**Date:** 2026-05-12  
**Collection:** bench-retrieval-custom-raw  
**Pattern:** qdrant_search(top=3, window=1, window_format="compact")

---

## Summary

| Outcome | Count |
|---|---|
| PASS_CLEAR | 0 |
| PASS_WITH_DISTRACTOR | 5 |
| FAIL_DISTRACTOR_SELECTED | 0 |
| AMBIGUOUS | 1 |

All 6 queries retrieve the correct source chunk at rank 1. No query fails outright. However, every result involves either an inline distractor or a co-located value that could mislead a non-careful agent.

---

## Results

| ID | Query | Top source | Chunk | Correct value | Distractor in chunk | Distractor labelled | Verdict | Reason |
|---|---|---|---|---|---|---|---|---|
| raw-noise-05 | ONNX_EMBED value in prod | raw-config-dump.txt | #0 | `ONNX_EMBED=1` | `Distractor: ONNX_EMBED=0` | Yes — "Distractor:" prefix | PASS_WITH_DISTRACTOR | Correct value appears first; distractor is explicitly prefixed. Careful agent reads `ONNX_EMBED=1` and ignores the labelled line. |
| raw-noise-06 | LLM_MODEL for context generation | raw-config-dump.txt | #0 | `LLM_MODEL=gemma3:4b` | `Distractor: LLM_MODEL=llama2` | Yes — "Distractor:" prefix | PASS_WITH_DISTRACTOR | Identical structure to ONNX_EMBED case; labelled distractor is clearly downstream of the correct assignment. |
| raw-exact-02 | WARN: Qdrant timeout after 5000ms | raw-mixed-incident-log.txt | #0 | `5000ms` | `Distractor: Qdrant timeout after 100ms.` | Yes — "Distractor:" prefix | PASS_WITH_DISTRACTOR | Correct value is in a WARN log line with BENCH_ANCHOR; distractor is labelled immediately after. Minor risk: another retrieved chunk (raw-config-dump.txt#0, rank 3) contains `"qdrant_timeout_ms": 10000` in the JSON config object — an unlabelled distinct value that could cause confusion (see Findings). |
| raw-noise-03 | agent context budget extremely tight | raw-agent-notes.txt | #0 | "extremely tight" / compact snippets | `Distractor: The agent context budget is unlimited. (False statement)` | Yes — "Distractor:" + "(False statement)" | PASS_WITH_DISTRACTOR | Double-labelled distractor is the strongest signal in the fixture set. Even a minimally careful agent will not pick the "(False statement)" value. |
| raw-para-06 | What is the token limit of our local language model? | raw-agent-notes.txt | #0 | "8k token limit of the local LLM" | `Distractor: We must use full snippets. (False statement)` | Yes — "Distractor:" + "(False statement)" | PASS_WITH_DISTRACTOR | The 8k limit is stated as a fact inside the correct sentence; the distractor is about snippet mode, not the token limit, so they answer different questions. No genuine value confusion, but the chunk is dense with adjacent concepts. |
| raw-noise-04 | use compact snippets | raw-agent-notes.txt | #0 | "We must use compact snippets for neighbor chunks" | `Distractor: We must use full snippets. (False statement)` | Yes — "Distractor:" + "(False statement)" | AMBIGUOUS | The correct statement and distractor are direct opposites on the same topic ("compact" vs "full"). The distractor is labelled, but the correct statement carries no reciprocal marker. A fast reader scanning for "full" or "compact" could pick either line without reading the label. This is the riskiest case in the set. |

---

## Findings

**1. Labelled distractors are sufficient for careful agents — today.**  
All 6 distractor instances use the `Distractor:` prefix. An agent explicitly instructed to ignore distractor-labelled values will not fail any of these queries. The instruction added to AGENTS.md covers this case.

**2. The compact-vs-full case (raw-noise-04) is the highest-risk distractor in the fixture.**  
The correct statement ("compact snippets") and the distractor ("full snippets") are grammatically parallel and both plausible. The only signal distinguishing them is the "Distractor:" label. If the label is absent — as it would be in real-world configs — an agent doing keyword extraction rather than careful reading would have a ~50% chance of selecting the wrong value.

**3. An unlabelled ambiguity exists in the Qdrant timeout query.**  
`raw-config-dump.txt#0` contains `"qdrant_timeout_ms": 10000` in the inline JSON config, while `raw-mixed-incident-log.txt#0` contains `Qdrant timeout after 5000ms` from an incident log. These are genuinely different values (configured timeout vs observed timeout). The config value is **not** labelled as a distractor because it is not one — it is real data from a different context. However, an agent querying "what is the Qdrant timeout?" could cite either value without being wrong, or could cite the wrong one for the queried context. This is a scope/context ambiguity, not a distractor problem.

**4. All fixture distractors are inline in the same chunk as the correct value.**  
No distractor appears only in a window neighbour. This means window=1 compact does not introduce new distractor risk — the risk is already present in the match chunk itself.

---

## Recommendations

**1. Are inline `Distractor:` labels enough for current fixtures?**  
Yes, for an agent following the distractor-awareness instruction. No, for a naïve agent doing lexical extraction. The fixtures are currently safe only because all distractors are labelled — remove the labels and at least 3 queries become genuinely dangerous (ONNX_EMBED, LLM_MODEL, compact-vs-full).

**2. Which queries would be dangerous without explicit distractor labels?**  
In order of risk: raw-noise-04 (compact vs full snippets — direct opposites, same syntax), raw-noise-05 (ONNX_EMBED=1 vs =0), raw-noise-06 (gemma3:4b vs llama2), raw-exact-02 (5000ms vs 100ms). These four involve value substitution where the distractor is plausible without the label.

**3. Should semidex add an agent instruction for stale/distractor values?**  
Yes — and it already has one in AGENTS.md ("Raw/unstructured chunks may contain distractors, stale values..."). No additional instruction is needed. The existing wording covers both labelled and unlabelled cases.

**4. Should future raw fixtures include unlabelled distractors?**  
Yes. The current labelled-distractor design tests agent reading discipline under ideal conditions. Real-world raw corpora (config dumps, runbooks, incident logs) contain stale values without labels. A future fixture variant with unlabelled distractors — or with distractors placed in commented-out lines, adjacent ENV_VAR blocks, or JSON sub-keys — would test whether the agent instruction alone is sufficient without the scaffold of explicit labels. This is the next realistic stress test for distractor discipline.
