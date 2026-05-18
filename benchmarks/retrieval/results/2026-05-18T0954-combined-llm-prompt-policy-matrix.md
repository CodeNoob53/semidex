# COMBINED_LLM Prompt Policy Matrix — 2026-05-18T0954

## Setup

| Item | Value |
|------|-------|
| Model | phi4-mini |
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
| current-minimal | 100% | 70% | 2787 ms | 3.1 | 0% | 52% | 0% | 1.00 |
| domain-aware-universal | 100% | 70% | 2082 ms | 3.1 | 0% | 52% | 0% | 0.91 |
| context-first | 100% | 70% | 2565 ms | 3.4 | 0% | 68% | 0% | 0.87 |
| question-guided-domain-aware ★ | 100% | 80% | 2992 ms | 4.5 | 0% | 67% | 0% | 0.94 |

## Per-Fixture Detail

### current-minimal

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 3233 ms | ctx score: 1.00
- Ident preservation: 17%
- Tags: reindex, config-json, trigger
- Context: This chunk explains how changing certain configuration parameters in config.json can cause a full collection reindex.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 50% | Latency: 2092 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: daily-routine, morning-task-planner, reminders
- Context: Describes daily morning routine including waking up early for coffee and planning tasks like calling a mother about an overgrown garden.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 50% | Latency: 2608 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: bridges, river-crossing, miscommunication
- Context: Mira steps onto a swaying bridge over a dark and fast river carrying storm debris. A voice calling from afar is misheard as Mira continues crossing.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 2965 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: retrieval-augmented-generation, dense-retrieval, sparse-retrieval, hybrid-systems
- Context: This chunk discusses different methods used in Retrieval-augmented Generation systems for selecting relevant passages.

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 50% | Latency: 3039 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: qdrant-startup-error, docker-container-troubleshooting, connection-refused
- Context: This section provides troubleshooting steps for ECONNREFUSED errors encountered during startup of a Qdrant instance.

### domain-aware-universal

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 2303 ms | ctx score: 0.85
- Ident preservation: 17%
- Tags: reindex-triggers, config-changes, collection-indexing
- Context: This section explains how certain changes in a configuration file will cause different parts or an entire collection to be fully indexed.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 2051 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: morning-routine, personal-notes, daily-planning
- Context: Describes a morning routine including making coffee and checking weather conditions.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 0% | Latency: 1913 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: crossing, bridge-crossing-suspense
- Context: Mira steps onto a swaying bridge while crossing it alone and hears what seems to be someone calling from afar.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 50% | Latency: 2031 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: retrieval-augmented-generation, dense-retrieval, sparse-retrieval, reciprocal-rank-fusion
- Context: This section explains how RAG systems integrate a language model with different types of data retrieval mechanisms.

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 2111 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: docker, qdrant-error, troubleshooting
- Context: This section provides troubleshooting steps for an ECONNREFUSED error encountered when starting a Qdrant indexer.

### context-first

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 2393 ms | ctx score: 1.00
- Ident preservation: 33%
- Tags: reindex, config-json, discriminators
- Context: Modifying certain configuration parameters in config.json initiates a full collection reindex upon running 'npm run index'.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 0% | Latency: 2279 ms | ctx score: 1.00
- Tech hallucination: no
- Tags: morning-routine, personal-reminder
- Context: The author woke up early in the morning and planned their day around making coffee, calling a family member about an important matter related to gardening responsibilities before leaving for work or e

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 2516 ms | ctx score: 0.70
- Tech hallucination: no
- Tags: bridge-crossing, swaying-planks, river-crossing
- Context: Mira steps onto a swaying bridge and hears someone calling her name.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 100% | Latency: 3114 ms | ctx score: 1.00
- Ident preservation: 100%
- Tags: rag, retrieval-augmented-generation, dense-retrieval, sparse-retrieval, neural-embeddings
- Context: This section describes how RAG systems integrate a dense/retrieval or sparse/sparse component for relevant passage selection.

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 50% | Latency: 2522 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: docker, qdrant, connect-error
- Context: This section addresses an ECONNREFUSED error during startup by checking Docker container status for a running instance of Qdrant.

### question-guided-domain-aware

**technical-config** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 3110 ms | ctx score: 1.00
- Ident preservation: 67%
- Tags: config-json, reindex-discriminators, sparse-provider, dense-provider
- Context: This chunk describes settings in config.json that initiate a full collection or file reindex when changed.

**everyday-note** (non-technical)

- JSON parse: 100% | Usable: 100% | Latency: 2258 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: personal-activities, waking-up, coffee, watching-rain
- Context: This chunk describes personal activities like waking up early and making coffee while watching rainy weather.

**narrative-fiction** (non-technical)

- JSON parse: 100% | Usable: 50% | Latency: 2385 ms | ctx score: 0.85
- Tech hallucination: no
- Tags: bridge-crossing, river-crossing, swaying-bridge
- Context: Mira steps onto a swaying bridge over a dark river carrying branches from an overnight storm and hears what seems to be someone calling her name on the other side.

**academic-prose** (mixed)

- JSON parse: 100% | Usable: 50% | Latency: 4184 ms | ctx score: 0.80
- Ident preservation: 100%
- Tags: retrieval-augmented-generation, dense-retrieval, neural-embeddings, approximate-nearest-neighbour-search, sparse-retrieval, term-frequency-weighting-bm25
- Context: This chunk explains different mechanisms used in Retrieval-Augmented Generation systems including dense representation with neural embeddings and approximate nearest-neighbour search for sparse retrie

**operational-troubleshooting** (technical)

- JSON parse: 100% | Usable: 100% | Latency: 3022 ms | ctx score: 1.00
- Ident preservation: 75%
- Tags: qdrant, docker-compose-up--d-qdrant, .env-file, qdrant_url, econnrefused
- Context: This section provides troubleshooting steps for ECONNREFUSED errors during startup of a Qdrant instance.

## Verdict

**Best candidate by composite score: `question-guided-domain-aware`**

| Criterion | Result |
|-----------|--------|
| Usable rate | 80% |
| JSON parse rate | 100% |
| Identifier preservation (technical) | 67% |
| Tech hallucination on non-technical text | 0% |
| Context usefulness | 0.94 |

**Verdict: needs deeper test** — `question-guided-domain-aware` is the best available candidate but does not fully satisfy all criteria on this small fixture set.
Rerun with larger fixture set or RUNS_PER_CELL=5 before committing to production.

*Generated: 2026-05-18T0954*