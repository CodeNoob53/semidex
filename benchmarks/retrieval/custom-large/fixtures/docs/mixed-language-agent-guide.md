# Mixed-Language Agent Workflow Guide

**Domain:** How AI agents use hybrid search with Ukrainian and English documents, exact tokens, Obsidian review, backlinks, and context windows.

---

## 1. Introduction to semidex Architecture

semidex is designed for local-first, high-fidelity Retrieval-Augmented Generation (RAG) workflows. The primary goal is to ensure that complex, multilingual knowledge graphs — spanning English and Ukrainian sources — are processed with maximum contextual integrity while maintaining strict **local-first privacy**.

This guide details the operational flow when an agent needs to synthesize an answer from disparate sources within an Obsidian vault.

### 1.1 Core Principles

* **Hybrid Retrieval:** Dense and sparse vectors are combined via Reciprocal Rank Fusion.
* **Contextual Depth:** Managing the **context window** efficiently is essential.
* **Auditability:** Every retrieval step must be logged for review.

[[BENCH_ANCHOR: MLG_LOCAL_PRIVACY]]
The commitment to **local-first privacy** means all indexing and retrieval operations occur entirely on the user's machine. Raw document text is never transmitted to external services when using Ollama or the ONNX embedding provider.

## 2. The Retrieval Pipeline: From Query to Context

The process begins when an agent receives a user query.

### 2.1 Query Ingestion and Pre-processing

When a user submits a query, the system first checks for explicit constraints.

**Example Scenario:** A user asks, "Які основні принципи роботи агента, якщо ми говоримо про *Python*?" (What are the main operating principles of an agent if we are talking about *Python*?).

The system must handle the mixed-language nature of the query, especially when a Ukrainian-language prompt targets an English source document.

[[BENCH_ANCHOR: MLG_UA_QUERY_EN_DOC]]
The system parses the query, recognizing the Ukrainian framing language but identifying the core technical term (*Python*) which requires searching within English source file documentation segments. BGE-M3 ONNX handles this cross-lingual mapping natively without query translation.

### 2.2 Indexing and Search Strategy

semidex employs a hybrid search mechanism combining multiple retrieval vectors.

**Search Steps:**

1. **Embedding Generation:** The query is passed through the local embedding model (ONNX or Ollama, controlled by `ONNX_EMBED`).
2. **Hybrid Search Execution:** A **hybrid RRF** search runs across the index, combining dense vector similarity with sparse keyword matching.
3. **Chunk Retrieval:** The vector store is queried for the top-K chunks; surrounding context is captured using `qdrant_get_chunk window=2`.

[[BENCH_ANCHOR: MLG_HYBRID_SEARCH]]
The **hybrid RRF** mechanism ensures that both semantic meaning (dense vectors) and exact keyword matches (sparse vectors) contribute to the final ranked set of chunks. RRF_K controls the balance; the default is 60.

### 2.3 Filtering and Scoping

To narrow the search space, metadata filters are applied.

* **Tag Filtering:** The **tag_filter** mechanism restricts results to documents tagged `AgentDesign`.
[[BENCH_ANCHOR: MLG_SECTION_BOUNDARY]]
* **Boundary Definition:** Section boundary markers in Markdown prevent context bleed between unrelated heading sections. Chunks do not span heading boundaries.

[[BENCH_ANCHOR: MLG_TAG_FILTER]]
Applying a **tag_filter** like `tag_filter: AgentDesign` ensures only relevant architectural discussions are retrieved, ignoring general notes or unrelated documents in the same collection.

## 3. Context Assembly and Agent Reasoning

Once the top-K chunks are retrieved, they must be assembled and passed to the LLM.

### 3.1 Context Window Management

The retrieved context must fit within the model's operational limits.

[[BENCH_ANCHOR: MLG_CONTEXT_WINDOW]]
The total token count of retrieved chunks is monitored against the available **context window** size. When the total exceeds the limit, chunks are ranked by relevance score and lower-ranked passages are dropped. The most relevant passages are always included.

### 3.2 Source Integration and Review

The final context block is a mix of retrieved text and metadata pointers.

**Example Context Snippet:**

```markdown
---
source: "docs/agent_flow.md"
language_mix: true
retrieval_method: hybrid
---
[Chunk Text Here...]
```

[[BENCH_ANCHOR: MLG_CODE_PROSE]]
The resulting context is a **code/prose mixed chunk** structure, allowing the LLM to distinguish between executable examples and narrative explanation. semidex preserves code blocks within chunks and does not split them across chunk boundaries when possible.

### 3.3 Advanced Linking and Review

The agent traces the source of its information.

* **Backlinks:** The source is traced by analyzing **backlinks** within retrieved chunks, showing related concepts across the knowledge graph.
* **Obsidian Review:** For complex queries, the system flags the need for manual review by directing the user to the relevant Obsidian QA section.

[[BENCH_ANCHOR: MLG_BACKLINK_FLOW]]
The **backlinks** analysis provides a graph view showing which other concepts in the vault reference the retrieved material. This is available via the `qdrant_backlinks` MCP tool.

[[BENCH_ANCHOR: MLG_OBSIDIAN_QA]]
When retrieval confidence is low, the agent generates a draft answer formatted for the **Obsidian QA** template and flags it for human review. The draft includes the source chunks, their relevance scores, and the section paths.

## 4. Workflow Control and Auditing

Transparency is required. Every significant step is recorded.

### 4.1 Decision Logging

The agent justifies its choices.

[[BENCH_ANCHOR: MLG_DECISION_LOG]]
A **decision log** is maintained throughout the retrieval session, detailing:
1. The initial query.
2. The search parameters used (top-K, search mode, tag filters).
3. The final set of retrieved chunks with their chunk IDs.
4. The synthesis prompt sent to the LLM.

### 4.2 Source-Specific Query Handling

When the query is highly specific, exact matching is enforced.

[[BENCH_ANCHOR: MLG_EXACT_TOKEN]]
If the user query contains a specific non-negotiable term (a product ID, an environment variable name, or a function name), a sparse vector pass alongside the dense search ensures exact token recall. The `expectedTokens` field in benchmark queries captures this behavior.

### 4.3 Final Output Generation

The final output is presented with clear provenance markers.

[[BENCH_ANCHOR: MLG_AGENT_WAKEUP]]
The agent signals completion upon finishing synthesis, returning the answer with a source summary: each chunk ID, its source file, section path, and relevance score. This provenance record allows downstream verification against the Obsidian review output in `chunks_out/`.
