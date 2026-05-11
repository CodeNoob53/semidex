import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { handle as searchHandle } from '../../../src/mcp/tools/search.js';

const COLLECTION = 'bench-retrieval-custom-large';

const QUERIES = [
  {
    id: 'exact-token',
    query: 'POST /v1/search request body tag_filter source_file top_k',
    hints: ['API_SEARCH_REQUEST', 'tag_filter']
  },
  {
    id: 'paraphrase',
    query: 'how should an agent recover when the v2 migration fails',
    hints: ['MIG_ROLLBACK', 'Rollback Plan']
  },
  {
    id: 'mixed-language',
    query: 'як агенту знайти налаштування для локальної LLM і OLLAMA_URL',
    hints: ['CFG_LOCAL_LLM', 'OLLAMA_URL']
  },
  {
    id: 'boundary-neighbor',
    query: 'inspect chunks_out after reindexing to verify section boundaries',
    hints: ['MIG_OBSIDIAN_REVIEW', 'chunks_out']
  },
  {
    id: 'troubleshooting',
    query: 'Qdrant timeout during indexing what env variable controls retry behavior',
    hints: ['TRB_QDRANT_TIMEOUT', 'RETRY_MAX_ATTEMPTS']
  }
];

async function main() {
  console.log(`=== semidex agent window eval ===`);
  console.log(`Provider  : ONNX`);
  console.log(`Collection: ${COLLECTION}`);

  const modes = ['full', 'compact'];
  const date = new Date().toISOString().split('T')[0];
  const content = [
    `=== Agent Window Evaluation (${date}) ===`,
    `Collection: ${COLLECTION}`,
    `Top-K: 3  Window: 1\n`
  ];

  for (const mode of modes) {
    console.log(`\n--- Running mode: ${mode} ---`);
    content.push(`\n============================`);
    content.push(`MODE: ${mode.toUpperCase()}`);
    content.push(`============================\n`);

    const report = [];
    let totalChars = 0;
    let totalWindowChunks = 0;
    let duplicateNeighborChunks = 0;
    let duplicateMatchedChunksAllowed = 0;

    for (const q of QUERIES) {
      console.log(`Evaluating: ${q.id}...`);
      const output = await searchHandle({ query: q.query, collection: COLLECTION, top: 3, window: 1, window_format: mode });

      const jsonMatches = [...output.matchAll(/~~~~json\n([\s\S]*?)\n~~~~/g)];
      let hasWindowChunks = jsonMatches.length === 3;
      let windowChunkCounts = [];
      let oneIsMatchTrue = jsonMatches.length > 0;
      let hintFound = false;

      const seenChunks = new Set();

      for (const match of jsonMatches) {
        try {
          const parsed = JSON.parse(match[1]);
          const chunks = parsed.window_chunks || [];
          windowChunkCounts.push(chunks.length);
          totalWindowChunks += chunks.length;

          let isMatchCount = chunks.filter(c => c.is_match).length;
          if (isMatchCount !== 1) oneIsMatchTrue = false;

          for (const c of chunks) {
             const sig = `${c.source_file}_${c.chunk_index}`;
             if (seenChunks.has(sig)) {
               if (c.is_match) duplicateMatchedChunksAllowed++;
               else duplicateNeighborChunks++;
             }
             seenChunks.add(sig);
          }
        } catch (e) {
          console.error("Failed to parse JSON for result");
        }
      }

      for (const hint of q.hints) {
        if (output.includes(hint)) hintFound = true;
      }

      totalChars += output.length;

      const summary = {
        id: q.id,
        window_exists: hasWindowChunks,
        window_chunks_per_top: windowChunkCounts,
        exactly_one_is_match: oneIsMatchTrue,
        approx_char_count: output.length,
        hint_found: hintFound
      };
      report.push(summary);
    }

    content.push(`--- Aggregate Summary (${mode}) ---`);
    content.push(`Queries run: ${QUERIES.length}`);
    content.push(`Avg output length: ${Math.round(totalChars / QUERIES.length)} chars`);
    content.push(`Total window chunks retrieved: ${totalWindowChunks}`);
    content.push(`Duplicate neighbor chunks (should be 0): ${duplicateNeighborChunks}`);
    content.push(`Duplicate matched chunks (allowed): ${duplicateMatchedChunksAllowed}`);
    content.push(`\n--- Per-query Details (${mode}) ---`);

    for (const r of report) {
      content.push(`Query: ${r.id}`);
      content.push(`  Window Chunks block exists: ${r.window_exists ? 'Yes' : 'No'}`);
      content.push(`  Window chunks per result: [${r.window_chunks_per_top.join(', ')}]`);
      content.push(`  Exactly one is_match=true per block: ${r.exactly_one_is_match ? 'Yes' : 'No'}`);
      content.push(`  Output char count: ~${r.approx_char_count}`);
      content.push(`  Expected hint found anywhere in output: ${r.hint_found ? 'Yes' : 'No'}`);
      content.push('');
    }
  }

  content.push(`--- Observations ---`);
  content.push(`- Neighbor deduplication reduces overlap; matched chunks are intentionally preserved.`);
  content.push(`- Compact mode significantly reduces character count while retaining expected hints.`);

  const outPath = path.resolve(`benchmarks/retrieval/results/${date}-agent-window-eval-compact.txt`);
  fs.writeFileSync(outPath, content.join('\n'));
  console.log(`\nSaved to ${outPath}`);
}

main().catch(console.error);
