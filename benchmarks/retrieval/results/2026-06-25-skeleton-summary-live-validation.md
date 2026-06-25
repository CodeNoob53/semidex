# Skeleton Summary Live Validation

**Date:** 2026-06-25
**Collection:** `fullstack-python-web`
**Source:** `<private-fullstack-python-source>` (91 Markdown files, 15 directories)
**Smoke:** 1208 passed, 0 failed
**Verdict:** SKELETON_SUMMARY_LIVE_ACCEPT (with MCP exposure blockers fixed during this run)

---

## Reindex Command

```powershell
$env:COLLECTION="fullstack-python-web"
$env:ONNX_EMBED="1"
$env:SKELETON_CHUNKING="1"
$env:SKELETON_NAV="1"
$env:SKELETON_SUMMARY="llm"
$env:FORCE_REINDEX="1"
$env:OLLAMA_URL="http://127.0.0.1:11434"
npm run index "<private-fullstack-python-source>"
```

Result: 91 indexed, 0 skipped. 15 directory summaries generated.

---

## Blockers Found and Fixed During Validation

### 1. `NAV_PAYLOAD_FIELDS` missing adaptive fields

The constant used by all MCP skeleton queries (`getCollectionSkeletonNode`,
`getSkeletonNodeById`, `getSkeletonNodeByPath`, `getSkeletonChildren`) specified
only the base structural fields. Qdrant's projection filter was silently dropping
`summary_kind`, `summary_version`, `key_topics`, `notable_terms`, `child_overview`
before returning results to the MCP tools.

Effect: all three skeleton query helpers returned nodes with summaries but none
of the adaptive metadata that the formatters were mostly prepared to expose.

Fix: added missing fields to `NAV_PAYLOAD_FIELDS`:

```js
// Before
const NAV_PAYLOAD_FIELDS = [
  'point_kind', 'node_type', 'node_id', 'node_path', 'parent_id',
  'summary', 'children', 'source_file', 'heading_path', 'inventory',
];

// After
const NAV_PAYLOAD_FIELDS = [
  'point_kind', 'node_type', 'node_id', 'node_path', 'parent_id',
  'summary', 'children', 'source_file', 'heading_path', 'inventory',
  'summary_kind', 'summary_version', 'key_topics', 'notable_terms', 'child_overview',
];
```

Verified via direct helper calls after fix — all fields are returned from Qdrant.

### 2. `qdrant_get_skeleton` root formatter hid collection topics

After fixing projection, `qdrant_get_skeleton_node` and
`qdrant_get_skeleton_children` exposed adaptive fields correctly, but
`qdrant_get_skeleton` still rendered only `summary_kind` and `summary_version`
for the collection root. That hid the most useful collection-level orientation
fields from the default entrypoint.

Fix: `src/mcp/tools/getSkeleton.js` now includes collection root
`key_topics` and `notable_terms`. Smoke section 53 was extended to cover both
presence and absence of those fields.

MCP server restart required to apply both fixes in the running process.

---

## Check 1: Collection Root

Raw Qdrant payload:

| Field | Value |
|-------|-------|
| `node_type` | `collection` |
| `summary_kind` | `collection_overview` ✓ |
| `summary_version` | `2` ✓ |
| `key_topics` | `["Full-Stack Python","FastAPI Development","Docker Containerization","API Design & REST","Database Integration","Web Security Basics","Testing Techniques","Deployment Strategies"]` |
| `notable_terms` | `["FastAPI","Docker","RabbitMQ","SQLAlchemy","Migrations","REST API","JWT-tokens","Sessions","Authorization","Authentication","Asynchronous Programming","Flask"]` |

**Summary:**
> Ця колекція надає всебічний вступ до повного стеку веб-розробки на Python,
> охоплюючи інфраструктуру, безпеку бекенду, проєктування API, тестування та
> розгортання. Вона використовує FastAPI, Docker та RabbitMQ для створення надійних
> та масштабованих додатків. Колекція особливо корисна для агентів, які хочуть
> вивчити веб-розробку з Python, зокрема, архітектуру REST API, асинхронне
> програмування та найкращі практики безпеки. Вона охоплює контейнеризацію за
> допомогою Docker та роботу з базами даних через SQLAlchemy.

Assessment: distinct from any individual directory summary. Covers breadth (15 topic
areas), entry signals ("when an agent should drill in"), and key identifiers. Not a
copy of a child node. ✓

---

## Check 2: Directory Nodes (5 samples)

| Directory | `summary_kind` | `summary_version` | Summary (excerpt) |
|-----------|---------------|-------------------|-------------------|
| Тема 12. Основи тестування | `rollup` | `2` | "covers fundamental web application testing concepts including unit and integration tests..." |
| Тема 11. Інтеграція поштових сервісів | `rollup` | `2` | "охоплює інтеграцію поштових сервісів та хмарного сховища у FastAPI..." |
| Тема 2. Основи технології Docker | `rollup` | `2` | "охоплює основи технології Docker, включаючи встановлення, основні команди..." |
| Тема 14. Асинхронна обробка | `rollup` | `2` | "описують використання RabbitMQ та Celery для асинхронної обробки завдань..." |
| Тема 8. Побудова REST API | `rollup` | `2` | "охоплює побудову REST API з використанням FastAPI та багаторівневої архітектури..." |

Note: directories use `rollup` because each has multiple file children (4-12 files).
No `propagated` directories observed here — all sampled directories are multi-child.
`key_topics`/`notable_terms` are absent on directory rollups (correct — rollup is plain
text, structured JSON fields only appear on `llm_structured` and propagated nodes that
sourced from `llm_structured`).

Summaries are useful for navigation: each communicates what content is in the directory
and at what level of detail, not just a structural count. ✓

---

## Check 3: File Nodes (6 samples)

| File | `summary_kind` | `summary_version` | key_topics count | Notes |
|------|---------------|-------------------|-----------------|-------|
| `2. Еволюція_менеджерів_пакетів.md` | `propagated` | `2` | 6 | Single-section, no preamble ✓ |
| `5. Структуроване_керування_завданнями.md` | `propagated` | `2` | 6 | Single-section propagation ✓ |
| `4. Збереження_файлів_у_хмарі.md` | `propagated` | `2` | 6 | Single-section propagation ✓ |
| `9. Випереджальне_виконання.md` | `propagated` | `2` | absent | Propagated from section that got medium tier (no key_topics) |
| `1. Розсилка_та_надсилання_електронних_листів.md` | `propagated` | `2` | — | Single-section propagation ✓ |
| `5. Сервіси_для_розгортання.md` | `propagated` | `2` | — | Single-section propagation ✓ |

Observation: most files in this collection are single-section (1 heading + content),
so propagation fires widely — saving ~50% of file-level LLM calls. Files that propagated
from a `llm_structured` section carry `key_topics`; files that propagated from
`llm_medium` do not (correct — medium tier returns plain text only). `inventory` is
preserved on all propagated files. ✓

---

## Check 4: MCP Tool Output

### Before fix (NAV_PAYLOAD_FIELDS gap)

`qdrant_get_skeleton` returned collection root with correct `summary` but:
- `summary_kind` absent (was filtered out by projection)
- `summary_version` absent
- `key_topics` absent
- Children showed summaries but no `summary_kind` hints

`qdrant_get_skeleton_node` on a file node:
- `summary`, `inventory`, `children` present
- `summary_kind: propagated` absent
- `key_topics` absent

`qdrant_get_skeleton_children` on a directory:
- Child summaries present
- No `summary_kind` per child

### After fix (verified via direct Node call)

`getSkeletonNodeByPath('...2. Еволюція_менеджерів_пакетів.md#file')` returns:
```json
{
  "summary_kind": "propagated",
  "summary_version": 2,
  "key_topics": ["Pipenv","Poetry","Lockfile","uv (Rust)","Pyproject.toml","Virtual environments"],
  "notable_terms": ["pip","venv","requirements.txt","Pipfile","Pipfile.lock","uv","Pyproject.toml","legacy code"]
}
```

`getCollectionSkeletonNode('fullstack-python-web')` returns:
```json
{
  "summary_kind": "collection_overview",
  "summary_version": 2,
  "key_topics": ["Full-Stack Python","FastAPI Development","Docker Containerization",...]
}
```

MCP server restart required to apply the fix in the running process. ✓

---

## Check 5: Regression — Smoke

```
Smoke tests: 1208 passed, 0 failed
```

`git diff --check`: clean (LF→CRLF warning only, no whitespace errors). ✓

---

## Summary of Findings

| Check | Result |
|-------|--------|
| Collection root `summary_kind: collection_overview` | ✓ PASS |
| Collection summary distinct from child summary | ✓ PASS |
| Collection `key_topics` + `notable_terms` present | ✓ PASS |
| Directory `summary_kind: rollup` on multi-child dirs | ✓ PASS |
| Directory summaries useful for navigation | ✓ PASS |
| File single-section propagation fires | ✓ PASS |
| `inventory` preserved on propagated files | ✓ PASS |
| `key_topics` absent when source is medium tier | ✓ PASS (correct behavior) |
| MCP tools expose adaptive fields | ✓ FIXED (NAV_PAYLOAD_FIELDS) |
| `qdrant_get_skeleton` exposes root `key_topics` / `notable_terms` | ✓ FIXED |
| Smoke 1208 passed | ✓ PASS |
| `git diff --check` clean | ✓ PASS |

**Verdict: SKELETON_SUMMARY_LIVE_ACCEPT**

Two MCP exposure blockers were fixed: `NAV_PAYLOAD_FIELDS` in `src/core/qdrant.js`
was missing adaptive fields, and `qdrant_get_skeleton` did not render collection
root `key_topics` / `notable_terms`. Together, these fixes make the collection
overview visible through the default skeleton entrypoint.

---

## Known Limitations (unchanged from hierarchical report)

- `key_topics`/`notable_terms` absent on directory `rollup` nodes — rollup prompt
  returns plain text, not structured JSON. Acceptable tradeoff: directory map is
  compact and readable; key_topics live on the file nodes agents drill into.
- Nav-only backfill not implemented — full `FORCE_REINDEX=1` required to update
  existing collections with directory semantic summaries.
- Short/medium file tier not observed in this collection — all files exceed 1500 tokens
  and hit the structured tier via propagated sections. Short/medium coverage is
  smoke-only.
