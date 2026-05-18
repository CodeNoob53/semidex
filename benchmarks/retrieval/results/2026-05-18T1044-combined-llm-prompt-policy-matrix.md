# COMBINED_LLM Prompt Policy Matrix — 2026-05-18T1044

## Setup

| Item | Value |
|------|-------|
| Model | gemma3:4b-it-qat |
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
| current-minimal ★ | 100% | 100% | 2072 ms | 5.4 | 0% | 71% | 0% | 0.85 |
| domain-aware-universal | 100% | 100% | 897 ms | 4.2 | 0% | 67% | 0% | 0.82 |
| context-first | 50% | 50% | 1016 ms | 6.6 | 0% | 79% | 0% | 0.85 |
| question-guided-domain-aware | 90% | 90% | 1015 ms | 6.9 | 0% | 70% | 0% | 0.87 |

## Per-Fixture Detail

### current-minimal

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 6581 ms | ctx score: 1.00
- Ident preservation: 83%
- Tags: reindex-trigger, config-json, sparse-provider, dense-provider, embedding-schema-version, file-hash
- Context: This section describes when a full reindex of a collection is triggered in the indexer. Specifically, changes to certain configuration fields trigger this process.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 798 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: morning-routine, personal-tasks, appointments, family
- Context: This chunk describes the speaker's morning routine and some tasks they need to complete, including a phone call to their mother and a dentist appointment. It also mentions a household errand.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 815 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: bridge-crossing, character-introduction, suspense, river, storm, audio-hallucination
- Context: This section describes Mira's initial steps onto the bridge and her unsettling experience of hearing a voice that might have been a soldier's call.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 1084 ms | ctx score: 0.80
- Ident preservation: 75%
- Tags: rag-systems, retrieval, generation, dense-retrieval, sparse-retrieval, hybrid-retrieval, bm25
- Context: This chunk describes Retrieval-Augmented Generation (RAG) systems, which combine retrieval and language models for improved generation. It explains the different types of retrieval methods used, inclu

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1085 ms | ctx score: 0.80
- Ident preservation: 75%
- Tags: qdrant-connection-errors, qdrant, docker, qdrant-cloud, startup-errors, connrefused
- Context: This section discusses issues encountered during Qdrant startup, specifically the `ECONNREFUSED` error, which indicates the Qdrant instance is unreachable. It provides troubleshooting steps including 

### domain-aware-universal

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 875 ms | ctx score: 1.00
- Ident preservation: 17%
- Tags: config-reindex, provider-settings, index-trigger
- Context: This section details the configuration settings that cause the indexing process to rerun. It highlights how specific configuration changes initiate a full collection reindex and individual file reinde

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 698 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: daily-planning, personal-schedule, appointments
- Context: This is a personal note recording a morning routine and scheduling tasks. It's a record of daily planning and personal commitments.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 940 ms | ctx score: 0.70
- Tech hallucination: no
- Tags: suspense-narrative, character-journey, bridge-crossing
- Context: This describes a scene of suspense and uncertainty as Mira crosses a bridge, highlighting the precariousness of her journey and a potential unsettling encounter. It’s a pivotal moment in the narrative

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 1018 ms | ctx score: 0.80
- Ident preservation: 100%
- Tags: rag, retrieval, generation, embeddings, bm25, rra, fusion
- Context: This section details the core architecture of Retrieval-Augmented Generation (RAG) systems, focusing on the retrieval component and its various techniques. It outlines the use of dense and sparse retr

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 954 ms | ctx score: 0.80
- Ident preservation: 75%
- Tags: qdrant-connection, docker-container, network-error, environment-variables
- Context: This section describes troubleshooting `ECONNREFUSED` errors when starting the Qdrant indexer, focusing on connectivity issues. It outlines steps to verify the Qdrant container is running and configur

### context-first

**technical-config** (technical)

- JSON parse: 50% | Usable: 50% | Latency: 1110 ms | ctx score: 0.80
- Ident preservation: 67%
- Tags: reindex, config.json, sparse-provider, dense-provider, npm-run-index, file-hash
- Context: Modifying the `sparseProvider`, `denseProvider`, or `denseModel` fields within the `config.json` file initiates a complete reindex of the collection, triggered by the `npm run index` command. The `fil

**everyday-note** (non-technical)

- JSON parse: 0% | Usable: 0% | Latency: 913 ms | ctx score: 0.00
- Tech hallucination: no
- Tags: *(parse failed)*
- Context: *(parse failed)*

**narrative-fiction** (non-technical)

- JSON parse: 50% | Usable: 50% | Latency: 927 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: bridge, crossing, river, soldier, isolation, disappearance
- Context: Mira cautiously crosses the swaying bridge over a fast-flowing river, encountering a confusing and unsettling event when she expects to see a soldier but finds the bank deserted. This highlights her i

**academic-prose** (mixed)

- JSON parse: 50% | Usable: 50% | Latency: 1002 ms | ctx score: 1.00
- Ident preservation: 100%
- Tags: rag, retrieval, dense-retrieval, sparse-retrieval, bm25, rref, language-models
- Context: This section describes RAG systems, which integrate a retrieval component to select relevant passages from a corpus. The retrieval process utilizes dense embeddings and BM25 algorithms, often combined

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1127 ms | ctx score: 0.80
- Ident preservation: 75%
- Tags: qdrant, connection-error, docker, qdrant_url, qdrant_key, container-health, port-mapping
- Context: This document describes the `ECONNREFUSED` error when starting the Qdrant indexer, indicating the Qdrant instance is not reachable. It guides troubleshooting by checking Docker container status, port 

### question-guided-domain-aware

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1181 ms | ctx score: 0.80
- Ident preservation: 17%
- Tags: reindex, trigger, config.json, sparseprovider, denseprovider, densemodel, file_hash
- Context: This section describes when a reindex of a collection is triggered based on changes to specific configuration fields. Specifically, altering `sparseProvider`, `denseProvider`, `denseModel`, or `embedd

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 869 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: coffee, rain, garden, dentist, insurance, bread
- Context: The text describes the beginning of the day, including activities like waking up, making coffee, and planning personal tasks like calling a family member and scheduling appointments. It also mentions 

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 950 ms | ctx score: 0.80
- Tech hallucination: no
- Tags: bridge, river, crossing, soldier, name, empty, plank
- Context: This section describes Mira's crossing of a bridge, emphasizing the instability of the bridge and her lack of attention to the dangerous river below. The experience is punctuated by a potential misint

**academic-prose** (mixed)

- JSON parse: 50% | Usable: 50% | Latency: 1039 ms | ctx score: 0.80
- Ident preservation: 75%
- Tags: rag-systems, retrieval, dense-retrieval, sparse-retrieval, bm25, hybrid-systems, rrf
- Context: This section describes Retrieval-Augmented Generation (RAG) systems, which integrate retrieval components with generative language models. The retrieval process involves selecting relevant passages fr

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1035 ms | ctx score: 0.80
- Ident preservation: 100%
- Tags: qdrant-url, docker, qdrant, container, port-mapping, qdrant-key, econnrefused
- Context: This section describes a common error, `ECONNREFUSED`, when the Qdrant indexer fails to start due to the Qdrant instance not being reachable. It provides troubleshooting steps, including checking Dock

## Verdict

**Best candidate by composite score: `current-minimal`**

| Criterion | Result |
|-----------|--------|
| Usable rate | 100% |
| JSON parse rate | 100% |
| Identifier preservation (technical) | 71% |
| Tech hallucination on non-technical text | 0% |
| Context usefulness | 0.85 |

**Verdict: proceed with `current-minimal`** — meets all criteria (usable rate, ident preservation, no hallucination).


*Generated: 2026-05-18T1044*