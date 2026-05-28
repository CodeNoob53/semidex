# Entity Boost — Private Linux Hard-Technical Corpus Validation

**Date:** 2026-05-27T1619  
**Verdict:** `ENTITY_BOOST_HARD_TECHNICAL_FAIL` — entity boost is a universal no-op on this corpus type because the current extractor does not create useful entities; hybrid retrieval quality is good without it

## Privacy Statement

This report does not contain private absolute paths, folder names, raw note text, or any
identifying corpus content. The source corpus is referred to as `private-linux-topic`.
Source file labels are sanitized short names (`note-1.md`, `note-2.md`, etc.). Raw outputs
and the validation script are kept under `.tmp/` and are not committed.

## Corpus Description

**private-linux-topic** is a single self-contained topic from a private Ukrainian-language
Linux notes corpus. The topic covers systemd service management: architecture, runtime
control commands, autostart configuration, log inspection, and best practices. It consists
of 6 Markdown files with a total of ~1,025 lines containing:

- prose explanations in Ukrainian
- inline code blocks with shell commands (`systemctl`, `journalctl`, `chmod`, etc.)
- configuration file fragments (`ExecStart=`, `WantedBy=`, `Restart=`, `After=`)
- tables of command options and flags
- no base64 image embeds (confirmed before indexing)

## Collection

| Field | Value |
|-------|-------|
| Collection name | `private-linux-entity-boost-<timestamp>` (timestamp omitted from report) |
| Source scope | `private-linux-topic` — 6 files |
| Points indexed | 16 |
| Provider | bge-m3-onnx / bge-m3-onnx |
| Schema version | 2 |
| Entity payload | 16/16 points — boost-relevant arrays (paths, symbols, env_vars, commands) empty on all points (see below) |
| No stale/unrelated source files | confirmed |
| `ENTITY_BOOST_WEIGHT` | 0.0015 |
| `ENTITY_BOOST_PREFETCH` | 20 |
| top-K | 5 |

## Key Finding: Extractor Produces Zero Tokens for This Corpus

The entity extractor (`src/indexer/phases/entities.js`) uses patterns tuned for the semidex
codebase:

| Pattern | Matches | Does NOT match |
|---------|---------|----------------|
| paths | `src/...`, `benchmarks/...`, `docs/...` prefix paths | `/usr/bin/myapp`, system paths |
| symbols | camelCase alternation (`hybridSearch`, `applyEntityBoost`) | `ExecStart`, `WantedBy`, `journalctl` |
| env_vars | known prefixes: `BENCH_`, `ONNX_`, `QDRANT_`, `RERANK_`, `ENTITY_BOOST_`, etc. | `PATH`, `HOME`, `SYSTEMD_UNIT` |
| commands | `npm run <name>` only | `systemctl start nginx`, `journalctl -u sshd` |

All 16 indexed chunks have empty `entities.paths`, `entities.symbols`, `entities.env_vars`,
and `entities.commands` arrays. Confirmed by direct scroll inspection and by running the
extractor on a synthetic representative string (no raw note text):

```
extractEntities({ text: 'systemctl start nginx\nExecStart=/usr/bin/myapp\nRestart=on-failure', ... })
→ { paths: [], symbols: [], env_vars: [], commands: [] }
```

Since no chunk carries any entity tokens, there is no overlap possible regardless of the
query. `queryEntityTokens(query)` also returns empty sets for all queries tested (shell
commands, config keys, and Ukrainian prose alike — none match the extractor patterns).

## Query Set and Results

14 queries across 4 classes. File labels sanitized as `note-N.md#chunk_index`.

| note-N.md mapping | description |
|--------------------|-------------|
| note-1.md | introduction |
| note-2.md | systemd architecture |
| note-3.md | runtime control (systemctl) |
| note-4.md | autostart (enable/disable) |
| note-5.md | log inspection (journalctl) |
| note-6.md | best practices |

### Per-query results

| id | type | tokens | overlap | boost_skipped | change | base top-1 | boost top-1 |
|----|------|--------|---------|---------------|--------|------------|-------------|
| n01 | nav | 0 | 0 | no_tokens | unchanged | note-3.md#1 | note-3.md#1 |
| n02 | nav | 0 | 0 | no_tokens | unchanged | note-4.md#1 | note-4.md#1 |
| n03 | nav | 0 | 0 | no_tokens | unchanged | note-5.md#0 | note-5.md#0 |
| n04 | nav | 0 | 0 | no_tokens | unchanged | note-4.md#2 | note-4.md#2 |
| n05 | nav | 0 | 0 | no_tokens | unchanged | note-6.md#1 | note-6.md#1 |
| n06 | nav | 0 | 0 | no_tokens | unchanged | note-6.md#1 | note-6.md#1 |
| s01 | sem | 0 | 0 | no_tokens | unchanged | note-2.md#0 | note-2.md#0 |
| s02 | sem | 0 | 0 | no_tokens | unchanged | note-4.md#2 | note-4.md#2 |
| s03 | sem | 0 | 0 | no_tokens | unchanged | note-3.md#2 | note-3.md#2 |
| s04 | sem | 0 | 0 | no_tokens | unchanged | note-6.md#1 | note-6.md#1 |
| t01 | struct | 0 | 0 | no_tokens | unchanged | note-3.md#0 | note-3.md#0 |
| t02 | struct | 0 | 0 | no_tokens | unchanged | note-4.md#2 | note-4.md#2 |
| t03 | struct | 0 | 0 | no_tokens | unchanged | note-5.md#0 | note-5.md#0 |
| z01 | zero | 0 | 0 | no_tokens | unchanged | note-2.md#0 | note-2.md#0 |

**All 14 queries: boost skipped (no_tokens), all results identical to baseline.**

## Hybrid Retrieval Quality (Baseline)

Although entity boost contributes nothing here, the hybrid retrieval results are semantically
correct in all 14 cases. Spot-check of top-1 placements:

- "systemctl status nginx" → note-3.md (runtime control file) ✓
- "journalctl -u nginx" → note-5.md (log inspection file) ✓
- "ExecStart WantedBy systemd unit file" → note-4.md (autostart/unit file configuration) ✓
- "what is PID 1 in Linux" → note-2.md (architecture file) ✓
- "best practices for running a custom application as a service" → note-6.md ✓
- "table of systemctl commands" → note-3.md#0 (the commands table chunk) ✓

BGE-M3 sparse encodes Ukrainian technical content and shell commands reliably enough that
lexical matching fires on `systemctl`, `journalctl`, `nginx`, and config keys without
entity boost.

## Source-Navigation Outcome

**Boost never fired.** All nav queries produce zero entity tokens — `systemctl`, `journalctl`,
`ExecStart`, `Restart=on-failure` are not matched by any current extractor pattern. Hybrid
sparse retrieval alone surfaces topically correct files in all 6 cases; entity boost provides
no additional lift and introduces no harm.

## Semantic Query Safety

**Boost never fired.** All 4 semantic queries (English-language explanation queries, e.g.
"what is PID 1 in Linux", "difference between enable and start") produce zero entity tokens —
English prose phrasing contains no extractor-matched identifiers. The one Ukrainian-language
control query (z01) likewise produces zero tokens. Results identical to baseline across all 5
queries. No regression risk.

## Structured-Data Observations

Queries targeting tables, code blocks, and config fragments (t01–t03) all produced
zero entity tokens. The hybrid sparse leg matched the technical identifiers (`systemctl`,
`journalctl`, `nginx`) directly, returning the expected chunks without boost.

No base64 image embeds were present in the topic. Chunk quality for structured content
(tables and code blocks) is good — the chunker preserved code blocks within chunks
without splitting mid-block in the sampled results.

## Extractor Scope Limitation — Root Cause

The entity extractor was designed and calibrated for **semidex's own codebase and
documentation**: `npm run` commands, `src/` file paths, camelCase JS symbols, and a known
set of env var prefixes. It is not a general-purpose identifier extractor.

For a Linux/systemd corpus, the relevant entity types would require additional extractor
patterns:

| Missing pattern | Example tokens |
|-----------------|----------------|
| Shell commands (`<word> <args>`) | `systemctl`, `journalctl`, `chmod` |
| Unit file directives (`Key=Value`) | `ExecStart`, `WantedBy`, `Restart`, `After` |
| System paths (`/usr/...`, `/etc/...`) | `/usr/bin/myapp`, `/etc/systemd/system/` |
| Generic env vars (`UPPER_CASE`) | `SYSTEMD_UNIT`, `PATH`, `HOME` |

Without these patterns, entity boost is a structural no-op on any Linux documentation
corpus regardless of weight or prefetch settings.

## Verdict

**`ENTITY_BOOST_HARD_TECHNICAL_FAIL`**

This is a failed production-generalization test. Entity boost does not degrade
retrieval, and the graceful no-op behavior is confirmed, but the feature provides
no value when the entity extractor does not create comparable query/chunk
entities.

However, entity boost provides **no benefit** on general Linux/systemd documentation.
The current extractor scope is the limiting factor, not the boost mechanism itself.

## Recommendation

**Remove from production MCP search and keep as benchmark-only.** The previous
custom-50 and semidex-docs results should be treated as situational evidence,
not as production acceptance evidence.

If entity boost is to be useful on general technical corpora (Linux, DevOps, API docs), the
extractor would need additional patterns for:
- shell commands beyond `npm run X`
- system paths beyond `src/`, `docs/`, `benchmarks/`
- generic ALL_CAPS identifiers (currently restricted to known semidex prefixes)
- unit file directives (`Key=Value` syntax)

This extractor extension is a separate work item and out of scope for the current opt-in
validation.

## Scope Caveat

This report covers one private-linux-topic only. It is not a general claim about
Linux documentation corpora — it is evidence for this specific topic with the current
extractor implementation.

## Verification

- `npm run smoke`: 650 passed, 0 failed
- `git diff --check`: clean (CRLF warnings only)
- Privacy scan: no private paths, folder names, or raw content in this report
- Temporary collection: created and used for validation only; will be cleaned up separately
- `.tmp/` validation script: not committed
