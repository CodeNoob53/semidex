# ADR 0001: BGE-M3 ONNX as Recommended Embedding Provider

Status: Accepted

Date: 2026-05-20

## Context

semidex supports two embedding provider combinations:

- `bge-m3-onnx` / `bge-m3-onnx` — dense + sparse vectors from the local ONNX model
- `ollama` / `hashed-tf` — dense via Ollama API, sparse via hashed term frequency

Early benchmarks used the `ollama` path as the default because it required no additional
setup beyond a running Ollama instance. As the ONNX path matured, quality differences
and operational tradeoffs became clear enough to make a recommendation.

## Decision

`bge-m3-onnx` / `bge-m3-onnx` is the recommended provider combination for any serious
indexing workload. `ollama` / `hashed-tf` is retained as a fallback only — for environments
where ONNX is unavailable or during initial exploration.

Activated via `ONNX_EMBED=1` at index time, or by setting `denseProvider: "bge-m3-onnx"` /
`sparseProvider: "bge-m3-onnx"` explicitly in `config.json`.

## Rationale

1. **Single model family for dense and sparse.** BGE-M3 produces both dense and sparse
   vectors from one forward pass. `hashed-tf` is a bag-of-words approximation that does
   not share vocabulary or weighting with the dense model.

2. **Exact-token coverage.** BGE-M3 sparse vectors encode subword-level token weights
   from the model's own vocabulary. This gives better exact-token recall for technical
   identifiers, env vars, function names, and error strings compared to `hashed-tf`.

3. **Multilingual support.** BGE-M3 handles Ukrainian/English mixed content without
   language-specific tuning. `hashed-tf` is language-agnostic but shallow.

4. **Reduced Ollama dependency.** Embedding (dense + sparse vectors) and MCP search run
   fully locally via ONNX without a running Ollama server. Indexing still calls Ollama
   for context generation; optional tag generation may also use Ollama when
   `TAG_GEN=1` and `TAG_PROVIDER=ollama`.

5. **Provider metadata is stored per-point.** Changing provider mid-collection corrupts
   retrieval. The ONNX path makes the provider explicit and auditable in `config.json`.

`ONNX_EXECUTION_PROVIDER` (`cpu`, `dml`, `cuda`) is a performance-only setting — it does
not affect vector values, collection metadata, or provider compatibility.

## Consequences

- New collections should always use `ONNX_EMBED=1`.
- `ollama` / `hashed-tf` collections remain queryable but are not recommended for new work.
- Mixing providers in one collection is rejected at index time (`assertValidCombo`).
- Switching providers requires a full reindex. Drop-and-reindex is required when the
  existing collection has an incompatible schema (e.g. plain vectors from a non-semidex
  indexer); for provider changes within semidex, the indexer detects the mismatch and
  reindexes each file automatically.
- Windows GPU acceleration uses the verified `ONNX_EXECUTION_PROVIDER=dml` path.
  CUDA is an experimental / unverified advanced opt-in intended for Linux x64 +
  NVIDIA; Linux and macOS are not yet supported end-to-end.

## Evidence

- [`docs/en/configuration.md`](../en/configuration.md) — provider env vars and config fields
- [`docs/en/retrieval.md`](../en/retrieval.md) — provider impact on retrieval quality
- [`benchmarks/retrieval/results/2026-05-09-bge-m3-onnx.txt`](../../benchmarks/retrieval/results/2026-05-09-bge-m3-onnx.txt)
- [`benchmarks/retrieval/results/2026-05-09-ollama-hashed-tf.txt`](../../benchmarks/retrieval/results/2026-05-09-ollama-hashed-tf.txt)
- [`benchmarks/retrieval/results/2026-05-10-custom50-onnx-baseline.txt`](../../benchmarks/retrieval/results/2026-05-10-custom50-onnx-baseline.txt)
- [`benchmarks/retrieval/results/2026-05-15-custom150-onnx-hybrid.txt`](../../benchmarks/retrieval/results/2026-05-15-custom150-onnx-hybrid.txt)
