# COMBINED_LLM Prompt Policy Matrix — 2026-05-18T1043

## Setup

| Item | Value |
|------|-------|
| Model | batiai/gemma4-e2b:q4 |
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
| current-minimal | 100% | 100% | 1068 ms | 4.7 | 0% | 56% | 0% | 0.97 |
| domain-aware-universal | 100% | 100% | 789 ms | 4.8 | 0% | 58% | 0% | 0.93 |
| context-first | 100% | 100% | 875 ms | 4.9 | 0% | 64% | 0% | 0.91 |
| question-guided-domain-aware ★ | 100% | 100% | 808 ms | 5.1 | 0% | 64% | 0% | 0.97 |

## Per-Fixture Detail

### current-minimal

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 2241 ms | ctx score: 1.00
- Ident preservation: 17%
- Tags: reindex, config-json, embedding-schema, provider-settings
- Context: Modifying specific fields in config.json, such as `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion`, triggers a full collection reindex.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 691 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: morning-routine, reminders, schedule, daily-tasks
- Context: This chunk details the morning routine and reminders for the day, including personal tasks and appointments.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 747 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: suspense, crossing, river, action, tension
- Context: This chunk describes Mira's tense crossing of a bridge over a dark river, highlighting a moment of suspense. It is part of the narrative action of the chapter.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 890 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: rag, retrieval, language-model, dense-retrieval, sparse-retrieval, hybrid-search
- Context: This chunk introduces Retrieval-Augmented Generation (RAG) systems and explains how they combine retrieval and generation. It details the different retrieval methods, including dense, sparse, and hybr

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 773 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: qdrant-errors, connection-refused, docker-troubleshooting, startup-errors
- Context: This chunk addresses the `ECONNREFUSED` error during Qdrant startup, providing troubleshooting steps related to Docker, container health, and environment variables.

### domain-aware-universal

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 781 ms | ctx score: 1.00
- Ident preservation: 17%
- Tags: reindex-triggers, config-json, index-management, sparseprovider, denseprovider
- Context: Modifying specific configuration fields in config.json initiates a full or partial reindex of the collection.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 708 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: daily-routine, personal-tasks, reminders, scheduling
- Context: This section details the morning routine and immediate tasks for the day. It outlines personal errands and reminders.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 737 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: suspense, river-crossing, setting, action
- Context: This passage describes Mira's perilous crossing of a bridge over a dark river, emphasizing her suspenseful journey. It advances the action in the narrative.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 935 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: rag, retrieval-augmented-generation, retrieval-mechanisms, dense-retrieval, sparse-retrieval, rrf
- Context: This section describes the architecture of Retrieval-Augmented Generation (RAG) systems, detailing how retrieval and generation components interact. It specifically explains the different retrieval me

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 784 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: docker, qdrant, error-handling, troubleshooting, networking
- Context: This section addresses the `ECONNREFUSED` error during Qdrant startup, troubleshooting connectivity issues related to Docker, container status, and environment variables.

### context-first

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 866 ms | ctx score: 1.00
- Ident preservation: 17%
- Tags: reindex, config.json, sparseprovider, denseprovider
- Context: Changing specific fields like `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion` in `config.json` triggers a full reindex on the next `npm run index`.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 720 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: morning, routine, tasks, dentist, reminder
- Context: The morning routine involved making coffee and observing the rain, along with planning tasks such as calling mom about the garden and preparing for a dentist appointment.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 754 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: bridge, river, mira, soldier, crossing
- Context: Mira steps onto a swaying bridge over a dark, fast river, and while walking, she hears a soldier call her name but finds the far bank empty.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 950 ms | ctx score: 0.80
- Ident preservation: 100%
- Tags: rag, retrieval, dense-retrieval, sparse-retrieval, rrf
- Context: Retrieval-augmented generation (RAG) systems combine a retrieval component and a generative language model. The retrieval component selects relevant passages using dense retrieval (neural embeddings) 

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 1086 ms | ctx score: 0.80
- Ident preservation: 75%
- Tags: qdrant-connection-errors, econnrefused, docker, qdrant_url, qdrant_key
- Context: If the indexer exits with `Error: connect ECONNREFUSED`, the Qdrant instance is unreachable at the configured `QDRANT_URL`. Troubleshooting involves checking if Docker is running, verifying the contai

### question-guided-domain-aware

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 932 ms | ctx score: 1.00
- Ident preservation: 17%
- Tags: sparseprovider, denseprovider, densemodel, embeddingschemaversion, config.json, file_hash
- Context: Changing `sparseProvider`, `denseProvider`, `denseModel`, or `embeddingSchemaVersion` in config.json triggers a full reindex of the collection on next `npm run index`. Changing `file_hash` also trigge

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 732 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: coffee, dentist-appointment, insurance-card, garden
- Context: The text describes morning activities including making coffee, watching the rain, and making reminders about calling mom, a garden, and a dentist appointment.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 713 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: bridge, river, plank, soldier
- Context: Mira stepped onto the first plank of a bridge over a dark, fast river, and heard a soldier call her name but found the far bank empty.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 850 ms | ctx score: 1.00
- Ident preservation: 100%
- Tags: retrieval-augmented-generation, rag, dense-retrieval, sparse-retrieval, neural-embeddings, bm25, reciprocal-rank-fusion
- Context: Retrieval-augmented generation (RAG) systems combine a retrieval component with a generative language model. The retrieval component selects relevant passages from a corpus using dense or sparse repre

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 814 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: econnrefused, qdrant_url, docker, qdrant, qdrant_key
- Context: If the indexer exits with `Error: connect ECONNREFUSED`, the Qdrant instance is not reachable at the configured `QDRANT_URL`.

## Verdict

**Best candidate by composite score: `question-guided-domain-aware`**

| Criterion | Result |
|-----------|--------|
| Usable rate | 100% |
| JSON parse rate | 100% |
| Identifier preservation (technical) | 64% |
| Tech hallucination on non-technical text | 0% |
| Context usefulness | 0.97 |

**Verdict: proceed with `question-guided-domain-aware`** — meets all criteria (usable rate, ident preservation, no hallucination).

If adopting `question-guided-domain-aware`, update `src/indexer/phases/combined.js` `buildPrompt()` and rerun `bench:custom50:combined` to confirm no aggregate regression.

*Generated: 2026-05-18T1043*