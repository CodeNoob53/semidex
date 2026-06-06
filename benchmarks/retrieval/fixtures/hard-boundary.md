# Hard Boundary Fixture

A synthetic document designed to produce many split-boundary chunks.
Each section below exceeds MAX_CHUNK_TOKENS (512; roughly 2048 ASCII chars in
this synthetic prose) and is split by the sentence-level chunker. No private
paths or corpora.

## Long Prose Section

Retrieval systems that combine dense vector search with sparse term matching
face a fundamental tension between semantic coverage and lexical precision.
Dense models map text into high-dimensional embedding spaces where semantic
similarity is captured by vector proximity, allowing queries to find relevant
passages even when no exact terms overlap. Sparse models, by contrast, rely on
term frequency and inverse document frequency to surface documents that share
exact or stemmed vocabulary with the query. Neither approach alone dominates
across all query types. Dense models struggle with precise identifier lookup,
such as finding a function name or environment variable that is rare in the
training corpus. Sparse models struggle with paraphrasing and synonymy, where
the query and the relevant passage share meaning but not vocabulary. Reciprocal
rank fusion (RRF) is a rank aggregation method that combines result lists from
multiple retrieval systems without requiring score calibration. Each system
assigns a reciprocal rank score of 1 / (k + rank) to each document, and the
scores are summed across systems. The parameter k controls the weight given to
highly-ranked versus lower-ranked results. In practice, k=60 is a common
default that gives reasonable weight to top results without over-emphasising
rank-1 results from a single system. One advantage of RRF is that it is robust
to score scale differences between dense and sparse systems. A dense model that
produces cosine similarity scores between 0 and 1 can be directly combined with
a BM25 system that produces unbounded term-frequency scores. The ranks, not the
scores, are what matters for fusion. The main limitation of RRF is that it
treats both systems as equally reliable regardless of query type. For queries
that are strongly lexical, the sparse system's rank-1 result may be definitively
correct, and RRF may dilute its influence by averaging with a dense system that
ranked it lower. Conversely, for semantic queries, the dense system's top result
may be strongly preferred, but RRF gives equal weight to a sparse system that
ranked an unrelated document first because it shares a common stopword.

## Long Checklist Section

The following checklist describes a systematic approach to evaluating a retrieval
system before deploying it in a production environment. Each item should be
verified by a human reviewer before the system is considered ready for release.

- Confirm that all embedding model versions are pinned in the dependency manifest
  and that the exact model weights are recorded in the experiment log, including
  the model name, provider, quantisation level, and download hash. Unpinned
  models may silently change between runs, producing non-reproducible results.

- Verify that the evaluation query set is not derived from the same source
  documents as the indexed corpus. Queries should represent genuine user
  intentions, not paraphrases of document headings. Using document headings as
  queries systematically overestimates recall because the heading vocabulary is
  already present in the chunk text and is strongly weighted by sparse retrieval.

- Check that the relevance judgements (qrels) were produced independently of the
  retrieval system being evaluated. If the same model that generated the index
  also produced the qrels, positive results may reflect correlation rather than
  retrieval quality. Ideally, qrels should be produced by a different model or
  by a human annotator.

- Ensure that the metric definitions are agreed upon before running the benchmark.
  Changing the metric after seeing results invalidates the comparison. Record the
  metric name, depth parameter (e.g. @5, @10), relevance threshold, and
  tie-breaking method in the experiment log before the first run.

- Run the benchmark at least twice with a fixed random seed if the retrieval
  system uses sampling or re-ranking steps that introduce stochasticity. Report
  the range of results across runs, not just the best run. If results vary
  significantly across runs, investigate the source of variance before drawing
  conclusions.

- Compare against a strong baseline before claiming a new approach is better.
  A baseline that always returns the top-scoring dense result is often harder
  to beat than it appears. Improvements smaller than two percentage points on
  standard metrics should be treated with scepticism unless the query set is
  very large and the confidence interval is narrow.

- Document the hardware and software environment in sufficient detail that the
  benchmark can be reproduced on a different machine. Include the operating
  system version, CPU and GPU model if relevant, available RAM, Qdrant version,
  ONNX runtime version, and any environment variables that affect model loading
  or inference behaviour.

## Long Config Block Section

The configuration reference below lists all environment variables accepted by
the retrieval system. Each variable is described with its default value, valid
range, and effect on system behaviour.

QDRANT_URL: URL of the Qdrant server, including scheme and port. Must be
reachable from the application host. No default; the application exits if this
variable is absent. Example: http://localhost:6333.

QDRANT_KEY: API key for the Qdrant server. Required when the server is
configured with authentication. If the server does not require authentication,
this variable may be omitted. Treat this value as a secret; do not log it.

DENSE_PROVIDER: Selects the dense embedding backend. Valid values are ollama,
onnx, and openai. When set to onnx, the system loads the BGE-M3 model from the
local ONNX model cache. When set to ollama, the system connects to an Ollama
server at OLLAMA_URL. When set to openai, the system calls the OpenAI embeddings
API at the configured endpoint. Default: ollama.

SPARSE_PROVIDER: Selects the sparse embedding backend. Valid values are none,
onnx, and ollama_tf. When set to onnx, the system uses the BGE-M3 ONNX session
to produce sparse BM25-style vectors in the same pass as dense embedding. When
set to ollama_tf, the system calls a separate Ollama model to produce hashed
term-frequency vectors. When set to none, the system operates in dense-only mode
and RRF fusion is skipped. Default: none.

ONNX_EMBED: Shortcut to select both DENSE_PROVIDER=onnx and SPARSE_PROVIDER=onnx
simultaneously. Set to 1 to enable. Overrides DENSE_PROVIDER and SPARSE_PROVIDER
if set. Useful in benchmark scripts to ensure consistent provider selection
without modifying individual provider variables.

RERANK_ENABLED: Enables the cross-encoder reranking stage. When set to 1, the
system fetches RERANK_PREFETCH_MULT × TOP_K candidates from Qdrant, passes them
through a cross-encoder model, and returns the top TOP_K results ranked by the
cross-encoder score. The cross-encoder model is selected by RERANK_CE_MODEL.
Default: 0 (disabled). Enabling reranking increases latency significantly; the
cross-encoder is not parallelised and processes candidates sequentially.

RERANK_CE_MODEL: Name of the cross-encoder model used for reranking. Must be
a model identifier accepted by the configured cross-encoder provider. The model
must produce a scalar relevance score for each query-document pair. Default:
cross-encoder/ms-marco-MiniLM-L-12-v2. Models with more parameters produce
better rankings at higher latency cost.

COMBINED_LLM: Enables the combined context-plus-tags indexing mode. When set
to 1, the indexer calls an LLM to generate a short context sentence and a set
of semantic tags for each chunk before embedding. The context and tags are
prepended to the chunk text before embedding, enriching the dense vector with
task-level information. Default: 0 (disabled). This mode increases indexing
time significantly because it requires one LLM call per chunk.

MAX_CHUNK_TOKENS: Maximum token budget for a single chunk, measured by the active
token counter. The production async path uses the BGE-M3 tokenizer by default.
Sections that exceed this budget are split at sentence boundaries. Short split
fragments below MIN_CHUNK_TOKENS are merged deterministically within the same
section before overlap is added. Default: 512.

OVERLAP_SENTENCES: Number of trailing sentences from the previous chunk to
prepend to the current chunk as overlap. Overlap is applied after final boundary
decisions by the addSplitOverlapAsync pass. Setting this to zero disables sentence
overlap; use CHUNK_OVERLAP_TOKENS for token-budgeted overlap instead. Default: 2.
