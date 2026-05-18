# COMBINED_LLM Prompt Policy Matrix — 2026-05-18T0948

## Setup

| Item | Value |
|------|-------|
| Model | qwen2.5:3b-instruct |
| Runs per cell | 2 |
| Fixture chunks | 5 |
| Prompt variants | 4 |
| Total LLM calls | 40 |

## Fixture Domains

| ID | Domain | Section | Identifiers expected |
|----|--------|---------|----------------------|
| technical-config | technical | Reindex triggers | discriminators, sparse-provider, dense-provider, embedding-schema-version, file-hash, reindex |
| everyday-note | non-technical | Morning | — |
| narrative-fiction | non-technical | The crossing | — |
| academic-prose | mixed | Retrieval mechanisms | retrieval, embedding, dense, sparse |
| operational-troubleshooting | technical | ECONNREFUSED on startup | qdrant, qdrant-url, econnrefused, docker |

## Aggregate Results by Policy

Scores:
- **json parse rate**: fraction of calls where `parseCombinedResponse` returned non-null
- **usable rate**: fraction of calls where JSON parsed AND tags 3-7 AND context non-empty
- **mean latency**: average LLM call duration
- **mean tag count**: average tags per usable chunk (target: 3-7)
- **generic rate**: fraction of tags that are generic/noisy single words
- **ident preserv**: fraction of expected identifiers present in tags+context (technical fixtures, usable rows only)
- **tech halluc rate**: fraction of non-technical chunks (usable) where forbidden tech terms appeared
- **ctx score**: heuristic context usefulness (0-1)

| Policy | json parse | usable | latency | tag count | generic rate | ident preserv | tech halluc | ctx score |
|--------|-----------|--------|---------|-----------|--------------|---------------|-------------|-----------|
| current-minimal ★ | 100% | 100% | 2246 ms | 3.5 | 0% | 61% | 0% | 0.96 |
| domain-aware-universal | 100% | 80% | 1364 ms | 3.3 | 0% | 55% | 0% | 0.94 |
| context-first | 100% | 100% | 2413 ms | 3.5 | 0% | 61% | 0% | 0.91 |
| question-guided-domain-aware | 100% | 80% | 1366 ms | 3.3 | 0% | 47% | 0% | 0.92 |

## Per-Fixture Detail

### current-minimal

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 4814 ms | ctx score: 1.00
- Ident preservation: 17%
- Tags: reindex, trigger-conditions, config-json
- Context: Chunk 1 explains the conditions under which a full reindex occurs for collections in a document management system.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 1703 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: morning-routine, appointments, gardening-tasks, insurance, grocery-shopping
- Context: This chunk describes morning activities and tasks, including waking up, making coffee, reminding about a doctor's appointment, and buying groceries.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 1458 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: fear, storm-crossing, bridge-walk
- Context: This chunk describes Mira's crossing of a shaky bridge during a storm, focusing on her fear and determination.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 1757 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: rag, dense-retrieval, sparse-retrieval, reciprocal-rank-fusion
- Context: This chunk describes Retrieval-augmented generation (RAG) systems and their components, which combine a retrieval component with a generative language model.

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1500 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: qdrant, docker, connect-refused
- Context: Chunk 1 explains how to diagnose a 'Error: connect ECONNREFUSED' on Qdrant startup.

### domain-aware-universal

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1329 ms | ctx score: 1.00
- Ident preservation: 33%
- Tags: reindex, config-changes, sparse-provider
- Context: The text explains which configuration changes cause a full reindex process.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 1054 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: morning-routine, appointments, grocery-shopping
- Context: This chunk describes morning activities and includes reminders.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 50% | Latency: 1062 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: story, crossing, bridge-shake
- Context: Mira crosses a shaky bridge while avoiding soldiers during a storm.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 50% | Latency: 2000 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: rag-systems, retrieval-mechanisms, dense-retrieval, sparse-retrieval, reciprocal-rank-fusion
- Context: This chunk explains the different types of retrieval mechanisms used in RAG systems and their combination with generative language models.

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1375 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: qdrant, docker, cloud
- Context: This chunk explains troubleshooting steps for encountering a `connect ECONNREFUSED` error during startup of Qdrant instance.

### context-first

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 2265 ms | ctx score: 0.80
- Ident preservation: 33%
- Tags: reindex, configjson, discriminators
- Context: This chunk discusses how changing certain config.json fields like sparseProvider or denseModel triggers a full reindex process in the collection. Key entities include `sparseProvider`, `denseProvider`

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 2671 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: morning, wake-up, reminder-call-mom, dental-appointment, bread-pickup
- Context: At Morning, woke up at 7 and made coffee while watching the rain. Important reminder includes a call to mom before Thursday for garden maintenance, a dental appointment at 3 pm on Friday, and picking 

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 2191 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: mira, bridge, storm
- Context: On the bridge in chapter 3 of 'story/chapter-03.md', Mira steps onto a swaying plank and hears an unfamiliar voice calling her from afar. This chunk describes her crossing while on edge due to the sto

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 1956 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: rag-systems, dense-retrieval, sparse-retrieval
- Context: This chunk discusses Retrieval-augmented generation (RAG) systems and their components in detail. Key subjects include dense or sparse retrieval methods used by RAG.

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 2983 ms | ctx score: 0.80
- Ident preservation: 75%
- Tags: qdrant, docker, url
- Context: For ECONNREFUSED errors on startup, ensure Qdrant instance is reachable at `QDRANT_URL`. Check Docker container status with `docker ps | grep qdrant`, start it if stopped with `docker compose up -d qd

### question-guided-domain-aware

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1258 ms | ctx score: 1.00
- Ident preservation: 17%
- Tags: sparseprovider, denseprovider, densemodell
- Context: This chunk describes conditions under which a full reindex occurs for a collection in an application.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 50% | Latency: 1561 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: morning, coffee, garden, insurance
- Context: This chunk describes a morning routine including waking up, making coffee, and preparing for tasks.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 1130 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: mira, bridge, river, storm
- Context: This chunk describes Mira's experience crossing a bridge over a fast-moving river.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 50% | Latency: 1523 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: retrieval-augmented-generation, dense-retrieval, sparse-retrieval
- Context: This chunk discusses retrieval-augmented generation systems that integrate a retrieval component with a generative language model using dense or sparse representations.

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1357 ms | ctx score: 1.00
- Ident preservation: 50%
- Tags: qdrant, docker, env-file
- Context: This chunk describes issues related to connecting to a Qdrant instance during startup, including checks for Docker and container health.

## Verdict

**Best candidate by composite score: `current-minimal`**

| Criterion | Result |
|-----------|--------|
| Usable rate | 100% |
| JSON parse rate | 100% |
| Identifier preservation (technical) | 61% |
| Tech hallucination on non-technical text | 0% |
| Context usefulness | 0.96 |

**Verdict: proceed with `current-minimal`** — meets all criteria (usable rate, ident preservation, no hallucination).


*Generated: 2026-05-18T0948*