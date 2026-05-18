# COMBINED_LLM Prompt Policy Matrix — 2026-05-18T0919

## Setup

| Item | Value |
|------|-------|
| Model | gemma3:4b |
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
| current-minimal ★ | 100% | 100% | 1211 ms | 6.2 | 0% | 72% | 0% | 0.86 |
| domain-aware-universal | 100% | 100% | 1027 ms | 5.7 | 0% | 71% | 0% | 0.81 |
| context-first | 40% | 40% | 1040 ms | 7.0 | 0% | 75% | 0% | 0.81 |
| question-guided-domain-aware | 30% | 30% | 1072 ms | 6.7 | 0% | 67% | 0% | 0.93 |

## Per-Fixture Detail

### current-minimal

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1991 ms | ctx score: 1.00
- Ident preservation: 67%
- Tags: reindex, trigger, config-json, sparse-provider, dense-provider, index
- Context: This section details triggers that initiate a reindex of the collection within the indexing process. Specifically, changes to certain configuration fields are identified as reindex discriminators.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 866 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: daily-routine, morning, appointments, family, errands
- Context: This chunk describes the beginning of the day, including morning activities and errands to be completed. It provides a reminder about a dental appointment and a task to call a family member.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 934 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: bridge-crossing, suspense, character-development, river, military, perception, mystery
- Context: This chunk describes Mira's initial crossing of a bridge and the unsettling experience of hearing a voice and seeing an empty bank. It builds suspense and introduces a potential element of mystery.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 1146 ms | ctx score: 0.80
- Ident preservation: 75%
- Tags: rag, retrieval, dense-retrieval, sparse-retrieval, bm25, hybrid-retrieval, rpf
- Context: This chunk describes Retrieval-Augmented Generation (RAG) systems, focusing on the different retrieval components used in these systems. It explains the distinction between dense and sparse retrieval 

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1117 ms | ctx score: 0.80
- Ident preservation: 100%
- Tags: qdrant, connection-errors, docker, qdrant-url, qdrant-key, startup, hybrid-search
- Context: This chunk addresses the `ECONNREFUSED` error that occurs when the Qdrant instance is unreachable during startup. It provides troubleshooting steps to verify the Qdrant container is running, the port 

### domain-aware-universal

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1041 ms | ctx score: 0.80
- Ident preservation: 33%
- Tags: reindex-triggers, config-json, discriminators
- Context: This section details the triggers that initiate a reindex operation within the indexing pipeline, specifically relating to configuration parameters. It highlights the critical settings that demand a c

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 810 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: daily-planning, personal-schedule, appointments, household-chores
- Context: This is a personal note detailing the morning routine and a few planned tasks. It represents a stream of consciousness record of activities and appointments.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 1033 ms | ctx score: 0.70
- Tech hallucination: no
- Tags: suspense-building, character-movement, bridge-crossing, narrative-tension, atmospheric-description, uncertainty, suspense
- Context: This excerpt depicts a tense moment in the narrative, focusing on a character's journey across a precarious structure. It establishes an atmosphere of suspense and uncertainty, a key element of the st

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 1178 ms | ctx score: 0.80
- Ident preservation: 75%
- Tags: rag-systems, retrieval-mechanisms, dense-retrieval, sparse-retrieval, bm25, approximate-nearest-neighbour, reciprocal-rank-fusion
- Context: This section details the core components of Retrieval-Augmented Generation (RAG) systems, specifically focusing on the retrieval mechanisms used to access relevant information. It describes different 

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1072 ms | ctx score: 0.80
- Ident preservation: 75%
- Tags: qdrant-connection-errors, docker-troubleshooting, network-connectivity, qdrant-cloud, startup-errors, container-health, environment-variables
- Context: This section details troubleshooting steps for a common `ECONNREFUSED` error encountered when the Qdrant indexer fails to start. It provides guidance on verifying network connectivity and Qdrant insta

### context-first

**technical-config** (technical)

- JSON parse: 0% | Usable: 0% | Latency: 1191 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 953 ms | ctx score: 0.65
- Tech hallucination: no
- Tags: morning, coffee, dentist, reminder, garden, bread, call
- Context: The user started their day by waking up at 7 am and engaging in personal activities like making coffee and observing the rain. They have scheduled tasks including calling their mother, a dentist appoi

**narrative-fiction** (non-technical)

- JSON parse: 0% | Usable: 0% | Latency: 903 ms | ctx score: 0.00
- Tech hallucination: no
- Tags: *(parse failed)*
- Context: *(parse failed)*

**academic-prose** (mixed)

- JSON parse: 0% | Usable: 0% | Latency: 1071 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1083 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: qdrant, connection, refused, docker, url, key, error
- Context: This section describes the `ECONNREFUSED` error, indicating the Qdrant instance is unreachable. It provides troubleshooting steps, including checking Docker status, verifying port mappings, and confir

### question-guided-domain-aware

**technical-config** (technical)

- JSON parse: 50% | Usable: 50% | Latency: 1400 ms | ctx score: 0.80
- Ident preservation: 67%
- Tags: reindex-triggers, config-json, sparse-provider, dense-provider, dense-model, file-hash, npm-run-index
- Context: Modifying specific configuration fields, such as `sparseProvider`, `denseProvider`, or `denseModel` within the `config.json` file, initiates a complete reindex process for the collection when executed

**everyday-note** (non-technical)

- JSON parse: 50% | Usable: 50% | Latency: 868 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: morning, coffee, dentist, garden, bread, reminder, appointment
- Context: The text describes a morning routine, including waking up, making coffee, a personal task (calling a mother), a scheduled appointment (dentist), and a household errand (picking up bread).

**narrative-fiction** (non-technical)

- JSON parse: 50% | Usable: 50% | Latency: 913 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: bridge, river, crossing, soldier, dark, plank
- Context: This passage describes Mira's cautious crossing of a bridge over a swiftly flowing river, emphasizing her lack of attention to the danger below and a confusing auditory experience involving a soldier'

**academic-prose** (mixed)

- JSON parse: 0% | Usable: 0% | Latency: 1053 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**operational-troubleshooting** (technical)

- JSON parse: 0% | Usable: 0% | Latency: 1126 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

## Verdict

**Best candidate by composite score: `current-minimal`**

| Criterion | Result |
|-----------|--------|
| Usable rate | 100% |
| JSON parse rate | 100% |
| Identifier preservation (technical) | 72% |
| Tech hallucination on non-technical text | 0% |
| Context usefulness | 0.86 |

**Verdict: proceed with `current-minimal`** — meets all criteria (usable rate, ident preservation, no hallucination).


*Generated: 2026-05-18T0919*