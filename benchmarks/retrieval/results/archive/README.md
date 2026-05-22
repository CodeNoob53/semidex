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
| `2026-05-22T1012-combined-llm-quality-matrix.md` | Pre-alignment `COMBINED_LLM=1` custom-50 quality matrix for gemma3/qwen2.5 | Generated before custom-50 `c48` qrel fix; may misclassify c48 retrieval quality | Rerun `npm run bench:custom50:combined-matrix` after qrel fix | Comparing pre-fix combined quality only |
| `2026-05-22T1036-combined-context-only-ablation.md` | Pre-alignment context-only ablation for combined mode | Generated before custom-50 `c48` qrel fix | Rerun `npm run bench:custom50:context-only-ablation` after qrel fix | Comparing pre-fix context-only hypothesis only |
| `2026-05-22T1117-combined-llm-quality-matrix.md` | First post-alignment combined quality matrix | Generated before custom-50 `c48` qrel fix; c48 was counted as a hard regression in this run | Rerun combined matrix after qrel fix | Checking run-to-run variance before qrel correction |
| `2026-05-22T1126-combined-context-only-ablation.md` | First post-alignment context-only ablation | Generated before custom-50 `c48` qrel fix | Rerun context-only ablation after qrel fix | Checking why the context-only verdict briefly flipped |
| `2026-05-22T1143-combined-llm-quality-matrix.md` | Second post-alignment combined quality matrix | Generated before custom-50 `c48` qrel fix | Rerun combined matrix after qrel fix | Comparing post-alignment variance against T1117 |
| `2026-05-22T1152-combined-context-only-ablation.md` | Second post-alignment context-only ablation | Generated before custom-50 `c48` qrel fix | Rerun context-only ablation after qrel fix | Comparing post-alignment variance against T1126 |
| `2026-05-22T1200-combined-prompt-alignment-verification.md` | Summary report comparing pre/post prompt alignment runs | Summary is based on pre-fix `c48` qrels and archived raw reports | Write a fresh verification report after reruns | Understanding the deprecated prompt-alignment conclusion |

## Batch Notes

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
