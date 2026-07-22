# BEIR SciFact input preparation validation

Verdict: **BEIR_SCIFACT_INPUT_PREPARATION_ACCEPT**

This report validates only the provider-neutral input preparation stage for
the SciFact provider comparison. It does not contain retrieval-quality
results and made no Qdrant API calls.

## Dataset

- Official BEIR SciFact archive, verified against MD5
  `5f7d1de60b170fc8027bb7898e2efca1` before extraction.
- 5,183 corpus documents.
- 300 test queries.
- 0 dangling qrels references.

## Correctness

The `common-512` body is prepared once and reused byte-for-byte by both
provider profiles. Model-specific formatting is applied only at the
embedding boundary:

| Profile/lane | Document input | Query input |
|---|---|---|
| Local BGE-M3 dense | raw prepared body | raw prepared body |
| Local BGE-M3 sparse | raw prepared body | raw prepared body |
| Qdrant E5 dense | `passage: ` + body | `query: ` + body |
| Qdrant BM25 sparse | raw prepared body | raw prepared body |

Validation of the generated cache:

- Documents requiring truncation: 742 / 5,183.
- Queries requiring truncation: 0 / 300.
- Maximum stored BGE-M3 count: 509 tokens.
- Maximum stored E5 count including its role prefix: 511 tokens.
- Truncated-document distribution by the stricter tokenizer:
  min 490, p50 510, p90 511, p95 511, max 511 tokens.
- 729 / 742 truncated documents retain at least 500 tokens.
- 0 truncated documents remain below 480 tokens.
- 0 provider-neutral cached bodies contain an E5 role prefix.
- Word-boundary truncation is used; no text is cut in the middle of a word.

The E5 tokenizer has a hard 512-token model limit. A bounded count of exactly
512 is therefore treated conservatively as ambiguous/overflow and shortened
until a count below the limit is observed. This prevents silent server-side
truncation in the common regime.

## Performance

Fresh preparation on the current Windows development machine:

- Wall time: 327,364 ms (about 5 minutes 27 seconds).
- Peak process RSS: 2,024 MB.
- Cache size: 15,814,309 bytes.

Validated cache-hit run:

- Wall time reported by the harness: 65 ms.
- End-to-end command wall time: about 0.9 seconds, including dataset checks.
- Peak process RSS: 167 MB.

The original implementation tokenized each document repeatedly inside the
profile/regime loop. It made no visible progress after 25 minutes and held
about 1.87 GB RSS. The replacement performs two bounded corpus passes once,
validates only overflow candidates, and caches the provider-neutral result.
Tokenizer tensors are capped at 513 tokens and no workers or unbounded
`Promise.all` calls are used.

## Verification

- `prepare-inputs.test.mjs`: provider lane formatting, bounded count
  sentinel, word-boundary truncation, one-tokenizer overflow handling, and
  one-time preparation behavior.
- `metrics.test.mjs`: standard document-level metric semantics and TREC
  serialization.
- Cache manifest binds the result to dataset checksum, selected content,
  tokenizer IDs, token budget, schema version, and corpus/query counts.
- Re-running `--prepare-inputs-only` used the validated cache and made no
  Qdrant requests.

## Remaining work

The full local-versus-Qdrant benchmark has not been completed yet. Its
remaining dense, sparse, and hybrid quality metrics must be produced by the
locked live run; no provider-wide retrieval conclusion can be drawn from
this preparation validation.

## Checkpoint and resume validation

The first full run was interrupted after `local-common-512` completed and
`local-native` had started. The completed run was preserved with:

- 5,183 / 5,183 indexed documents;
- 300 / 300 evaluated queries;
- dense, sparse, and `hybrid_k60` metrics present;
- 0 indexing, query, or run errors;
- successful deletion of its temporary collection.

The partial `local-native` collection left by the old runner was identified
by its exact benchmark prefix and deleted. A subsequent Qdrant collection
list confirmed that no `semidex-beir-scifact-*` temporary collections remain.

The runner now supports:

- `--resume-check`: validate the checkpoint and print completed/pending runs
  without Qdrant calls or report changes;
- `--resume`: skip only fully validated runs and continue pending runs;
- `--restart`: explicitly discard the checkpoint and start over.

The real checkpoint passes `--resume-check`: `local-common-512` is complete;
`local-native`, `cloud-common-512`, and `cloud-native` are pending. A plain
run without `--resume` or `--restart` refuses to overwrite the checkpoint.
