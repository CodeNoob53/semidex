#!/usr/bin/env node
// Stage B semantic qrel review for custom-50.
//
// This file IS the review: one entry per query, each carrying a human
// verdict (valid | corrected | ambiguous | unanswerable), the reasoning,
// and — for answerable queries — the relevant chunk IDs judged against
// benchmarks/retrieval/custom-50/corpus.frozen.json (the CURRENT skeleton
// chunker output, rebuilt by build-corpus.mjs). Nothing is judged against
// a live collection.
//
// Method (audit 2026-09-06, P1):
//   1. Determine the answer from the frozen corpus text FIRST.
//   2. Then pick the chunk(s) that actually contain that answer.
//   3. relevance 3 = the chunk states the answer directly;
//      relevance 2 = supporting/adjacent context a reader would also want;
//      relevance 1 = same topic, not sufficient alone.
//   4. Alternative correct sources are ALL judged (multiple rel-3 allowed).
//   5. `requiredEvidence` groups mark queries that need >1 chunk to be
//      fully answered (all-required-evidence coverage, distinct from Hit@K).
//   6. Labels are NOT set to "whatever the old retriever returned".
//
// The skeleton chunker emits a structural node (table/code_block) as its
// own chunk (rawContent = the whole table/block) AND a sibling prose chunk
// carrying a placeholder + surrounding prose. Where the answer is a table
// row, the table chunk is the rel-3 anchor and the prose sibling is rel-2.
//
// Output:
//   node qrels-review.mjs            -> writes queries.v4.json + review-table.md
//   node qrels-review.mjs --check    -> verifies every referenced chunkId
//                                       exists in the frozen corpus and its
//                                       content hash still matches; exit 1 on drift
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FROZEN = JSON.parse(readFileSync(resolve(__dirname, 'corpus.frozen.json'), 'utf8'));
const SOURCE_QUERIES = JSON.parse(readFileSync(resolve(__dirname, 'queries.json'), 'utf8'));

// chunkId -> { contentHash, section, nodeType, text }
const CHUNK_INDEX = new Map();
for (const [fname, file] of Object.entries(FROZEN.files)) {
  for (const ch of file.chunks) {
    CHUNK_INDEX.set(ch.chunkId, ch);
  }
}

function hashOf(chunkId) {
  const ch = CHUNK_INDEX.get(chunkId);
  if (!ch) throw new Error(`review references a chunkId not in the frozen corpus: ${chunkId}`);
  return ch.contentHash;
}

// ── The review ────────────────────────────────────────────────────────────
// verdict:
//   valid       — original qrel's intent was right; chunk IDs updated to the
//                 skeleton corpus but the query is answerable and unchanged.
//   corrected   — the original relevance labels pointed at the wrong chunk
//                 (audit c44/c38/c09/c37 class); the answer chunk is now
//                 identified from the text.
//   ambiguous   — the query under-specifies; intent clarified in `query`
//                 and/or `ambiguityNote`, kept in the set.
//   unanswerable— the frozen corpus contains no chunk that answers this;
//                 kept as a retrieval-negative (no positive qrels).
const REVIEW = [
  {
    id: 'c01', verdict: 'valid',
    answer: 'providers.md#3 ("sparseProvider configuration") describes the sparseProvider field in config.json, its valid values, and where it lives. providers.md#5 (Reindex triggers) lists sparseProvider among the discriminators.',
    relevant: [
      { chunkId: 'providers.md#3', relevance: 3, evidence: 'The `sparseProvider` field in config.json controls which sparse encoder is used for a collection. Valid values are `hashed-tf` … and `bge-m3-onnx`.' },
      { chunkId: 'providers.md#1', relevance: 2, evidence: 'default combination … hashed-tf for sparse embeddings — establishes what sparseProvider selects.' },
    ],
  },
  {
    id: 'c02', verdict: 'valid',
    answer: 'providers.md#3 states the valid values; config-env.md#3 lists the two valid provider combinations explicitly.',
    relevant: [
      { chunkId: 'providers.md#3', relevance: 3, evidence: 'Valid values are `hashed-tf` (default…) and `bge-m3-onnx`… Mixed combinations such as `ollama + bge-m3-onnx` or `bge-m3-onnx + hashed-tf` are rejected.' },
      { chunkId: 'config-env.md#3', relevance: 3, evidence: 'Valid provider combinations: ollama + hashed-tf (default…) / bge-m3-onnx + bge-m3-onnx …' },
      { chunkId: 'providers.md#5', relevance: 1, evidence: 'Reindex triggers — same-topic, not a combination list.' },
    ],
  },
  {
    id: 'c03', verdict: 'valid',
    answer: 'providers.md#2 (bge-m3-onnx section) gives the ONNX_EMBED=1 shorthand and the explicit DENSE/SPARSE_PROVIDER form; config-env.md#3 also states it.',
    relevant: [
      { chunkId: 'providers.md#2', relevance: 3, evidence: 'Enable with `ONNX_EMBED=1` (shorthand) or explicitly with `DENSE_PROVIDER=bge-m3-onnx SPARSE_PROVIDER=bge-m3-onnx`.' },
      { chunkId: 'config-env.md#2', relevance: 2, evidence: 'ONNX_EMBED | 0 | Shorthand to enable bge-m3-onnx for both dense and sparse.' },
      { chunkId: 'providers.md#3', relevance: 1, evidence: 'same-topic sparseProvider values.' },
    ],
  },
  {
    id: 'c04', verdict: 'valid',
    answer: 'providers.md#5 (Reindex triggers) names embeddingSchemaVersion as a discriminator; project-structure.md#3 explains SCHEMA_VERSION -> embedding_schema_version payload field. The query mixes the payload field name (embedding_schema_version) with the concept.',
    relevant: [
      { chunkId: 'providers.md#5', relevance: 3, evidence: 'Changing `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion` … will cause every file … to be reindexed. The six reindex discriminators are: file hash, denseProvider, denseModel, sparseProvider, embeddingSchemaVersion, vectorSize.' },
      { chunkId: 'qdrant.md#8', relevance: 2, evidence: 'getStoredMeta … returns the six reindex discriminator fields … embedding_schema_version …' },
      { chunkId: 'project-structure.md#3', relevance: 2, evidence: '`SCHEMA_VERSION` … stored in Qdrant payloads as `embedding_schema_version` and used as a reindex discriminator.' },
    ],
  },
  {
    id: 'c05', verdict: 'valid',
    answer: 'providers.md#5 states changing denseModel triggers a full reindex of every file in the collection.',
    relevant: [
      { chunkId: 'providers.md#5', relevance: 3, evidence: 'Changing `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion` in config.json for a collection will cause every file in that collection to be reindexed on the next `npm run index` run.' },
      { chunkId: 'providers.md#0', relevance: 2, evidence: 're-indexing is triggered automatically when the provider changes.' },
      { chunkId: 'providers.md#4', relevance: 1, evidence: 'provider validation, same topic.' },
    ],
  },
  {
    id: 'c06', verdict: 'valid',
    answer: 'providers.md#4 names resolveEnvProviders() as one of the two validators; the "single source of truth" phrasing is in providers.md#3 and project-structure.md#2.',
    relevant: [
      { chunkId: 'providers.md#3', relevance: 3, evidence: 'The `resolveEnvProviders()` function in `src/core/config.js` is the single source of truth for mapping environment variables to provider names.' },
      { chunkId: 'project-structure.md#2', relevance: 3, evidence: 'Exports `resolveEnvProviders()` which maps environment variables … to canonical provider names. This is the single source of truth for provider resolution.' },
      { chunkId: 'providers.md#4', relevance: 2, evidence: 'Both `resolveEnvProviders()` (env-time) and `_embed()` … validate the provider combination.' },
    ],
  },
  {
    id: 'c07', verdict: 'valid',
    answer: 'providers.md#3 and config-env.md#3 both name the "Invalid provider combination" error for mixed ollama+onnx.',
    relevant: [
      { chunkId: 'providers.md#3', relevance: 3, evidence: 'Mixed combinations such as `ollama + bge-m3-onnx` or `bge-m3-onnx + hashed-tf` are rejected at runtime with an `Invalid provider combination` error.' },
      { chunkId: 'config-env.md#3', relevance: 3, evidence: 'Mixed combinations (`ollama + bge-m3-onnx` or `bge-m3-onnx + hashed-tf`) are rejected at runtime with an `Invalid provider combination` error.' },
      { chunkId: 'providers.md#4', relevance: 2, evidence: 'validate the provider combination before any embedding work is done.' },
    ],
  },
  {
    id: 'c08', verdict: 'valid',
    answer: 'qdrant.md#3 ("RRF k parameter") is the direct explanation of the k parameter and RRF_K env var; qdrant.md#2 gives the RRF formula and default 60.',
    relevant: [
      { chunkId: 'qdrant.md#3', relevance: 3, evidence: 'The `k` parameter in RRF controls rank sensitivity. It is configured via the `RRF_K` environment variable (default: 60, range: 1–10000).' },
      { chunkId: 'qdrant.md#2', relevance: 2, evidence: 'The RRF formula scores each result as the sum of `1 / (k + rank_i)` … The default value is 60, which is the standard RRF constant from the original paper.' },
      { chunkId: 'config-env.md#9', relevance: 2, evidence: 'RRF_K | 60 | 1–10000 | RRF smoothing constant (Hybrid Search table).' },
    ],
  },
  {
    id: 'c09', verdict: 'corrected',
    audit: 'Audit 2026-09-06: legacy qrel put HYBRID_PREFETCH_LIMIT at qdrant.md#2 (rel 3) and qdrant.md#6 (rel 2) — neither contains the parameter under the skeleton chunker.',
    answer: 'HYBRID_PREFETCH_LIMIT and its prefetch formula are in qdrant.md#5 (RRF k parameter section, 2nd prose chunk) and the qdrant.md#9 "Env tuning" table; config-env.md#9/#10 (Hybrid Search) also give it with the formula.',
    relevant: [
      { chunkId: 'qdrant.md#5', relevance: 3, evidence: 'The prefetch limit for each leg is `max(limit * HYBRID_PREFETCH_LIMIT, limit + 1)` where `HYBRID_PREFETCH_LIMIT` defaults to 2.' },
      { chunkId: 'qdrant.md#9', relevance: 3, evidence: 'Env tuning table: `HYBRID_PREFETCH_LIMIT` | 2 | 1–100 | Prefetch multiplier per RRF leg.' },
      { chunkId: 'config-env.md#10', relevance: 2, evidence: '`HYBRID_PREFETCH_LIMIT` controls how many candidates each leg fetches before RRF fusion. The actual prefetch count is `max(limit * HYBRID_PREFETCH_LIMIT, limit + 1)`.' },
      { chunkId: 'config-env.md#9', relevance: 2, evidence: 'Hybrid Search table row: HYBRID_PREFETCH_LIMIT | 2 | 1–100 | Prefetch multiplier per dense/sparse RRF leg.' },
    ],
  },
  {
    id: 'c10', verdict: 'valid',
    answer: 'qdrant.md#6 ("Fallback to dense-only") directly answers why hybridSearch falls back when there are no sparse vectors.',
    relevant: [
      { chunkId: 'qdrant.md#6', relevance: 3, evidence: 'If a collection has no sparse vectors yet …, `hybridSearch` falls back to `search` (dense-only) automatically. The fallback is triggered when the Qdrant response contains `"sparse"` or `"Wrong input"` in the error message.' },
      { chunkId: 'qdrant.md#1', relevance: 1, evidence: 'Each collection stores named vectors: a dense … and a sparse vector — establishes the precondition.' },
    ],
  },
  {
    id: 'c11', verdict: 'valid',
    answer: 'qdrant.md#8 is the getStoredMeta section — lists exactly the fields it reads.',
    relevant: [
      { chunkId: 'qdrant.md#8', relevance: 3, evidence: '`getStoredMeta(collection, sourceFile)` scrolls one point … and returns the six reindex discriminator fields from its payload: `file_hash`, `dense_provider`, `dense_model`, `sparse_provider`, `embedding_schema_version`, and `vector_size`.' },
      { chunkId: 'qdrant.md#7', relevance: 2, evidence: 'The `source_file` index is used by `getStoredMeta` and `deleteBySourceFile`.' },
      { chunkId: 'project-structure.md#4', relevance: 1, evidence: '`getStoredMeta(collection, sourceFile)` — reads six reindex discriminator fields (module list).' },
    ],
  },
  {
    id: 'c12', verdict: 'valid',
    answer: 'qdrant.md#1 ("Collections") states each collection stores a dense (cosine) and a sparse named vector.',
    relevant: [
      { chunkId: 'qdrant.md#1', relevance: 3, evidence: 'Each collection stores named vectors: a `dense` vector (cosine distance) and a `sparse` vector.' },
      { chunkId: 'qdrant.md#0', relevance: 1, evidence: 'Qdrant as vector database, typed functions for collections/points/search.' },
    ],
  },
  {
    id: 'c13', verdict: 'valid',
    answer: 'qdrant.md#7 ("Payload Indexes") states source_file is a keyword index used by getStoredMeta and deleteBySourceFile.',
    relevant: [
      { chunkId: 'qdrant.md#7', relevance: 3, evidence: 'Two payload indexes are created on every collection: `source_file` (keyword) and `tags` (keyword). These allow Qdrant to filter points efficiently … The `source_file` index is used by `getStoredMeta` and `deleteBySourceFile`.' },
      { chunkId: 'qdrant.md#1', relevance: 2, evidence: 'createCollection … also creates payload indexes on `source_file` and `tags` for efficient filtering.' },
      { chunkId: 'qdrant.md#8', relevance: 1, evidence: 'getStoredMeta scrolls one point matching the given source file.' },
    ],
  },
  {
    id: 'c14', verdict: 'valid',
    answer: 'The Qdrant Query API RRF body shape is the code block qdrant.md#4; qdrant.md#3 introduces it, qdrant.md#2 describes the two-prefetch-leg structure.',
    relevant: [
      { chunkId: 'qdrant.md#4', relevance: 3, evidence: 'code block: { "prefetch": [ {sparse}, {dense} ], "query": { "rrf": { "k": 60 } }, "limit": 5, "with_payload": true }' },
      { chunkId: 'qdrant.md#3', relevance: 2, evidence: 'The Qdrant request body shape for RRF (available since Qdrant 1.16.0): …' },
      { chunkId: 'qdrant.md#2', relevance: 2, evidence: 'uses the Qdrant Query API (`/points/query`) with two prefetch legs followed by an RRF fusion step.' },
    ],
    requiredEvidence: [['qdrant.md#4']],
  },
  {
    id: 'c15', verdict: 'corrected',
    audit: 'Legacy qrel: chunking.md#1 (rel 3) + chunking.md#3 (rel 2). Under the skeleton chunker chunking.md#1 is the Parameters TABLE (rawContent) and #2 the prose sibling; the OVERLAP_SENTENCES default (2) is a row in that table. config-env.md#7 also has the row.',
    answer: 'OVERLAP_SENTENCES default = 2 is in the chunking.md#1 Parameters table and the config-env.md#7 Chunking table; chunking.md#4 (Overlap section) explains what it does.',
    relevant: [
      { chunkId: 'chunking.md#1', relevance: 3, evidence: 'Parameters table: `OVERLAP_SENTENCES` | 2 | 0–100 | Sentences carried from chunk N into N+1.' },
      { chunkId: 'config-env.md#7', relevance: 3, evidence: 'Chunking table: `OVERLAP_SENTENCES` | `2` | 0–100 | Sentence overlap between consecutive chunks.' },
      { chunkId: 'chunking.md#4', relevance: 2, evidence: '`OVERLAP_SENTENCES` controls how many sentences from the end of chunk N are prepended to chunk N+1.' },
      { chunkId: 'chunking.md#2', relevance: 1, evidence: 'prose sibling of the Parameters table (placeholder + "All three are validated with envInt()").' },
    ],
  },
  {
    id: 'c16', verdict: 'valid',
    answer: 'chunking.md#6 ("Flushing the final chunk") directly explains the dropped-final-chunk bug and the `pending > 0` guard.',
    relevant: [
      { chunkId: 'chunking.md#6', relevance: 3, evidence: 'The previous implementation skipped the final chunk when `current.length <= OVERLAP_SENTENCES`, which silently dropped content from short documents or short terminal sections. The flush is conditional on `pending > 0` …' },
      { chunkId: 'chunking.md#4', relevance: 1, evidence: 'Overlap section, same topic.' },
    ],
  },
  {
    id: 'c17', verdict: 'valid',
    answer: 'chunking.md#5 ("Why overlap must not cross section boundaries") is the direct answer.',
    relevant: [
      { chunkId: 'chunking.md#5', relevance: 3, evidence: 'If overlap crosses a markdown heading boundary, the first chunk of section B will contain sentences from section A. This contaminates the embedding … semidex resets the overlap accumulator … at each new heading.' },
      { chunkId: 'chunking.md#4', relevance: 2, evidence: 'Overlap section — establishes the mechanism the boundary reset applies to.' },
    ],
  },
  {
    id: 'c18', verdict: 'valid',
    answer: 'chunking.md#3 ("Sentence splitting") gives the splitSentences regex and the trailing-fragment behaviour.',
    relevant: [
      { chunkId: 'chunking.md#3', relevance: 3, evidence: '`splitSentences(text)` uses the regex `/[^.!?\\n]+[.!?\\n]+|[^.!?\\n]+$/g` to split … while also capturing any trailing fragment without a terminator.' },
      { chunkId: 'multilingual.md#4', relevance: 1, evidence: 'same regex quoted in the Ukrainian chunking-notes context.' },
    ],
  },
  {
    id: 'c19', verdict: 'valid',
    answer: 'chunking.md#8 ("Pandoc formats") lists docx/odt/rtf/epub/html and the synthetic-.md-path mechanism.',
    relevant: [
      { chunkId: 'chunking.md#8', relevance: 3, evidence: '`.docx`, `.odt`, `.rtf`, `.epub`, `.html`, and `.htm` files are converted to Markdown via `pandoc` before chunking. … passing a synthetic `.md` path to `chunkFile` …' },
      { chunkId: 'chunking.md#9', relevance: 1, evidence: 'PDF conversion — adjacent format-conversion topic, not pandoc.' },
    ],
  },
  {
    id: 'c20', verdict: 'valid',
    answer: 'MAX_CHUNK_TOKENS/MIN_CHUNK_TOKENS with ranges are in the chunking.md#1 Parameters table and config-env.md#7 Chunking table.',
    relevant: [
      { chunkId: 'chunking.md#1', relevance: 3, evidence: 'Parameters table: MAX_CHUNK_TOKENS | 400 | 1–100000; MIN_CHUNK_TOKENS | 30 | 0–100000.' },
      { chunkId: 'config-env.md#7', relevance: 3, evidence: 'Chunking table: MAX_CHUNK_TOKENS | 400 | 1–100000; MIN_CHUNK_TOKENS | 30 | 0–100000.' },
      { chunkId: 'chunking.md#0', relevance: 1, evidence: 'controlled by three environment variables — same topic.' },
    ],
  },
  {
    id: 'c21', verdict: 'valid',
    answer: 'sync.md#0 states what `npm run sync` does with config.json; sync.md#1 enumerates the steps.',
    relevant: [
      { chunkId: 'sync.md#0', relevance: 3, evidence: '`npm run sync` … synchronises `config.json` with the live collections in Qdrant. It does not index any files — it only updates the local config.' },
      { chunkId: 'sync.md#1', relevance: 2, evidence: 'What sync does: fetches collections … writes a full provider entry … backfills any missing provider fields.' },
    ],
  },
  {
    id: 'c22', verdict: 'valid',
    answer: 'sync.md#2 ("Backfill logic") is the direct answer for how sync fills missing provider fields.',
    relevant: [
      { chunkId: 'sync.md#2', relevance: 3, evidence: 'When an existing config entry is missing the new provider fields, sync infers them from context: If `sparseProvider` is already `bge-m3-onnx` … Otherwise, `denseProvider`, `denseModel`, and `sparseProvider` are copied from the current env provider resolution …' },
      { chunkId: 'sync.md#1', relevance: 2, evidence: 'For existing collections, backfills any missing provider fields introduced by schema upgrades.' },
    ],
  },
  {
    id: 'c23', verdict: 'valid',
    answer: 'sync.md#3 ("When to run sync") lists "Upgrading semidex to a version that adds new config.json fields".',
    relevant: [
      { chunkId: 'sync.md#3', relevance: 3, evidence: 'Run sync after: Creating a new Qdrant collection manually. Upgrading semidex to a version that adds new config.json fields. Switching provider configuration …' },
      { chunkId: 'sync.md#4', relevance: 2, evidence: 'Relationship to indexer — when sync is needed vs the indexer.' },
    ],
  },
  {
    id: 'c24', verdict: 'valid',
    answer: 'sync.md#5 ("Provider recorded by sync") states sync records the current env provider, not the historical one.',
    relevant: [
      { chunkId: 'sync.md#5', relevance: 3, evidence: 'The provider written by sync reflects the environment at the time sync is run, not the environment at the time the collection was originally indexed. … sync is a declaration of current intent, not a historical record.' },
    ],
  },
  {
    id: 'c25', verdict: 'valid',
    answer: 'sync.md#4 ("Relationship to indexer") directly contrasts sync and the indexer w.r.t. config.json.',
    relevant: [
      { chunkId: 'sync.md#4', relevance: 3, evidence: 'The indexer also updates config.json when it creates a new collection. Sync is only needed for collections that were created outside the indexer …, or to repair a config.json that has drifted.' },
      { chunkId: 'sync.md#0', relevance: 2, evidence: 'sync … does not index any files — it only updates the local config.' },
    ],
  },
  {
    id: 'c26', verdict: 'valid',
    answer: 'mcp-workflow.md#1 ("Registering the MCP Server") has the `claude mcp add` command for both OSes.',
    relevant: [
      { chunkId: 'mcp-workflow.md#1', relevance: 3, evidence: '`claude mcp add --scope user semidex -- node /absolute/path/to/semidex/src/mcp/server.js` … After registering, run `/mcp` in Claude Code to verify the connection.' },
      { chunkId: 'mcp-workflow.md#0', relevance: 2, evidence: 'read-only MCP server … registered as an MCP tool provider under the name `qdrant` in Claude Code.' },
    ],
  },
  {
    id: 'c27', verdict: 'valid',
    answer: 'mcp-workflow.md#6 ("qdrant_get_chunk and Context Windows") explains the window parameter directly.',
    relevant: [
      { chunkId: 'mcp-workflow.md#6', relevance: 3, evidence: 'The `window` parameter controls how many neighboring chunks to return on each side. For example, `window=1` returns the previous chunk, the target chunk, and the next chunk.' },
      { chunkId: 'mcp-workflow.md#2', relevance: 2, evidence: 'Tool Reference table row: `qdrant_get_chunk` | `collection`, `source_file`, `chunk_index`, `window?` | Retrieves one chunk and optional neighbors.' },
      { chunkId: 'mcp-workflow.md#4', relevance: 1, evidence: 'Set `window=1` or `window=2` to retrieve adjacent chunks when more context is needed.' },
    ],
  },
  {
    id: 'c28', verdict: 'valid',
    answer: 'mcp-workflow.md#8 ("qdrant_find_by_tag") states results are grouped by source_file; the Tool Reference table (mcp-workflow.md#2) gives the signature.',
    relevant: [
      { chunkId: 'mcp-workflow.md#8', relevance: 3, evidence: '`qdrant_find_by_tag` returns all chunks in a collection that carry a specific tag. Results are grouped by `source_file`.' },
      { chunkId: 'mcp-workflow.md#2', relevance: 2, evidence: 'Tool Reference table row: `qdrant_find_by_tag` | `collection`, `tag`, `limit?` | Lists chunks matching a tag, grouped by file.' },
      { chunkId: 'mcp-workflow.md#5', relevance: 1, evidence: 'qdrant_search filters (tags/source_file) — adjacent filtering topic.' },
    ],
  },
  {
    id: 'c29', verdict: 'valid',
    answer: 'mcp-workflow.md#9 ("Collection Discovery") + the Recommended Workflow code block (mcp-workflow.md#3) describe how an agent should start a session.',
    relevant: [
      { chunkId: 'mcp-workflow.md#9', relevance: 3, evidence: 'Run `qdrant_collection_info` at the start of a session to discover available collections … lets the agent pick the most relevant collection.' },
      { chunkId: 'mcp-workflow.md#3', relevance: 3, evidence: 'Recommended Workflow: qdrant_collection_info -> qdrant_search(query, collection, top=5) -> qdrant_get_chunk(…) -> …' },
      { chunkId: 'obsidian.md#7', relevance: 2, evidence: 'The typical agent workflow combines navigation and search: qdrant_collection_info … qdrant_list_directories … qdrant_search … qdrant_get_chunk.' },
    ],
  },
  {
    id: 'c30', verdict: 'valid',
    answer: 'mcp-workflow.md#7 ("qdrant_list_files and qdrant_list_directories") describes both tools for corpus navigation.',
    relevant: [
      { chunkId: 'mcp-workflow.md#7', relevance: 3, evidence: '`qdrant_list_files` returns all files indexed in a collection … `qdrant_list_directories` returns the top-level directories … most useful for navigating the corpus structure.' },
      { chunkId: 'mcp-workflow.md#2', relevance: 2, evidence: 'Tool Reference table rows for qdrant_list_files / qdrant_list_directories.' },
      { chunkId: 'obsidian.md#0', relevance: 2, evidence: 'The primary tools are `qdrant_list_files` and `qdrant_list_directories`.' },
    ],
  },
  {
    id: 'c31', verdict: 'valid',
    answer: 'obsidian.md#1 ("qdrant_list_directories") states it is the recommended first step when the corpus layout is unknown.',
    relevant: [
      { chunkId: 'obsidian.md#1', relevance: 3, evidence: '`qdrant_list_directories` returns the distinct top-level directory paths … This is the recommended first step when the agent does not know the corpus layout.' },
      { chunkId: 'obsidian.md#7', relevance: 2, evidence: 'Combining Navigation with Search — qdrant_list_directories — map the corpus layout (step 2).' },
      { chunkId: 'mcp-workflow.md#7', relevance: 1, evidence: 'both tools operate at the file level … navigating the corpus structure.' },
    ],
  },
  {
    id: 'c32', verdict: 'valid',
    answer: 'obsidian.md#2 ("qdrant_list_files") states it returns all source_file values, optionally directory-filtered, in alphabetical order.',
    relevant: [
      { chunkId: 'obsidian.md#2', relevance: 3, evidence: '`qdrant_list_files` returns all `source_file` values in a collection, optionally filtered to a directory prefix. Results are returned in alphabetical order.' },
      { chunkId: 'obsidian.md#4', relevance: 2, evidence: 'Use `qdrant_list_files` when you need to enumerate files before calling `qdrant_get_chunk` …' },
      { chunkId: 'obsidian.md#3', relevance: 2, evidence: 'code block: qdrant_list_files(collection="my-notes", directory="docs/")' },
    ],
  },
  {
    id: 'c33', verdict: 'valid',
    answer: 'obsidian.md#5 is the "Payload Fields Used for Navigation" TABLE (source_file, chunk_index, section, total_chunks, tags); obsidian.md#6 is its prose sibling.',
    relevant: [
      { chunkId: 'obsidian.md#5', relevance: 3, evidence: 'Payload Fields table: source_file | chunk_index | section | total_chunks | tags — with types and descriptions.' },
      { chunkId: 'obsidian.md#6', relevance: 2, evidence: 'source_file and tags are payload-indexed for efficient filtering.' },
    ],
  },
  {
    id: 'c34', verdict: 'valid',
    answer: 'obsidian.md#8 ("Use Cases") is the list of listing-files use cases (verify coverage, audit tags, scope search).',
    relevant: [
      { chunkId: 'obsidian.md#8', relevance: 3, evidence: 'Use Cases: Listing all indexed documents before a benchmark run to verify coverage. Auditing LLM-generated tags … Scoping a search to a known subdirectory using the source_file filter. …' },
      { chunkId: 'obsidian.md#7', relevance: 1, evidence: 'Combining Navigation with Search — adjacent workflow context.' },
    ],
  },
  {
    id: 'c35', verdict: 'corrected',
    audit: 'Legacy qrel: project-structure.md#5 (rel 3) + #1 (rel 2). Under the skeleton chunker the `src/core/qdrant.js` module section is project-structure.md#4, and the Source Tree code block is #1.',
    answer: 'project-structure.md#4 is the "src/core/qdrant.js" section listing its exports (hybridSearch, mmrSearch, scroll, getStoredMeta, createCollection); the Source Tree code block #1 shows its path and one-line role.',
    relevant: [
      { chunkId: 'project-structure.md#4', relevance: 3, evidence: '### src/core/qdrant.js … All Qdrant REST calls go through this module. Key exports: hybridSearch … mmrSearch … scroll … getStoredMeta … createCollection …' },
      { chunkId: 'project-structure.md#1', relevance: 2, evidence: 'Source Tree code block: `qdrant.js  # Qdrant REST client (search, upsert, scroll, etc.)`.' },
      { chunkId: 'qdrant.md#0', relevance: 1, evidence: 'All Qdrant calls go through `src/core/qdrant.js` (from the Qdrant doc, cross-file).' },
    ],
  },
  {
    id: 'c36', verdict: 'valid',
    answer: 'chunkFile/splitSentences/parseMarkdown location: project-structure.md#1 Source Tree lists `chunk.js  # chunkFile(), splitSentences(), parseMarkdown()`; project-structure.md#5 is the chunk.js module section.',
    relevant: [
      { chunkId: 'project-structure.md#1', relevance: 3, evidence: 'Source Tree: `chunk.js       # chunkFile(), splitSentences(), parseMarkdown()`.' },
      { chunkId: 'project-structure.md#5', relevance: 3, evidence: '### src/indexer/phases/chunk.js … Exports `chunkFile(filePath, text, sourceFile)`. … Controlled by `MAX_CHUNK_TOKENS`, `MIN_CHUNK_TOKENS`, and `OVERLAP_SENTENCES`.' },
      { chunkId: 'chunking.md#0', relevance: 1, evidence: 'The chunking logic lives in `src/indexer/phases/chunk.js` (cross-file).' },
    ],
  },
  {
    id: 'c37', verdict: 'corrected',
    audit: 'Audit 2026-09-06: legacy qrel put the answer at project-structure.md#8 (rel 3) which was the src/mcp/server.js section. The bench:custom50 -> run-v3.js mapping is in the Entry Points table.',
    answer: 'project-structure.md#7 is the "Entry Points" table, whose last row is `npm run bench:custom50 | benchmarks/retrieval/custom-50/run-v3.js | Run 50q quality benchmark`. The Source Tree code block #1 also names run-v3.js. benchmarking.md#2 describes the custom-50 harness.',
    relevant: [
      { chunkId: 'project-structure.md#7', relevance: 3, evidence: 'Entry Points table: `npm run bench:custom50` | `benchmarks/retrieval/custom-50/run-v3.js` | Run 50q quality benchmark.' },
      { chunkId: 'project-structure.md#1', relevance: 2, evidence: 'Source Tree: `run-v3.js          # Quality benchmark runner (v3 schema, graded qrels)`.' },
      { chunkId: 'benchmarking.md#12', relevance: 2, evidence: 'Running Benchmarks code block: `# Quality 50q benchmark` / `npm run bench:custom50`.' },
      { chunkId: 'benchmarking.md#2', relevance: 1, evidence: '50-query quality benchmark … The collection name is bench-retrieval-custom-50.' },
    ],
  },
  {
    id: 'c38', verdict: 'corrected',
    audit: 'Audit 2026-09-06: legacy qrel put SCHEMA_VERSION at project-structure.md#4 (rel 3) which was the src/core/config.js section. Under the skeleton chunker the embeddings.js section is project-structure.md#3.',
    answer: 'project-structure.md#3 is the "src/core/embeddings.js" section, which defines SCHEMA_VERSION and its role as a reindex discriminator stored as embedding_schema_version. The Source Tree #1 also names it. providers.md#5 lists embeddingSchemaVersion among discriminators (cross-file).',
    relevant: [
      { chunkId: 'project-structure.md#3', relevance: 3, evidence: '### src/core/embeddings.js … `SCHEMA_VERSION` is a constant incremented when the embedding schema changes; it is stored in Qdrant payloads as `embedding_schema_version` and used as a reindex discriminator.' },
      { chunkId: 'project-structure.md#1', relevance: 2, evidence: 'Source Tree: `embeddings.js      # embedForIndex(), embedForSearch(), SCHEMA_VERSION`.' },
      { chunkId: 'providers.md#5', relevance: 1, evidence: 'The six reindex discriminators are: … embeddingSchemaVersion … (cross-file, concept not the constant).' },
    ],
  },
  {
    id: 'c39', verdict: 'corrected',
    audit: 'Legacy qrel: benchmarking.md#7 (rel 3) + #6 (rel 2). Under the skeleton chunker #7 is the Relevance Scale table and #6 is the v3 chunkId-format prose. The chunkRecall/nDCG/graded-relevance definitions are in benchmarking.md#8 (Relevance Scale prose) and #9 (Chunk-level metrics table); the v3 schema example is #5.',
    answer: 'benchmarking.md#8 defines the gain formula 2^relevance-1, chunkRecall@K (rel>=3), supportRecall@K (rel>=2). benchmarking.md#9 is the Chunk-level metrics table. benchmarking.md#5 is the v3 schema code block.',
    relevant: [
      { chunkId: 'benchmarking.md#8', relevance: 3, evidence: 'Grades are used for: nDCG@K with gain formula `2^relevance − 1`; chunkRecall@K: counts only `relevance >= 3`; supportRecall@K: counts `relevance >= 2`.' },
      { chunkId: 'benchmarking.md#9', relevance: 3, evidence: 'Chunk-level (v3 only) table: `chunkRecall@3` … `chunkRecall@5` … `supportRecall@K` … `nDCG@K` … `MRR@10`.' },
      { chunkId: 'benchmarking.md#5', relevance: 2, evidence: 'v3 (graded chunk-level) code block: schemaVersion 3, relevantChunks with relevance 3/2 …' },
      { chunkId: 'benchmarking.md#7', relevance: 2, evidence: 'Relevance Scale table: 3 = Exact answer … 2 = Supporting context … 1 = Same-topic … 0 = Irrelevant.' },
    ],
  },
  {
    id: 'c40', verdict: 'corrected',
    audit: 'Legacy qrel: benchmarking.md#5 (rel 3) + #2 (rel 2). Under the skeleton chunker the chunkId-format sentence is benchmarking.md#6 (prose sibling of the v3 code block); the code block itself is #5.',
    answer: 'benchmarking.md#6 states `chunkId` format is `source_file#chunk_index` (zero-based) and that it matches Qdrant payload fields. The v3 schema code block #5 shows a relevantChunks example with that chunkId form.',
    relevant: [
      { chunkId: 'benchmarking.md#6', relevance: 3, evidence: '`chunkId` format is `source_file#chunk_index` (zero-based). This matches the `source_file` and `chunk_index` fields in Qdrant payloads.' },
      { chunkId: 'benchmarking.md#5', relevance: 2, evidence: 'v3 code block: `"chunkId": "file.md#2"` inside relevantChunks.' },
      { chunkId: 'obsidian.md#5', relevance: 1, evidence: 'Payload Fields table: `chunk_index` | integer | Zero-based position within the source file (cross-file).' },
    ],
  },
  {
    id: 'c41', verdict: 'valid',
    answer: 'benchmarking.md#0 states there are two tiers; #1 and #2 describe the 21q regression and 50q quality benchmarks respectively.',
    relevant: [
      { chunkId: 'benchmarking.md#1', relevance: 3, evidence: '21-query regression benchmark … The stable regression smoke benchmark. It uses 4 fixture docs and 21 queries … run before merges to detect retrieval regressions.' },
      { chunkId: 'benchmarking.md#2', relevance: 3, evidence: '50-query quality benchmark … A richer evaluation harness using 8-10 fixture docs and 50 queries in v3 schema with graded relevance …' },
      { chunkId: 'benchmarking.md#0', relevance: 2, evidence: 'There are two benchmark tiers:' },
    ],
    requiredEvidence: [['benchmarking.md#1', 'benchmarking.md#2']],
  },
  {
    id: 'c42', verdict: 'valid',
    answer: 'benchmarking.md#16 ("BENCH_SKIP_INDEX") states the stored provider is validated against the current env provider and the run fails if they differ.',
    relevant: [
      { chunkId: 'benchmarking.md#16', relevance: 3, evidence: 'When `BENCH_SKIP_INDEX=1` is set, the runner skips re-indexing and reuses the existing collection. The stored provider is validated against the current env provider — if they differ, the run fails with an explicit error.' },
      { chunkId: 'config-env.md#12', relevance: 2, evidence: 'Benchmark Variables table: `BENCH_SKIP_INDEX` | unset | Reuse existing bench collection; skip reindexing.' },
      { chunkId: 'benchmarking.md#12', relevance: 1, evidence: 'Running Benchmarks: `# Skip reindex (reuse existing collection)` / `BENCH_SKIP_INDEX=1 npm run bench:custom50`.' },
    ],
  },
  {
    id: 'c43', verdict: 'valid',
    answer: 'config-env.md#1 is the "Required" table (QDRANT_URL, QDRANT_KEY); config-env.md#0 states only these two are required.',
    relevant: [
      { chunkId: 'config-env.md#1', relevance: 3, evidence: 'Required table: `QDRANT_URL` | Qdrant instance URL …; `QDRANT_KEY` | Qdrant API key …' },
      { chunkId: 'config-env.md#0', relevance: 2, evidence: 'Most variables have sensible defaults; only `QDRANT_URL` and `QDRANT_KEY` are required.' },
    ],
  },
  {
    id: 'c44', verdict: 'corrected',
    audit: 'Audit 2026-09-06: legacy qrel put RERANK_PROTECT_TOP1_DELTA at config-env.md#9 (rel 3) which was the config.json section. Under the skeleton chunker the value is a row in the Reranking table config-env.md#11.',
    answer: 'RERANK_PROTECT_TOP1_DELTA (default 0.05, "Minimum advantage required to displace RRF rank-0") is a row in the config-env.md#11 "Reranking (experimental)" table. No prose sibling elaborates it, so this is a single-chunk answer.',
    relevant: [
      { chunkId: 'config-env.md#11', relevance: 3, evidence: 'Reranking (experimental) table: `RERANK_PROTECT_TOP1_DELTA` | `0.05` | Minimum advantage required to displace RRF rank-0.' },
    ],
    requiredEvidence: [['config-env.md#11']],
  },
  {
    id: 'c45', verdict: 'valid',
    answer: 'config-env.md#15 ("config.json" prose, 2nd chunk) lists the six reindex discriminators; the code block #14 is the example structure; providers.md#5 also lists them (cross-file).',
    relevant: [
      { chunkId: 'config-env.md#15', relevance: 3, evidence: 'The six reindex discriminators stored in `config.json` per collection are: `denseProvider`, `denseModel`, `sparseProvider`, `embeddingSchemaVersion`, `vectorSize`, and implicitly `file_hash` …' },
      { chunkId: 'providers.md#5', relevance: 3, evidence: 'The six reindex discriminators are: file hash, denseProvider, denseModel, sparseProvider, embeddingSchemaVersion, vectorSize.' },
      { chunkId: 'config-env.md#14', relevance: 2, evidence: 'config.json code block: denseProvider / denseModel / sparseProvider / embeddingSchemaVersion / vectorSize.' },
      { chunkId: 'qdrant.md#8', relevance: 1, evidence: 'getStoredMeta returns the six reindex discriminator fields (payload field names, cross-file).' },
    ],
  },
  {
    id: 'c46', verdict: 'valid',
    answer: 'config-env.md#6 ("Indexing" prose sibling) explains SOURCE_ROOT is for stable source_file IDs across machines/runs; the #5 table row defines it.',
    relevant: [
      { chunkId: 'config-env.md#6', relevance: 3, evidence: '`SOURCE_ROOT` should be set to the root of the documents directory so that `source_file` values are stable across machines and across runs from different working directories.' },
      { chunkId: 'config-env.md#5', relevance: 2, evidence: 'Indexing table: `SOURCE_ROOT` | Root path used to compute stable `source_file` IDs.' },
      { chunkId: 'obsidian.md#5', relevance: 1, evidence: 'Payload Fields table: `source_file` | string | Stable file identifier relative to `SOURCE_ROOT` (cross-file).' },
    ],
  },
  {
    id: 'c47', verdict: 'valid',
    answer: 'multilingual.md#2 ("bge-m3-onnx + bge-m3-onnx") states the ONNX sparse embeddings are neural (learned token importance) and better for Ukrainian/rare vocabulary; #1 gives the hashed-tf contrast.',
    relevant: [
      { chunkId: 'multilingual.md#2', relevance: 3, evidence: 'The sparse embeddings are neural sparse — the model learns token importance, not just frequency. For Ukrainian and mixed-language content, this produces better sparse weights for technical terms and rare vocabulary.' },
      { chunkId: 'multilingual.md#1', relevance: 2, evidence: 'For Ukrainian content, `hashed-tf` assigns uniform weight … a rare Ukrainian technical term … gets the same sparse weight as a common word, which can reduce retrieval precision.' },
      { chunkId: 'multilingual.md#8', relevance: 2, evidence: 'The neural sparse encoder consistently outperforms `hashed-tf` on rare and technical Ukrainian terms, especially for exact-token queries.' },
    ],
  },
  {
    id: 'c48', verdict: 'valid',
    answer: 'multilingual.md#3 ("Query Language vs Document Language") is the direct answer for cross-lingual UA-query/EN-document retrieval with BGE-M3.',
    relevant: [
      { chunkId: 'multilingual.md#3', relevance: 3, evidence: 'semidex supports cross-lingual retrieval: a Ukrainian query can match an English document and vice versa. BGE-M3 maps both to the same semantic space, so language mismatch does not require separate indexes or translation.' },
      { chunkId: 'multilingual.md#0', relevance: 2, evidence: 'The BGE-M3 model … supports over 100 languages and produces high-quality embeddings for cross-lingual retrieval.' },
      { chunkId: 'multilingual.md#5', relevance: 1, evidence: 'Mixed-Language Documents — adjacent topic.' },
    ],
  },
  {
    id: 'c49', verdict: 'valid',
    answer: 'multilingual.md#8 ("Recommended Provider for Multilingual Use") recommends bge-m3-onnx (ONNX_EMBED=1) for Ukrainian/mixed content.',
    relevant: [
      { chunkId: 'multilingual.md#8', relevance: 3, evidence: 'For best results with Ukrainian or mixed-language content, use `bge-m3-onnx`: `ONNX_EMBED=1 COLLECTION=my-notes SOURCE_ROOT=./notes npm run index`.' },
      { chunkId: 'multilingual.md#2', relevance: 2, evidence: 'bge-m3-onnx … Enable with `ONNX_EMBED=1` … better sparse weights for technical terms and rare vocabulary.' },
      { chunkId: 'providers.md#2', relevance: 1, evidence: 'Enable with `ONNX_EMBED=1` (shorthand) (cross-file, not multilingual-specific).' },
    ],
  },
  {
    id: 'c50', verdict: 'valid-negative',
    answer: 'No chunk in the frozen corpus mentions PostgreSQL, connection pooling, or any relational database. semidex uses only Qdrant. Correct behaviour: no strong hit / abstain.',
    relevant: [],
    negativeKind: 'unknown-fact',
    negativeNote: 'semidex has no PostgreSQL support anywhere in the corpus. A retriever will still return its nearest neighbours (likely qdrant.md / config-env.md); the test is that no returned top-1 chunk contains the expected token "postgres" and that Ask would abstain. This is a token-absence diagnostic, NOT proof of abstention quality — see negative-fixtures.json for the typed negative set.',
  },
];

// ── Emit ──────────────────────────────────────────────────────────────────

function buildV4() {
  const bySource = new Map(SOURCE_QUERIES.queries.map((q) => [q.id, q]));
  const queries = [];
  for (const r of REVIEW) {
    const src = bySource.get(r.id);
    if (!src) throw new Error(`review entry ${r.id} has no matching source query`);
    const isNegative = r.verdict === 'valid-negative';
    const relevantChunks = (r.relevant ?? []).map((rc) => ({
      chunkId: rc.chunkId,
      relevance: rc.relevance,
      contentHash: hashOf(rc.chunkId),
      evidence: rc.evidence,
    }));
    queries.push({
      id: r.id,
      type: src.type,
      query: src.query,
      expectedFiles: isNegative ? [] : [...new Set(relevantChunks.map((c) => c.chunkId.split('#')[0]))],
      relevantChunks,
      ...(r.requiredEvidence ? { requiredEvidence: r.requiredEvidence } : {}),
      expectedTokens: src.expectedTokens ?? null,
      ...(isNegative ? { shouldHaveNoStrongHit: true, negativeKind: r.negativeKind } : {}),
      reviewVerdict: r.verdict,
      answer: r.answer,
      ...(r.audit ? { auditNote: r.audit } : {}),
      ...(r.ambiguityNote ? { ambiguityNote: r.ambiguityNote } : {}),
      ...(r.negativeNote ? { negativeNote: r.negativeNote } : {}),
    });
  }
  return {
    schemaVersion: 4,
    corpusHash: JSON.parse(readFileSync(resolve(__dirname, 'corpus.manifest.json'), 'utf8')).corpusHash,
    chunkingModel: FROZEN.chunkingModel,
    note: 'v4 qrels — judged against corpus.frozen.json (skeleton-v1 chunker). The 2026-09-06 audit diagnostic numbers used the legacy-chunker corpus and are NOT a baseline for this set. This is a regression/tuning set, not an independent held-out benchmark.',
    queries,
  };
}

function buildReviewTable() {
  const rows = REVIEW.map((r) => {
    const rel = (r.relevant ?? []).map((rc) => `${rc.chunkId}(${rc.relevance})`).join(' ');
    return `| ${r.id} | ${r.verdict} | ${rel || '— (negative)'} | ${r.answer.replace(/\|/g, '\\|').slice(0, 240)} |`;
  });
  const counts = REVIEW.reduce((m, r) => { m[r.verdict] = (m[r.verdict] ?? 0) + 1; return m; }, {});
  return [
    '# custom-50 qrel semantic review (Stage B, 2026-09-07)',
    '',
    `Judged against \`corpus.frozen.json\` (skeleton-v1 chunker, ${FROZEN.totalChunks} chunks, corpusHash \`${JSON.parse(readFileSync(resolve(__dirname, 'corpus.manifest.json'), 'utf8')).corpusHash.slice(0, 16)}…\`).`,
    '',
    'Method: determine the answer from the frozen corpus text first, then pick the chunk(s) that contain it. Labels are never set to "whatever the old retriever returned".',
    '',
    `Verdict counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    '',
    'Every corrected query is one the 2026-09-06 audit flagged (c09, c37, c38, c44) or a case where the legacy chunk index no longer maps to the same content under skeleton chunking (c15, c35, c39, c40).',
    '',
    '| Query | Verdict | Relevant chunks (relevance) | Answer determined from corpus |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## Notes',
    '',
    '- **valid** — original intent correct; chunk IDs re-anchored to the skeleton corpus.',
    '- **corrected** — original relevance labels pointed at the wrong chunk; the answer chunk is re-identified from the text.',
    '- **valid-negative** — c50: no corpus chunk answers it; kept as a retrieval-negative. See `negative-fixtures.json` for the typed negative set (unknown fact / scope mismatch / false premise / source conflict).',
    '- `requiredEvidence` groups (c14, c41, c44) mark queries needing a specific chunk (or all of a set) to be fully answered — scored separately from Hit@K.',
    '- No query was deleted to improve an aggregate. No ambiguous query was dropped.',
  ].join('\n');
}

function check() {
  let drift = 0;
  for (const r of REVIEW) {
    for (const rc of r.relevant ?? []) {
      const ch = CHUNK_INDEX.get(rc.chunkId);
      if (!ch) { console.error(`MISSING: ${r.id} -> ${rc.chunkId} not in frozen corpus`); drift++; continue; }
    }
  }
  // Also verify the committed queries.v4.json hashes still match the frozen corpus.
  try {
    const v4 = JSON.parse(readFileSync(resolve(__dirname, 'queries.v4.json'), 'utf8'));
    for (const q of v4.queries) {
      for (const rc of q.relevantChunks ?? []) {
        const ch = CHUNK_INDEX.get(rc.chunkId);
        if (!ch) { console.error(`v4 DRIFT: ${q.id} -> ${rc.chunkId} not in frozen corpus`); drift++; continue; }
        if (ch.contentHash !== rc.contentHash) {
          console.error(`v4 DRIFT: ${q.id} -> ${rc.chunkId} content hash changed (${rc.contentHash.slice(0, 12)} != ${ch.contentHash.slice(0, 12)}) — content moved under a stable chunkId`);
          drift++;
        }
      }
    }
  } catch (e) {
    console.error(`(queries.v4.json not readable: ${e.message})`);
  }
  if (drift > 0) {
    console.error(`\n${drift} drift issue(s). Rebuild the corpus, re-review, regenerate.`);
    process.exitCode = 1;
  } else {
    console.error('qrels-review --check OK — every referenced chunk exists and its content hash matches the frozen corpus.');
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--check')) {
    check();
  } else {
    const v4 = buildV4();
    writeFileSync(resolve(__dirname, 'queries.v4.json'), JSON.stringify(v4, null, 2) + '\n', 'utf8');
    writeFileSync(resolve(__dirname, 'review-table.md'), buildReviewTable() + '\n', 'utf8');
    console.error(`wrote queries.v4.json (${v4.queries.length} queries) + review-table.md`);
  }
}

export { REVIEW, buildV4 };
