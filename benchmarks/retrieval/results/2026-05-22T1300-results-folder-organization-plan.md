# Results Folder Organization Plan — 2026-05-22

## Executive Summary

The `benchmarks/retrieval/results/` folder contains ~123 files across `.md` and
`.txt` formats. A `results/archive/` subfolder already exists and is in use —
7 files were moved there in the current session (2026-05-22 combined-prompt-alignment
series, invalidated by a custom-50 `c48` qrel correction).

Based on MCP retrieval from `semidex-results` (1,507 points indexed) and static
analysis of ADR citations, the folder breaks into 9 clear categories. The main
concern is not the total file count but the density of intermediate/repeated runs
in the combined-LLM series — approximately 10–15 reports that are superseded by
later runs in the same investigation and provide no unique signal.

**No files are moved by this proposal.** This is analysis and proposal only.

---

## Verified Collection State

| Item | Value |
|------|-------|
| Collection | `semidex-results` |
| Provider | bge-m3-onnx / bge-m3-onnx |
| Points | 1,507 |
| Source file prefix | `benchmarks/retrieval/results/...` |
| Indexed via | `SOURCE_ROOT=.`, `TAG_GEN=0`, `ONNX_EMBED=1` |

---

## Proposed Folder Policy

No structural changes to the two-tier model (root / archive). The existing policy
in `results/README.md` is correct. The following refinements are proposed:

| Layer | Meaning | Criteria to stay here |
|-------|---------|----------------------|
| `results/` (root) | Current or still-decision-relevant | Valid qrels/methodology; cited by ADR or open investigation; most recent in its series |
| `results/archive/` | Historical — do not treat as current evidence | Superseded methodology; intermediate run in a series; wrong setup; qrel-invalidated |

**New rule to add:** when multiple same-topic runs exist (e.g., 7 combined-quality
runs from 2026-05-18), keep the final run and archive all earlier intermediate runs.
Exception: keep any run explicitly cited by an ADR or that contains a unique finding
not present in later runs.

---

## Category Map (MCP-evidence-backed)

| # | Category | File patterns | Count (approx) |
|---|----------|--------------|----------------|
| 1 | **Early baseline benchmarks** (8q/20q/21q; rerank v1/v2; MMR matrix) | `2026-05-09-*`, `2026-05-10-rerank*`, `2026-05-10-mmr*` | 10 `.txt` |
| 2 | **custom-50/150 retrieval quality** (tuning, threshold, failure analysis) | `2026-05-10-custom50-*`, `2026-05-10-custom-large*` | 7 `.txt` |
| 3 | **Cross-encoder / ColBERT rerankers** (CE v1–v4, ColBERT top-20/40) | `2026-05-15-*ce*`, `2026-05-16-*ce*`, `2026-05-16-*colbert*`, `2026-05-17-*colbert*` | 12 `.txt` |
| 4 | **ONNX batching, DML, CUDA, indexing performance** | `2026-05-17-onnx-*`, `2026-05-17-indexing-perf-*`, `2026-05-17-indexing-performance-*`, `2026-05-17-performance-bottleneck-*`, `2026-05-13-indexing-performance-*` | 9 `.md` |
| 5 | **Combined LLM quality** (context+tags, prompt policy, ablation, quality matrices) | `2026-05-17-combined-*`, `2026-05-17T*combined*`, `2026-05-18T*combined*`, `2026-05-18-combined-*`, `2026-05-18-section-window-*`, `2026-05-18T-custom150-*`, `2026-05-22T02*combined*`, `2026-05-22T03*combined*` + archive | ~25 `.md` |
| 6 | **Tag generation** (TAG_GEN ablation, tag model benchmark, tag-batch fallback, usefulness audit) | `2026-05-20-tag-*`, `2026-05-21T1833-tag-*`, `2026-05-22T00*tag*`, `2026-05-22T01*tag*` | 6 `.md` |
| 7 | **Custom-raw / live agent behavior** (scope, filter, negative, timeout, distractor) | `2026-05-11-*`, `2026-05-12-custom-raw-*`, `2026-05-12-clean-live-*`, `2026-05-12-positive-*` | ~14 `.md` + `.txt` |
| 8 | **Audits, design docs, link-building** | `2026-05-12-*audit*`, `2026-05-12-link-*`, `2026-05-14-*audit*`, `2026-05-14-*design*`, `2026-05-17-architecture-*`, `2026-05-17-link-*`, `2026-05-21T2221-*`, `2026-05-16-bge-m3-colbert-head-probe*` | 14 `.md` |
| 9 | **Snapshots and summary** | `link-equivalence-snapshot-*.json`, `summary.md`, `README.md` | 4 |

---

## Keep in Root — Table

Files that should remain in `results/` because they are the current/final signal
in their series or are cited by docs/ADRs.

| File / pattern | Why keep | Cited by ADR? |
|----------------|----------|---------------|
| `summary.md` | Rolling benchmark summary; entry point for agents | No (but README points to it) |
| `README.md` | Folder policy and navigation guide | No |
| `2026-05-09-bge-m3-onnx.txt`, `2026-05-09-ollama-hashed-tf.txt` | ADR 0001 decision evidence | **ADR 0001** |
| `2026-05-10-custom50-onnx-baseline.txt` | ADR 0001 decision evidence | **ADR 0001** |
| `2026-05-15-custom150-onnx-hybrid.txt` | ADR 0001 decision evidence | **ADR 0001** |
| `2026-05-10-rerank-matrix.txt` | ADR 0003 decision evidence | **ADR 0003** |
| `2026-05-10-mmr-matrix.txt` | ADR 0002 decision evidence | **ADR 0002** |
| `2026-05-16-bge-m3-colbert-head-probe.md` | ADR 0003 decision evidence | **ADR 0003** |
| `2026-05-16-custom50-ce-routing-v4-*` (custom-50 + custom-150) | ADR 0003 decision evidence — final CE routing version | **ADR 0003** |
| `2026-05-17-custom50-colbert-top40-*-official.txt` (both dates) | ADR 0003 decision evidence — final ColBERT run | **ADR 0003** |
| `2026-05-15-custom50-ce-bench-text.txt` | ADR 0003 baseline CE run | **ADR 0003** |
| `2026-05-14-mmr-mcp-opt-in-audit.md` | ADR 0002 decision evidence | **ADR 0002** |
| `2026-05-14-full-text-literal-search-audit.md` | ADR 0002 decision evidence | **ADR 0002** |
| `2026-05-17-combined-context-tags-feasibility.md` | ADR 0004 decision evidence (first feasibility; cited directly) | **ADR 0004** |
| `2026-05-17T2248-combined-llm-live-verification.md` | ADR 0004 decision evidence | **ADR 0004** |
| `2026-05-17T2333-combined-llm-custom50-quality.md` | ADR 0004 decision evidence — first custom-50 quality run | **ADR 0004** |
| `2026-05-18T0804-combined-llm-custom50-quality.md` | ADR 0004 decision evidence | **ADR 0004** |
| `2026-05-18T1010-qwen25-3b-combined-llm-custom50-quality.md` | ADR 0004 decision evidence — qwen vs gemma comparison | **ADR 0004** |
| `2026-05-18T-custom150-qwen25-combined-quality.md` | ADR 0004 decision evidence — custom-150 combined | **ADR 0004** |
| `2026-05-18-section-window-context-policy.md` | ADR 0004 decision evidence — section-window policy verdict | **ADR 0004** |
| `2026-05-18T1144-combined-llm-custom50-quality.md` | Final combined quality run on 2026-05-18; verdict PROCEED opt-in | No (post-ADR) |
| `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | Final prompt policy matrix run (qwen2.5); verdict `current-minimal` | No |
| `2026-05-17-architecture-blockers-audit.md` | ADR 0005 decision evidence | **ADR 0005** |
| `2026-05-14-self-docs-bootstrap-design.md` | ADR 0005 decision evidence | **ADR 0005** |
| `2026-05-20-tag-usefulness-audit.md` | Current TAG_GEN audit; TAG_GEN=0 flag motivation | No |
| `2026-05-20-tag-model-qwen25-separate-path.md` | TAG_MODEL benchmark; cites ADR 0004; current decision evidence | No |
| `2026-05-21T1833-tag-gen-ablation-custom50.md` | TAG_GEN latency/payload result; referenced by tag-usefulness-audit | No |
| `2026-05-22T0239-combined-parser-stability.md` | Parser stability — independent of c48 qrel; explicitly excluded from archive in README | No |
| `2026-05-22T0039-tag-batch-fallback-diagnostic.md` | First tag-batch diagnostic (root cause) | No |
| `2026-05-22T0129-tag-batch-fallback-diagnostic.md` | Second diagnostic — post-fix | No |
| `2026-05-22T0129-tag-batch-fallback-postfix-qwen25.md` | Post-fix comparison for qwen25 | No |
| `2026-05-12-clean-live-agent-review.md` | Definitive live agent review; conclusion used by several custom-raw reports | No |
| `2026-05-12-*custom-raw-*.md` (all 8) | Live agent behavior corpus — each tests a distinct policy dimension | No |
| `2026-05-14-duplicate-source-pressure-audit.md` | MMR/diversity analysis; verdict still current | No |
| `2026-05-14-diagnostic-bundle-design.md`, `2026-05-14-preflight-live-verification.md`, `2026-05-14-sync-link-filter-semantics-audit.md` | Design/verification docs; conclusions not qrel-dependent | No |
| `2026-05-17-link-dense-reuse-equivalence-design.md`, `2026-05-17-link-dense-reuse-patch-a-result.md` | Link-phase fix record; still relevant for link regression archaeology | No |
| `2026-05-17-dml-batching-production-wiring-design.md`, `2026-05-17-indexing-performance-live-summary.md` | DML wiring complete; summary still current decision record | No |
| `2026-05-21T2221-empty-section-live-verification.md` | Empty-section fix verification | No |
| `link-equivalence-snapshot-*.json` | Machine-readable snapshots for smoke equivalence | No |

---

## Archive Candidates — Table

Files that are intermediate runs, superseded by a later run in the same series,
or provide no unique signal beyond what later reports contain.

| File | Reason to archive | Replacement / current source | Confidence |
|------|-------------------|------------------------------|------------|
| `2026-05-09-bge-m3-onnx-20q.txt` | 20q variant; same verdict as `-bge-m3-onnx.txt` which ADR cites directly | `2026-05-09-bge-m3-onnx.txt` | High |
| `2026-05-09-ollama-hashed-tf-20q.txt` | 20q variant; same verdict as `-ollama-hashed-tf.txt` | `2026-05-09-ollama-hashed-tf.txt` | High |
| `2026-05-09-rerank-v1-compare.txt`, `2026-05-09-rerank-v2-compare.txt` | Superseded by controlled `2026-05-10-rerank-matrix.txt` (ADR 0003 cites matrix, not these) | `2026-05-10-rerank-matrix.txt` | Medium (ADR 0003 cites matrix; v1/v2 are earlier iterations) |
| `2026-05-10-custom50-candidate-comparison.txt`, `2026-05-10-custom50-threshold-sweep.txt`, `2026-05-10-custom50-tuning-matrix.txt`, `2026-05-10-custom50-diagnostics.txt`, `2026-05-10-custom50-failure-analysis.txt`, `2026-05-10-custom50-agent-policy.txt` | Pre-v3-qrel custom-50 tuning runs; methodology predates the current 50-query graded schema | None individually — collectively superseded by current custom-50 benchmark harness | Medium (old schema, but no explicit qrel-break documented) |
| `2026-05-10-custom-large.txt`, `2026-05-10-custom-large-failure-analysis.txt` | custom-large fixture abandoned in favour of custom-150 | `2026-05-15-custom150-onnx-hybrid.txt` | High |
| `2026-05-11-agent-window-eval.txt`, `2026-05-11-agent-window-eval-compact.txt`, `2026-05-11-agent-default-eval.txt` | Superseded by `2026-05-12-clean-live-agent-review.md` (definitive live review) | `2026-05-12-clean-live-agent-review.md` | High |
| `2026-05-11-custom-raw-baseline.txt`, `2026-05-12-custom-raw-baseline.txt`, `2026-05-12-custom-raw-k5-w1-negative-window.txt` | Raw baseline text dumps; conclusions folded into custom-raw `.md` series | Custom-raw `.md` series | High |
| `2026-05-15-custom50-rank1-analysis-hybrid.txt`, `2026-05-15-custom50-rank1-analysis-rerank.txt` | Intermediate rank-1 analysis leading to CE routing v3/v4; superseded | `2026-05-16-custom50-ce-routing-v4-*` | Medium |
| `2026-05-15-custom50-ce-bench-bge-v2-m3-q4-text-meta.txt`, `2026-05-15-custom50-ce-bench-bge-v2-m3-q4-text-section.txt` | BGE-v2-m3-q4 CE model eliminated in favour of mmarco-mminilmv2; intermediate | `2026-05-16-custom50-ce-routing-v4-*` | High |
| `2026-05-15-custom50-ce-bench-mmarco-mminilmv2-l12-h384-v1-text-meta.txt`, `2026-05-15-custom50-ce-bench-mmarco-mminilmv2-l12-h384-v1-text-section.txt` | Early CE routing iterations (v1); superseded by v3/v4 | `2026-05-16-custom50-ce-routing-v4-*` | High |
| `2026-05-15-custom50-ce-routing-mmarco-mminilmv2-l12-h384-v1.txt`, `2026-05-15-custom50-ce-routing-v3-*`, `2026-05-15-custom150-ce-routing-mmarco-*`, `2026-05-15-custom150-ce-routing-v2-*`, `2026-05-15-custom150-ce-routing-v3-*` | CE routing v1–v3 runs; superseded by v4 (final, ADR-cited) | `2026-05-16-*-ce-routing-v4-*` | High |
| `2026-05-15-bge-q4-ce-latency-probe.txt`, `2026-05-15-custom150-onnx-rerank.txt` | Intermediate probes; findings folded into ADR 0003 conclusion | ADR 0003 | High |
| `2026-05-16-custom50-colbert-top40-maxlen512-mean-official.txt` (2026-05-16 date only) | Superseded by same-named 2026-05-17 run with identical setup | `2026-05-17-custom50-colbert-top40-maxlen512-mean-official.txt` | High |
| `2026-05-17-custom50-colbert-top40-maxlen512-mean-no-eos.txt` | No-EOS variant eliminated; official policy chosen | `2026-05-17-custom50-colbert-top40-maxlen512-mean-official.txt` | High |
| `2026-05-17-combined-context-tags-feasibility.md` (plain date, no T time) | Duplicate of `2026-05-17T2122-combined-context-tags-feasibility.md`; both have identical first 15 lines; T2122 is the timestamped version | `2026-05-17T2122-combined-context-tags-feasibility.md` | High — **needs human eye-check first** |
| `2026-05-17T2122-combined-context-tags-feasibility.md` | Feasibility probe only (30 chunks); superseded as quality evidence by full custom-50 runs — BUT ADR 0004 cites the plain-date version; see note | ADR 0004 cites `2026-05-17-combined-context-tags-feasibility.md` — keep that one | Medium — do not archive until ADR is confirmed |
| `2026-05-18T0804-combined-llm-custom50-quality.md` (intermediate verdict: INVESTIGATE) | Earlier gemma3:4b run, verdict INVESTIGATE; superseded by T1010/T1048/T1054/T1144 progression | `2026-05-18T1144-combined-llm-custom50-quality.md` | Medium — ADR 0004 cites it; keep |
| `2026-05-18T1004-combined-llm-custom50-quality.md` | Intermediate run (INVESTIGATE verdict); same day as T1010 with identical setup | `2026-05-18T1010-combined-llm-custom50-quality.md` | High |
| `2026-05-18T1010-combined-llm-custom50-quality.md` | Intermediate run (INVESTIGATE verdict); superseded by T1048 → T1054 → T1144 | `2026-05-18T1144-combined-llm-custom50-quality.md` | High |
| `2026-05-18T1048-combined-llm-custom50-quality.md` | Intermediate (PROCEED opt-in with caution); superseded by T1054, T1144 | `2026-05-18T1144-combined-llm-custom50-quality.md` | High |
| `2026-05-18T1054-combined-llm-custom50-quality.md` | Intermediate (PROCEED opt-in); superseded by T1144 (last clean run) | `2026-05-18T1144-combined-llm-custom50-quality.md` | High |
| `2026-05-18T0919-combined-llm-prompt-policy-matrix.md` | gemma3:4b run; T0948 (qwen2.5) is the definitive cross-model run; same verdict | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | Medium |
| `2026-05-18T0950-combined-llm-prompt-policy-matrix.md` | qwen3:1.7b model; exploratory only; `current-minimal` still won | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | High |
| `2026-05-18T0951-combined-llm-prompt-policy-matrix.md` | qwen3:4b model; exploratory only; `current-minimal` still won | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | High |
| `2026-05-18T0954-combined-llm-prompt-policy-matrix.md` | phi4-mini model; exploratory only | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | High |
| `2026-05-18T1043-combined-llm-prompt-policy-matrix.md` | batiai/gemma4-e2b:q4 model; exploratory only | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | High |
| `2026-05-18T1044-combined-llm-prompt-policy-matrix.md` | gemma3:4b-it-qat model; exploratory only | `2026-05-18T0948-combined-llm-prompt-policy-matrix.md` | High |
| `2026-05-18T0045-combined-llm-hard-regressions.md`, `2026-05-18T0812-combined-llm-hard-regressions.md` | Regression diagnostics from early combined runs; root cause (tag quality) documented; findings folded into T1144 | `2026-05-18T1144-combined-llm-custom50-quality.md` | Medium |
| `2026-05-18-combined-llm-exact-token-tweak.md` | Prompt-tweak attempt (failed); documents dead end | (dead end) | Medium — keep if dead-end documentation is valued |
| `2026-05-17-onnx-true-batching-probe.md`, `2026-05-17-onnx-cuda-node-provider-research.md`, `2026-05-17-onnx-cuda-strict-probe-design.md` | Intermediate ONNX investigation steps; conclusions folded into `2026-05-17-onnx-batching-provider-comparison.md` and `2026-05-17-dml-batching-production-wiring-design.md` | Those two files | Medium |
| `2026-05-17-onnx-length-bucketed-batching.md` | CPU bucketed batching: 0.92× (DEFER); intermediate step before DML comparison | `2026-05-17-onnx-batching-provider-comparison.md` | High |
| `2026-05-17-indexing-perf-onnx-cpu-run1.md` | Run 1 of 3 CPU benchmark (preserved before overwrite); superseded by multi-run average in `-onnx-cpu.md` | `2026-05-17-indexing-perf-onnx-cpu.md` | High |
| `2026-05-13-indexing-performance-analysis.md` | Early performance analysis predating the ONNX batching investigation; superseded | `2026-05-17-indexing-performance-live-summary.md` | Medium |
| `2026-05-17-performance-bottleneck-audit.md` | Audit that fed the ONNX work; concluded/acted upon | `2026-05-17-architecture-blockers-audit.md` (final audit) | Medium |
| `2026-05-12-indexing-robustness-audit.md`, `2026-05-12-expanded-window-utility-audit.md`, `2026-05-12-positive-compact-window-smoke.md` | May-12 audits; conclusions were acted on (window=1 compact is now recommended default); still informative for archaeology but not current decision evidence | `2026-05-12-clean-live-agent-review.md` contains same conclusions | Low — keep; no urgency |

---

## Files Needing Human Review Before Archiving

| File | Issue |
|------|-------|
| `2026-05-17-combined-context-tags-feasibility.md` (plain date) | ADR 0004 links to this exact filename. If this file differs from `T2122`, both may need to stay. Verify they are identical before archiving either. |
| `2026-05-18T0804-combined-llm-custom50-quality.md` | ADR 0004 cites it directly. Even though verdict is INVESTIGATE, removing it breaks ADR traceability. Do not archive without updating ADR 0004. |
| `2026-05-18T0919-combined-llm-prompt-policy-matrix.md` | ADR 0004 does not cite this directly, but it is the same-day gemma3 run that led to the `current-minimal` decision. Check if any doc references it before archiving. |
| `2026-05-18-combined-llm-exact-token-tweak.md` | Documents a failed dead end. Archiving is fine, but it's short and records a useful negative finding — human judgement call. |
| Early May-10 custom-50 `.txt` files | Pre-date v3 qrel schema but no explicit schema-break documented. Archiving is correct if the qrel change is confirmed to have happened between 2026-05-10 and the v3 schema. |

---

## Proposed Updates to README Files

### `benchmarks/retrieval/results/README.md`

Add to **How To Navigate** table:

```
| Tag generation behavior  | `*tag*` reports, `2026-05-20-tag-usefulness-audit.md` first |
| Combined LLM decisions   | ADR 0004 cites list; post-ADR quality: `2026-05-18T1144-*` |
| Intermediate/superseded  | Check `archive/` — ~25 combined-LLM intermediate runs proposed for archiving |
```

Add to **Current Cleanup Status**:

```
~25 intermediate combined-LLM, reranker, and ONNX runs from 2026-05-15 to 2026-05-18
are proposed for archiving per `2026-05-22T1300-results-folder-organization-plan.md`.
No files moved yet. Human review required before acting on archive candidates marked
Medium or Low confidence.
```

### `benchmarks/retrieval/results/archive/README.md`

When archive candidates are acted on, add a batch note covering each of:

1. **2026-05-09 to 2026-05-10 intermediate `.txt` runs** — pre-ADR tuning iterations,
   superseded by ADR-cited files
2. **2026-05-15 to 2026-05-16 CE routing v1–v3** — superseded by v4 (ADR 0003)
3. **2026-05-17 intermediate ONNX probes** — superseded by batching provider comparison
   and DML wiring design
4. **2026-05-18 intermediate combined-LLM custom-50 quality runs** — T1004, T1010, T1048,
   T1054 superseded by T1144 (final PROCEED opt-in run)
5. **2026-05-18 prompt policy matrix non-decisive model runs** — T0919, T0950, T0951,
   T0954, T1043, T1044 all produced `current-minimal` verdict; T0948 (qwen2.5) is canonical

---

## Risks

| Risk | Mitigation |
|------|------------|
| Archiving an ADR-cited file breaks its evidence link | Do not archive any file in the "Needs Human Review" table without first verifying the ADR citation and optionally updating the ADR to point to the replacement |
| `2026-05-17-combined-context-tags-feasibility.md` duplicate ambiguity | Read both files, confirm content; if identical, ADR 0004 citation determines which survives in root |
| Early May-10 `.txt` qrel-break uncertainty | Confirm the custom-50 qrel schema version history before marking as superseded |
| Combined-LLM quality benchmarks still ongoing | c48 qrel fix is recent; post-fix reruns not yet complete. Do not archive any combined-quality report whose replacement rerun has not been written |
| `semidex-results` collection includes archive/ subdirectory | Archive files were indexed too (MCP evidence shows hits from `archive/` paths). This is correct — archived reports should remain searchable. No action needed. |

---

## Notes

- MCP evidence used: `semidex-results` collection, 8 targeted searches across all
  9 categories.
- ADR citation map derived by static grep of `docs/adr/*.md`.
- No files were moved in this task.
- `BENCH_COMBINED_CONTEXT_ONLY=1` is benchmark-only. Production default unchanged.

*Generated: 2026-05-22*
