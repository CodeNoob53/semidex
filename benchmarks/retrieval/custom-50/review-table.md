# custom-50 qrel semantic review (Stage B, 2026-09-07)

Judged against `corpus.frozen.json` (skeleton-v1 chunker, 102 chunks, corpusHash `c1f2915300793b52…`).

Method: determine the answer from the frozen corpus text first, then pick the chunk(s) that contain it. Labels are never set to "whatever the old retriever returned".

Verdict counts: valid=41, corrected=8, valid-negative=1

Every corrected query is one the 2026-09-06 audit flagged (c09, c37, c38, c44) or a case where the legacy chunk index no longer maps to the same content under skeleton chunking (c15, c35, c39, c40).

| Query | Verdict | Relevant chunks (relevance) | Answer determined from corpus |
|---|---|---|---|
| c01 | valid | providers.md#3(3) providers.md#1(2) | providers.md#3 ("sparseProvider configuration") describes the sparseProvider field in config.json, its valid values, and where it lives. providers.md#5 (Reindex triggers) lists sparseProvider among the discriminators. |
| c02 | valid | providers.md#3(3) config-env.md#3(3) providers.md#5(1) | providers.md#3 states the valid values; config-env.md#3 lists the two valid provider combinations explicitly. |
| c03 | valid | providers.md#2(3) config-env.md#2(2) providers.md#3(1) | providers.md#2 (bge-m3-onnx section) gives the ONNX_EMBED=1 shorthand and the explicit DENSE/SPARSE_PROVIDER form; config-env.md#3 also states it. |
| c04 | valid | providers.md#5(3) qdrant.md#8(2) project-structure.md#3(2) | providers.md#5 (Reindex triggers) names embeddingSchemaVersion as a discriminator; project-structure.md#3 explains SCHEMA_VERSION -> embedding_schema_version payload field. The query mixes the payload field name (embedding_schema_version) w |
| c05 | valid | providers.md#5(3) providers.md#0(2) providers.md#4(1) | providers.md#5 states changing denseModel triggers a full reindex of every file in the collection. |
| c06 | valid | providers.md#3(3) project-structure.md#2(3) providers.md#4(2) | providers.md#4 names resolveEnvProviders() as one of the two validators; the "single source of truth" phrasing is in providers.md#3 and project-structure.md#2. |
| c07 | valid | providers.md#3(3) config-env.md#3(3) providers.md#4(2) | providers.md#3 and config-env.md#3 both name the "Invalid provider combination" error for mixed ollama+onnx. |
| c08 | valid | qdrant.md#3(3) qdrant.md#2(2) config-env.md#9(2) | qdrant.md#3 ("RRF k parameter") is the direct explanation of the k parameter and RRF_K env var; qdrant.md#2 gives the RRF formula and default 60. |
| c09 | corrected | qdrant.md#5(3) qdrant.md#9(3) config-env.md#10(2) config-env.md#9(2) | HYBRID_PREFETCH_LIMIT and its prefetch formula are in qdrant.md#5 (RRF k parameter section, 2nd prose chunk) and the qdrant.md#9 "Env tuning" table; config-env.md#9/#10 (Hybrid Search) also give it with the formula. |
| c10 | valid | qdrant.md#6(3) qdrant.md#1(1) | qdrant.md#6 ("Fallback to dense-only") directly answers why hybridSearch falls back when there are no sparse vectors. |
| c11 | valid | qdrant.md#8(3) qdrant.md#7(2) project-structure.md#4(1) | qdrant.md#8 is the getStoredMeta section — lists exactly the fields it reads. |
| c12 | valid | qdrant.md#1(3) qdrant.md#0(1) | qdrant.md#1 ("Collections") states each collection stores a dense (cosine) and a sparse named vector. |
| c13 | valid | qdrant.md#7(3) qdrant.md#1(2) qdrant.md#8(1) | qdrant.md#7 ("Payload Indexes") states source_file is a keyword index used by getStoredMeta and deleteBySourceFile. |
| c14 | valid | qdrant.md#4(3) qdrant.md#3(2) qdrant.md#2(2) | The Qdrant Query API RRF body shape is the code block qdrant.md#4; qdrant.md#3 introduces it, qdrant.md#2 describes the two-prefetch-leg structure. |
| c15 | corrected | chunking.md#1(3) config-env.md#7(3) chunking.md#4(2) chunking.md#2(1) | OVERLAP_SENTENCES default = 2 is in the chunking.md#1 Parameters table and the config-env.md#7 Chunking table; chunking.md#4 (Overlap section) explains what it does. |
| c16 | valid | chunking.md#6(3) chunking.md#4(1) | chunking.md#6 ("Flushing the final chunk") directly explains the dropped-final-chunk bug and the `pending > 0` guard. |
| c17 | valid | chunking.md#5(3) chunking.md#4(2) | chunking.md#5 ("Why overlap must not cross section boundaries") is the direct answer. |
| c18 | valid | chunking.md#3(3) multilingual.md#4(1) | chunking.md#3 ("Sentence splitting") gives the splitSentences regex and the trailing-fragment behaviour. |
| c19 | valid | chunking.md#8(3) chunking.md#9(1) | chunking.md#8 ("Pandoc formats") lists docx/odt/rtf/epub/html and the synthetic-.md-path mechanism. |
| c20 | valid | chunking.md#1(3) config-env.md#7(3) chunking.md#0(1) | MAX_CHUNK_TOKENS/MIN_CHUNK_TOKENS with ranges are in the chunking.md#1 Parameters table and config-env.md#7 Chunking table. |
| c21 | valid | sync.md#0(3) sync.md#1(2) | sync.md#0 states what `npm run sync` does with config.json; sync.md#1 enumerates the steps. |
| c22 | valid | sync.md#2(3) sync.md#1(2) | sync.md#2 ("Backfill logic") is the direct answer for how sync fills missing provider fields. |
| c23 | valid | sync.md#3(3) sync.md#4(2) | sync.md#3 ("When to run sync") lists "Upgrading semidex to a version that adds new config.json fields". |
| c24 | valid | sync.md#5(3) | sync.md#5 ("Provider recorded by sync") states sync records the current env provider, not the historical one. |
| c25 | valid | sync.md#4(3) sync.md#0(2) | sync.md#4 ("Relationship to indexer") directly contrasts sync and the indexer w.r.t. config.json. |
| c26 | valid | mcp-workflow.md#1(3) mcp-workflow.md#0(2) | mcp-workflow.md#1 ("Registering the MCP Server") has the `claude mcp add` command for both OSes. |
| c27 | valid | mcp-workflow.md#6(3) mcp-workflow.md#2(2) mcp-workflow.md#4(1) | mcp-workflow.md#6 ("qdrant_get_chunk and Context Windows") explains the window parameter directly. |
| c28 | valid | mcp-workflow.md#8(3) mcp-workflow.md#2(2) mcp-workflow.md#5(1) | mcp-workflow.md#8 ("qdrant_find_by_tag") states results are grouped by source_file; the Tool Reference table (mcp-workflow.md#2) gives the signature. |
| c29 | valid | mcp-workflow.md#9(3) mcp-workflow.md#3(3) obsidian.md#7(2) | mcp-workflow.md#9 ("Collection Discovery") + the Recommended Workflow code block (mcp-workflow.md#3) describe how an agent should start a session. |
| c30 | valid | mcp-workflow.md#7(3) mcp-workflow.md#2(2) obsidian.md#0(2) | mcp-workflow.md#7 ("qdrant_list_files and qdrant_list_directories") describes both tools for corpus navigation. |
| c31 | valid | obsidian.md#1(3) obsidian.md#7(2) mcp-workflow.md#7(1) | obsidian.md#1 ("qdrant_list_directories") states it is the recommended first step when the corpus layout is unknown. |
| c32 | valid | obsidian.md#2(3) obsidian.md#4(2) obsidian.md#3(2) | obsidian.md#2 ("qdrant_list_files") states it returns all source_file values, optionally directory-filtered, in alphabetical order. |
| c33 | valid | obsidian.md#5(3) obsidian.md#6(2) | obsidian.md#5 is the "Payload Fields Used for Navigation" TABLE (source_file, chunk_index, section, total_chunks, tags); obsidian.md#6 is its prose sibling. |
| c34 | valid | obsidian.md#8(3) obsidian.md#7(1) | obsidian.md#8 ("Use Cases") is the list of listing-files use cases (verify coverage, audit tags, scope search). |
| c35 | corrected | project-structure.md#4(3) project-structure.md#1(2) qdrant.md#0(1) | project-structure.md#4 is the "src/core/qdrant.js" section listing its exports (hybridSearch, mmrSearch, scroll, getStoredMeta, createCollection); the Source Tree code block #1 shows its path and one-line role. |
| c36 | valid | project-structure.md#1(3) project-structure.md#5(3) chunking.md#0(1) | chunkFile/splitSentences/parseMarkdown location: project-structure.md#1 Source Tree lists `chunk.js  # chunkFile(), splitSentences(), parseMarkdown()`; project-structure.md#5 is the chunk.js module section. |
| c37 | corrected | project-structure.md#7(3) project-structure.md#1(2) benchmarking.md#12(2) benchmarking.md#2(1) | project-structure.md#7 is the "Entry Points" table, whose last row is `npm run bench:custom50 \| benchmarks/retrieval/custom-50/run-v3.js \| Run 50q quality benchmark`. The Source Tree code block #1 also names run-v3.js. benchmarking.md#2 d |
| c38 | corrected | project-structure.md#3(3) project-structure.md#1(2) providers.md#5(1) | project-structure.md#3 is the "src/core/embeddings.js" section, which defines SCHEMA_VERSION and its role as a reindex discriminator stored as embedding_schema_version. The Source Tree #1 also names it. providers.md#5 lists embeddingSchemaV |
| c39 | corrected | benchmarking.md#8(3) benchmarking.md#9(3) benchmarking.md#5(2) benchmarking.md#7(2) | benchmarking.md#8 defines the gain formula 2^relevance-1, chunkRecall@K (rel>=3), supportRecall@K (rel>=2). benchmarking.md#9 is the Chunk-level metrics table. benchmarking.md#5 is the v3 schema code block. |
| c40 | corrected | benchmarking.md#6(3) benchmarking.md#5(2) obsidian.md#5(1) | benchmarking.md#6 states `chunkId` format is `source_file#chunk_index` (zero-based) and that it matches Qdrant payload fields. The v3 schema code block #5 shows a relevantChunks example with that chunkId form. |
| c41 | valid | benchmarking.md#1(3) benchmarking.md#2(3) benchmarking.md#0(2) | benchmarking.md#0 states there are two tiers; #1 and #2 describe the 21q regression and 50q quality benchmarks respectively. |
| c42 | valid | benchmarking.md#16(3) config-env.md#12(2) benchmarking.md#12(1) | benchmarking.md#16 ("BENCH_SKIP_INDEX") states the stored provider is validated against the current env provider and the run fails if they differ. |
| c43 | valid | config-env.md#1(3) config-env.md#0(2) | config-env.md#1 is the "Required" table (QDRANT_URL, QDRANT_KEY); config-env.md#0 states only these two are required. |
| c44 | corrected | config-env.md#11(3) | RERANK_PROTECT_TOP1_DELTA (default 0.05, "Minimum advantage required to displace RRF rank-0") is a row in the config-env.md#11 "Reranking (experimental)" table. No prose sibling elaborates it, so this is a single-chunk answer. |
| c45 | valid | config-env.md#15(3) providers.md#5(3) config-env.md#14(2) qdrant.md#8(1) | config-env.md#15 ("config.json" prose, 2nd chunk) lists the six reindex discriminators; the code block #14 is the example structure; providers.md#5 also lists them (cross-file). |
| c46 | valid | config-env.md#6(3) config-env.md#5(2) obsidian.md#5(1) | config-env.md#6 ("Indexing" prose sibling) explains SOURCE_ROOT is for stable source_file IDs across machines/runs; the #5 table row defines it. |
| c47 | valid | multilingual.md#2(3) multilingual.md#1(2) multilingual.md#8(2) | multilingual.md#2 ("bge-m3-onnx + bge-m3-onnx") states the ONNX sparse embeddings are neural (learned token importance) and better for Ukrainian/rare vocabulary; #1 gives the hashed-tf contrast. |
| c48 | valid | multilingual.md#3(3) multilingual.md#0(2) multilingual.md#5(1) | multilingual.md#3 ("Query Language vs Document Language") is the direct answer for cross-lingual UA-query/EN-document retrieval with BGE-M3. |
| c49 | valid | multilingual.md#8(3) multilingual.md#2(2) providers.md#2(1) | multilingual.md#8 ("Recommended Provider for Multilingual Use") recommends bge-m3-onnx (ONNX_EMBED=1) for Ukrainian/mixed content. |
| c50 | valid-negative | — (negative) | No chunk in the frozen corpus mentions PostgreSQL, connection pooling, or any relational database. semidex uses only Qdrant. Correct behaviour: no strong hit / abstain. |

## Notes

- **valid** — original intent correct; chunk IDs re-anchored to the skeleton corpus.
- **corrected** — original relevance labels pointed at the wrong chunk; the answer chunk is re-identified from the text.
- **valid-negative** — c50: no corpus chunk answers it; kept as a retrieval-negative. See `negative-fixtures.json` for the typed negative set (unknown fact / scope mismatch / false premise / source conflict).
- `requiredEvidence` groups (c14, c41, c44) mark queries needing a specific chunk (or all of a set) to be fully answered — scored separately from Hit@K.
- No query was deleted to improve an aggregate. No ambiguous query was dropped.
