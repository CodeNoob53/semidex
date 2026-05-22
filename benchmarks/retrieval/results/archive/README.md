# Retrieval Results Archive

This directory stores historical benchmark reports that are useful for audit
history, but should not be treated as current quality evidence.

Archive reports instead of deleting them when their inputs, qrels, labels, or
methodology are superseded. Keep current decision-making reports in
`benchmarks/retrieval/results/`.

Agents should read this README before opening archived reports. Open an archived
file only when you need historical comparison, regression archaeology, or the
exact old methodology.

## How To Use This Archive

| Need | Action |
|------|--------|
| Current benchmark quality | Use non-archived reports in `benchmarks/retrieval/results/`. |
| Compare against an older run | Use the table below to choose the archived file, then open only that file. |
| Understand why a report was archived | Read the `Archive reason` column first. |
| Rerun a superseded benchmark | Use the archived file only as historical baseline; write the new report outside `archive/`. |

## Archive Index

| File | Original purpose | Archive reason | Current replacement / next action | Open when |
|------|------------------|----------------|-----------------------------------|-----------|
| `2026-05-09-bge-m3-onnx-20q.txt` | 20-query BGE-M3 ONNX benchmark variant | 20q variant; same verdict as `2026-05-09-bge-m3-onnx.txt` which ADR 0001 cites directly | `2026-05-09-bge-m3-onnx.txt` | Comparing early 20q vs full-set run only |
| `2026-05-09-ollama-hashed-tf-20q.txt` | 20-query Ollama hashed-TF benchmark variant | 20q variant; same verdict as `2026-05-09-ollama-hashed-tf.txt` which ADR 0001 cites directly | `2026-05-09-ollama-hashed-tf.txt` | Comparing early 20q vs full-set run only |
| `2026-05-09-rerank-v1-compare.txt` | Reranker v1 comparison | Superseded by controlled `2026-05-10-rerank-matrix.txt`; ADR 0003 cites matrix, not v1/v2 | `2026-05-10-rerank-matrix.txt` | Reranker v1 raw output archaeology |
| `2026-05-09-rerank-v2-compare.txt` | Reranker v2 comparison | Superseded by controlled `2026-05-10-rerank-matrix.txt`; ADR 0003 cites matrix, not v1/v2 | `2026-05-10-rerank-matrix.txt` | Reranker v2 raw output archaeology |
| `2026-05-10-custom-large.txt` | custom-large fixture benchmark | custom-large fixture abandoned in favour of custom-150 | `2026-05-15-custom150-onnx-hybrid.txt` | Understanding abandoned large-fixture experiment |
| `2026-05-10-custom-large-failure-analysis.txt` | custom-large fixture failure analysis | custom-large fixture abandoned in favour of custom-150 | `2026-05-15-custom150-onnx-hybrid.txt` | Understanding abandoned large-fixture experiment |
| `2026-05-11-agent-window-eval.txt` | Agent window=2 evaluation | Superseded by `2026-05-12-clean-live-agent-review.md` (definitive live review) | `2026-05-12-clean-live-agent-review.md` | Comparing pre-compact-window agent behavior |
| `2026-05-11-agent-window-eval-compact.txt` | Agent compact window evaluation | Superseded by `2026-05-12-clean-live-agent-review.md` | `2026-05-12-clean-live-agent-review.md` | Comparing pre-compact-window agent behavior |
| `2026-05-11-agent-default-eval.txt` | Agent default window evaluation | Superseded by `2026-05-12-clean-live-agent-review.md` | `2026-05-12-clean-live-agent-review.md` | Comparing pre-compact-window agent behavior |
| `2026-05-11-custom-raw-baseline.txt` | May-11 raw baseline text dump | Raw text dump; conclusions folded into custom-raw `.md` series | Custom-raw `.md` series in `results/` | Raw query output before custom-raw harness |
| `2026-05-12-custom-raw-baseline.txt` | May-12 raw baseline text dump | Raw text dump; conclusions folded into custom-raw `.md` series | Custom-raw `.md` series in `results/` | Raw query output archaeology |
| `2026-05-12-custom-raw-k5-w1-negative-window.txt` | k=5 w=1 negative window raw dump | Raw text dump; conclusions folded into custom-raw `.md` series | Custom-raw `.md` series in `results/` | Raw k5/w1 parameter sweep output |
| `2026-05-15-custom50-rank1-analysis-hybrid.txt` | Rank-1 analysis for hybrid retrieval (custom-50) | Intermediate rank-1 analysis leading to CE routing v3/v4; superseded | `2026-05-16-custom50-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt` | Tracing rank-1 failure path to CE routing decision |
| `2026-05-15-custom50-rank1-analysis-rerank.txt` | Rank-1 analysis for rerank (custom-50) | Intermediate rank-1 analysis leading to CE routing v3/v4; superseded | `2026-05-16-custom50-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt` | Tracing rank-1 failure path to CE routing decision |
| `2026-05-15-custom50-ce-bench-mmarco-mminilmv2-l12-h384-v1-text-meta.txt` | CE routing v1 mmarco model text-meta variant (custom-50) | CE routing v1 iteration; superseded by v3/v4 final runs | `2026-05-16-custom50-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt` | Tracing CE routing v1 parameter exploration |
| `2026-05-15-custom50-ce-bench-mmarco-mminilmv2-l12-h384-v1-text-section.txt` | CE routing v1 mmarco model text-section variant (custom-50) | CE routing v1 iteration; superseded by v3/v4 final runs | `2026-05-16-custom50-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt` | Tracing CE routing v1 parameter exploration |
| `2026-05-15-custom50-ce-routing-v3-mmarco-mminilmv2-l12-h384-v1.txt` | CE routing v3 run (custom-50) | Superseded by v4 final run which ADR 0003 cites | `2026-05-16-custom50-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt` | Comparing v3 vs v4 CE routing decision |
| `2026-05-15-custom150-ce-routing-v2-mmarco-mminilmv2-l12-h384-v1.txt` | CE routing v2 run (custom-150) | Superseded by v4 final run which ADR 0003 cites | `2026-05-16-custom150-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt` | Comparing v2 vs v4 CE routing on custom-150 |
| `2026-05-15-custom150-ce-routing-v3-mmarco-mminilmv2-l12-h384-v1.txt` | CE routing v3 run (custom-150) | Superseded by v4 final run which ADR 0003 cites | `2026-05-16-custom150-ce-routing-v4-mmarco-mminilmv2-l12-h384-v1.txt` | Comparing v3 vs v4 CE routing on custom-150 |
| `2026-05-17-onnx-true-batching-probe.md` | ONNX true-batching feasibility probe | Intermediate ONNX investigation step; conclusions folded into `2026-05-17-onnx-batching-provider-comparison.md` | `2026-05-17-onnx-batching-provider-comparison.md` | Tracing ONNX batching investigation steps |
| `2026-05-17-onnx-cuda-node-provider-research.md` | ONNX CUDA node provider research | Intermediate investigation step; superseded by DML decision | `2026-05-17-dml-batching-production-wiring-design.md` | Tracing CUDA vs DML provider evaluation |
| `2026-05-17-onnx-cuda-strict-probe-design.md` | ONNX CUDA strict probe design | Intermediate investigation step; superseded by DML decision | `2026-05-17-dml-batching-production-wiring-design.md` | Tracing CUDA strict probe design rationale |
| `2026-05-17-onnx-length-bucketed-batching.md` | CPU length-bucketed batching: 0.92× result | CPU bucketed batching deferred (0.92×); intermediate step before DML comparison | `2026-05-17-onnx-batching-provider-comparison.md` | Checking why CPU bucketed batching was rejected |
| `2026-05-17-indexing-perf-onnx-cpu-run1.md` | ONNX CPU indexing perf — run 1 of 3 | Preserved before overwrite; superseded by multi-run average in `2026-05-17-indexing-perf-onnx-cpu.md` | `2026-05-17-indexing-perf-onnx-cpu.md` | Checking per-run variance for CPU baseline |
| `2026-05-18T1004-combined-llm-custom50-quality.md` | Combined-LLM custom-50 quality (INVESTIGATE verdict) | Intermediate run; same setup as T1010, both superseded by T1144 final run | `2026-05-18T1144-combined-llm-custom50-quality.md` | Checking T1004 vs T1010 run-to-run variance |
| `2026-05-18T1010-combined-llm-custom50-quality.md` | Combined-LLM custom-50 quality (INVESTIGATE verdict) | Intermediate run; superseded by T1048 → T1054 → T1144 progression | `2026-05-18T1144-combined-llm-custom50-quality.md` | Tracing INVESTIGATE→PROCEED opt-in progression |
| `2026-05-18T1048-combined-llm-custom50-quality.md` | Combined-LLM custom-50 quality (PROCEED opt-in with caution) | Intermediate run; superseded by T1054, T1144 | `2026-05-18T1144-combined-llm-custom50-quality.md` | Tracing INVESTIGATE→PROCEED opt-in progression |
| `2026-05-18T1054-combined-llm-custom50-quality.md` | Combined-LLM custom-50 quality (PROCEED opt-in) | Intermediate run; superseded by T1144 (last clean run) | `2026-05-18T1144-combined-llm-custom50-quality.md` | Comparing T1054 vs T1144 final run |
| `2026-05-18T0950-combined-llm-prompt-policy-matrix.md` | Prompt policy matrix — qwen3:1.7b model | Exploratory model run; `current-minimal` verdict same as canonical T0948 (qwen2.5) | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | Checking qwen3:1.7b vs qwen2.5 prompt policy behavior |
| `2026-05-18T0951-combined-llm-prompt-policy-matrix.md` | Prompt policy matrix — qwen3:4b model | Exploratory model run; `current-minimal` verdict same as canonical T0948 | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | Checking qwen3:4b prompt policy behavior |
| `2026-05-18T0954-combined-llm-prompt-policy-matrix.md` | Prompt policy matrix — phi4-mini model | Exploratory model run; `current-minimal` verdict same as canonical T0948 | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | Checking phi4-mini prompt policy behavior |
| `2026-05-18T1043-combined-llm-prompt-policy-matrix.md` | Prompt policy matrix — batiai/gemma4-e2b:q4 model | Exploratory model run; `current-minimal` verdict same as canonical T0948 | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | Checking gemma4-e2b prompt policy behavior |
| `2026-05-18T1044-combined-llm-prompt-policy-matrix.md` | Prompt policy matrix — gemma3:4b-it-qat model | Exploratory model run; `current-minimal` verdict same as canonical T0948 | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | Checking gemma3:4b-it-qat prompt policy behavior |
| `2026-05-22T1012-combined-llm-quality-matrix.md` | Pre-alignment `COMBINED_LLM=1` custom-50 quality matrix for gemma3/qwen2.5 | Generated before custom-50 `c48` qrel fix; may misclassify c48 retrieval quality | Rerun `npm run bench:custom50:combined-matrix` after qrel fix | Comparing pre-fix combined quality only |
| `2026-05-22T1036-combined-context-only-ablation.md` | Pre-alignment context-only ablation for combined mode | Generated before custom-50 `c48` qrel fix | Rerun `npm run bench:custom50:context-only-ablation` after qrel fix | Comparing pre-fix context-only hypothesis only |
| `2026-05-22T1117-combined-llm-quality-matrix.md` | First post-alignment combined quality matrix | Generated before custom-50 `c48` qrel fix; c48 was counted as a hard regression in this run | Rerun combined matrix after qrel fix | Checking run-to-run variance before qrel correction |
| `2026-05-22T1126-combined-context-only-ablation.md` | First post-alignment context-only ablation | Generated before custom-50 `c48` qrel fix | Rerun context-only ablation after qrel fix | Checking why the context-only verdict briefly flipped |
| `2026-05-22T1143-combined-llm-quality-matrix.md` | Second post-alignment combined quality matrix | Generated before custom-50 `c48` qrel fix | Rerun combined matrix after qrel fix | Comparing post-alignment variance against T1117 |
| `2026-05-22T1152-combined-context-only-ablation.md` | Second post-alignment context-only ablation | Generated before custom-50 `c48` qrel fix | Rerun context-only ablation after qrel fix | Comparing post-alignment variance against T1126 |
| `2026-05-22T1200-combined-prompt-alignment-verification.md` | Summary report comparing pre/post prompt alignment runs | Summary is based on pre-fix `c48` qrels and archived raw reports | Write a fresh verification report after reruns | Understanding the deprecated prompt-alignment conclusion |

## Batch Notes

### 2026-05-22 First High-Confidence Cleanup Batch

Batch moved 33 files based on `benchmarks/retrieval/results/2026-05-22T1300-results-folder-organization-plan.md`.
Only high-confidence candidates with no ADR or `docs/en/` citations were moved.
Medium/low-confidence candidates and files needing human review remain in `results/`.

**Groups moved:**

1. **2026-05-09 early 20q variants and rerank v1/v2** — ADR 0001 and ADR 0003 cite the canonical
   runs directly; 20q variants and pre-matrix rerank comparisons provide no unique signal.

2. **2026-05-10 custom-large fixture** — fixture abandoned in favour of custom-150; no doc cites it.

3. **2026-05-11/05-12 agent-eval text dumps and custom-raw raw baselines** — conclusions folded
   into the definitive `2026-05-12-clean-live-agent-review.md` and custom-raw `.md` series.

4. **2026-05-15 CE routing intermediate runs (custom-50 and custom-150)** — rank-1 analysis,
   v1 mmarco CE bench runs, v3 routing runs (custom-50), v2/v3 routing runs (custom-150);
   all superseded by v4 final runs (ADR 0003 cited files).
   Note: `custom50-ce-bench-bge-v2-m3-q4-*`, `custom50-ce-routing-mmarco-*`,
   `custom150-ce-routing-mmarco-*`, `bge-q4-ce-latency-probe.txt`, and
   `custom150-onnx-rerank.txt` were **skipped** because `docs/en/retrieval.md` or
   `docs/en/benchmarking.md` cite them directly.

5. **2026-05-17 ONNX intermediate probes** — true-batching probe, CUDA node/strict probe designs,
   length-bucketed batching result, and cpu-run1 single-run snapshot; all superseded by
   `2026-05-17-onnx-batching-provider-comparison.md` and `2026-05-17-dml-batching-production-wiring-design.md`.

6. **2026-05-18 intermediate combined-LLM custom-50 quality runs** — T1004, T1010, T1048, T1054;
   all superseded by T1144 (final PROCEED opt-in run).

7. **2026-05-18 prompt policy matrix non-decisive model runs** — T0950 (qwen3:1.7b), T0951
   (qwen3:4b), T0954 (phi4-mini), T1043 (gemma4-e2b:q4), T1044 (gemma3:4b-it-qat); all produced
   `current-minimal` verdict; T0948 (qwen2.5) is the canonical cross-model run.

**Files skipped from this batch (cited by docs/en/):**

| File | Cited in |
|------|----------|
| `2026-05-15-custom150-onnx-rerank.txt` | `docs/en/benchmarking.md:285`, `docs/en/retrieval.md:157` |
| `2026-05-15-custom150-ce-routing-mmarco-mminilmv2-l12-h384-v1.txt` | `docs/en/benchmarking.md:315`, `docs/en/retrieval.md:512` |
| `2026-05-15-bge-q4-ce-latency-probe.txt` | `docs/en/retrieval.md:332` |
| `2026-05-15-custom50-ce-bench-bge-v2-m3-q4-text-meta.txt` | `docs/en/retrieval.md:381` |
| `2026-05-15-custom50-ce-bench-bge-v2-m3-q4-text-section.txt` | `docs/en/retrieval.md:382` |
| `2026-05-15-custom50-ce-routing-mmarco-mminilmv2-l12-h384-v1.txt` | `docs/en/retrieval.md:460` |
| `2026-05-16-custom50-colbert-top40-maxlen512-mean-official.txt` | `docs/en/benchmarking.md:467` |
| `2026-05-17-custom50-colbert-top40-maxlen512-mean-no-eos.txt` | `docs/adr/0003-rerankers-default-off.md:58`, `docs/en/benchmarking.md:468` |

These 8 files remain in `results/` until their referencing docs are updated or the citations are removed.

### 2026-05-22 Combined Prompt Alignment Reports

The custom-50 `c48` qrel was corrected after these reports were generated. The
old qrel treated `multilingual.md#3` as the primary relevant chunk for:

```text
cross-lingual retrieval Ukrainian query English document BGE-M3
```

Manual inspection showed that `multilingual.md#4` is the direct answer because
it explicitly describes a Ukrainian query matching an English document through
BGE-M3. The old reports may therefore overstate or misclassify `c48`
regressions.

After the qrel fix, rerun the affected custom-50 combined benchmarks and write a
new non-archived report.

## Agent Archiving Rules

Archive a report when:

- benchmark qrels, fixtures, query labels, or metric definitions changed;
- the report was a draft/superseded summary and a later report replaces it;
- the report used a known flawed setup, provider mismatch, wrong env, or stale collection;
- the report remains useful for history but should not guide current decisions.

Do not archive:

- current reports that remain valid for decision-making;
- diagnostic/design reports whose conclusions do not depend on the changed qrels;
- private raw outputs or corpus dumps. Keep those under `.tmp/` and do not commit them.

When archiving:

1. Move the report into `benchmarks/retrieval/results/archive/`.
2. Add or update a row in `Archive Index`.
3. Fill all columns: file, original purpose, archive reason, replacement/next action, and when to open it.
4. Add a batch note if several files share the same reason.
5. If the file was already tracked, stage both the deletion from `results/` and the new file under `archive/`.
6. Run `git diff --check`; CRLF warnings on Windows are acceptable.
