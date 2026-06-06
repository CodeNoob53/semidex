# Global Search and Collection Profiles

Status: draft for design discussion.

This note records two connected ideas:

1. Replace the removed indexing-time related-file graph with query-time global
   search across selected collections.
2. Add collection-level profiles/markers so global search can route safely and
   avoid unrelated or private/memory collections.

The goal is not to add another ranking shortcut. The goal is to make collection
selection explicit, cheap enough for agents to use, and safe for future agent
memory.

---

## 1. Problem

semidex currently has two retrieval/navigation mechanisms:

- `qdrant_search` searches one collection at query time.
- the removed link phase searched during indexing and wrote file-level related
  files into generated graph/payload metadata.

The link phase is expensive because it does work for every indexed chunk:

```text
new chunks * target collections * Qdrant search
```

For example, 30 chunks across 30 target collections means roughly 900 semantic
searches during indexing, before counting extra payload updates.

This cost was paid even if no agent ever used the precomputed related-file data.

Same-collection links are especially questionable: in one collection,
`qdrant_search(top=3|5)` can already surface nearby chunks for the user's actual
query. A precomputed "similar files" graph often duplicates search while adding
indexing cost and stale-link maintenance.

Cross-collection discovery is more valuable, but doing it during indexing is
still expensive and hard to scope correctly.

---

## 2. Design Direction

Move broad cross-collection discovery from indexing-time to query-time:

```text
removed link phase:
  during indexing:
    chunk -> search many collections -> write precomputed related-file metadata

target global search:
  during agent query:
    query -> choose allowed collections -> search them -> merge/group results
```

In other words, the removed link phase was effectively a **precomputed global
related search**:

```text
during indexing:
  for each chunk
    search target collections
    write precomputed related-file metadata
```

The proposed global-search model makes the same kind of discovery demand-driven:

```text
during agent query:
  choose search scope
  search selected collections
  return relevant chunks grouped by collection/source_file
```

This changes the cost model:

- indexing gets faster because related-file graph building is gone;
- search pays cross-collection cost only when the agent actually needs it;
- results are current because they are read directly from Qdrant;
- stale precomputed relation metadata is avoided.

The missing piece is routing. Global search cannot mean "search every Qdrant
collection". It needs collection profiles.

### 2.1 Tradeoff

Benefits:

- removes a heavy link-building phase from indexing;
- avoids maintaining broad precomputed relation metadata;
- avoids stale graph edges after updates, deletes, and renames;
- lets agents search across collections when the task actually needs it;
- makes cross-collection discovery easier to scope through explicit parameters.

Costs:

- a global query is more expensive than a single-collection query;
- unscoped global search can create noise across unrelated domains;
- results need collection-aware grouping and rank fusion;
- agents need clear rules for local search vs global search.

The design only works if global search is scoped by collection profile, explicit
collection list, or project/domain filters.

---

## 3. Collection Profile

Each semidex collection should have explicit routing metadata in `config.json`.
This profile is not embedded into chunks and is not retrieval content. It is a
control-plane description used to decide where an agent is allowed to search.

Proposed schema:

```jsonc
{
  "collections": {
    "example-docs": {
      "denseProvider": "bge-m3-onnx",
      "denseModel": "aapot/bge-m3-onnx",
      "sparseProvider": "bge-m3-onnx",
      "embeddingSchemaVersion": 2,
      "vectorSize": 1024,
      "description": "Human-editable short description",
      "profile": {
        "profile_version": 1,
        "kind": "documentation",
        "domain": "software",
        "visibility": "searchable",
        "global_search": true,
        "memory_access": "none",
        "project": "semidex",
        "language": "multi",
        "topics": ["rag", "qdrant", "mcp", "indexing"],
        "audience": "developers",
        "sensitivity": "normal",
        "review_status": "generated",
        "generated_by": {
          "provider": "ollama",
          "model": "gemma3:4b",
          "created_at": "2026-06-05T00:00:00Z"
        }
      }
    }
  }
}
```

### 3.1 Fields

`kind`

Allowed values for the first version:

- `documentation`
- `codebase`
- `business-kb`
- `research`
- `education`
- `literature`
- `agent-memory`
- `benchmark`
- `demo`
- `private-notes`
- `unknown`

`domain`

Short routing label. It can be broader than `kind`:

- `software`
- `science`
- `business`
- `education`
- `fiction`
- `personal`
- `mixed`
- `unknown`

This should remain controlled enough for agents to use, but not too rigid.

`visibility`

- `searchable` - can be used by normal search tools if scope allows it.
- `memory-only` - not part of global search; only memory tools can read it.
- `hidden` - never searched automatically.
- `benchmark-only` - excluded from normal agent search.

`global_search`

Boolean. If `false`, the collection is not included in automatic global search.
Explicit collection search still works if the user/tool names the collection.

`memory_access`

- `none` - ordinary collection.
- `explicit` - readable only by explicit memory tools or explicit user request.
- `agent-owned` - internal agent memory. Never searched as ordinary knowledge.

Agent-memory collections must not be included in global search automatically.

`project`

Namespace for routing. Examples:

- `semidex`
- `client-a`
- `personal`
- `web3lab-demo`

This prevents unrelated collections from being searched together only because
they share a broad domain like `software`.

`topics`

Short LLM-generated topic labels. Maximum 10. Lowercase. No private paths,
emails, or long identifiers.

`sensitivity`

- `normal`
- `private`
- `confidential`
- `unknown`

If `sensitivity` is `private`, `confidential`, or `unknown`, automatic
`global_search` should be conservative.

`review_status`

- `generated` - produced by LLM and not reviewed.
- `reviewed` - user or maintainer confirmed it.
- `manual` - set by user/agent directly.

---

## 4. LLM-Generated Profiles

The profile can be generated after indexing by an LLM, but only under a strict
contract.

### 4.1 Command

Initial command:

```bash
COLLECTION=my-docs npm run profile:collection
```

Later, indexing can offer:

```bash
PROFILE_COLLECTION=1 COLLECTION=my-docs npm run index ./docs
```

The separate command is safer for the first implementation because it keeps
indexing performance and collection profiling independent.

### 4.2 Input Sample

The profiler should not feed the whole collection to the LLM. It should build a
small routing sample:

- collection name;
- point count;
- provider metadata;
- top-level directories;
- file list sample;
- section names sample;
- existing tags sample;
- context sample from a limited number of chunks;
- optional language detection summary.

Do not include raw large documents, binary data, generated inspect artifacts, or
private absolute paths.

### 4.3 Prompt Contract

The LLM must return JSON only. The output is validated against enum fields.

High-level instruction:

```text
Classify this indexed collection for search routing.
Do not answer about the content.
Do not invent capabilities.
Use only allowed enum values.
If unsure, choose conservative values:
  kind="unknown"
  domain="unknown"
  global_search=false
  sensitivity="unknown"
```

### 4.4 Validation Rules

The validator should enforce:

- enum values only;
- `topics.length <= 10`;
- no absolute paths;
- no emails/API keys/URLs in `topics`;
- `agent-memory` implies:
  - `visibility="memory-only"`;
  - `global_search=false`;
  - `memory_access` is not `none`;
- `benchmark` implies `visibility="benchmark-only"` and `global_search=false`;
- `demo` should not automatically become global unless explicitly reviewed;
- `sensitivity="private|confidential|unknown"` should default
  `global_search=false` unless manually overridden.

The LLM suggests. The validator decides whether the profile is usable.

---

## 5. Global Search Tool

Proposed MCP tool:

```text
qdrant_search_global(
  query,
  collections?,
  collection_prefix?,
  project?,
  include_kinds?,
  exclude_kinds?,
  include_domains?,
  exclude_domains?,
  final_top?,
  top_per_collection?,
  window?,
  window_format?
)
```

### 5.1 Collection Selection

Candidate collections:

1. Must exist in Qdrant.
2. Must be known in `config.json`.
3. Must have compatible semidex payload/schema.
4. Must pass profile filters:
   - `visibility="searchable"`;
   - `global_search=true`;
   - `memory_access="none"`;
   - `kind`/`domain`/`project` match the requested scope.

If `collections` is explicitly provided, the tool searches only those
collections, but still rejects `hidden`, incompatible, or memory-only
collections unless an explicit future memory tool handles that path.

If `collection_prefix` is provided, it narrows the selected collection names
after profile filtering. This is useful for project naming schemes such as:

```text
client-a-docs
client-a-codebase
client-a-memory
```

where normal global search should include `client-a-docs` and maybe
`client-a-codebase`, but not `client-a-memory`.

### 5.2 Search And Merge

For each candidate collection:

```text
qdrant_search(query, collection, top=top_per_collection, window=...)
```

Then merge results across collections.

Do not compare raw score values as absolute confidence. Qdrant RRF scores are
rank-oriented and collection-local. Cross-collection merging should use a
rank-based method:

```text
global_score = 1 / (rank + k)
```

or another deterministic rank fusion method.

Return results grouped by:

```text
collection -> source_file -> chunks
```

The tool should avoid a flat list when possible. Flat global results are hard
for agents to reason about because a rank-4 hit from the right collection may
be more useful than a rank-1 hit from a distractor collection. Grouping preserves
both signals:

- global rank says "what looked strongest overall";
- collection grouping says "which knowledge base this came from";
- file grouping says "which document family the evidence belongs to".

Each result should include:

- collection;
- collection profile summary;
- source_file;
- section;
- chunk_index;
- context;
- text or compact snippet;
- local rank;
- global rank.

### 5.3 Suggested Defaults

Initial defaults should be conservative:

```jsonc
{
  "top_per_collection": 3,
  "final_top": 10,
  "window": 1,
  "window_format": "compact"
}
```

Do not search all Qdrant collections by default. Search only semidex-managed,
profile-allowed collections.

### 5.4 Agent Behavior

Agents should use global search when:

- the user asks across multiple knowledge bases;
- the relevant collection is unknown;
- one collection may need support from another collection;
- the task is cross-project or cross-domain by nature.

Agents should not use global search when:

- the collection is already known;
- the task is a narrow lookup inside one collection;
- the query is about agent memory;
- unrelated domains would add noise.

---

## 6. Agent Memory Isolation

Future agent memory must be isolated from ordinary global search.

Memory collections can contain:

- previous user preferences;
- agent instructions learned from usage;
- notes about how to search a specific collection;
- user-provided additions;
- private task history.

These must not leak into ordinary knowledge-base answers by accident.

Rules:

1. `kind="agent-memory"` is never included in global search.
2. `visibility="memory-only"` is never included in global search.
3. Memory is accessed only through a dedicated future tool, for example:

```text
qdrant_search_memory(query, agent_id?, project?)
```

4. A normal knowledge answer can cite memory only when the user/tool explicitly
   chose memory as an input source.

This prevents a global search for "refund policy" from mixing a company
knowledge base with an agent's private notes about previous conversations.

---

## 7. Relationship To Removed Link Phase

The previous related-file graph was removed from production because it did
index-time global-ish search without reliable query-time scope control. Global
search is the replacement direction, not another layer on top of that graph.

Future direction:

1. Prefer global search for cross-collection discovery.
2. Keep local collection search as the default for ordinary questions.
3. Use collection profiles to decide which collections are eligible for a
   global query.
4. Do not reintroduce index-time related-file graph building unless a separate
   benchmark proves it solves a problem global search cannot solve.

Decision hypothesis:

```text
If qdrant_search_global can reliably find the right cross-collection evidence,
then broad indexing-time link-building should disappear from the normal indexing
path.
```

This is especially true for same-collection links. Same-collection relatedness is
usually better handled by `qdrant_search(top=3|5)` on the user's actual query.
Precomputing same-collection links pays indexing cost before knowing what the
user will ask.

The likely long-term model:

- local search: `qdrant_search`;
- cross-collection search: `qdrant_search_global`;
- memory search: dedicated memory tool;
- precomputed graph: optional or removed from the default indexing path.

---

## 8. Benchmark Plan

Before changing defaults, measure:

### 8.1 Indexing Cost

Compare:

- current indexing path without related-file graph building;
- global search query-time alternative;
- scoped global search with a collection allowlist.

Metrics:

- wall time;
- Qdrant search count;
- points indexed;
- failures/retries.

### 8.2 Retrieval Quality

Create cross-collection tasks where the answer genuinely requires multiple
collections.

Compare:

- previous related-file graph workflow;
- manual multi-collection search;
- proposed `qdrant_search_global`.

Metrics:

- relevant collection found at K;
- relevant file found at K;
- relevant chunk found at K;
- noise count from unrelated collections;
- agent steps required.

### 8.3 Routing Safety

Test collections with intentionally different profiles:

- software documentation;
- benchmark collection;
- demo collection;
- fiction/literature;
- research papers;
- agent-memory collection;
- private notes.

Acceptance:

- memory collections are never returned by ordinary global search;
- benchmark/demo collections are excluded unless explicitly requested;
- unrelated domains do not dominate top results;
- explicit `collections=[...]` still works for allowed searchable collections.

---

## 9. Implementation Plan

### Phase 1 - Profile Schema

- Extend `config.json` collection entries with optional `profile`.
- Add pure validation helpers.
- Add smoke tests for profile validation and memory exclusion.
- Do not change search behavior yet.

### Phase 2 - Collection Profiling Command

- Add `npm run profile:collection`.
- Build safe collection sample from Qdrant/config.
- Generate profile via LLM.
- Validate profile.
- Write to `config.json`.
- Mark profile as `generated`.

### Phase 3 - Global Search Prototype

- Add internal helper to select candidate collections by profile.
- Add global search implementation.
- Add MCP tool behind a clear contract.
- Return grouped results with collection metadata.

### Phase 4 - Benchmarks

- Build cross-collection fixture.
- Compare manual multi-collection search vs global search.
- Measure query-time cost for scoped global search.

### Phase 5 - Default Decision

Based on benchmark evidence:

- keep global search behind explicit collection scope;
- enable profile-routed global search for safe collections;
- or reject global search if it adds too much query-time noise/cost.

Do not reintroduce indexing-time related-file graph building unless a separate
benchmark proves it solves a problem scoped global search cannot solve.

---

## 10. Open Questions

1. Should unprofiled collections be excluded from global search by default?
   Proposed answer: yes, except when explicitly listed by name.

2. Should generated profiles require user review before `global_search=true`?
   Proposed answer: for private/confidential/unknown sensitivity, yes.

3. Should `demo` and `benchmark` collections ever be globally searchable?
   Proposed answer: only by explicit request or manual profile override.

4. Should profile generation use local-only LLM by default?
   Proposed answer: yes for local-first mode; external providers can be a
   future explicit configuration.

5. Should `qdrant_collection_info` show profile fields?
   Proposed answer: yes. Agents need these fields to choose a safe search scope.

6. Should profiles be stored only in `config.json`, or also in Qdrant?
   Proposed answer: start with `config.json`; add Qdrant metadata only if MCP
   routing needs it without reading config.

---

## 11. Expected Result

If this design works:

- indexing becomes faster because semantic link-building is no longer a broad
  default cost;
- agents can search across collections when it is actually useful;
- memory/private/benchmark/demo collections do not pollute ordinary search;
- routing becomes inspectable through collection profiles;
- future agent memory gets a safe boundary from normal RAG search.
