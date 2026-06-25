# Private Agent Quiz Seed

**Date:** 2026-06-25  
**Status:** neutralized seed report, not a formal benchmark yet  
**Source material:** private external quiz transcript; source text is not copied
or identified here  
**Verdict:** `PRIVATE_AGENT_QUIZ_SEED_ACCEPT`

---

## 1. Purpose

This report records only aggregate observations from a private manual
agent-style quiz run. The original source material must not be committed,
quoted, reproduced, or used as a public benchmark fixture.

The value of this run is methodological: it shows how to turn a realistic
question-answering session into a future semidex benchmark without preserving
the private material itself.

---

## 2. Observed Outcome

| Metric | Value |
|--------|-------|
| Questions in transcript | 50 |
| Correct answers in transcript | 49 |
| Wrong answers in transcript | 1 |
| Accuracy | 98.0% |

The single failed answer was rechecked manually against semidex retrieval.
Follow-up validation showed that the relevant source was returned at rank 1 for
the natural-language query. With `window=1` and `window_format="compact"`, the
needed evidence was visible in a neighboring compact snippet.

Interpretation: the observed failure is best treated as an **agent evidence-use
error**, not as a retrieval miss. The agent likely selected a nearby distractor
from prose instead of using the stronger neighboring structured evidence.

---

## 3. What This Tells Us

This run is closer to an agent workflow test than to a retrieval benchmark.

The evaluated behavior is:

1. agent receives a question;
2. agent chooses MCP tools;
3. agent retrieves evidence;
4. agent selects an answer;
5. agent uses or ignores neighboring/structured evidence correctly.

This is different from `custom-50` style retrieval metrics, which evaluate
whether expected chunks appear at rank K. Both are useful, but they measure
different failure modes.

---

## 4. Skeleton Navigation Implication

The manual run reinforces a design point already seen in skeleton testing:

- skeleton summaries are useful for orientation and routing;
- retrieval chunks remain the evidence for factual answers;
- neighboring structural chunks can contain the decisive answer even when the
  matched prose chunk contains a plausible distractor.

So a future benchmark should not only ask "was the right chunk retrieved?" It
should also ask "did the agent use the right evidence after retrieval?"

---

## 5. Why This Is Not A Public Benchmark

Current limitations:

- The source quiz is private and cannot be published.
- The transcript records final correctness, but not a complete machine-readable
  trace of retrieved chunks, ranks, tool calls, and final evidence choice.
- The case set is mostly positive/answerable.
- Negative, distractor, and wrong-scope cases are not yet explicit.
- The run does not compare controlled workflows such as search-only vs
  skeleton-first.

The aggregate numbers may guide test design, but they should not be cited as a
public quality benchmark.

---

## 6. Neutral Benchmark Replacement

Instead of committing the private quiz, create a synthetic/open fixture that
preserves the same test shapes:

```text
benchmarks/retrieval/agent-quiz/
  fixtures/
    docs/
      ...
  queries.json
  run-agent-quiz.js
  README.md
```

Suggested query schema:

```jsonc
{
  "id": "aq-001",
  "type": "fact_lookup",
  "question": "Synthetic question text",
  "choices": ["A", "B", "C", "D"],
  "expectedAnswer": "C",
  "expectedFiles": ["docs/topic.md"],
  "expectedTokens": ["exact_identifier"],
  "relevantChunks": ["docs/topic.md#3"],
  "relevantNodes": [],
  "routeExpectation": {
    "mode": "search_or_skeleton",
    "expectedArea": "synthetic topic area"
  }
}
```

Keep qrels explicit after inspecting the generated fixture. Do not infer them
only from final answers.

---

## 7. Negative And Distractor Cases To Add

Add at least 10-15 negative or adversarial cases before using this benchmark for
quality decisions.

| Class | Purpose |
|-------|---------|
| Not in collection | Agent should refuse or state that evidence is missing. |
| Wrong scope | Agent should not answer from an unrelated area. |
| Close distractor | Agent must prefer exact evidence over nearby plausible prose. |
| Structured-neighbor answer | Answer is in a neighboring table/code/checklist chunk. |
| Compact-snippet risk | Compact output contains only partial evidence; agent must request more context when needed. |
| Ambiguous question | Agent should ask for clarification or present scoped alternatives. |
| External-current fact | Agent should not invent current facts not present in the collection. |
| Exact-token absent | Tests semantic fallback without relying on literal token overlap. |

---

## 8. Metrics To Track

Use separate metrics for retrieval and agent behavior:

| Metric | Meaning |
|--------|---------|
| answerAccuracy | final multiple-choice answer correctness |
| sourceHit@K | expected source file appears in retrieved evidence |
| chunkRecall@K / nodeRecall@K | expected chunk/node appears in results |
| skeletonRouteHit@K | skeleton workflow routes to expected area |
| evidenceUsePass | final answer uses the strongest available evidence |
| negativePass | agent refuses or scopes correctly for unanswerable cases |
| toolCallsPerQuestion | workflow cost |
| wallTimePerQuestion | latency |

Run at least two modes:

1. `search_only`: direct `qdrant_search` workflow.
2. `skeleton_first`: skeleton map first, then scoped search/get_chunk for
   evidence.

Do not merge these results. They answer different questions.

---

## 9. Recommended Next Steps

1. Do not commit the private quiz or direct derivatives of its wording.
2. Build a synthetic/open quiz fixture with the same failure modes.
3. Include positive, negative, distractor, and structured-neighbor cases.
4. Record retrieved sources, ranks, tool calls, final answers, and evidence
   choices.
5. Use this only after it can be repeated without relying on the private
   transcript.

---

## 10. Current Conclusion

The private run is useful as design evidence, not as benchmark data. It shows
that semidex can support realistic agent quiz workflows, and it exposes a real
agent-side risk: the answer can be available in retrieved evidence while the
agent still selects a nearby distractor.

The right follow-up is a neutral synthetic benchmark that tests the same
workflow failures without retaining private or third-party educational content.
