# Audit: Full-Text / Literal Payload Search Need

Date: 2026-05-14

## Summary

Hybrid sparse search (neural BGE-M3 sparse or hashed-TF) already handles the
use cases commonly attributed to literal search in the semidex corpus. The
custom-raw benchmark achieved **100% tokenHit@5** on all 7 exact-token queries
— including error strings, env var assignments with values, and log line
fragments — without any payload full-text index.

Adding Qdrant payload full-text indexing would require a new index type on the
`text` field (large, potentially slow to create/query), a new filter path in
the MCP tool or a new tool, and an extra sync step. The benefit is narrow: only
verbatim substring/phrase matching that sparse hashing cannot handle, which the
benchmark shows is not a current failure class.

**Recommendation: defer full-text / literal search. Docs-only note is
appropriate. Revisit if a benchmark run shows tokenHit@5 < 90% for exact-token
queries that require substring matching (not whole-token matching).**

---

## Q1 — What payload indexes currently exist?

**Source:** `src/core/qdrant.js:200–203` (`createCollection`),
`src/sync.js:11–15` (`REQUIRED_INDEXES`)

```js
// src/sync.js
const REQUIRED_INDEXES = {
  'source_file': 'keyword',
  'tags':        'keyword',
  'chunk_index': 'integer'
};
```

```js
// src/core/qdrant.js — createCollection
await createPayloadIndex(name, 'source_file', 'keyword');
await createPayloadIndex(name, 'tags',        'keyword');
await createPayloadIndex(name, 'chunk_index', 'integer');
```

**Created indexes:**

| Field | Type | Used for |
|-------|------|----------|
| `source_file` | `keyword` | exact match filter in `qdrant_search`, `qdrant_get_chunk`, scroll |
| `tags` | `keyword` | OR filter in `qdrant_search` |
| `chunk_index` | `integer` | range filter in `fetchWindowChunks` |

**Not indexed:**

| Field | Notes |
|-------|-------|
| `text` | The raw chunk text. No index of any kind. |
| `context` | LLM-generated 1-2 sentence summary. No index. |
| `section` | Heading string. No index. |

**What Qdrant requires for full-text payload search:**

Qdrant supports a `text` payload index type (distinct from `keyword`):
```json
{ "field_name": "text", "field_schema": { "type": "text", "tokenizer": "word" } }
```

A text index enables `{ "key": "text", "match": { "text": "some phrase" } }`
filters in scroll/search requests. It is **not enabled by default** and must be
created explicitly. Options include `word`, `whitespace`, `multilingual`, and
`prefix` tokenizers.

**Verdict:** No text-field index exists. Adding one requires:
1. A new `createPayloadIndex(name, 'text', { type: 'text', tokenizer: '...' })` call in `sync.js` and `createCollection`.
2. A new filter path in the MCP layer to use it.
3. Re-running `npm run sync` on all existing collections (index creation is
   non-blocking for already-indexed points, but may be slow on large collections).

---

## Q2 — Use cases where full-text could outperform hybrid

### 2a. Verbatim multi-word phrases

Example: `"java.lang.OutOfMemoryError: Java heap space"`

Sparse (hashed-TF): tokenizes on whitespace/punctuation → finds `java`, `lang`,
`OutOfMemoryError`, `Java`, `heap`, `space` as separate hash buckets. Retrieves
the chunk with high confidence because all tokens match.

Full-text: substring match on the exact string. Guaranteed hit if the phrase
appears verbatim — even if sparse misses one token due to hash collision or
normalization.

**Edge advantage for full-text:** Very long exact strings with unusual
punctuation or tokenization boundaries. Rare in practice.

### 2b. Env var with value assignment: `ONNX_EMBED=1`

Sparse (bge-m3-onnx neural): encodes `ONNX_EMBED=1` as a neural lexical unit.
**Benchmark result (raw-exact-03): 100% hit at top-1.**

Hashed-TF: hashes `ONNX_EMBED=1` as tokens. `=` is a delimiter; effective
tokens are `ONNX_EMBED` and `1`. The chunk containing `ONNX_EMBED=1` also
contains the key without the value → still retrieved.

**Gap:** A query distinguishing `ONNX_EMBED=1` from `ONNX_EMBED=0` (distractor
in the raw corpus) depends on the sparse model encoding `=1` as a unit. The
raw-neg-04 distractor test for `ONNX_EMBED=0` passes — meaning sparse correctly
distinguishes values. But this is corpus-specific.

Full-text: `match: { text: "ONNX_EMBED=1" }` is a guaranteed exact substring.
No false positive from `ONNX_EMBED=0`.

**Edge advantage for full-text:** Numeric-value-distinguishing queries where
the env var appears in the corpus with multiple values (staging vs prod configs).

### 2c. Error strings with file paths: `OOM killed at /src/indexer.js:42`

Sparse (bge-m3-onnx): **Benchmark result (raw-exact-01): 100% hit at top-1.**
The full string including path segments is represented in the neural sparse
output.

**No demonstrated gap here.**

### 2d. Exact phrase with stopwords: `"use compact snippets"`

Sparse: stopwords (`use`) may be downweighted or absent. Effective weight on
`compact` and `snippets`. **Benchmark result (raw-noise-04): 100% hit at top-1.**

**No demonstrated gap.**

### 2e. Long quoted string / code block excerpt

Example: `"at com.example.service.Worker.process(Worker.java:100)"`

Sparse: encodes class path segments. Retrieves OOM chunk because the log
repeats this pattern 20 times across many chunks — all match.

Full-text: same — finds exact substring in any chunk containing the line.
No advantage over sparse here.

### 2f. Audit/debug "why did this chunk exist?"

This is a provenance question, not a search question. It is answered by reading
`source_file`, `chunk_index`, `section`, `context`, `tags` from the payload
of a known chunk — not by filtering on `text`.

`qdrant_get_chunk(collection, source_file, chunk_index)` is the right tool
for this. No literal search needed.

---

## Q3 — Does sparse/hybrid already cover these use cases?

**Empirical answer from custom-raw benchmark (2026-05-12, bge-m3-onnx):**

| Query type | Count | Hit rate | Sample queries |
|------------|-------|----------|----------------|
| exact-token | 7 | **100%** | `ONNX_EMBED=1`, `OVERLAP_SENTENCES=2`, `LLM_MODEL=gemma3:4b`, `Error: OOM killed at /src/indexer.js:42`, `WARN: Qdrant timeout after 5000ms`, `retrieval_mode hybrid`, `sparse_provider bge-m3-onnx` |
| noise-distractor | 6 | **100%** | `use compact snippets`, `ONNX_EMBED value in prod`, etc. |
| mixed-language | 3 | **100%** | UA/EN mixed queries |
| boundary-neighbor | 2 | **100%** | `append the next chunk's first sentence` |

**All 7 exact-token queries hit at top-5, including queries with `=value`
assignments, file paths, and timeout values in ms.**

The only failure in the custom-raw benchmark was a **negative query**
(raw-neg-01: staging vs. prod timeout) — which is a scope-disambiguation
problem, not a literal-match problem. Full-text search would not help here
because it also cannot distinguish "is this the staging or prod timeout?" from
the text alone.

**For hashed-TF (ollama default):** The behavior is weaker. hashed-TF has no
IDF and uses a fixed vocabulary hash. Rare tokens like `gemma3:4b` or a
Java exception class path fragment may collide with other terms. No benchmark
data for exact-token queries with hashed-TF on raw logs exists yet. This is the
**only confirmed gap** — but it is a hashed-TF weakness, not a missing
full-text feature.

---

## Q4 — API option analysis

### Option A: docs-only (recommended)

Tell agents: use exact-token hybrid queries — `ONNX_EMBED=1`, `5000ms`, full
error strings verbatim — because BGE-M3 sparse encodes them as lexical units.
Add a note that this is a known strength of `bge-m3-onnx` over `hashed-tf`.

**Cost:** zero. **Risk:** zero. **Benefit:** sets correct agent expectations.

### Option B: `qdrant_search(search_mode="literal")`

Adds a `search_mode` enum value. Behind it:
- Skip embedding entirely.
- Build a Qdrant scroll/filter request: `{ "key": "text", "match": { "text": query } }`.
- Requires a `text` payload index. Without it, scroll falls back to full
  linear scan (slow, scales poorly with collection size).
- Result: chunks containing the exact substring, unranked or in scroll order.

**Problems:**
- No relevance ranking — literal scroll returns all matching chunks in ID order.
- Agent loses score/ranking signal; cannot distinguish "contains the string
  once" from "entire chunk is about this string".
- Requires creating a large text index (every chunk's `text` field, avg ~280
  tokens) on all collections and keeping it synchronized.
- The `text` field is deliberately not indexed today: it is large and the only
  query needs it serves are already covered by sparse search.
- False confidence risk: agent treats "no literal hits" as "this value does not
  exist in the corpus" — but the search may have failed due to tokenization or
  field coverage.
- `search_mode` is already the planned name for the `dense_mmr` enum. Adding
  `literal` as a third value entangles two unrelated features.

### Option C: separate `qdrant_literal_search` tool

Clean separation from `qdrant_search`. Still requires the text payload index.
Doubles tool surface. Justified only if literal search is frequently needed
and clearly distinct from semantic search — not currently demonstrated.

### Option D: `qdrant_search(literal=true)` boolean

Same cost as Option B, less expressive (no mode-specific parameters). Not
preferred over the enum form.

**Ranking: A >> B > D > C** (for current needs). Option A has no cost.

---

## Q5 — Risks of implementing payload full-text search

### 5a. Index size and memory pressure

Qdrant text indexes tokenize and store posting lists for every token in the
`text` field. Average chunk: ~280 tokens. 100-point collection → ~28,000 token
entries. 10,000-point collection → ~2.8M entries, possibly several hundred MB
in RAM.

`on_disk: false` (default) means the index lives in RAM. For large corpora this
is the primary operational risk.

### 5b. Slower sync and index creation

Creating a text index on an existing collection with many points triggers a
Qdrant background indexing job. For large collections this may take minutes
and consume CPU/IO while running. `npm run sync` would need to wait or handle
the async completion.

### 5c. `text` field is large

The `text` payload field contains the full raw chunk text — the largest field
in the payload. Indexing it is more expensive than indexing `source_file` (a
short string) or `tags` (a short array). The `context` field (1-2 sentence LLM
summary) is smaller and would be a cheaper alternative if a text index is
needed — but it is a lossy representation.

### 5d. False confidence from literal-only results

An agent receiving results from literal search may conclude that "this exact
string is not in the corpus" when no results are returned. But the query may
have missed due to: chunking split the phrase across two chunks; the tokenizer
normalized punctuation; the field contains an alias or paraphrase. Hybrid
search degrades gracefully on near-misses; literal search returns nothing and
the agent may halt or hallucinate.

### 5e. Qdrant version compatibility

The `text` index type and `match: { text: "..." }` filter syntax are available
in Qdrant ≥ 1.1.0 (approximately). `{ "type": "text", "tokenizer": "word" }`
schema syntax and the multilingual tokenizer require checking the deployed
Qdrant version. semidex currently has no Qdrant version gate — adding a text
index would require either a version check or explicit minimum version
documentation.

### 5f. `context` field vs `text` field

Indexing `text` (raw chunk) is noisier than indexing `context` (LLM summary).
But literal search is only useful for the `text` field — `context` is a
paraphrase and will not contain the exact error string or env var value.
This means the large field cannot be avoided.

---

## Q6 — Live verification on custom-raw?

**Not needed now.** The 2026-05-12 custom-raw baseline already demonstrates
100% exact-token recall with `bge-m3-onnx`. The queries in `custom-raw/queries.json`
include the hardest literal-match cases (exact error strings with paths, env
var key=value pairs, quoted phrases, mixed-language tokens).

A live re-run would confirm this on the current codebase but would not change
the audit conclusion, because:

1. The query set is defined and stable.
2. Embeddings for the corpus are already indexed and unchanged.
3. The code path (hybridSearch → bge-m3-onnx sparse) is unchanged.

**When a live run is useful:** After indexing a collection with `hashed-tf`
(not bge-m3-onnx) and running the same exact-token query set, to quantify the
hashed-TF gap on raw-log-style content. This would inform whether the
recommendation "use ONNX_EMBED=1 for literal-heavy corpora" needs a stronger
warning.

---

## Decision: Implement Now / Defer / Docs-Only

### Verdict: **Defer implementation. Docs-only note now.**

Reasons:

1. **No demonstrated failure class.** Custom-raw benchmark: 100% exact-token
   recall with bge-m3-onnx. There is no evidence that hybrid sparse fails on
   the literal-match queries semidex users actually submit.

2. **Narrow remaining gap.** The only plausible gap is `hashed-tf` on rare
   tokens in large raw-log corpora. The fix for this gap is `ONNX_EMBED=1`,
   not a new payload index — since bge-m3-onnx neural sparse handles these
   tokens correctly.

3. **Implementation cost is not trivial.** Text payload indexes are large,
   RAM-resident, require sync changes, and introduce Qdrant version sensitivity.
   The benefit is narrower than the cost.

4. **False confidence risk.** Literal search returning zero results is
   misleading in a chunked corpus. Hybrid search fails gracefully; literal
   search fails silently in hard-to-diagnose ways.

5. **Roadmap fit.** The roadmap already lists "stronger lexical fallback than
   hashed-TF" (Phase 4) as the right lever for literal-match improvement. That
   is an indexer change (switch to BM25 or bge-m3-onnx), not an MCP tool
   change.

### Docs-only note (to add to `docs/en/retrieval.md` or `AGENTS.md`):

> For exact-token queries (error strings, env var values, config keys),
> use verbatim terms in the `query` field — BGE-M3 sparse encodes them as
> lexical units and retrieves them reliably. If using the `ollama + hashed-tf`
> provider and exact literal recall is critical for raw logs or config dumps,
> switch to `ONNX_EMBED=1` for the collection — hashed-TF has no IDF and
> may miss rare tokens in high-noise corpora.

This note does not require any code changes.

---

## Appendix: Qdrant Text Index API Reference

For future implementation reference only:

```js
// Create a full-text index on the 'text' payload field
await createPayloadIndex(name, 'text', {
  type: 'text',
  tokenizer: 'word',   // options: 'word', 'whitespace', 'prefix', 'multilingual'
});

// Filter in scroll/search using the text index
const filter = {
  must: [{ key: 'text', match: { text: queryString } }]
};
// Returns: all points where text field contains the query tokens
// Note: this is token-based, not substring — "indexer.js:42" may be tokenized
// to ["indexer", "js", "42"] depending on tokenizer choice.
```

**Critical caveat:** `match: { text: "..." }` with the `word` tokenizer is
**not** a verbatim substring search. It is still tokenized. For a true
substring match, Qdrant does not have a native operator — the closest is
`prefix` tokenizer for prefix matching.

**Implication:** Even if implemented, `match: { text: "OOM killed at /src/indexer.js:42" }`
would be tokenized the same way sparse search tokenizes it. The advantage over
hybrid sparse would be exactness of matching (no vector approximation) but the
tokenization step is shared. The true literal-match use case (verbatim
substring) is not directly supported by Qdrant payload filters.

This further reduces the motivation for implementation: the main claimed
advantage (true substring matching) is not achievable through the Qdrant filter
API anyway.

---

## Trigger Criteria for Future Reconsideration

| Criterion | Threshold | Evidence required |
|-----------|-----------|-------------------|
| Exact-token benchmark regression | tokenHit@5 < 90% on custom-raw | Run `npm run bench:custom-raw` after provider change |
| User-reported literal miss | Reproducible case where hybrid returns wrong chunk despite exact string being present | Filed issue with corpus and query |
| hashed-TF gap confirmed | exact-token recall < 70% with ollama+hashed-tf on raw-log corpus | Benchmark run comparing providers on raw fixture |
| Qdrant text-tokenizer changes to support true substring | Release notes show verbatim substring filter | Track Qdrant changelog |
