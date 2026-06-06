# semidex Troubleshooting Runbook

**Domain:** Operational diagnosis for retrieval failures, Qdrant timeouts, ONNX cache corruption, empty chunks, MCP tool issues, and stale index points.

---

## Overview

This runbook provides systematic troubleshooting steps for common operational failures encountered when using semidex. Follow these steps sequentially based on the observed error or degraded performance.

## Core Components and Dependencies

semidex relies on several interconnected services:

1. **Vector Store:** Qdrant instance (local Docker or Qdrant Cloud)
2. **Embedding Model:** ONNX runtime (BGE-M3) or Ollama
3. **Document Parser:** Pandoc integration (for .docx, .pdf, .html, .epub, .odt, .rtf)

## Common Failure Scenarios

### 1. Retrieval Failures and Vector Store Issues

[[BENCH_ANCHOR: TRB_QDRANT_TIMEOUT]]
#### 1.1 Connection Timeouts

If retrieval consistently fails with timeouts, check connection health and resource limits.

**Symptom:** Intermittent `QDRANT_TIMEOUT_MS` errors during search.
**Action:**
1. Verify the Qdrant service status: `docker ps` or check Qdrant Cloud dashboard.
2. Check network latency between the semidex process and the vector store.
3. If the timeout is persistent, increase the connection timeout parameter in your environment configuration.

**Error Example:**
```javascript
// Attempting to connect to a slow or overloaded Qdrant instance
try {
    await client.search(queryVector, { timeout: 5000 });
} catch (e) {
    console.error('Timeout occurred. Check Qdrant health.');
}
```

#### 1.2 Vector Schema Mismatch

This occurs when the embedding model used for indexing differs from the model used for querying.

[[BENCH_ANCHOR: TRB_PROVIDER_MISMATCH]]
If the embedding provider used during indexing differs from the current provider, semidex exits with a provider mismatch error. This prevents silent corruption of retrieval results caused by incompatible vector spaces.

**Error:** Provider mismatch detected at startup.
**Resolution:** Reindex the collection with the correct provider, or restore the `.env` provider settings to match the indexed collection.

#### 1.3 Missing Vector Data

Sometimes the index structure is incomplete.

[[BENCH_ANCHOR: TRB_MISSING_SPARSE]]
If the system reports a missing sparse vector during retrieval, the document chunk was indexed without a sparse representation. This typically means the chunk was indexed with a different `SPARSE_PROVIDER` than the current configuration.

**Check:** Review the `config.json` collection entry for `sparseProvider`. Reindex with consistent provider settings.

### 2. Indexing and Chunking Issues

#### 2.1 Empty Content Generation

If the system processes documents but yields no usable chunks, the indexing process stalls.

[[BENCH_ANCHOR: TRB_EMPTY_CHUNKS]]
If `emptyChunkIds` are reported by the benchmark, the document source is either empty or the chunking strategy is producing heading-only sections. A chunk containing only a Markdown heading line or an `(empty section: ...)` placeholder carries no retrievable answer content.

**Debugging:**
* Use `qdrant_get_chunk(collection, source_file, chunk_index)` to inspect the stored chunk text for the affected document.
* Review the heading structure of the source file for sections with no body text.
* Adjust `MIN_CHUNK_TOKENS` if very short sections should be merged.

#### 2.2 Stale Index Points

Qdrant may contain points for source files that have been deleted or moved.

[[BENCH_ANCHOR: TRB_STALE_INDEX]]
If `qdrant_list_files` returns files that no longer exist on disk, or if search returns results from deleted sources, the collection has stale index points. semidex does not delete points automatically unless `PRUNE_STALE=1` is set.

**Fix:** Run `PRUNE_STALE=1 COLLECTION=<name> npm run index <path>` to remove stale points for files that are no longer present at the source path.

### 3. Retrieval Quality Degradation

When retrieval works but results are poor, focus on quality metrics.

#### 3.1 Low Retrieval Recall

If relevant documents are consistently missed, recall is low.

[[BENCH_ANCHOR: TRB_LOW_RECALL]]
A low `chunkRecall@5` score indicates that the embedding space or chunking may be suboptimal for the query type.

**Action Plan:**
1. **Re-embed:** Reindex the corpus with the ONNX provider (`ONNX_EMBED=1`) for higher multilingual quality.
2. **Hybrid Search:** Ensure both dense and sparse vectors are active. Pure dense search misses exact technical token matches.
3. **Benchmark:** Run `npm run bench:custom50` to establish a baseline before changing parameters.

#### 3.2 Duplicate Results

Receiving the same source material multiple times reduces answer diversity.

[[BENCH_ANCHOR: TRB_DUPLICATE_RESULTS]]
If `duplicateSourceRate` exceeds acceptable thresholds (above 0.3 in top-5 results), multiple chunks from the same document are dominating the results. This typically indicates the query matches a single document very strongly.

**Mitigation:** Consider MMR (Maximal Marginal Relevance) search mode via `BENCH_SEARCH_MODE=dense-mmr` to introduce diversity at the cost of some relevance.

### 4. Tooling and Integration Failures

#### 4.1 Multi-Step Reasoning Failures

If the agent framework cannot invoke MCP tools, retrieval halts.

[[BENCH_ANCHOR: TRB_MCP_NO_TOOLS]]
If no MCP tools are available to the agent, verify that the MCP server is connected. Run `/mcp` in Claude Code to see connection status. The server appears as `qdrant` with 6 tools. Reconnect by restarting the MCP server process.

**Check:** Start with `qdrant_collection_info` to verify the MCP connection and confirm which collections are available before issuing a search.

#### 4.2 Document Parsing Failures

When processing complex formats like PDFs or DOCX files.

[[BENCH_ANCHOR: TRB_PANDOC_FAILURE]]
A non-zero `pandoc` exit code indicates a parsing failure. This typically points to corrupted source files, unsupported document structures, or Pandoc not being installed.

**Workaround:**
1. Verify Pandoc is installed: `pandoc --version`.
2. Test the failing file directly: `pandoc --to markdown <file>`.
3. For PDFs with no text layer, convert to plain text first using a dedicated PDF tool.

### 5. System Limits and Maintenance

#### 5.1 Rate Limiting

If the service is called too frequently, local resources throttle requests.

[[BENCH_ANCHOR: TRB_RATE_LIMIT]]
If embedding calls to Ollama are timing out under load, set `RATE_LIMIT_RPS` to limit the indexing throughput. The default is no rate limiting, which can overload a shared Ollama instance. Reduce the batch size with the `--batch-size` flag when indexing large corpora.

#### 5.2 Reindexing Loops

If reindexing fails to complete or enters a repeated cycle.

[[BENCH_ANCHOR: TRB_REINDEX_LOOP]]
semidex uses SHA-256 hash checks on source files to skip unchanged content. If the hash check is not functioning — for example, because `file_hash` was not stored correctly during a previous partial index run — reindexing may repeat unnecessarily.

**Mitigation:** Delete the affected collection in Qdrant and perform a clean full reindex from scratch.

---

## Troubleshooting Checklist Summary

| Issue | Potential Cause | Quick Fix |
| :--- | :--- | :--- |
| Slow or failed search | Network latency, Qdrant overload | Check network path; increase timeout. |
| Bad results | Outdated embeddings, poor chunking | Reindex with ONNX; adjust chunk sizes. |
| Tool failure | MCP server not connected | Run `/mcp` in Claude Code; reconnect. |
| Empty chunks | Heading-only sections in source | Inspect with `qdrant_get_chunk`; adjust source doc. |
| Stale points | Deleted or moved files | Run with `PRUNE_STALE=1` to remove deleted sources. |

**Final Step:** If all else fails, delete the collection in Qdrant and perform a controlled full reindex with `COLLECTION=<name> npm run index <path>`.

[[BENCH_ANCHOR: TRB_ONNX_CACHE_CORRUPT]]
#### ONNX Cache Corruption

If model loading fails after a partial download or interrupted run, treat the ONNX cache as corrupted. Stop all active indexing processes, delete the `MODEL_CACHE_DIR` contents, verify available disk space, and restart. The runtime rebuilds the cache from a clean model artifact on the next run with `ONNX_EMBED=1`.
