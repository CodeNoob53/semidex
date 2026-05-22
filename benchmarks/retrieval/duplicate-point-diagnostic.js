/**
 * Duplicate Qdrant point diagnostic.
 *
 * Scrolls all points in a target collection and identifies duplicate
 * (source_file, chunk_index) pairs — i.e. multiple Qdrant point IDs that
 * share the same logical chunk address.
 *
 * Required env:
 *   QDRANT_URL, QDRANT_KEY (via .env)
 *
 * Optional env:
 *   COLLECTION  — target collection name (default: bitwize-music)
 *   SCROLL_LIMIT — page size for scroll (default: 250)
 *
 * Outputs:
 *   benchmarks/retrieval/results/YYYY-MM-DDTHHMM-duplicate-point-diagnostic-<collection>.md
 *
 * Does NOT delete points, does NOT reindex, does NOT write vectors.
 * Report contains no private absolute paths or raw chunk text.
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const QDRANT_URL  = process.env.QDRANT_URL;
const QDRANT_KEY  = process.env.QDRANT_KEY;
const COLLECTION  = process.env.COLLECTION || 'bitwize-music';
const SCROLL_LIMIT = parseInt(process.env.SCROLL_LIMIT || '250');

const PAYLOAD_FIELDS = [
  'source_file',
  'chunk_index',
  'total_chunks',
  'file_hash',
  'tags',
  'context',
  'dense_provider',
  'dense_model',
  'sparse_provider',
  'embedding_schema_version',
  'vector_size',
];

const headers = { 'api-key': QDRANT_KEY, 'Content-Type': 'application/json' };

async function scrollAll() {
  const points = [];
  let offset = null;
  let page = 0;
  while (true) {
    const body = {
      limit: SCROLL_LIMIT,
      with_payload: PAYLOAD_FIELDS,
      with_vectors: false,
    };
    if (offset !== null) body.offset = offset;

    const r = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
      method:  'POST',
      headers,
      body:    JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Scroll failed (page ${page}): ${await r.text()}`);
    const data = await r.json();
    const batch = data.result?.points ?? [];
    points.push(...batch);
    offset = data.result?.next_page_offset ?? null;
    page++;
    process.stderr.write(`\r  scrolled ${points.length} points (page ${page})...`);
    if (offset === null) break;
  }
  process.stderr.write('\n');
  return points;
}

// Strip any absolute path prefix — keep only relative portion starting with
// the first path segment that looks like a project-relative path.
function sanitizePath(p) {
  if (!p) return p;
  // Remove Windows absolute paths like C:\Users\...\semidex\
  const match = p.replace(/\\/g, '/').match(/(?:^.*semidex[/\\])?(.+)$/);
  return match ? match[1].replace(/\\/g, '/') : p;
}

function hashContext(s) {
  return createHash('sha1').update(s ?? '').digest('hex');
}

function payloadSignature(p) {
  return JSON.stringify({
    file_hash:                p.file_hash                ?? null,
    tags:                     JSON.stringify(p.tags ?? []),
    context_hash:             hashContext(p.context),
    dense_provider:           p.dense_provider           ?? null,
    dense_model:              p.dense_model              ?? null,
    sparse_provider:          p.sparse_provider          ?? null,
    embedding_schema_version: p.embedding_schema_version ?? null,
    vector_size:              p.vector_size              ?? null,
  });
}

function classifyGroup(entries) {
  const sigs     = new Set(entries.map(e => payloadSignature(e.payload)));
  const hashes   = new Set(entries.map(e => e.payload.file_hash  ?? null));
  const tagSets  = new Set(entries.map(e => JSON.stringify(e.payload.tags ?? [])));
  const ctxs     = new Set(entries.map(e => hashContext(e.payload.context)));
  const providers= new Set(entries.map(e => `${e.payload.dense_provider}/${e.payload.dense_model}/${e.payload.sparse_provider}`));
  const schemas  = new Set(entries.map(e => e.payload.embedding_schema_version ?? null));

  if (sigs.size === 1)           return 'exact-duplicate';
  if (hashes.size > 1)           return 'different-file-hash';
  if (providers.size > 1 || schemas.size > 1) return 'different-provider-or-schema';
  if (tagSets.size > 1 && ctxs.size > 1)      return 'different-tags-and-context';
  if (tagSets.size > 1)                        return 'different-tags';
  if (ctxs.size > 1)                           return 'different-context';
  return 'partial-difference';
}

function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}`;
}

(async () => {
  console.log(`[diag] Duplicate point diagnostic — collection: ${COLLECTION}`);
  console.log(`[diag] Scrolling all points (page size ${SCROLL_LIMIT})...`);

  const all = await scrollAll();
  console.log(`[diag] Total points fetched: ${all.length}`);

  // Group by source_file#chunk_index
  const groups = new Map();
  for (const pt of all) {
    const sf  = sanitizePath(pt.payload?.source_file ?? '');
    const ci  = pt.payload?.chunk_index ?? '?';
    const key = `${sf}#${ci}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: pt.id, payload: pt.payload ?? {} });
  }

  const uniqueFiles = new Set(all.map(p => sanitizePath(p.payload?.source_file ?? '')));

  const dupGroups = [...groups.entries()]
    .filter(([, v]) => v.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  const totalDupPoints = dupGroups.reduce((s, [, v]) => s + v.length, 0);

  console.log(`[diag] Unique source files: ${uniqueFiles.size}`);
  console.log(`[diag] Duplicate groups:    ${dupGroups.length}`);
  console.log(`[diag] Duplicate points:    ${totalDupPoints}`);

  // Classification counts
  const classCounts = {};
  for (const [, entries] of dupGroups) {
    const cls = classifyGroup(entries);
    classCounts[cls] = (classCounts[cls] ?? 0) + 1;
  }

  // Check for the reported special case
  const specialKey = [...groups.keys()].find(k =>
    k.includes('social-media-best-practices') && k.endsWith('#46')
  );
  const specialGroup = specialKey ? groups.get(specialKey) : null;

  // Top 20 duplicate groups
  const top20 = dupGroups.slice(0, 20);

  // Build report
  const stamp = nowStamp();
  const reportName = `${stamp}-duplicate-point-diagnostic-${COLLECTION}.md`;
  const reportPath = resolve(__dirname, 'results', reportName);

  const classTable = Object.entries(classCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([cls, cnt]) => `| ${cls.padEnd(35)} | ${cnt} |`)
    .join('\n');

  const top20Table = top20.map(([key, entries]) => {
    const cls = classifyGroup(entries);
    const [sf, ci] = key.split('#');
    const ptIds = entries.map(e => String(e.id).slice(0, 8) + '…').join(', ');
    return `| \`${sf}\` | ${ci} | ${entries.length} | ${cls} | ${ptIds} |`;
  }).join('\n');

  let specialSection = '';
  if (specialGroup) {
    const cls = classifyGroup(specialGroup);
    const ids = specialGroup.map(e => e.id).join(', ');
    const tagHashes = specialGroup.map(e => hashContext(JSON.stringify(e.payload.tags ?? [])));
    const tagCounts = specialGroup.map(e => (e.payload.tags ?? []).length);
    const ctxHashes = specialGroup.map(e => hashContext(e.payload.context));
    specialSection = `
## Named Example: social-media-best-practices.md#46

| Field | Values |
|-------|--------|
| Key | \`${specialKey}\` |
| Count | ${specialGroup.length} |
| Point IDs | ${ids} |
| Classification | ${cls} |
| Tag set hash (per point) | ${tagHashes.map((h, i) => `pt${i+1}: ${h.slice(0, 12)}`).join(' / ')} |
| Tag count (per point) | ${tagCounts.map((c, i) => `pt${i+1}: ${c}`).join(' / ')} |
| Context hash (per point) | ${ctxHashes.map((h, i) => `pt${i+1}: ${h.slice(0, 12)}`).join(' / ')} |

This is the case that triggered the diagnostic.
`;
  } else {
    specialSection = `
## Named Example: social-media-best-practices.md#46

Not found in duplicate groups — either the chunk is not duplicated or the
source_file path does not match the expected pattern.
`;
  }

  const report = `# Duplicate Point Diagnostic — \`${COLLECTION}\`

*Generated: ${stamp}*

## Summary

| Metric | Value |
|--------|-------|
| Total points scanned | ${all.length} |
| Unique source files | ${uniqueFiles.size} |
| Duplicate groups (source_file#chunk_index) | ${dupGroups.length} |
| Duplicate points total | ${totalDupPoints} |
| Clean (unique) groups | ${groups.size - dupGroups.length} |

## Classification Summary

| Class | Duplicate group count |
|-------|-----------------------|
${classTable}

**Classification key:**

- **exact-duplicate** — all payload fields identical; only point ID differs
- **different-tags** — same file_hash + context, but tags differ between copies
- **different-context** — same file_hash + tags, but context text differs
- **different-tags-and-context** — both tags and context differ; likely two separate indexing runs with different LLM output
- **different-file-hash** — source content changed between indexing runs
- **different-provider-or-schema** — different embedding provider or schema version; stale points from a provider switch
- **partial-difference** — some fields differ but none of the above categories match exactly
${specialSection}
## Top 20 Duplicate Groups by Count

| source_file | chunk_index | count | class | point IDs (truncated) |
|-------------|-------------|-------|-------|-----------------------|
${top20Table}

## Likely Cause

Duplicate points with the same \`source_file + chunk_index\` but different point
IDs arise when:

1. **randomUUID point IDs**: semidex generates a new UUID on every indexing run
   rather than deriving a stable ID from \`source_file + chunk_index\`. Without a
   stable ID, Qdrant cannot overwrite the existing point — it always inserts a new
   one.

2. **Missing pre-upsert cleanup**: the indexer does not call
   \`deleteBySourceFile\` before upserting if the file hash is unchanged
   (\`✓ unchanged, skipping\`). If a prior run left stale points and then the
   indexer was run again after a hash change (or a forced reindex), the old UUIDs
   remain.

3. **Partial reindex after provider/schema change**: if a source was reindexed
   with a new provider (e.g. ollama → bge-m3-onnx) without a full
   \`deleteBySourceFile\` first, both the old and new provider points coexist.

The presence of **different-tags** and **different-tags-and-context** duplicates
indicates repeated indexing runs (historical, sequential, or concurrent) where
the LLM produced different tag/context output each time, but the underlying
content (file_hash) was unchanged. Because point IDs are random, each run
inserted new points rather than overwriting existing ones.

## Does \`PRUNE_STALE=1\` Fix This?

**No.** \`PRUNE_STALE=1\` compares the set of \`source_file\` values currently on
disk against the set stored in Qdrant, and deletes any Qdrant source_file that no
longer exists on disk. It does **not** detect or remove intra-source duplicates —
i.e. two points sharing the same \`source_file + chunk_index\`. Both duplicates
would show the same \`source_file\` and would both survive the stale check.

## Recommended Safe Repair Options

### Option A — Targeted deleteBySourceFile + reindex (preferred)

For each \`source_file\` that has at least one duplicate group:

1. Call \`deleteBySourceFile(collection, sourceFile)\` to wipe all existing points
   for that file.
2. Re-run the indexer for that single file; a clean set of points is written.

This is safe, reversible (just reindex again if something goes wrong), and scoped
to affected files only.

**Caveat:** requires listing all affected source files first (script can produce
that list). Avoid running while another indexer job is in progress.

### Option B — Full collection wipe + reindex

Delete the collection entirely and reindex from scratch. Safe but slow for a
14,000+ point collection.

### Option C — Stable deterministic point IDs (long-term fix)

Change the indexer to derive point IDs from
\`hash(source_file + chunk_index + schema_version)\` instead of \`randomUUID()\`.
Qdrant upserts are idempotent when the ID is stable, so reindexing the same
content never produces duplicates. This is the root-cause fix.

---

*Report generated by \`benchmarks/retrieval/duplicate-point-diagnostic.js\`.*
*No chunk text, no private absolute paths.*
`;

  mkdirSync(resolve(__dirname, 'results'), { recursive: true });
  writeFileSync(reportPath, report, 'utf8');
  console.log(`[diag] Report: ${reportPath}`);

  // Also print affected source files list to stdout for convenience
  const affectedFiles = [...new Set(dupGroups.map(([key]) => key.split('#')[0]))];
  console.log(`[diag] Affected source files (${affectedFiles.length}):`);
  for (const f of affectedFiles.slice(0, 10)) console.log(`  - ${f}`);
  if (affectedFiles.length > 10) console.log(`  ... and ${affectedFiles.length - 10} more`);
})();
