# COMBINED_LLM Prompt Policy Matrix — 2026-05-18T0950

## Setup

| Item | Value |
|------|-------|
| Model | qwen3:1.7b |
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
| current-minimal ★ | 0% | 0% | 403 ms | 0.0 | 0% | n/a | n/a | 0.00 |
| domain-aware-universal | 0% | 0% | 273 ms | 0.0 | 0% | n/a | n/a | 0.00 |
| context-first | 0% | 0% | 266 ms | 0.0 | 0% | n/a | n/a | 0.00 |
| question-guided-domain-aware | 0% | 0% | 302 ms | 0.0 | 0% | n/a | n/a | 0.00 |

## Per-Fixture Detail

### current-minimal

**technical-config** (technical)

- JSON parse: 0% | Usable: 0% | Latency: 999 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**everyday-note** (non-technical)

- JSON parse: 0% | Usable: 0% | Latency: 213 ms | ctx score: 0.00
- Tech hallucination: no
- Tags: *(parse failed)*
- Context: *(parse failed)*

**narrative-fiction** (non-technical)

- JSON parse: 0% | Usable: 0% | Latency: 256 ms | ctx score: 0.00
- Tech hallucination: no
- Tags: *(parse failed)*
- Context: *(parse failed)*

**academic-prose** (mixed)

- JSON parse: 0% | Usable: 0% | Latency: 260 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**operational-troubleshooting** (technical)

- JSON parse: 0% | Usable: 0% | Latency: 286 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

### domain-aware-universal

**technical-config** (technical)

- JSON parse: 0% | Usable: 0% | Latency: 272 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**everyday-note** (non-technical)

- JSON parse: 0% | Usable: 0% | Latency: 252 ms | ctx score: 0.00
- Tech hallucination: no
- Tags: *(parse failed)*
- Context: *(parse failed)*

**narrative-fiction** (non-technical)

- JSON parse: 0% | Usable: 0% | Latency: 280 ms | ctx score: 0.00
- Tech hallucination: no
- Tags: *(parse failed)*
- Context: *(parse failed)*

**academic-prose** (mixed)

- JSON parse: 0% | Usable: 0% | Latency: 281 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**operational-troubleshooting** (technical)

- JSON parse: 0% | Usable: 0% | Latency: 282 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

### context-first

**technical-config** (technical)

- JSON parse: 0% | Usable: 0% | Latency: 233 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**everyday-note** (non-technical)

- JSON parse: 0% | Usable: 0% | Latency: 229 ms | ctx score: 0.00
- Tech hallucination: no
- Tags: *(parse failed)*
- Context: *(parse failed)*

**narrative-fiction** (non-technical)

- JSON parse: 0% | Usable: 0% | Latency: 271 ms | ctx score: 0.00
- Tech hallucination: no
- Tags: *(parse failed)*
- Context: *(parse failed)*

**academic-prose** (mixed)

- JSON parse: 0% | Usable: 0% | Latency: 289 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**operational-troubleshooting** (technical)

- JSON parse: 0% | Usable: 0% | Latency: 307 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

### question-guided-domain-aware

**technical-config** (technical)

- JSON parse: 0% | Usable: 0% | Latency: 289 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**everyday-note** (non-technical)

- JSON parse: 0% | Usable: 0% | Latency: 292 ms | ctx score: 0.00
- Tech hallucination: no
- Tags: *(parse failed)*
- Context: *(parse failed)*

**narrative-fiction** (non-technical)

- JSON parse: 0% | Usable: 0% | Latency: 292 ms | ctx score: 0.00
- Tech hallucination: no
- Tags: *(parse failed)*
- Context: *(parse failed)*

**academic-prose** (mixed)

- JSON parse: 0% | Usable: 0% | Latency: 303 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

**operational-troubleshooting** (technical)

- JSON parse: 0% | Usable: 0% | Latency: 334 ms | ctx score: 0.00
- Tags: *(parse failed)*
- Context: *(parse failed)*

## Verdict

**All variants fail** — no policy produced usable output across all fixtures.
Check model availability and Ollama connectivity.

**Recommendation:** fix model/connectivity before proceeding.

*Generated: 2026-05-18T0950*