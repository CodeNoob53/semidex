# Agent Memory and Conversation Context

> Status: future architecture direction, not implemented.
>
> This document defines the intended boundary between conversation storage,
> context-window management, retrieval memory, and authoritative indexed
> knowledge. It does not change the stateless `POST /api/v1/ask` contract.

## 1. Goal

Semidex should let an assistant continue useful work across long conversations
without sending the complete transcript to a generation provider on every
request. Context compaction must reduce the active prompt, not destroy access
to the original conversation.

The design must remain provider-neutral. Ollama, ONNX generation, Gemini,
OpenAI-compatible APIs, Anthropic, and other providers receive a context
assembled by Semidex; provider-side threads or prompt caches may be used as
optimizations, but are never the canonical memory store.

## 2. Core invariant

**Compaction never mutates or replaces the conversation archive.** A summary
is a derived representation with provenance. Original messages and tool events
remain addressable and can be retrieved again when a later question needs
their exact content.

Conversation memory is also separate from authoritative document evidence.
An agent recollection cannot silently become a source fact or be cited as if it
came from an indexed document collection.

## 3. Memory levels

### Working context

The bounded input assembled for one generation request:

- system and application instructions;
- current goal and unresolved actions;
- recent turns and tool results;
- relevant retrieved conversation episodes;
- selected durable memories;
- retrieved document evidence;
- reserved output-token budget.

This is ephemeral and may be rebuilt differently for every request.

### Conversation events

The append-only source record for user messages, assistant messages, tool
calls, tool results, confirmations, cancellations, and errors. Events retain
their ordering, timestamps, conversation identity, and links to any derived
records.

### Episodic memory

A bounded group of related events around one task or topic. An episode stores
a concise summary, outcome, unresolved actions, topic metadata, embedding,
and references to the original events. Episode boundaries consider time,
conversation identity, active task, and topic changes; semantic similarity
alone is insufficient.

### Conversation state

A compact representation of the current conversation: goal, accepted
decisions, active constraints, superseded decisions, and pending work. It is
used after compaction to continue the same conversation, not as global user
memory.

### Durable agent memory

Information useful across conversations within a defined agent or project
scope: recurring preferences, project rules, accepted architectural
decisions, and repeatable workflows. Each record needs provenance, scope,
created/updated timestamps, confidence, and supersession state.

### Global user memory

Only stable, explicitly permitted information useful across agents, such as
language preference or a persistent accessibility requirement. Global memory
must be the narrowest and most reviewable layer, not a dumping ground for
conversation summaries.

## 4. Retrieval and ranking

Before generation, the context manager searches eligible memory scopes and
merges them with recent turns. Ranking must not use vector similarity alone.
The initial policy should combine:

```text
semantic relevance
+ lexical relevance
+ scope match
+ recency
+ importance
+ confidence
- staleness
- superseded-state penalty
```

Retrieval is scope-first: current conversation, current agent/project, then
explicitly allowed global user memory. A record from another user, tenant, or
unauthorized collection must never become a candidate.

Every injected memory item carries its source record IDs so the system can
inspect why it was recalled and recover the exact original events when a
summary is insufficient.

## 5. Compaction flow

When the active context approaches its configured budget:

1. Keep system instructions, the current goal, recent turns, and unresolved
   tool operations verbatim.
2. Close completed topical segments into episodes.
3. Generate or update the conversation-state summary.
4. Validate that accepted decisions, constraints, negations, and pending work
   were not dropped.
5. Store summaries as derived records linked to their source event ranges.
6. Assemble the next prompt from the compact state, recent turns, retrieved
   memories, and document evidence.

Summarization may use the active provider, a cheaper provider, a local model,
or deterministic extraction for structured events. The storage contract must
not depend on which summarizer produced the derived record.

## 6. Write policy

Not every message becomes durable memory. Promotion should evaluate:

- whether the information is stable beyond the current episode;
- whether its intended scope is conversation, project, agent, or user;
- whether a newer record contradicts or supersedes it;
- whether the user allowed this class of data to be retained;
- whether the source events remain available for verification.

Sensitive data, inferred personal attributes, credentials, and transient tool
payloads must not be promoted automatically. Product integrations should
offer review, correction, deletion, export, and a way to disable memory.

## 7. Proposed boundaries

The future implementation should use narrow, provider-neutral services:

- `ConversationStore`: append and read immutable conversation events;
- `EpisodeStore`: persist derived episodes and provenance;
- `MemoryStore`: query and manage scoped durable memories;
- `MemoryWriter`: decide whether a candidate is rejected, retained in its
  current scope, or proposed for promotion;
- `ContextManager`: enforce token budgets and assemble generation input;
- `MemoryRetriever`: retrieve and rank eligible records.

Qdrant can provide dense/sparse retrieval for episodes and durable memories,
but vector storage is an implementation detail behind these contracts. The
relational/event metadata needed for ordering, permissions, supersession, and
deletion must remain explicit rather than encoded only in vector payload text.

## 8. Delivery sequence

### Phase 1: demo memory slice

- durable conversation event storage;
- recent-turn context plus one rolling conversation summary;
- retrieval of prior episodes from the same conversation;
- source links from recalled summaries to original messages;
- explicit new-chat and delete-chat actions.

This is sufficient for a reference shopping assistant to remember prior meal
plans, accepted substitutions, and unresolved shopping tasks without claiming
general autonomous long-term memory.

### Phase 2: scoped durable memory

- project/agent/user scopes;
- candidate-memory inbox and explicit promotion;
- conflict and supersession handling;
- review, correction, export, retention, and deletion controls.

### Phase 3: evaluation and policy tuning

- memory retrieval precision and useful-recall rate;
- stale or contradictory memory injection rate;
- compaction loss tests for constraints, negations, decisions, and open work;
- token cost and latency against a no-memory baseline;
- privacy and cross-scope isolation tests.

## 9. Non-goals for the first implementation

- silently converting all chat messages into global memory;
- treating model-generated summaries as authoritative evidence;
- relying on one provider's hosted thread state as canonical storage;
- sharing memory across users or tenants by default;
- autonomous promotion of sensitive personal information;
- replacing document retrieval with conversation memory.

