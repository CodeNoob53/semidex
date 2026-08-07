// Bench-only experiment: deterministic prose carryover for structural chunks.
//
// Goal:
//   Test whether embedding table/code_block chunks with a short nearby prose
//   explanation improves natural-language direct/window retrieval.
//
// This script does NOT change production indexing. It clones the existing
// skeleton collection into a temporary benchmark collection, recomputing
// vectors only for structural chunks that have a nearby prose anchor.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ONNX_EMBED = '1';
delete process.env.DENSE_PROVIDER;
delete process.env.SPARSE_PROVIDER;

const {
  listCollections,
  upsertPoints,
  hybridSearch,
} = await import('../../src/shared/core/qdrant.js');
const {
  embedForIndex,
  embedForSearch,
} = await import('../../src/shared/core/embeddings.js');
const { createStorageAdapter } = await import('../../src/core/storage/factory.js');
const { resolveBenchProfile } = await import('../lib/resolve-profile.js');

const storageAdapter = createStorageAdapter();

const QDRANT_URL = process.env.QDRANT_URL?.replace(/\/$/, '');
const QDRANT_KEY = process.env.QDRANT_KEY ?? '';
if (!QDRANT_URL) throw new Error('QDRANT_URL is not set');

const HEADERS = { 'Content-Type': 'application/json' };
if (QDRANT_KEY) HEADERS['api-key'] = QDRANT_KEY;

const SOURCE_COLLECTION = process.env.BENCH_SOURCE_COLLECTION || 'fullstack-python-web';
const TARGET_COLLECTION = process.env.BENCH_TARGET_COLLECTION || 'bench-structural-carryover';
const SOURCE_LABEL = process.env.BENCH_SOURCE_LABEL || '<private-skeleton-source>';
const RESULTS_DIR = resolve('benchmarks/retrieval/results');
const REPORT_PATH = resolve(RESULTS_DIR, '2026-06-26-structural-carryover-bench.md');
const TOP_K = 10;
const WINDOW = 1;
const MAX_CASES_PER_TYPE = parseInt(process.env.BENCH_MAX_CASES_PER_TYPE ?? '50', 10);
const CARRYOVER_CHARS = parseInt(process.env.BENCH_CARRYOVER_CHARS ?? '500', 10);

function cUrl(collection, path = '') {
  return `${QDRANT_URL}/collections/${encodeURIComponent(collection)}${path}`;
}

async function qdrant(method, url, body = undefined) {
  const response = await fetch(url, {
    method,
    headers: HEADERS,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${method} ${url} failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return response.status === 204 ? null : response.json();
}

async function deleteCollectionIfExists(name) {
  const collections = await listCollections();
  if (!collections.includes(name)) return;
  await qdrant('DELETE', cUrl(name));
}

async function scrollAllWithVectors(collection) {
  const points = [];
  let offset = null;
  for (;;) {
    const body = {
      limit: 256,
      with_payload: true,
      with_vectors: true,
    };
    if (offset !== null) body.offset = offset;
    const data = await qdrant('POST', cUrl(collection, '/points/scroll'), body);
    const batch = data.result?.points ?? [];
    points.push(...batch);
    offset = data.result?.next_page_offset ?? null;
    if (offset === null) break;
  }
  return points;
}

function isNav(point) {
  return point.payload?.point_kind === 'skeleton_nav';
}

function isStructural(point) {
  return ['table', 'code_block', 'checklist'].includes(point.payload?.node_type);
}

function isParagraph(point) {
  return point.payload?.node_type === 'paragraph';
}

function headingKey(point) {
  return JSON.stringify(point.payload?.heading_path ?? []);
}

function cleanProse(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter(line => !/^\s*\[[^\]]*node: /.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(text, maxChars = CARRYOVER_CHARS) {
  const clean = cleanProse(text);
  if (clean.length <= maxChars) return clean;
  const slice = clean.slice(0, maxChars);
  const cut = slice.lastIndexOf(' ');
  return (cut > 120 ? slice.slice(0, cut) : slice).trim();
}

function vectorsOf(point) {
  return point.vectors ?? point.vector;
}

function sameTarget(a, target) {
  const ap = a.payload ?? {};
  const tp = target.payload ?? {};
  if (ap.node_id && tp.node_id && ap.node_id === tp.node_id) return true;
  return ap.source_file === tp.source_file &&
    ap.chunk_index === tp.chunk_index &&
    ap.node_type === tp.node_type;
}

function containsTargetPlaceholder(point, target) {
  const text = String(point.payload?.text ?? '');
  const nodePath = target.payload?.node_path;
  return Boolean(nodePath && text.includes(nodePath));
}

function buildIndexes(points) {
  const bySource = new Map();
  for (const point of points) {
    const source = point.payload?.source_file;
    if (!source) continue;
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(point);
  }
  for (const arr of bySource.values()) {
    arr.sort((a, b) => (a.payload?.chunk_index ?? 0) - (b.payload?.chunk_index ?? 0));
  }
  return { bySource };
}

function findCarryover(point, bySource) {
  const source = point.payload?.source_file;
  const chunkIndex = point.payload?.chunk_index;
  if (!source || !Number.isInteger(chunkIndex)) return null;
  const siblings = bySource.get(source) ?? [];
  const hKey = headingKey(point);

  const candidates = siblings
    .filter(p => isParagraph(p))
    .filter(p => headingKey(p) === hKey)
    .map(p => ({
      point: p,
      distance: Math.abs((p.payload?.chunk_index ?? 0) - chunkIndex),
      before: (p.payload?.chunk_index ?? 0) < chunkIndex,
      hasPlaceholder: containsTargetPlaceholder(p, point),
      prose: truncateText(p.payload?.text),
    }))
    .filter(c => c.prose.length >= 40)
    .filter(c => c.distance <= 2);

  if (!candidates.length) return null;

  candidates.sort((a, b) =>
    Number(b.hasPlaceholder) - Number(a.hasPlaceholder) ||
    Number(b.before) - Number(a.before) ||
    a.distance - b.distance
  );

  return candidates[0];
}

function pickCases(points, bySource) {
  const cases = [];
  const structural = points
    .filter(p => !isNav(p))
    .filter(isStructural)
    .sort((a, b) =>
      String(a.payload?.node_type).localeCompare(String(b.payload?.node_type)) ||
      String(a.payload?.source_file).localeCompare(String(b.payload?.source_file)) ||
      (a.payload?.chunk_index ?? 0) - (b.payload?.chunk_index ?? 0)
    );

  const perType = new Map();
  for (const point of structural) {
    const carry = findCarryover(point, bySource);
    if (!carry) continue;
    const type = point.payload.node_type;
    const n = perType.get(type) ?? 0;
    if (n >= MAX_CASES_PER_TYPE) continue;
    perType.set(type, n + 1);
    cases.push({
      id: `${type}-case-${n + 1}`,
      type,
      target: point,
      query: carry.prose,
      carryover: carry.prose,
      carryoverDistance: carry.distance,
      carryoverHasPlaceholder: carry.hasPlaceholder,
    });
  }
  return cases;
}

async function cloneWithCarryover(points, casesByNodeId) {
  await deleteCollectionIfExists(TARGET_COLLECTION);
  // Collection was just deleted, so this always resolves a fresh profile
  // from current env (ONNX_EMBED=1, forced above) and creates the
  // collection with it.
  const targetProfile = await resolveBenchProfile(storageAdapter, TARGET_COLLECTION, { vectorSize: 1024 });

  const out = [];
  let recomputed = 0;

  for (const point of points.filter(p => !isNav(p))) {
    const payload = { ...(point.payload ?? {}) };
    const nodeId = payload.node_id;
    const carry = nodeId ? casesByNodeId.get(nodeId) : null;
    let vector = vectorsOf(point);

    if (carry && isStructural(point)) {
      payload.context = [
        payload.context,
        `Nearby prose: ${carry.carryover}`,
      ].filter(Boolean).join('\n');
      const embedText = `${payload.context ?? ''}\n\n${payload.text ?? ''}`.trim();
      const { dense, sparse, meta } = await embedForIndex(targetProfile, embedText);
      vector = { dense, sparse };
      Object.assign(payload, meta);
      recomputed += 1;
    }

    out.push({
      id: randomUUID(),
      vector,
      payload,
    });

    if (out.length >= 128) {
      await upsertPoints(TARGET_COLLECTION, out.splice(0));
    }
  }
  if (out.length) await upsertPoints(TARGET_COLLECTION, out);
  return { recomputed, targetProfile };
}

function windowHit(results, allPointsBySource, target, k) {
  const top = results.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    const result = top[i];
    if (sameTarget(result, target)) {
      return { ok: true, rank: i + 1, type: 'direct' };
    }
    if (containsTargetPlaceholder(result, target)) {
      return { ok: true, rank: i + 1, type: 'placeholder' };
    }

    const source = result.payload?.source_file;
    const center = result.payload?.chunk_index;
    if (!source || !Number.isInteger(center)) continue;
    const siblings = allPointsBySource.get(source) ?? [];
    for (const p of siblings) {
      const idx = p.payload?.chunk_index;
      if (!Number.isInteger(idx) || Math.abs(idx - center) > WINDOW) continue;
      if (sameTarget(p, target)) {
        return { ok: true, rank: i + 1, type: 'target_in_window' };
      }
      if (containsTargetPlaceholder(p, target)) {
        return { ok: true, rank: i + 1, type: 'placeholder_in_window' };
      }
    }
  }
  return { ok: false, rank: null, type: 'miss' };
}

function directRank(results, target) {
  const idx = results.findIndex(r => sameTarget(r, target));
  return idx >= 0 ? idx + 1 : null;
}

async function runSearches(collection, profile, cases, pointsBySource) {
  const rows = [];
  const filter = { must_not: [{ key: 'point_kind', match: { value: 'skeleton_nav' } }] };
  for (const c of cases) {
    const { dense, sparse } = await embedForSearch(profile, c.query);
    const results = await hybridSearch(collection, dense, sparse, TOP_K, filter);
    rows.push({
      id: c.id,
      type: c.type,
      directRank: directRank(results, c.target),
      w3: windowHit(results, pointsBySource, c.target, 3),
      w5: windowHit(results, pointsBySource, c.target, 5),
      w10: windowHit(results, pointsBySource, c.target, 10),
      topType: results[0]?.payload?.node_type ?? null,
    });
  }
  return rows;
}

function summarize(rows, type = null) {
  const selected = type ? rows.filter(r => r.type === type) : rows;
  const n = selected.length || 1;
  const directAt = k => selected.filter(r => r.directRank !== null && r.directRank <= k).length;
  const windowAt = k => selected.filter(r => r[`w${k}`]?.ok).length;
  return {
    count: selected.length,
    direct3: directAt(3), direct5: directAt(5), direct10: directAt(10),
    window3: windowAt(3), window5: windowAt(5), window10: windowAt(10),
    direct3Pct: directAt(3) / n, direct5Pct: directAt(5) / n, direct10Pct: directAt(10) / n,
    window3Pct: windowAt(3) / n, window5Pct: windowAt(5) / n, window10Pct: windowAt(10) / n,
  };
}

function fmtCell(count, total) {
  const pct = total ? Math.round((count / total) * 100) : 0;
  return `${count}/${total} (${pct}%)`;
}

function summaryTable(label, rows) {
  const all = summarize(rows);
  const tables = summarize(rows, 'table');
  const code = summarize(rows, 'code_block');
  const lines = [];
  lines.push(`### ${label}`);
  lines.push('');
  lines.push('| Type | Cases | direct@3 | direct@5 | direct@10 | window@3 | window@5 | window@10 |');
  lines.push('|------|-------|----------|----------|-----------|----------|----------|-----------|');
  for (const [name, s] of [['table', tables], ['code_block', code], ['total', all]]) {
    lines.push(`| ${name} | ${s.count} | ${fmtCell(s.direct3, s.count)} | ${fmtCell(s.direct5, s.count)} | ${fmtCell(s.direct10, s.count)} | ${fmtCell(s.window3, s.count)} | ${fmtCell(s.window5, s.count)} | ${fmtCell(s.window10, s.count)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function compareRows(baseRows, enrichedRows) {
  const byId = new Map(enrichedRows.map(r => [r.id, r]));
  return baseRows.map(b => {
    const e = byId.get(b.id);
    return {
      id: b.id,
      type: b.type,
      baseDirect: b.directRank ?? 'MISS',
      enrichedDirect: e?.directRank ?? 'MISS',
      baseWindow10: b.w10.ok ? b.w10.type : 'MISS',
      enrichedWindow10: e?.w10.ok ? e.w10.type : 'MISS',
      topTypeBefore: b.topType,
      topTypeAfter: e?.topType ?? null,
    };
  });
}

function verdict(baseRows, enrichedRows) {
  const b = summarize(baseRows);
  const e = summarize(enrichedRows);
  if (e.direct10 > b.direct10 || e.window10 > b.window10) return 'STRUCTURAL_CARRYOVER_BENCH_POSITIVE_SYNTHETIC';
  if (e.direct10 === b.direct10 && e.window10 === b.window10) return 'STRUCTURAL_CARRYOVER_BENCH_NEUTRAL_SYNTHETIC';
  return 'STRUCTURAL_CARRYOVER_BENCH_NEGATIVE_SYNTHETIC';
}

mkdirSync(RESULTS_DIR, { recursive: true });

console.log(`[load] ${SOURCE_COLLECTION}`);
const sourcePoints = await scrollAllWithVectors(SOURCE_COLLECTION);
const contentPoints = sourcePoints.filter(p => !isNav(p));
const { bySource } = buildIndexes(contentPoints);
const cases = pickCases(contentPoints, bySource);
const casesByNodeId = new Map(cases.map(c => [c.target.payload.node_id, c]));

console.log(`[cases] ${cases.length} structural nodes with prose carryover`);
console.log(`[clone] ${TARGET_COLLECTION}`);
const cloneStats = await cloneWithCarryover(sourcePoints, casesByNodeId);

const targetPoints = await scrollAllWithVectors(TARGET_COLLECTION);
const targetIndex = buildIndexes(targetPoints);

// SOURCE_COLLECTION is a pre-existing production collection — must already
// carry a valid native profile; reused as-is, never re-derived from env.
const sourceProfile = await resolveBenchProfile(storageAdapter, SOURCE_COLLECTION, { vectorSize: 1024 });

console.log('[search] baseline');
const baselineRows = await runSearches(SOURCE_COLLECTION, sourceProfile, cases, bySource);
console.log('[search] enriched');
const enrichedRows = await runSearches(TARGET_COLLECTION, cloneStats.targetProfile, cases, targetIndex.bySource);

const diffRows = compareRows(baselineRows, enrichedRows);
const v = verdict(baselineRows, enrichedRows);

const report = [];
report.push('# Structural Carryover Bench');
report.push('');
report.push('**Date:** 2026-06-26');
report.push(`**Source collection:** \`${SOURCE_LABEL}\``);
report.push(`**Bench collection:** \`${TARGET_COLLECTION}\``);
report.push(`**Verdict:** ${v}`);
report.push('');
report.push('## What Was Tested');
report.push('');
report.push('Bench-only experiment: structural chunks (`table`, `code_block`, `checklist`) were re-embedded with deterministic nearby prose carryover.');
report.push('No production code was changed. No LLM calls were added. Raw content and payload text stayed unchanged.');
report.push('');
report.push('Carryover query design: for each structural node, the query is the nearby prose anchor text that introduces or neighbors that node.');
report.push('This tests whether a user phrasing the question like the prose explanation can retrieve the structural node directly.');
report.push('');
report.push('Important limitation: this is a targeted synthetic test, not an independent user-query benchmark. The query text is intentionally the same signal added to the enriched structural embedding. A positive result proves the mechanism works; it does not prove production promotion by itself.');
report.push('');
report.push('## Inventory');
report.push('');
const structuralCounts = contentPoints.reduce((acc, p) => {
  const type = p.payload?.node_type ?? '<missing>';
  acc[type] = (acc[type] ?? 0) + 1;
  return acc;
}, {});
report.push('| Item | Count |');
report.push('|------|-------|');
report.push(`| content points cloned | ${contentPoints.length} |`);
report.push(`| table points | ${structuralCounts.table ?? 0} |`);
report.push(`| code_block points | ${structuralCounts.code_block ?? 0} |`);
report.push(`| paragraph points | ${structuralCounts.paragraph ?? 0} |`);
report.push(`| selected carryover cases | ${cases.length} |`);
report.push(`| structural vectors recomputed | ${cloneStats.recomputed} |`);
report.push('');
report.push(summaryTable('Baseline', baselineRows));
report.push(summaryTable('Carryover-Enriched', enrichedRows));
report.push('## Case-Level Changes');
report.push('');
report.push('| Case | Type | direct before | direct after | window@10 before | window@10 after | top type before | top type after |');
report.push('|------|------|---------------|--------------|------------------|-----------------|-----------------|----------------|');
for (const row of diffRows) {
  if (
    row.baseDirect === row.enrichedDirect &&
    row.baseWindow10 === row.enrichedWindow10 &&
    row.topTypeBefore === row.topTypeAfter
  ) continue;
  report.push(`| ${row.id} | ${row.type} | ${row.baseDirect} | ${row.enrichedDirect} | ${row.baseWindow10} | ${row.enrichedWindow10} | ${row.topTypeBefore ?? 'n/a'} | ${row.topTypeAfter ?? 'n/a'} |`);
}
if (report.at(-1)?.startsWith('|------')) report.push('| none | — | — | — | — | — | — | — |');
report.push('');
report.push('## Interpretation');
report.push('');
report.push('- This is a synthetic but targeted test: queries are derived from nearby prose, not from private raw table/code content.');
report.push('- A positive result means deterministic carryover helps structural nodes answer natural-language queries phrased like their surrounding explanation.');
report.push('- Baseline `window=1` can already recover the selected cases because they were selected from nodes with local prose anchors. The meaningful change here is direct structural rank, not window recall.');
report.push('- A neutral/negative result would mean the current window-based workflow already covers most of the benefit, or the carryover text is not discriminative enough.');
report.push('- `qdrant_get_node` is not evaluated as a search fallback; it remains a raw/original display resolver after a node is already known.');
report.push('');
report.push('## Commands');
report.push('');
report.push('```powershell');
report.push('node benchmarks/retrieval/structural-carryover-bench.js');
report.push('git diff --check');
report.push('```');
report.push('');

writeFileSync(REPORT_PATH, report.join('\n'), 'utf8');
console.log(`[report] ${REPORT_PATH}`);
console.log(`[verdict] ${v}`);
