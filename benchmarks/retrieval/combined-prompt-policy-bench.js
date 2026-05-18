/**
 * COMBINED_LLM prompt policy matrix — benchmark-only.
 *
 * Tests 4 prompt variants against 5 mixed-domain fixture chunks.
 * No production code changes. No Qdrant. No indexer. Pure LLM call benchmark.
 *
 * Usage:
 *   node benchmarks/retrieval/combined-prompt-policy-bench.js
 *
 * Requires: Ollama running with CONTEXT_MODEL pulled.
 *
 * Optional env:
 *   CONTEXT_MODEL=gemma3:4b   LLM model to use (default: gemma3:4b)
 *   RUNS_PER_CELL=2           repeat each (variant × chunk) N times (default: 2)
 *   POLICY=current-minimal    run only one variant (for quick spot-checks)
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { generate } from '../../src/core/ollama.js';
import { parseCombinedResponse } from '../../src/indexer/phases/combined.js';

const ROOT        = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const RESULTS_DIR = join(ROOT, 'benchmarks', 'retrieval', 'results');

const MODEL         = process.env.CONTEXT_MODEL || 'gemma3:4b';
const RUNS_PER_CELL = Math.max(1, parseInt(process.env.RUNS_PER_CELL || '2', 10));
const POLICY_FILTER = process.env.POLICY || null;

// ── Prompt variants ───────────────────────────────────────────────────────────

// Exact copy of current production prompt (no changes).
function promptCurrentMinimal(chunk) {
  return `You are a document indexer. Given a text chunk, return a JSON object with:
- "context": 1-2 sentences describing what this chunk is about and where it fits in the document
- "tags": array of 3-7 lowercase hyphenated tags (e.g. "node-js", "qdrant-hybrid-search")

Output ONLY valid JSON, nothing else. Example: {"context":"This chunk explains X.","tags":["x","y"]}

File: ${chunk.source_file}
Section: ${chunk.section}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;
}

// Domain-aware: explains that text can be any domain and tags should reflect
// the actual domain without injecting technical vocabulary.
function promptDomainAwareUniversal(chunk) {
  return `You are a document indexer working across many domains (technical docs, personal notes, fiction, academic writing, operations guides, etc.).

Return a JSON object with:
- "context": 1-2 sentences describing what this chunk is about and where it fits in the document. Use the vocabulary of the source domain.
- "tags": array of 3-7 lowercase hyphenated tags matching the actual content domain. For technical text include exact identifiers. For non-technical text use natural topic tags (e.g. "daily-planning", "character-description", "research-methods"). Do not add technical vocabulary to non-technical text.

Output ONLY valid JSON, nothing else. Example: {"context":"This chunk explains X.","tags":["x","y"]}

File: ${chunk.source_file}
Section: ${chunk.section}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;
}

// Context-first: asks for a richer context sentence as the primary output,
// with tags as secondary anchors derived from that context.
function promptContextFirst(chunk) {
  return `You are a document indexer. Your primary goal is a high-quality context sentence that captures the main point of the chunk and its role in the document.

Return a JSON object with:
- "context": 1-2 sentences that would help a reader locate this chunk when searching. Mention the key subject and any important named entities, commands, or config fields present in the text.
- "tags": 3-7 lowercase hyphenated tags derived from the context. Prefer terms that appear in the text over paraphrases.

Output ONLY valid JSON, nothing else. Example: {"context":"This chunk explains X.","tags":["x","y"]}

File: ${chunk.source_file}
Section: ${chunk.section}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;
}

// Question-guided + domain-aware: frames tagging as "what questions would this chunk answer"
// and names the domain explicitly.
function promptQuestionGuidedDomainAware(chunk) {
  return `You are a document indexer. Read the text chunk and answer two questions:
1. What is this chunk about? (→ "context": 1-2 sentences, use the language of the source text)
2. What search queries would retrieve this chunk? (→ "tags": 3-7 lowercase hyphenated keywords from those queries)

Rules for tags:
- Use terms from the text itself, not synonyms or paraphrases.
- For technical text: include identifier names, command names, config keys, field names.
- For non-technical text: include topic words, people, places, or concepts from the text.
- Never add tags that don't appear (directly or closely) in the text.

Output ONLY valid JSON, nothing else. Example: {"context":"This chunk explains X.","tags":["x","y"]}

File: ${chunk.source_file}
Section: ${chunk.section}
Chunk ${chunk.chunkIndex + 1} of ${chunk.totalChunks}

Text:
${chunk.text.slice(0, 1000)}`;
}

const POLICIES = [
  { id: 'current-minimal',          build: promptCurrentMinimal },
  { id: 'domain-aware-universal',   build: promptDomainAwareUniversal },
  { id: 'context-first',            build: promptContextFirst },
  { id: 'question-guided-domain-aware', build: promptQuestionGuidedDomainAware },
].filter(p => !POLICY_FILTER || p.id === POLICY_FILTER);

// ── Mixed-domain fixture chunks ───────────────────────────────────────────────

const FIXTURES = [
  {
    id: 'technical-config',
    domain: 'technical',
    source_file: 'providers.md',
    section: 'Reindex triggers',
    chunkIndex: 0, totalChunks: 8,
    // identifiers expected in tags/context
    expectedIdentifiers: ['discriminators', 'sparse-provider', 'dense-provider',
      'embedding-schema-version', 'file-hash', 'reindex'],
    text: `Changing \`sparseProvider\`, \`denseProvider\`, \`denseModel\`, or \`embeddingSchemaVersion\` in config.json triggers a full reindex of the collection on next \`npm run index\`. These fields are the reindex discriminators. Changing \`file_hash\` also triggers reindex of individual files. Other fields (description, vectorSize already stored) do not trigger reindex.`,
  },
  {
    id: 'everyday-note',
    domain: 'non-technical',
    source_file: 'notes/2024-03-15.md',
    section: 'Morning',
    chunkIndex: 0, totalChunks: 3,
    // no technical identifiers — watch for hallucinated tech tags
    expectedIdentifiers: [],
    forbiddenTechTerms: ['api', 'json', 'config', 'database', 'node', 'function',
      'endpoint', 'server', 'git', 'deploy'],
    text: `Woke up at 7. Made coffee and sat by the window watching the rain. Need to call mom before Thursday — she mentioned the garden is getting overgrown. Reminder: dentist appointment at 3pm on Friday, bring insurance card. Also pick up bread on the way home.`,
  },
  {
    id: 'narrative-fiction',
    domain: 'non-technical',
    source_file: 'story/chapter-03.md',
    section: 'The crossing',
    chunkIndex: 2, totalChunks: 12,
    expectedIdentifiers: [],
    forbiddenTechTerms: ['api', 'json', 'config', 'database', 'node', 'function',
      'endpoint', 'server', 'git', 'deploy', 'schema', 'query'],
    text: `The bridge swayed under Mira's feet as she stepped onto the first plank. Below, the river ran dark and fast, carrying branches from the storm two nights ago. She did not look down. Halfway across she heard the soldier call her name — or thought she did — but when she turned, the far bank was empty. She kept walking.`,
  },
  {
    id: 'academic-prose',
    domain: 'mixed',
    source_file: 'research/retrieval-augmented-generation.md',
    section: 'Retrieval mechanisms',
    chunkIndex: 1, totalChunks: 6,
    expectedIdentifiers: ['retrieval', 'embedding', 'dense', 'sparse'],
    text: `Retrieval-augmented generation (RAG) systems combine a retrieval component with a generative language model. The retrieval component selects relevant passages from a corpus using dense or sparse representations. Dense retrieval uses neural embeddings and approximate nearest-neighbour search; sparse retrieval uses term-frequency weighting such as BM25. Hybrid systems fuse both signals, typically via reciprocal rank fusion (RRF), to benefit from the complementary strengths of each approach.`,
  },
  {
    id: 'operational-troubleshooting',
    domain: 'technical',
    source_file: 'runbooks/qdrant-connection-errors.md',
    section: 'ECONNREFUSED on startup',
    chunkIndex: 0, totalChunks: 4,
    expectedIdentifiers: ['qdrant', 'qdrant-url', 'econnrefused', 'docker'],
    text: `If the indexer exits immediately with \`Error: connect ECONNREFUSED\`, the Qdrant instance is not reachable at the configured \`QDRANT_URL\`. Check that Docker is running and the container is healthy: \`docker ps | grep qdrant\`. If the container is stopped, start it with \`docker compose up -d qdrant\`. Verify the port mapping matches \`QDRANT_URL\` in your \`.env\` file. If using Qdrant Cloud, confirm \`QDRANT_KEY\` is set and the cluster is not paused.`,
  },
];

// ── Evaluation helpers ────────────────────────────────────────────────────────

// Generic/noisy tags: single common English words or overly broad terms unlikely
// to be useful for retrieval. Not an exhaustive list — just a signal.
const GENERIC_TOKENS = new Set([
  'text', 'document', 'file', 'section', 'chunk', 'content', 'information',
  'data', 'note', 'notes', 'item', 'example', 'details', 'description',
  'overview', 'summary', 'topic', 'thing', 'things', 'concept', 'concepts',
  'general', 'specific', 'various', 'other', 'related', 'type', 'types',
  'part', 'feature', 'features', 'usage', 'use', 'guide', 'guides',
]);

function isGenericTag(tag) {
  const tokens = tag.split('-');
  return tokens.length === 1 && GENERIC_TOKENS.has(tag);
}

function genericTagRate(tags) {
  if (!tags || tags.length === 0) return 0;
  return tags.filter(isGenericTag).length / tags.length;
}

function identifierPreservationRate(tags, context, expectedIdentifiers) {
  if (!expectedIdentifiers || expectedIdentifiers.length === 0) return null;
  const haystack = [...(tags || []), (context || '')].join(' ').toLowerCase();
  const found = expectedIdentifiers.filter(id => haystack.includes(id.toLowerCase()));
  return found.length / expectedIdentifiers.length;
}

function hasForbiddenTechTerms(tags, context, forbidden) {
  if (!forbidden || forbidden.length === 0) return false;
  const haystack = [...(tags || []), (context || '')].join(' ').toLowerCase();
  return forbidden.some(t => haystack.includes(t));
}

// Simple context usefulness rubric (heuristic, not LLM-graded):
// - length: too short (<30 chars) or too long (>300 chars) = penalty
// - mentions section or source_file basename = bonus
// - mentions at least one word from the text (>5 chars) = bonus
function contextUsefulnessScore(context, chunk) {
  if (!context || context.trim().length === 0) return 0;
  let score = 0.5; // baseline for any non-empty context
  const len = context.trim().length;
  if (len >= 40 && len <= 250) score += 0.2;
  const sectionWords = (chunk.section || '').toLowerCase().split(/\W+/).filter(w => w.length > 3);
  if (sectionWords.some(w => context.toLowerCase().includes(w))) score += 0.15;
  const textWords = chunk.text.toLowerCase().match(/\b\w{6,}\b/g) || [];
  const unique = [...new Set(textWords)].slice(0, 20);
  const overlap = unique.filter(w => context.toLowerCase().includes(w));
  if (overlap.length >= 2) score += 0.15;
  return Math.min(1, score);
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function runCell(policy, fixture, runIdx) {
  const prompt = policy.build(fixture);
  const t0 = Date.now();
  let raw, parsed, latencyMs, jsonParseOk;
  try {
    raw         = await generate(MODEL, prompt, { format: 'json' });
    latencyMs   = Date.now() - t0;
    parsed      = parseCombinedResponse(raw);
    jsonParseOk = parsed !== null;
  } catch (e) {
    latencyMs   = Date.now() - t0;
    jsonParseOk = false;
    parsed      = null;
    raw         = String(e.message);
  }

  const tags    = parsed?.tags ?? [];
  const context = parsed?.context ?? '';
  // usableOk: JSON parsed AND output is within spec (3-7 tags, non-empty context)
  const usableOk = jsonParseOk && tags.length >= 3 && tags.length <= 7 && context.trim().length > 0;

  return {
    policyId:     policy.id,
    fixtureId:    fixture.id,
    domain:       fixture.domain,
    runIdx,
    latencyMs,
    jsonParseOk,
    usableOk,
    tagCount:     tags.length,
    tags,
    context,
    genericRate:  genericTagRate(tags),
    identPreserv: identifierPreservationRate(tags, context, fixture.expectedIdentifiers),
    techHalluc:   hasForbiddenTechTerms(tags, context, fixture.forbiddenTechTerms),
    ctxScore:     contextUsefulnessScore(context, fixture),
    rawSnippet:   (raw || '').slice(0, 200),
  };
}

// ── Report builder ────────────────────────────────────────────────────────────

function fmtPct(n) {
  if (n === null || n === undefined) return 'n/a';
  return `${Math.round(n * 100)}%`;
}
function fmtMs(n) { return `${Math.round(n)} ms`; }
function fmtNum(n, decimals = 2) { return n.toFixed(decimals); }

function aggregateByPolicy(results) {
  const byPolicy = {};
  for (const r of results) {
    (byPolicy[r.policyId] ??= []).push(r);
  }
  return Object.entries(byPolicy).map(([id, rows]) => {
    const jsonOkRows    = rows.filter(r => r.jsonParseOk);
    const usableRows    = rows.filter(r => r.usableOk);
    const parseRate     = jsonOkRows.length / rows.length;
    const usableRate    = usableRows.length / rows.length;
    const meanLatency   = rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length;
    const meanTagCount  = usableRows.reduce((s, r) => s + r.tagCount, 0) / (usableRows.length || 1);
    const meanGeneric   = usableRows.reduce((s, r) => s + r.genericRate, 0) / (usableRows.length || 1);
    const identRows     = usableRows.filter(r => r.identPreserv !== null);
    const meanIdent     = identRows.length ? identRows.reduce((s, r) => s + r.identPreserv, 0) / identRows.length : null;
    const nonTechRows   = usableRows.filter(r => r.domain === 'non-technical');
    const hallucRate    = nonTechRows.length ? nonTechRows.filter(r => r.techHalluc).length / nonTechRows.length : null;
    const meanCtxScore  = usableRows.reduce((s, r) => s + r.ctxScore, 0) / (usableRows.length || 1);
    // Per-fixture ident preservation (for hard-gate checks): keyed by fixtureId, usable rows only
    const identByFixture = {};
    for (const r of usableRows) {
      if (r.identPreserv !== null) {
        (identByFixture[r.fixtureId] ??= []).push(r.identPreserv);
      }
    }
    const meanIdentByFixture = Object.fromEntries(
      Object.entries(identByFixture).map(([fid, vals]) => [fid, vals.reduce((s, v) => s + v, 0) / vals.length])
    );
    return { id, parseRate, usableRate, meanLatency, meanTagCount, meanGeneric, meanIdent, hallucRate, meanCtxScore, meanIdentByFixture, rows };
  });
}

function aggregateByFixture(policyId, results) {
  return FIXTURES.map(f => {
    const rows       = results.filter(r => r.policyId === policyId && r.fixtureId === f.id);
    if (rows.length === 0) return null;
    const jsonOkRows = rows.filter(r => r.jsonParseOk);
    const usableRows = rows.filter(r => r.usableOk);
    // Use the last usable row for display; fall back to last json-ok row for tags/context
    const lastUsable = [...usableRows].pop();
    const lastJson   = [...jsonOkRows].pop();
    const displayRow = lastUsable ?? lastJson ?? null;
    return {
      fixtureId:    f.id,
      domain:       f.domain,
      parseRate:    jsonOkRows.length / rows.length,
      usableRate:   usableRows.length / rows.length,
      meanLatency:  rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length,
      tags:         displayRow?.tags ?? [],
      tagsEmpty:    displayRow !== null && (displayRow.tags?.length ?? 0) === 0,
      jsonFailed:   displayRow === null,
      context:      displayRow?.context ?? '',
      identPreserv: displayRow?.identPreserv ?? null,
      techHalluc:   displayRow?.techHalluc ?? false,
      ctxScore:     displayRow?.ctxScore ?? 0,
    };
  }).filter(Boolean);
}

function pickBestPolicy(agg) {
  // Score on usableRate (not parseRate): usableRate*30 + identPreserv*30 + (1-hallucRate)*20 + (1-genericRate)*10 + ctxScore*10
  let best = null, bestScore = -Infinity;
  for (const p of agg) {
    const identScore  = p.meanIdent  !== null ? p.meanIdent  : 0.5;
    const hallucScore = p.hallucRate !== null ? (1 - p.hallucRate) : 1;
    const score = p.usableRate * 30 + identScore * 30 + hallucScore * 20
                + (1 - p.meanGeneric) * 10 + p.meanCtxScore * 10;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return { best, bestScore };
}

function buildReport(results, dateStr) {
  const agg = aggregateByPolicy(results);
  const { best } = pickBestPolicy(agg);

  // Baseline (current-minimal) per-fixture ident for hard-gate comparison
  const baseline = agg.find(p => p.id === 'current-minimal');

  const lines = [];
  lines.push(`# COMBINED_LLM Prompt Policy Matrix — ${dateStr}`);
  lines.push('');
  lines.push('## Setup');
  lines.push('');
  lines.push('| Item | Value |');
  lines.push('|------|-------|');
  lines.push(`| Model | ${MODEL} |`);
  lines.push(`| Runs per cell | ${RUNS_PER_CELL} |`);
  lines.push(`| Fixture chunks | ${FIXTURES.length} |`);
  lines.push(`| Prompt variants | ${POLICIES.length} |`);
  lines.push(`| Total LLM calls | ${results.length} |`);
  lines.push('');
  lines.push('## Fixture Domains');
  lines.push('');
  lines.push('| ID | Domain | Section | Identifiers expected |');
  lines.push('|----|--------|---------|----------------------|');
  for (const f of FIXTURES) {
    const ids = f.expectedIdentifiers?.join(', ') || '—';
    lines.push(`| ${f.id} | ${f.domain} | ${f.section} | ${ids} |`);
  }
  lines.push('');
  lines.push('## Aggregate Results by Policy');
  lines.push('');
  lines.push('Scores:');
  lines.push('- **json parse rate**: fraction of calls where `parseCombinedResponse` returned non-null');
  lines.push('- **usable rate**: fraction of calls where JSON parsed AND tags 3-7 AND context non-empty');
  lines.push('- **mean latency**: average LLM call duration');
  lines.push('- **mean tag count**: average tags per usable chunk (target: 3-7)');
  lines.push('- **generic rate**: fraction of tags that are generic/noisy single words');
  lines.push('- **ident preserv**: fraction of expected identifiers present in tags+context (technical fixtures, usable rows only)');
  lines.push('- **tech halluc rate**: fraction of non-technical chunks (usable) where forbidden tech terms appeared');
  lines.push('- **ctx score**: heuristic context usefulness (0-1)');
  lines.push('');
  lines.push('| Policy | json parse | usable | latency | tag count | generic rate | ident preserv | tech halluc | ctx score |');
  lines.push('|--------|-----------|--------|---------|-----------|--------------|---------------|-------------|-----------|');
  for (const p of agg) {
    const mark = p.id === best?.id ? ' ★' : '';
    lines.push(
      `| ${p.id}${mark} | ${fmtPct(p.parseRate)} | ${fmtPct(p.usableRate)} | ${fmtMs(p.meanLatency)} | ${fmtNum(p.meanTagCount, 1)} | ${fmtPct(p.meanGeneric)} | ${fmtPct(p.meanIdent)} | ${fmtPct(p.hallucRate)} | ${fmtNum(p.meanCtxScore, 2)} |`
    );
  }
  lines.push('');
  lines.push('## Per-Fixture Detail');
  lines.push('');

  for (const policy of POLICIES) {
    lines.push(`### ${policy.id}`);
    lines.push('');
    const fixtureRows = aggregateByFixture(policy.id, results);
    for (const fr of fixtureRows) {
      lines.push(`**${fr.fixtureId}** (${fr.domain})`);
      lines.push('');
      lines.push(`- JSON parse: ${fmtPct(fr.parseRate)} | Usable: ${fmtPct(fr.usableRate)} | Latency: ${fmtMs(fr.meanLatency)} | ctx score: ${fmtNum(fr.ctxScore, 2)}`);
      if (fr.identPreserv !== null) lines.push(`- Ident preservation: ${fmtPct(fr.identPreserv)}`);
      if (fr.domain === 'non-technical') lines.push(`- Tech hallucination: ${fr.techHalluc ? '**YES**' : 'no'}`);
      // Tag label: distinguish json failure, empty tags, and normal output
      let tagLabel;
      if (fr.jsonFailed) tagLabel = '*(parse failed)*';
      else if (fr.tagsEmpty) tagLabel = '*(empty)*';
      else tagLabel = fr.tags.join(', ');
      lines.push(`- Tags: ${tagLabel}`);
      lines.push(`- Context: ${fr.context ? fr.context.slice(0, 200) : '*(parse failed)*'}`);
      lines.push('');
    }
  }

  lines.push('## Verdict');
  lines.push('');

  const allUsableFail = agg.every(p => p.usableRate === 0);
  if (allUsableFail) {
    lines.push('**All variants fail** — no policy produced usable output across all fixtures.');
    lines.push('Check model availability and Ollama connectivity.');
    lines.push('');
    lines.push('**Recommendation:** fix model/connectivity before proceeding.');
  } else {
    const hallucOk  = best?.hallucRate === null || best.hallucRate <= 0.2;
    const identOk   = best?.meanIdent !== null && best.meanIdent >= 0.6;

    lines.push(`**Best candidate by composite score: \`${best?.id}\`**`);
    lines.push('');
    lines.push('| Criterion | Result |');
    lines.push('|-----------|--------|');
    lines.push(`| Usable rate | ${best ? fmtPct(best.usableRate) : 'n/a'} |`);
    lines.push(`| JSON parse rate | ${best ? fmtPct(best.parseRate) : 'n/a'} |`);
    lines.push(`| Identifier preservation (technical) | ${best ? fmtPct(best.meanIdent) : 'n/a'} |`);
    lines.push(`| Tech hallucination on non-technical text | ${best ? fmtPct(best.hallucRate) : 'n/a'} |`);
    lines.push(`| Context usefulness | ${best ? fmtNum(best.meanCtxScore, 2) : 'n/a'} |`);
    lines.push('');

    // Hard gates: candidate must not regress ident preservation vs current-minimal
    // on any technical fixture where baseline had usable output.
    const hardGateFailures = [];
    if (best && baseline && best.id !== 'current-minimal') {
      const technicalFixtures = FIXTURES.filter(f => f.expectedIdentifiers?.length > 0);
      for (const f of technicalFixtures) {
        const baselineIdent   = baseline.meanIdentByFixture[f.id] ?? null;
        const candidateIdent  = best.meanIdentByFixture[f.id] ?? null;
        if (baselineIdent !== null && candidateIdent !== null && candidateIdent < baselineIdent - 0.001) {
          hardGateFailures.push(
            `\`${f.id}\`: candidate ident ${fmtPct(candidateIdent)} < baseline ${fmtPct(baselineIdent)}`
          );
        }
        // Also gate if baseline had usable output but candidate had none
        if (baselineIdent !== null && candidateIdent === null) {
          hardGateFailures.push(
            `\`${f.id}\`: candidate has no usable output but baseline did (ident ${fmtPct(baselineIdent)})`
          );
        }
      }
    }

    if (hardGateFailures.length > 0) {
      lines.push('**Hard gate FAILED** — candidate regresses identifier preservation vs `current-minimal` on:');
      for (const msg of hardGateFailures) lines.push(`- ${msg}`);
      lines.push('');
      lines.push('**Verdict: needs deeper test** — best candidate passes composite score but fails hard gate.');
      lines.push('Do not promote to production until per-fixture ident regression is resolved.');
    } else if (!hallucOk) {
      lines.push('**Concern:** best candidate shows high tech-hallucination rate on non-technical text.');
      lines.push('');
      lines.push('**Verdict: needs deeper test** — hallucination rate exceeds threshold.');
    } else if (identOk && hallucOk && best?.usableRate >= 0.9) {
      lines.push(`**Verdict: proceed with \`${best.id}\`** — meets all criteria (usable rate, ident preservation, no hallucination).`);
      lines.push('');
      if (best.id !== 'current-minimal') {
        lines.push(`If adopting \`${best.id}\`, update \`src/indexer/phases/combined.js\` \`buildPrompt()\` and rerun \`bench:custom50:combined\` to confirm no aggregate regression.`);
      }
    } else if (best?.usableRate >= 0.7) {
      lines.push(`**Verdict: needs deeper test** — \`${best.id}\` is the best available candidate but does not fully satisfy all criteria on this small fixture set.`);
      lines.push('Rerun with larger fixture set or RUNS_PER_CELL=5 before committing to production.');
    } else {
      lines.push('**Verdict: all variants fail to meet criteria** — none achieve reliable usable rate + identifier preservation + hallucination control.');
      lines.push('Prompt-only approach may be insufficient; consider heuristic post-processing.');
    }
  }

  lines.push('');
  lines.push(`*Generated: ${dateStr}*`);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  console.log('[policy-bench] COMBINED_LLM prompt policy matrix');
  console.log(`  model:         ${MODEL}`);
  console.log(`  runs per cell: ${RUNS_PER_CELL}`);
  console.log(`  policies:      ${POLICIES.map(p => p.id).join(', ')}`);
  console.log(`  fixtures:      ${FIXTURES.map(f => f.id).join(', ')}`);
  console.log(`  ollama:        ${ollamaUrl}`);
  console.log('');

  // Quick connectivity check
  try {
    const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`[policy-bench] Ollama not reachable at ${ollamaUrl}: ${e.message}`);
    process.exit(1);
  }

  const results = [];
  const total = POLICIES.length * FIXTURES.length * RUNS_PER_CELL;
  let done = 0;

  for (const policy of POLICIES) {
    console.log(`[policy-bench] policy: ${policy.id}`);
    for (const fixture of FIXTURES) {
      for (let run = 0; run < RUNS_PER_CELL; run++) {
        const cell = await runCell(policy, fixture, run);
        results.push(cell);
        done++;
        const statusIcon = cell.usableOk ? '✓' : (cell.jsonParseOk ? '~' : '✗');
        const identStr = cell.identPreserv !== null ? ` ident=${fmtPct(cell.identPreserv)}` : '';
        const hallucStr = cell.techHalluc ? ' HALLUC' : '';
        console.log(
          `  [${done}/${total}] ${statusIcon} ${fixture.id} run${run} — ${fmtMs(cell.latencyMs)}` +
          ` tags=[${cell.tags.join(', ')}]${identStr}${hallucStr}`
        );
      }
    }
    console.log('');
  }

  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 16).replace(':', '');
  const report  = buildReport(results, `${dateStr}T${timeStr}`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `${dateStr}T${timeStr}-combined-llm-prompt-policy-matrix.md`);
  writeFileSync(outPath, report, 'utf8');
  console.log(`[policy-bench] Report: ${outPath}`);

  // Print aggregate table to stdout for quick review
  const agg = aggregateByPolicy(results);
  const { best } = pickBestPolicy(agg);
  console.log('\n[policy-bench] Summary:');
  console.log('  Policy                          | parse | usable | latency | ident | halluc | ctx');
  console.log('  --------------------------------|-------|--------|---------|-------|--------|----');
  for (const p of agg) {
    const mark = p.id === best?.id ? ' ★' : '  ';
    console.log(
      `  ${mark}${p.id.padEnd(32)}| ${fmtPct(p.parseRate).padEnd(6)}| ${fmtPct(p.usableRate).padEnd(7)}| ${fmtMs(p.meanLatency).padEnd(8)}| ${fmtPct(p.meanIdent).padEnd(6)}| ${fmtPct(p.hallucRate).padEnd(7)}| ${fmtNum(p.meanCtxScore, 2)}`
    );
  }
  console.log(`\n  Best: ${best?.id ?? 'none'}`);
}

main().catch(err => {
  console.error('[policy-bench] fatal:', err.message);
  if (err.cause) console.error('[policy-bench] cause:', err.cause?.message ?? err.cause);
  process.exit(1);
});
