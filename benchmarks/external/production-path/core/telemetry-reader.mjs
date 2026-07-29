// Parses the opt-in benchmark telemetry JSONL file that both the spawned
// indexer subprocess (indexing-side events) and the harness's own
// in-process runHybridSearch() calls (query-side events) write into —
// see src/core/bench-telemetry.js. Produces EXACT counts, never
// estimates, for every event kind this harness's own production-code
// changes actually emit.
import { existsSync, readFileSync } from 'node:fs';

function emptyLaneSummary() {
  return { indexing: 0, query: 0, total: 0 };
}

/**
 * @param {string} jsonlPath
 * @returns {{
 *   qdrantSdkOps: { byLabel: Object<string,number>, total: number },
 *   denseInferenceItems: {indexing:number, query:number, total:number},
 *   sparseInferenceItems: {indexing:number, query:number, total:number},
 *   totalDenseChars: {indexing:number, query:number, total:number},
 *   totalSparseChars: {indexing:number, query:number, total:number},
 *   malformedLines: number,
 * }}
 */
export function summarizeTelemetry(jsonlPath) {
  const result = {
    qdrantSdkOps: { byLabel: {}, total: 0 },
    denseInferenceItems: emptyLaneSummary(),
    sparseInferenceItems: emptyLaneSummary(),
    totalDenseChars: emptyLaneSummary(),
    totalSparseChars: emptyLaneSummary(),
    malformedLines: 0,
  };

  if (!existsSync(jsonlPath)) return result;

  const lines = readFileSync(jsonlPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      result.malformedLines += 1;
      continue;
    }
    if (event.kind === 'qdrant_sdk_op') {
      result.qdrantSdkOps.total += 1;
      result.qdrantSdkOps.byLabel[event.label] = (result.qdrantSdkOps.byLabel[event.label] ?? 0) + 1;
    } else if (event.kind === 'inference') {
      const phase = event.phase === 'query' ? 'query' : 'indexing';
      if (event.lane === 'dense') {
        result.denseInferenceItems[phase] += 1;
        result.denseInferenceItems.total += 1;
        result.totalDenseChars[phase] += event.textLength ?? 0;
        result.totalDenseChars.total += event.textLength ?? 0;
      } else if (event.lane === 'sparse') {
        result.sparseInferenceItems[phase] += 1;
        result.sparseInferenceItems.total += 1;
        result.totalSparseChars[phase] += event.textLength ?? 0;
        result.totalSparseChars.total += event.textLength ?? 0;
      }
    }
    // Unknown event kinds are silently ignored (forward-compatible), never
    // counted as malformed — only a JSON parse failure counts as malformed.
  }

  return result;
}

/** approxTokens is the ONE genuinely-approximate derived figure here — the
 * char/4 heuristic, matching the existing TOKEN_COUNT=heuristic convention
 * used elsewhere in this exact recipe. Everything else summarizeTelemetry()
 * returns is an exact, observed count. */
export function approxTokensFromChars(totalChars) {
  return Math.ceil(totalChars / 4);
}
