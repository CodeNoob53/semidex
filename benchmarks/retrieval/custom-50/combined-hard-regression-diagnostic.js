/**
 * Diagnostic for COMBINED_LLM=1 hard regressions on custom-50.
 *
 * For each target query (default: c04, c41) runs baseline and combined
 * indexing, then shows full top-10 result tables, expected chunk payload
 * comparison, and classifies the likely regression cause.
 *
 * Usage:
 *   node benchmarks/retrieval/custom-50/combined-hard-regression-diagnostic.js
 *   npm run bench:custom50:diag
 *
 * Or against already-indexed collections (KEEP_COLLECTIONS=1 from a prior run):
 *   BASELINE_COLLECTION=bench-c50-baseline-... COMBINED_COLLECTION=bench-c50-combined-... \
 *     node benchmarks/retrieval/custom-50/combined-hard-regression-diagnostic.js
 *
 * Optional env:
 *   QUERY_IDS=c04,c41        comma-separated; default "c04,c41"
 *   KEEP_COLLECTIONS=1       skip Qdrant + config cleanup on exit
 *   BASELINE_COLLECTION=...  reuse existing collection (skip indexing)
 *   COMBINED_COLLECTION=...  reuse existing collection (skip indexing)
 */

import 'dotenv/config';
import { spawnSync } from 'child_process';
import {
  existsSync, mkdirSync, writeFileSync,
  copyFileSync, rmSync, readFileSync,
} from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  deleteCollection,
  hybridSearch, scroll,
} from '../../../src/shared/core/qdrant.js';
import { stableSortResults } from './sort-results.js';
import { embedForSearch } from '../../../src/shared/core/embeddings.js';
import { createStorageAdapter } from '../../../src/core/storage/factory.js';
import { resolveBenchProfile } from '../../lib/resolve-profile.js';

const storageAdapter = createStorageAdapter();
// Per-collection resolved embedding profiles — embedForSearch requires a
// resolved profile object, not a bare collection name (see
// benchmarks/lib/resolve-profile.js's header comment). Populated by
// ensureBenchCollection() for each of COL_BASELINE / COL_COMBINED.
const PROFILES = new Map();

const ROOT          = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');
const QUERIES_PATH  = join(ROOT, 'benchmarks', 'retrieval', 'custom-50', 'queries.json');
const FIXTURES_SHARED = join(ROOT, 'benchmarks', 'retrieval', 'fixtures', 'docs');
const FIXTURES_OWN    = join(ROOT, 'benchmarks', 'retrieval', 'custom-50', 'fixtures', 'docs');
const RESULTS_DIR   = join(ROOT, 'benchmarks', 'retrieval', 'results');

const CONTEXT_MODEL = process.env.CONTEXT_MODEL || 'gemma3:4b';
const QDRANT_URL    = (process.env.QDRANT_URL ?? '').replace(/\/$/, '');
const KEEP          = process.env.KEEP_COLLECTIONS === '1';
const TOP_K         = 10;

// BENCH_COMBINED_CONTEXT_POLICY — benchmark-only. Passed to the combined indexer run only.
// Baseline is always pinned to 'current-minimal' so it remains a stable reference.
// Valid values match BENCH_CONTEXT_POLICY in combined.js: 'current-minimal' (default),
// 'identifier-preserving', 'section-window-aware'.
const BENCH_COMBINED_CONTEXT_POLICY = process.env.BENCH_COMBINED_CONTEXT_POLICY || 'current-minimal';

// Target query IDs to diagnose
const TARGET_IDS = (process.env.QUERY_IDS ?? 'c04,c41').split(',').map(s => s.trim()).filter(Boolean);

// Collection names: either passed in (reuse mode) or fresh stamped
const STAMP          = Date.now();
const REUSE_BASELINE = process.env.BASELINE_COLLECTION ?? null;
const REUSE_COMBINED = process.env.COMBINED_COLLECTION ?? null;
const REUSE_MODE     = !!(REUSE_BASELINE && REUSE_COMBINED);
const COL_BASELINE   = REUSE_BASELINE ?? `bench-c50-diag-baseline-${STAMP}`;
const COL_COMBINED   = REUSE_COMBINED ?? `bench-c50-diag-combined-${STAMP}`;

const CORPUS_DIR      = join(ROOT, '.tmp', `bench-c50-diag-corpus-${STAMP}`);
const CHUNKS_BASELINE = join(ROOT, '.tmp', `bench-c50-diag-chunks-baseline-${STAMP}`);
const CHUNKS_COMBINED = join(ROOT, '.tmp', `bench-c50-diag-chunks-combined-${STAMP}`);

const FIXTURE_FILES = [
  { name: 'providers.md',         dir: FIXTURES_SHARED },
  { name: 'qdrant.md',            dir: FIXTURES_SHARED },
  { name: 'chunking.md',          dir: FIXTURES_SHARED },
  { name: 'sync.md',              dir: FIXTURES_SHARED },
  { name: 'mcp-workflow.md',      dir: FIXTURES_OWN },
  { name: 'obsidian.md',          dir: FIXTURES_OWN },
  { name: 'project-structure.md', dir: FIXTURES_OWN },
  { name: 'benchmarking.md',      dir: FIXTURES_OWN },
  { name: 'config-env.md',        dir: FIXTURES_OWN },
  { name: 'multilingual.md',      dir: FIXTURES_OWN },
];

// ── Corpus setup ──────────────────────────────────────────────────────────────

function buildCorpus() {
  rmSync(CORPUS_DIR, { recursive: true, force: true });
  mkdirSync(CORPUS_DIR, { recursive: true });
  for (const { name, dir } of FIXTURE_FILES) {
    const src = join(dir, name);
    if (!existsSync(src)) throw new Error(`fixture missing: ${src}`);
    copyFileSync(src, join(CORPUS_DIR, name));
  }
}

function cleanupTransient() {
  try { rmSync(CORPUS_DIR,      { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(CHUNKS_BASELINE, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(CHUNKS_COMBINED, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Collection helpers ────────────────────────────────────────────────────────

async function ensureBenchCollection(name) {
  const profile = await resolveBenchProfile(storageAdapter, name, { vectorSize: 1024 });
  PROFILES.set(name, profile);
}

async function deleteBenchCollection(name) {
  try { await deleteCollection(name); console.log(`  [cleanup] deleted "${name}"`); }
  catch { console.log(`  [cleanup] could not delete "${name}"`); }
}

// ── Indexer ───────────────────────────────────────────────────────────────────

function runIndexer(collection, extraEnv, chunksOutDir, label) {
  console.log(`\n[diag] Indexing ${label}...`);
  const env = {
    ...process.env,
    COLLECTION:    collection,
    SOURCE_ROOT:   CORPUS_DIR,
    ONNX_EMBED:    '1',
    CONTEXT_MODEL: CONTEXT_MODEL,
    INDEX_PROFILE: '1',
    ...extraEnv,
  };
  const t0 = Date.now();
  const result = spawnSync('node', ['src/indexer/index.js', CORPUS_DIR], {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  const totalMs = Date.now() - t0;
  const stdout  = result.stdout ?? '';
  const stderr  = result.stderr ?? '';
  if (result.status !== 0) {
    console.error(`  FAILED (exit ${result.status})`);
    console.error(stderr.slice(-2000));
    return { ok: false, totalMs, fallbacks: 0, tagFallbacks: 0 };
  }
  const fallbacks    = (stderr.match(/\[combined\] parse failed/g) ?? []).length;
  const tagFallbacks = (stderr.match(/\[tag\] batch parse failed/g) ?? []).length;
  const indexed      = (stdout.match(/(\d+) indexed/) ?? [])[1] ?? '?';
  console.log(`  done in ${totalMs} ms — exit 0 — ${indexed} file(s) indexed`);
  if (fallbacks)    console.log(`  [combined] parse fallbacks: ${fallbacks}`);
  if (tagFallbacks) console.log(`  [tag] batch fallbacks: ${tagFallbacks}`);
  return { ok: true, totalMs, fallbacks, tagFallbacks };
}

// ── Qdrant scroll helpers ─────────────────────────────────────────────────────

async function scrollPage(collection, offset) {
  const body = { limit: 100, with_payload: true, with_vectors: false };
  if (offset !== null) body.offset = offset;
  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: { 'api-key': process.env.QDRANT_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Qdrant scroll "${collection}" returned ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

async function scrollAll(collection) {
  const points = [];
  let offset   = null;
  while (true) {
    let data;
    // Retry once on network-level failure (stale keep-alive after long spawnSync)
    try {
      data = await scrollPage(collection, offset);
    } catch (e) {
      if (offset === null && e.message === 'fetch failed') {
        console.log('  [scroll] network error on first page — retrying once...');
        await new Promise(r => setTimeout(r, 2000));
        data = await scrollPage(collection, offset);
      } else {
        throw e;
      }
    }
    const batch = data?.result?.points ?? [];
    points.push(...batch);
    offset = data?.result?.next_page_offset ?? null;
    if (offset === null || batch.length === 0) break;
  }
  return points;
}

// Fetch a single point by source_file + chunk_index from a pre-fetched points array.
function findPoint(points, sourceFile, chunkIndex) {
  return points.find(p =>
    p.payload?.source_file === sourceFile &&
    Number(p.payload?.chunk_index) === Number(chunkIndex)
  ) ?? null;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

function tokenise(str) {
  return (str ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function buildQrels(relevantChunks) {
  const map = new Map();
  for (const rc of (relevantChunks ?? [])) map.set(rc.chunkId, rc.relevance ?? 3);
  return map;
}

function normaliseQuery(q) {
  return {
    id:             q.id,
    type:           q.type ?? 'unknown',
    query:          q.query,
    expectedFiles:  q.expectedFiles ?? [],
    relevantChunks: q.relevantChunks ?? [],
    qrels:          buildQrels(q.relevantChunks),
    expectedTokens: q.expectedTokens ?? [],
    note:           q.note ?? '',
  };
}

function resultChunkId(r) {
  const sf = r.payload?.source_file;
  const ci = r.payload?.chunk_index;
  if (!sf || ci == null) return null;
  return `${sf}#${ci}`;
}

async function runQuery(collection, queryText) {
  const profile = PROFILES.get(collection)
    ?? await resolveBenchProfile(storageAdapter, collection, { vectorSize: 1024 });
  PROFILES.set(collection, profile);
  const { dense, sparse } = await embedForSearch(profile, queryText);
  return stableSortResults(await hybridSearch(collection, dense, sparse, TOP_K));
}

// ── Cause classifier ──────────────────────────────────────────────────────────

function classifyCause(query, bExpected, cExpected, bResults, cResults) {
  // bExpected / cExpected = payload of the rel=3 chunk from each collection (may be null)
  // bResults / cResults   = top-10 result arrays

  const causes = [];

  const bRank = bResults.findIndex(r => resultChunkId(r) === [...query.qrels.entries()].find(([,v]) => v >= 3)?.[0]);
  const cRank = cResults.findIndex(r => resultChunkId(r) === [...query.qrels.entries()].find(([,v]) => v >= 3)?.[0]);

  // 1. Did the expected chunk text/context change?
  if (bExpected && cExpected) {
    const bCtx  = (bExpected.context ?? '').trim();
    const cCtx  = (cExpected.context ?? '').trim();
    const bTags = (bExpected.tags ?? []).join(' ');
    const cTags = (cExpected.tags ?? []).join(' ');

    if (bCtx !== cCtx) {
      // Check if combined context lost key terms from query
      const queryTokens = tokenise(query.query);
      const bCtxTokens  = new Set(tokenise(bCtx));
      const cCtxTokens  = new Set(tokenise(cCtx));
      const lost = queryTokens.filter(t => bCtxTokens.has(t) && !cCtxTokens.has(t));
      const gained = queryTokens.filter(t => !bCtxTokens.has(t) && cCtxTokens.has(t));
      if (lost.length > 0) {
        causes.push(`combined context wording drift — exact query tokens absent (no stemming): ${lost.join(', ')}`);
      } else {
        causes.push('combined context changed semantic focus (no direct term loss detected)');
      }
      if (gained.length > 0) {
        causes.push(`combined context gained terms not in query: ${gained.join(', ')}`);
      }
    }

    if (bTags !== cTags) {
      const bTagSet = new Set(bExpected.tags ?? []);
      const cTagSet = new Set(cExpected.tags ?? []);
      const lostTags   = [...bTagSet].filter(t => !cTagSet.has(t));
      const noisyTags  = [...cTagSet].filter(t => !bTagSet.has(t));
      const queryTerms = new Set(tokenise(query.query));

      // Tags that were in baseline and match query terms — useful exact terms lost
      const usefulLost = lostTags.filter(t =>
        tokenise(t).some(tok => queryTerms.has(tok))
      );
      // New combined tags whose tokens don't overlap query at all — noise
      const noisy = noisyTags.filter(t =>
        !tokenise(t).some(tok => queryTerms.has(tok))
      );

      if (usefulLost.length > 0) causes.push(`combined tags lost useful query-matching terms: ${usefulLost.join(', ')}`);
      if (noisy.length > 0)      causes.push(`combined tags added noisy off-topic terms: ${noisy.join(', ')}`);
      if (usefulLost.length === 0 && noisy.length === 0 && lostTags.length + noisyTags.length > 0) {
        causes.push('combined tags changed but no direct query-relevance impact detected');
      }
    }

    // Short chunk guard: was the chunk text very short?
    const COMBINED_MIN_CHARS = 80;
    if ((bExpected.text ?? '').trim().length < COMBINED_MIN_CHARS) {
      causes.push(`short-chunk guard: chunk text < ${COMBINED_MIN_CHARS} chars — combined fallback to separate calls`);
    }
  }

  // 2. Is the expected chunk absent from combined top-10 entirely?
  const bInTop10 = bRank >= 0;
  const cInTop10 = cRank >= 0;
  if (bInTop10 && !cInTop10) {
    causes.push('expected chunk present in baseline top-10 but absent from combined top-10');
  }

  // 3. Was baseline rank already weak (both missed top-5)?
  if (bRank >= 5 && cRank < 0) {
    causes.push('qrel/query weakness: baseline itself had weak retrieval (rank > 5), combined missed entirely');
  }

  // 4. Are the top-1 chunks in combined suspiciously high-scoring irrelevant content?
  const cTop1Id  = resultChunkId(cResults[0]);
  const cTop1Rel = cTop1Id ? (query.qrels.get(cTop1Id) ?? 0) : 0;
  if (cTop1Rel === 0 && cResults[0]?.score > 0.8) {
    causes.push('RRF/embedding variance: combined top-1 is irrelevant but high-scoring — possible context-drift boosting wrong chunk');
  }

  // 5. Fallthrough: no clear cause
  if (causes.length === 0) {
    causes.push('unknown — regression pattern unclear; recommend rerun to check variance');
  }

  return causes;
}

// ── Report builder ────────────────────────────────────────────────────────────

function snippet(text, maxLen = 160) {
  const s = (text ?? '').replace(/\n/g, ' ').trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '…';
}

function buildResultTable(results, qrels, label) {
  const lines = [];
  lines.push(`**${label} top-10:**`);
  lines.push('');
  lines.push('| rank | score | chunkId | rel | section | context snippet | tags |');
  lines.push('|------|-------|---------|-----|---------|-----------------|------|');
  for (let i = 0; i < results.length; i++) {
    const r   = results[i];
    const p   = r.payload ?? {};
    const cid = resultChunkId(r) ?? '?';
    const rel = qrels.get(cid) ?? 0;
    const relMark = rel >= 3 ? `**${rel}**` : rel > 0 ? String(rel) : '—';
    lines.push(
      `| ${i + 1} | ${(r.score ?? 0).toFixed(4)} | ${cid} | ${relMark} | ${snippet(p.section, 30)} | ${snippet(p.context, 80)} | ${(p.tags ?? []).slice(0, 4).join(', ')} |`
    );
  }
  return lines.join('\n');
}

function buildChunkComparison(chunkId, bPayload, cPayload) {
  const lines = [];
  lines.push(`**Expected chunk: \`${chunkId}\`**`);
  lines.push('');

  if (!bPayload && !cPayload) {
    lines.push('*Not found in either collection.*');
    return lines.join('\n');
  }

  lines.push('| Field | Baseline | Combined |');
  lines.push('|-------|----------|----------|');
  lines.push(`| section | ${snippet(bPayload?.section, 60)} | ${snippet(cPayload?.section, 60)} |`);
  lines.push(`| context | ${snippet(bPayload?.context, 120)} | ${snippet(cPayload?.context, 120)} |`);
  lines.push(`| tags | ${(bPayload?.tags ?? []).join(', ')} | ${(cPayload?.tags ?? []).join(', ')} |`);
  lines.push(`| text snippet | ${snippet(bPayload?.text, 100)} | ${snippet(cPayload?.text, 100)} |`);
  lines.push(`| text length (chars) | ${(bPayload?.text ?? '').length} | ${(cPayload?.text ?? '').length} |`);

  return lines.join('\n');
}

function buildReport({ dateStr, targetQueries, diagResults, indexingNotes }) {
  const lines = [];
  lines.push(`# COMBINED_LLM=1 Hard Regression Diagnostic — ${dateStr}`);
  lines.push('');
  lines.push('## Diagnostic Scope');
  lines.push('');
  lines.push('Target queries:');
  for (const id of TARGET_IDS) lines.push(`- \`${id}\``);
  lines.push('');
  lines.push('Compares exact top-10 results and expected chunk payloads between');
  lines.push('baseline (context+tags) and combined (COMBINED_LLM=1) to identify the root cause.');
  lines.push('');

  if (indexingNotes) {
    lines.push('## Indexing');
    lines.push('');
    lines.push(indexingNotes);
    lines.push('');
  }

  // Pre-compute per-query reproduced status
  const diagWithStatus = diagResults.map(entry => {
    const { query, bResults, cResults, bAllPoints, cAllPoints } = entry;
    const exactChunks = query.relevantChunks.filter(rc => rc.relevance >= 3);
    // Reproduced = at least one rel>=3 chunk was in baseline top-5 but absent from combined top-5
    const reproduced = exactChunks.some(rc => {
      const bRank = bResults.findIndex(r => resultChunkId(r) === rc.chunkId);
      const cRank = cResults.findIndex(r => resultChunkId(r) === rc.chunkId);
      return bRank >= 0 && bRank < 5 && !(cRank >= 0 && cRank < 5);
    });
    return { ...entry, exactChunks, reproduced };
  });

  for (const { query, bResults, cResults, bAllPoints, cAllPoints, exactChunks, reproduced } of diagWithStatus) {
    const statusLabel = reproduced ? 'hard regression reproduced' : 'hard regression NOT reproduced — likely variance';
    lines.push(`## Query \`${query.id}\` — ${query.type} — *${statusLabel}*`);
    lines.push('');
    lines.push(`**Query:** ${query.query}`);
    lines.push('');
    lines.push(`**Note:** ${query.note}`);
    lines.push('');
    lines.push('**qrels:**');
    for (const rc of query.relevantChunks) {
      lines.push(`- \`${rc.chunkId}\` — relevance ${rc.relevance}`);
    }
    lines.push('');

    // Rank summary
    lines.push('**Rank summary:**');
    lines.push('');
    lines.push('| chunkId | baseline rank | combined rank | baseline in top-5 | combined in top-5 |');
    lines.push('|---------|--------------|---------------|-------------------|-------------------|');
    for (const rc of exactChunks) {
      const bRank = bResults.findIndex(r => resultChunkId(r) === rc.chunkId);
      const cRank = cResults.findIndex(r => resultChunkId(r) === rc.chunkId);
      const bR5   = bRank >= 0 && bRank < 5 ? '✓' : '✗';
      const cR5   = cRank >= 0 && cRank < 5 ? '✓' : '✗';
      const bLabel = bRank >= 0 ? String(bRank + 1) : 'absent';
      const cLabel = cRank >= 0 ? String(cRank + 1) : 'absent';
      lines.push(`| \`${rc.chunkId}\` | ${bLabel} | ${cLabel} | ${bR5} | ${cR5} |`);
    }
    lines.push('');

    if (!reproduced) {
      lines.push('> **Note:** hard regression did not reproduce in this run — both baseline and combined');
      lines.push('> retrieved the expected chunk within top-5. Payload comparison and cause classification');
      lines.push('> are shown for reference only; do not use to draw conclusions about regression cause.');
      lines.push('');
    }

    // Top-10 tables
    lines.push(buildResultTable(bResults, query.qrels, 'Baseline'));
    lines.push('');
    lines.push(buildResultTable(cResults, query.qrels, 'Combined'));
    lines.push('');

    // Expected chunk payload comparison for all relevant chunks
    lines.push('### Expected Chunk Payload Comparison');
    lines.push('');
    for (const rc of query.relevantChunks) {
      const [sf, ci] = rc.chunkId.split('#');
      const bPt = findPoint(bAllPoints, sf, ci);
      const cPt = findPoint(cAllPoints, sf, ci);
      lines.push(buildChunkComparison(rc.chunkId, bPt?.payload, cPt?.payload));
      lines.push('');
    }

    // Cause classification
    const primaryExact = exactChunks[0];
    const [psf, pci] = primaryExact ? primaryExact.chunkId.split('#') : [null, null];
    const bPayload = psf ? findPoint(bAllPoints, psf, pci)?.payload : null;
    const cPayload = psf ? findPoint(cAllPoints, psf, pci)?.payload : null;
    const causes = classifyCause(query, bPayload, cPayload, bResults, cResults);

    lines.push('### Cause Classification');
    lines.push('');
    if (!reproduced) lines.push('*Not reproduced — classification is indicative only.*');
    lines.push('');
    for (const cause of causes) lines.push(`- ${cause}`);
    lines.push('');
  }

  // Overall recommendation — based only on reproduced regressions
  lines.push('## Overall Recommendation');
  lines.push('');

  const reproducedEntries  = diagWithStatus.filter(e => e.reproduced);
  const notReproducedIds   = diagWithStatus.filter(e => !e.reproduced).map(e => e.query.id);

  if (notReproducedIds.length > 0) {
    lines.push(`**Not reproduced in this run:** ${notReproducedIds.map(id => `\`${id}\``).join(', ')} — regression did not appear; likely LLM output variance. Rerun \`bench:custom50:combined\` 2-3 times to check consistency.`);
    lines.push('');
  }

  const reproducedCauses = reproducedEntries.flatMap(({ query, bResults, cResults, bAllPoints, cAllPoints }) => {
    const primaryExact = query.relevantChunks.find(rc => rc.relevance >= 3);
    if (!primaryExact) return [];
    const [psf, pci] = primaryExact.chunkId.split('#');
    return classifyCause(
      query,
      findPoint(bAllPoints, psf, pci)?.payload,
      findPoint(cAllPoints, psf, pci)?.payload,
      bResults, cResults,
    );
  });

  if (reproducedEntries.length === 0) {
    lines.push('**All target regressions not reproduced in this run** — no hard failures observed.');
    lines.push('');
    lines.push('**Recommendation:** rerun `bench:custom50:combined` 2-3 times to determine whether');
    lines.push('the regressions are consistent or purely LLM variance.');
  } else {
    const hasContextDrift = reproducedCauses.some(c => c.includes('context'));
    const hasTagLoss      = reproducedCauses.some(c => c.includes('tags lost'));
    const hasTagNoise     = reproducedCauses.some(c => c.includes('noisy'));
    const hasShortChunk   = reproducedCauses.some(c => c.includes('short-chunk'));
    const hasVariance     = reproducedCauses.some(c => c.includes('variance') || c.includes('rerun'));

    lines.push(`**Reproduced regressions:** ${reproducedEntries.map(e => `\`${e.query.id}\``).join(', ')}`);
    lines.push('');

    if (hasTagLoss || hasTagNoise) {
      lines.push('**Primary cause: combined tag quality** — combined mode produced tags that lost');
      lines.push('query-relevant terms or introduced off-topic terms, reducing BM25/sparse recall.');
      lines.push('');
      lines.push('**Recommendation:** tag normalization tweak — add explicit tag instructions to the');
      lines.push('combined prompt to prefer exact technical tokens over paraphrased terms.');
    } else if (hasContextDrift) {
      lines.push('**Primary cause: combined context/wording drift** — the single-call prompt produces');
      lines.push('context that emphasises different aspects than the two-call baseline, shifting embedding');
      lines.push('similarity for exact-token queries.');
      lines.push('');
      lines.push('**Recommendation:** prompt tweak — add an explicit instruction to preserve exact');
      lines.push('technical token mentions from the source text in the context summary.');
      lines.push('Alternatively, accept as opt-in tradeoff: aggregate MRR is within tolerance (+/-0.01)');
      lines.push('and windowRecall is unchanged.');
    } else if (hasShortChunk) {
      lines.push('**Primary cause: short-chunk guard** — affected chunks are near the COMBINED_MIN_CHARS');
      lines.push('threshold and fell back to separate calls, introducing inconsistency.');
      lines.push('');
      lines.push('**Recommendation:** COMBINED_MIN_CHARS threshold tuning — review threshold value.');
    } else if (hasVariance) {
      lines.push('**Primary cause unclear: likely LLM output variance** — causes are not definitively');
      lines.push('attributable to a structural combined-mode problem.');
      lines.push('');
      lines.push('**Recommendation:** rerun — run `bench:custom50:combined` 2-3 more times and check');
      lines.push('whether regressions are consistent.');
    } else {
      lines.push('**Cause unclear** — see per-query analysis above.');
      lines.push('');
      lines.push('**Recommendation:** rerun to check variance.');
    }
  }

  lines.push('');
  lines.push('**COMBINED_LLM=1 status:** remains opt-in with caution. Do not promote to default');
  lines.push('until root cause is resolved or accepted as a known tradeoff.');
  lines.push('');
  lines.push(`*Generated: ${dateStr}*`);

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[diag] COMBINED_LLM=1 hard regression diagnostic');
  console.log(`  targets:   ${TARGET_IDS.join(', ')}`);
  console.log(`  combined context policy: ${BENCH_COMBINED_CONTEXT_POLICY}`);
  console.log(`  reuse mode: ${REUSE_MODE ? `${COL_BASELINE} | ${COL_COMBINED}` : 'no — will index fresh'}`);

  if (!QDRANT_URL) { console.error('[diag] QDRANT_URL not set'); process.exit(1); }

  // Load queries up-front — fail before indexing if targets not found
  const raw     = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const allQ    = raw.queries.map(normaliseQuery);
  const targets = allQ.filter(q => TARGET_IDS.includes(q.id));
  if (targets.length === 0) {
    console.error(`[diag] none of the target IDs (${TARGET_IDS.join(', ')}) found in queries.json`);
    process.exit(1);
  }
  const missing = TARGET_IDS.filter(id => !targets.find(q => q.id === id));
  if (missing.length) console.warn(`[diag] WARN: query IDs not found: ${missing.join(', ')}`);

  let indexingNotes = null;

  try {
    // ── Index if not reusing ────────────────────────────────────────────────
    if (!REUSE_MODE) {
      buildCorpus();
      console.log(`  corpus built: ${FIXTURE_FILES.length} files → ${CORPUS_DIR}`);

      await ensureBenchCollection(COL_BASELINE);
      await ensureBenchCollection(COL_COMBINED);

      const baselineRun = runIndexer(COL_BASELINE, {
        BENCH_CONTEXT_POLICY: 'current-minimal',
      }, CHUNKS_BASELINE, 'A: baseline (context + tags)');
      const combinedRun = runIndexer(COL_COMBINED, {
        COMBINED_LLM:         '1',
        BENCH_CONTEXT_POLICY: BENCH_COMBINED_CONTEXT_POLICY,
      }, CHUNKS_COMBINED, `B: combined (COMBINED_LLM=1, BENCH_CONTEXT_POLICY=${BENCH_COMBINED_CONTEXT_POLICY})`);

      if (!baselineRun.ok || !combinedRun.ok) {
        throw new Error('one or both indexing runs failed');
      }
      indexingNotes = [
        `| Setting | Value |`,
        `|---------|-------|`,
        `| Baseline context policy | \`current-minimal\` (pinned) |`,
        `| Combined context policy | \`${BENCH_COMBINED_CONTEXT_POLICY}\` |`,
        ``,
        `| Run | Wall time | Combined fallbacks | Tag batch fallbacks |`,
        `|-----|-----------|-------------------|---------------------|`,
        `| Baseline | ${baselineRun.totalMs} ms | n/a | ${baselineRun.tagFallbacks} |`,
        `| Combined | ${combinedRun.totalMs} ms | ${combinedRun.fallbacks} | n/a |`,
      ].join('\n');
    } else {
      indexingNotes = `Reusing existing collections:\n- baseline: \`${COL_BASELINE}\`\n- combined: \`${COL_COMBINED}\``;
    }

    // ── Fetch all points for payload lookup ─────────────────────────────────
    console.log('\n[diag] Fetching all points from both collections...');
    const bAllPoints = await scrollAll(COL_BASELINE);
    const cAllPoints = await scrollAll(COL_COMBINED);
    console.log(`  baseline: ${bAllPoints.length} points`);
    console.log(`  combined: ${cAllPoints.length} points`);

    if (bAllPoints.length === 0 || cAllPoints.length === 0) {
      throw new Error('empty collection — cannot run diagnostic');
    }

    // ── Run target queries ──────────────────────────────────────────────────
    console.log('\n[diag] Running target queries...');
    const diagResults = [];
    for (const query of targets) {
      console.log(`  ${query.id}: ${query.query.slice(0, 50)}...`);
      const bResults = await runQuery(COL_BASELINE, query.query);
      const cResults = await runQuery(COL_COMBINED, query.query);

      const bRank = bResults.findIndex(r => [...query.qrels.entries()].some(([k, v]) => v >= 3 && resultChunkId(r) === k));
      const cRank = cResults.findIndex(r => [...query.qrels.entries()].some(([k, v]) => v >= 3 && resultChunkId(r) === k));
      console.log(`    baseline rank: ${bRank >= 0 ? bRank + 1 : 'absent'}  combined rank: ${cRank >= 0 ? cRank + 1 : 'absent'}`);

      diagResults.push({ query, bResults, cResults, bAllPoints, cAllPoints });
    }

    // ── Write report ────────────────────────────────────────────────────────
    const now     = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');

    const report  = buildReport({ dateStr, targetQueries: targets, diagResults, indexingNotes });
    mkdirSync(RESULTS_DIR, { recursive: true });
    const outPath = join(RESULTS_DIR, `${dateStr}T${timeStr}-combined-llm-hard-regressions.md`);
    writeFileSync(outPath, report, 'utf8');
    console.log(`\n[diag] Report: ${outPath}`);

  } finally {
    if (!REUSE_MODE) {
      if (!KEEP) {
        console.log('\n[diag] Cleaning up...');
        await deleteBenchCollection(COL_BASELINE);
        await deleteBenchCollection(COL_COMBINED);
      } else {
        console.log(`\n[diag] KEEP_COLLECTIONS=1 — retained: ${COL_BASELINE}, ${COL_COMBINED}`);
        console.log('  Re-run with these env vars to skip re-indexing:');
        console.log(`    BASELINE_COLLECTION=${COL_BASELINE}`);
        console.log(`    COMBINED_COLLECTION=${COL_COMBINED}`);
      }
      cleanupTransient();
    }
  }
}

main().catch(err => {
  console.error('[diag] fatal:', err.message);
  if (err.cause) console.error('[diag] cause:', err.cause?.message ?? err.cause);
  console.error('[diag] stack:', err.stack?.split('\n').slice(1, 4).join(' | '));
  process.exit(1);
});
