/**
 * BGE-M3 tokenizer audit: measure how well Math.ceil(text.length / 4) approximates
 * real BGE-M3 token counts across different corpora and scripts.
 *
 * Audit-only — does not change any production chunking behavior.
 * Reads chunkFile() output unchanged and measures each chunk with the real tokenizer.
 *
 * Usage:
 *   node benchmarks/retrieval/bge-tokenizer-audit.js
 *
 * Requires: tokenizer cache must be present in ./models/ (run ONNX_EMBED=1 indexing first).
 * If the tokenizer cannot be loaded from local files, the script stops immediately with
 * AUDIT_BLOCKED.
 */

import 'dotenv/config';
import { env, AutoTokenizer } from '@huggingface/transformers';
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, extname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { chunkFile } from '../../src/indexer/phases/chunk.js';
import { readFileSync } from 'fs';
import { ONNX_CACHE_DIR as CACHE_DIR } from '../../src/shared/core/onnx-paths.js';

// ── paths ──────────────────────────────────────────────────────────────────
const ROOT      = resolve(join(dirname(fileURLToPath(import.meta.url)), '../..'));
const MODEL_ID  = 'aapot/bge-m3-onnx';

const RESULTS_DIR = join(ROOT, 'benchmarks/retrieval/results');
const NOW = new Date();
const TIMESTAMP = `${NOW.getFullYear()}-${String(NOW.getMonth()+1).padStart(2,'0')}-${String(NOW.getDate()).padStart(2,'0')}T${String(NOW.getHours()).padStart(2,'0')}${String(NOW.getMinutes()).padStart(2,'0')}`;
const REPORT_PATH = join(RESULTS_DIR, `${TIMESTAMP}-bge-m3-tokenizer-audit.md`);

// ── tokenizer loading (tokenizer only, no ONNX session) ───────────────────
env.cacheDir = CACHE_DIR;

async function loadTokenizer() {
  // Check for cache directory presence before attempting load.
  // AutoTokenizer will try the network if the cache is empty; we block that here
  // to avoid unexpected downloads during an audit run.
  const cacheExists = existsSync(CACHE_DIR);
  if (!cacheExists) {
    return { ok: false, reason: `Cache directory not found: ${CACHE_DIR}\nRun ONNX_EMBED=1 indexing first to populate the tokenizer cache.` };
  }

  try {
    process.stderr.write('[audit] loading BGE-M3 tokenizer (no ONNX session)...\n');
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
      local_files_only: true,
    });
    process.stderr.write('[audit] tokenizer ready\n');
    return { ok: true, tokenizer };
  } catch (err) {
    return { ok: false, reason: `Tokenizer load failed: ${err.message}\nEnsure tokenizer files are cached in ${CACHE_DIR}.` };
  }
}

// ── corpus collection ─────────────────────────────────────────────────────
function collectMdFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMdFiles(full));
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      files.push(full);
    }
  }
  return files;
}

const CORPORA = [
  {
    id: 'custom-50-fixtures',
    label: 'custom-50 fixtures (English + mixed)',
    dir: join(ROOT, 'benchmarks/retrieval/custom-50/fixtures'),
  },
  {
    id: 'docs-en',
    label: 'docs/en (English documentation)',
    dir: join(ROOT, 'docs/en'),
  },
  {
    id: 'docs-design',
    label: 'docs/design (mixed — design docs)',
    dir: join(ROOT, 'docs/design'),
  },
  {
    id: 'ua-synthetic',
    label: 'Ukrainian synthetic fixture',
    dir: join(ROOT, 'benchmarks/retrieval/fixtures'),
    single: join(ROOT, 'benchmarks/retrieval/fixtures/ua-prose-synthetic.md'),
  },
];

// ── per-chunk measurement ─────────────────────────────────────────────────
async function measureFile(filePath, tokenizer) {
  const text = readFileSync(filePath, 'utf8');
  const sourceFile = filePath.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, '');
  const chunks = chunkFile(filePath, text, sourceFile);

  const measurements = [];
  for (const chunk of chunks) {
    const t = chunk.text;
    const heuristic = Math.ceil(t.length / 4);

    // Tokenizer encode: returns token ids. Count excluding special tokens
    // (we count input_ids length; for a single text without padding it equals
    // real token count including CLS/SEP which BGE-M3 does include in its seq).
    const encoded = await tokenizer(t, {
      padding: false,
      truncation: false, // intentionally no truncation — we want the real count
    });
    const realTokens = encoded.input_ids.dims[1];

    measurements.push({
      source_file: sourceFile,
      chunk_index: chunk.chunkIndex,
      section: chunk.section || '',
      charLen: t.length,
      heuristic,
      real: realTokens,
      ratio: realTokens / heuristic,
    });
  }
  return measurements;
}

// ── statistics ────────────────────────────────────────────────────────────
function stats(measurements) {
  if (!measurements.length) return null;

  const sorted = [...measurements].sort((a, b) => a.ratio - b.ratio);
  const ratios = sorted.map(m => m.ratio);
  const reals  = measurements.map(m => m.real);
  const heurs  = measurements.map(m => m.heuristic);

  const sum = arr => arr.reduce((s, v) => s + v, 0);
  const mean = arr => sum(arr) / arr.length;
  const median = arr => {
    const s = [...arr].sort((a,b)=>a-b);
    const mid = Math.floor(s.length/2);
    return s.length % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
  };
  const percentile = (arr, p) => {
    const s = [...arr].sort((a,b)=>a-b);
    const idx = Math.min(Math.ceil(p/100 * s.length) - 1, s.length-1);
    return s[idx];
  };

  const over = (threshold) => measurements.filter(m => m.real > threshold);

  return {
    count: measurements.length,
    avgHeuristic: mean(heurs),
    avgReal: mean(reals),
    medianRatio: median(ratios),
    p90Ratio: percentile(ratios, 90),
    maxRatio: Math.max(...ratios),
    over400: over(400),
    over512: over(512),
    over768: over(768),
    over1024: over(1024),
    worst10: [...measurements]
      .sort((a,b) => b.ratio - a.ratio)
      .slice(0, 10),
  };
}

// ── report formatting ─────────────────────────────────────────────────────
function pct(n, total) {
  return total === 0 ? '0.0%' : `${(100*n/total).toFixed(1)}%`;
}
function fmt2(n) { return n.toFixed(2); }
function fmt0(n) { return Math.round(n).toString(); }

function renderCorpusSection(label, s, fileCount) {
  if (!s) return `\n### ${label}\n\n_No files found — skipped._\n`;

  const lines = [];
  lines.push(`\n### ${label}\n`);
  lines.push(`- files analyzed: ${fileCount}`);
  lines.push(`- chunks analyzed: ${s.count}`);
  lines.push(`- avg heuristicTokens: ${fmt0(s.avgHeuristic)}`);
  lines.push(`- avg realBgeTokens: ${fmt0(s.avgReal)}`);
  lines.push(`- median ratio (real/heuristic): ${fmt2(s.medianRatio)}`);
  lines.push(`- p90 ratio: ${fmt2(s.p90Ratio)}`);
  lines.push(`- max ratio: ${fmt2(s.maxRatio)}`);
  lines.push('');
  lines.push('**Oversized chunks (real BGE-M3 tokens):**');
  lines.push('');
  lines.push(`| Threshold | Count | % of chunks |`);
  lines.push(`|-----------|-------|-------------|`);
  for (const [thr, key] of [[400,'over400'],[512,'over512'],[768,'over768'],[1024,'over1024']]) {
    const arr = s[key];
    lines.push(`| > ${thr} tokens | ${arr.length} | ${pct(arr.length, s.count)} |`);
  }
  lines.push('');
  lines.push('**Top 10 worst underestimates (highest ratio real/heuristic):**');
  lines.push('');
  lines.push('| source_file | chunk | section | heuristic | real | ratio |');
  lines.push('|-------------|-------|---------|-----------|------|-------|');
  for (const m of s.worst10) {
    const sec = m.section.length > 40 ? m.section.slice(0,37)+'...' : m.section;
    lines.push(`| \`${m.source_file}\` | ${m.chunk_index} | ${sec || '—'} | ${m.heuristic} | ${m.real} | ${fmt2(m.ratio)} |`);
  }
  return lines.join('\n');
}

// ── verdict logic ─────────────────────────────────────────────────────────
function computeVerdict(corpusResults) {
  // corpusResults: Map<id, {stats, label, fileCount}>
  const ua = corpusResults.get('ua-synthetic')?.stats;
  const en = corpusResults.get('custom-50-fixtures')?.stats;
  const design = corpusResults.get('docs-design')?.stats;
  const en2 = corpusResults.get('docs-en')?.stats;

  const anyStats = [ua, en, design, en2].filter(Boolean);
  if (!anyStats.length) return { verdict: 'AUDIT_BLOCKED', reason: 'No corpora could be measured.' };

  // Check English-heavy corpora
  const englishCorporaOk = [en, en2, design].filter(Boolean)
    .every(s => s.over512.length / s.count < 0.05 && s.medianRatio < 1.3);

  // Check Cyrillic corpus
  const cyrillicRisky = ua && (
    ua.medianRatio > 1.4 ||
    ua.over512.length / ua.count > 0.10
  );
  const cyrillicUnsafe = ua && (
    ua.medianRatio > 1.8 ||
    ua.over512.length / ua.count > 0.25
  );

  // Global unsafe: any corpus has >25% chunks over 512.
  // Max-ratio check only applies to chunks with heuristicTokens > 10 to exclude
  // degenerate micro-chunks (single-word stubs, headings) where tiny absolute
  // token differences produce huge ratios that are not retrieval-relevant.
  const anyUnsafe = anyStats.some(s =>
    s.over512.length / s.count > 0.25 ||
    s.worst10.filter(m => m.heuristic > 10).some(m => m.ratio > 2.5)
  );

  if (anyUnsafe || cyrillicUnsafe) {
    return {
      verdict: 'TOKEN_HEURISTIC_UNSAFE',
      reason: 'Critical overruns detected: >25% of chunks exceed 512 real tokens in at least one corpus, or max ratio >2.5.',
    };
  }
  if (cyrillicRisky) {
    return {
      verdict: 'TOKEN_HEURISTIC_CYRILLIC_RISK',
      reason: 'Heuristic is acceptable for English but materially wrong for Ukrainian/Cyrillic text (median ratio >1.4 or >10% chunks over 512 real tokens).',
    };
  }
  if (englishCorporaOk) {
    return {
      verdict: 'TOKEN_HEURISTIC_ACCEPTABLE',
      reason: 'Heuristic is within acceptable bounds for the measured corpora. Cyrillic corpus not available or shows low risk.',
    };
  }
  return {
    verdict: 'TOKEN_HEURISTIC_CYRILLIC_RISK',
    reason: 'Mixed results: English corpora appear acceptable, but some mixed-language corpora show elevated ratios.',
  };
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('[bge-tokenizer-audit] starting...\n');

  // Load tokenizer — hard stop if unavailable
  const tokResult = await loadTokenizer();
  if (!tokResult.ok) {
    const msg = [
      '# BGE-M3 Tokenizer Audit',
      '',
      `**Status: AUDIT_BLOCKED**`,
      '',
      '## Blocker',
      '',
      tokResult.reason,
      '',
      '## How to unblock',
      '',
      'Run indexing with ONNX_EMBED=1 at least once to populate the tokenizer cache:',
      '',
      '```bash',
      'ONNX_EMBED=1 COLLECTION=my-docs npm run index ./docs',
      '```',
      '',
      'Then re-run this audit script.',
    ].join('\n');

    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, msg);
    console.error('[bge-tokenizer-audit] AUDIT_BLOCKED\n');
    console.error(tokResult.reason);
    console.error(`\nReport written to: ${REPORT_PATH}`);
    process.exit(1);
  }

  const { tokenizer } = tokResult;
  const corpusResults = new Map();

  // Run each corpus
  for (const corpus of CORPORA) {
    const files = corpus.single
      ? (existsSync(corpus.single) ? [corpus.single] : [])
      : collectMdFiles(corpus.dir);

    if (!files.length) {
      console.warn(`[audit] corpus "${corpus.id}": no files found in ${corpus.dir}`);
      continue;
    }

    console.log(`[audit] corpus "${corpus.id}": ${files.length} file(s)...`);
    const allMeasurements = [];
    for (const fp of files) {
      try {
        const m = await measureFile(fp, tokenizer);
        allMeasurements.push(...m);
      } catch (err) {
        console.warn(`  [warn] ${fp}: ${err.message}`);
      }
    }

    corpusResults.set(corpus.id, {
      label: corpus.label,
      fileCount: files.length,
      stats: stats(allMeasurements),
    });
    console.log(`  → ${allMeasurements.length} chunks measured`);
  }

  // Compute verdict
  const { verdict, reason } = computeVerdict(corpusResults);
  console.log(`\n[audit] VERDICT: ${verdict}`);

  // Build report
  const lines = [];
  lines.push('# BGE-M3 Tokenizer Audit Report');
  lines.push('');
  lines.push(`**Date:** ${NOW.toISOString().slice(0, 10)}`);
  lines.push(`**Script:** \`benchmarks/retrieval/bge-tokenizer-audit.js\``);
  lines.push(`**Model:** \`${MODEL_ID}\` (tokenizer only — no ONNX inference session)`);
  lines.push(`**Heuristic:** \`Math.ceil(text.length / 4)\` (legacy fallback via \`TOKEN_COUNT=heuristic\`)`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`**Verdict: ${verdict}**`);
  lines.push('');
  lines.push(reason);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Per-Corpus Results');

  for (const [id, { label, fileCount, stats: s }] of corpusResults) {
    lines.push(renderCorpusSection(label, s, fileCount));
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Interpretation');
  lines.push('');

  // Pull stats for interpretation
  const ua   = corpusResults.get('ua-synthetic')?.stats;
  const en   = corpusResults.get('custom-50-fixtures')?.stats;
  const en2  = corpusResults.get('docs-en')?.stats;

  lines.push('### Is `length/4` acceptable for English-heavy docs?');
  // Use docs/en as the English-prose reference; custom-50 fixtures include code/table chunks
  const enRef = en2 || en;
  if (enRef) {
    const pctOver512 = (100 * enRef.over512.length / enRef.count).toFixed(1);
    const label = en2 ? 'docs/en' : 'custom-50 fixtures';
    if (enRef.medianRatio < 1.2 && enRef.over512.length / enRef.count < 0.05) {
      lines.push(`Yes. On the ${label} corpus, median ratio is ${fmt2(enRef.medianRatio)} `);
      lines.push(`and only ${pctOver512}% of chunks exceed 512 real tokens. The heuristic is close enough for English prose.`);
    } else {
      lines.push(`Partially. On the ${label} corpus, median ratio is ${fmt2(enRef.medianRatio)} and ${pctOver512}% of chunks exceed 512 real tokens.`);
      lines.push('Overruns are concentrated in code blocks and Markdown tables, where tokens-per-char is lower than ASCII prose.');
      lines.push('Pure prose English sections are unlikely to overflow, but mixed-content docs (code + prose) frequently do.');
    }
  } else {
    lines.push('English corpus data not available in this run.');
  }
  lines.push('');

  lines.push('### Is it unsafe for Ukrainian/Cyrillic?');
  if (ua) {
    const pctOver512 = (100 * ua.over512.length / ua.count).toFixed(1);
    lines.push(`On the synthetic Ukrainian corpus: median ratio = ${fmt2(ua.medianRatio)},`);
    lines.push(`p90 ratio = ${fmt2(ua.p90Ratio)}, max ratio = ${fmt2(ua.maxRatio)}.`);
    lines.push(`${pctOver512}% of chunks exceed 512 real tokens.`);
    if (ua.medianRatio > 1.4) {
      lines.push('**The heuristic materially underestimates tokens for Cyrillic text.** This confirms the theoretical prediction from the design plan.');
    } else if (ua.medianRatio > 1.1) {
      lines.push('The heuristic underestimates Cyrillic tokens moderately. Real-world impact depends on corpus composition.');
    } else {
      lines.push('Surprisingly, the heuristic is close for this synthetic fixture. Verify with a larger, more varied Cyrillic corpus.');
    }
  } else {
    lines.push('Ukrainian synthetic fixture not found. See `benchmarks/retrieval/fixtures/ua-prose-synthetic.md`.');
  }
  lines.push('');

  lines.push('### Would switching to real tokenizer likely increase chunk count?');
  if (ua && ua.medianRatio > 1.3) {
    lines.push('Yes. If the real tokenizer is used with the same `MAX_CHUNK_TOKENS=400` limit, chunks that currently pass the heuristic');
    lines.push('check would be split further. This increases chunk count and may improve retrieval precision for Cyrillic content,');
    lines.push('but also invalidates existing `chunk_index`-based qrels and changes all point IDs (requiring full reindex).');
  } else {
    lines.push('Likely marginal increase for English-heavy corpora. Significant increase expected if Cyrillic corpus is substantial.');
  }
  lines.push('');

  lines.push('### Is the issue large enough to justify implementing `TOKEN_COUNT=bge-m3`?');
  if (verdict === 'TOKEN_HEURISTIC_UNSAFE') {
    lines.push('**Yes, urgently.** The data shows critical overruns that will degrade retrieval quality.');
    lines.push('Use the real-tokenizer production default; keep `TOKEN_COUNT=heuristic` only as an explicit fallback.');
  } else if (verdict === 'TOKEN_HEURISTIC_CYRILLIC_RISK') {
    lines.push('**Yes, for Cyrillic workloads.** English-heavy corpora are likely fine with the heuristic, but any collection');
    lines.push('with significant Ukrainian/Russian content should use the real-tokenizer production default. Keep');
    lines.push('`TOKEN_COUNT=heuristic` only as an explicit fallback and document qrel regeneration for positional benchmarks.');
  } else if (verdict === 'TOKEN_HEURISTIC_ACCEPTABLE') {
    lines.push('**Not urgently.** The data does not show material retrieval risk from the current heuristic on the measured corpora.');
    lines.push('The theoretical risk for Cyrillic is real, but this dataset does not demonstrate it at a level that justifies');
    lines.push('immediate production changes. Continue monitoring with a larger Cyrillic corpus.');
  } else {
    lines.push('Audit was blocked — cannot make a recommendation. Address the blocker above first.');
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Real token counts include CLS and SEP special tokens (as BGE-M3 includes them in its sequence).');
  lines.push('- Legacy heuristic is `Math.ceil(text.length / 4)`; production default is the BGE-M3 tokenizer.');
  lines.push('- This measurement script does not change production code.');
  lines.push('- Extreme max-ratio values (e.g., ratio 5.0) arise from micro-chunks of 1–3 heuristic tokens');
  lines.push('  (stray heading residuals, single-word stubs). These are artifacts of the current sentence splitter,');
  lines.push('  not evidence of systematic overruns. Verdict logic excludes chunks with heuristic ≤ 10 from the');
  lines.push('  max-ratio gate to prevent micro-chunk noise from dominating the verdict.');
  lines.push('- `docs/design` corpus contains significant Ukrainian text (design docs are written in Ukrainian),');
  lines.push('  so its elevated ratios reflect Cyrillic token density, not English-specific issues.');
  lines.push('- Synthetic Ukrainian fixture: `benchmarks/retrieval/fixtures/ua-prose-synthetic.md`.');
  lines.push('- Design plan: `docs/design/bge-m3-token-aware-chunking-plan.md`.');

  const report = lines.join('\n');
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, report);
  console.log(`\nReport written to: ${REPORT_PATH}`);
  console.log(`Verdict: ${verdict}`);
}

main().catch(err => {
  console.error('[bge-tokenizer-audit] fatal error:', err.message);
  process.exit(1);
});
