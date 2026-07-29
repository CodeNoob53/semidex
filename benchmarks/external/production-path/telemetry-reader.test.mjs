// core/telemetry-reader.mjs — offline. Parses hand-built JSONL fixtures,
// never a real telemetry file from a real run.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeTelemetry, approxTokensFromChars } from './core/telemetry-reader.mjs';

let scratchDir;
afterEach(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = undefined;
});

function writeJsonl(lines) {
  scratchDir = mkdtempSync(join(tmpdir(), 'semidex-telemetry-reader-test-'));
  const path = join(scratchDir, 'telemetry.jsonl');
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf-8');
  return path;
}

describe('summarizeTelemetry()', () => {
  it('returns all-zero summary for a nonexistent file', () => {
    const result = summarizeTelemetry(join(mkdtempSync(join(tmpdir(), 'semidex-telemetry-reader-test-')), 'does-not-exist.jsonl'));
    assert.equal(result.qdrantSdkOps.total, 0);
    assert.equal(result.denseInferenceItems.total, 0);
  });

  it('counts qdrant_sdk_op events by label and total', () => {
    const path = writeJsonl([
      { kind: 'qdrant_sdk_op', label: 'Qdrant upsert failed', ok: true, ms: 5 },
      { kind: 'qdrant_sdk_op', label: 'Qdrant upsert failed', ok: true, ms: 5 },
      { kind: 'qdrant_sdk_op', label: 'Qdrant hybridSearch failed', ok: true, ms: 5 },
    ]);
    const result = summarizeTelemetry(path);
    assert.equal(result.qdrantSdkOps.total, 3);
    assert.equal(result.qdrantSdkOps.byLabel['Qdrant upsert failed'], 2);
    assert.equal(result.qdrantSdkOps.byLabel['Qdrant hybridSearch failed'], 1);
  });

  it('counts indexing-phase and query-phase inference items separately, and combined in .total', () => {
    const path = writeJsonl([
      { kind: 'inference', phase: 'indexing', lane: 'dense', textLength: 100, model: 'e5' },
      { kind: 'inference', phase: 'indexing', lane: 'sparse', textLength: 100, model: 'bm25' },
      { kind: 'inference', phase: 'query', lane: 'dense', textLength: 20, model: 'e5' },
      { kind: 'inference', phase: 'query', lane: 'dense', textLength: 30, model: 'e5' },
    ]);
    const result = summarizeTelemetry(path);
    assert.equal(result.denseInferenceItems.indexing, 1);
    assert.equal(result.denseInferenceItems.query, 2);
    assert.equal(result.denseInferenceItems.total, 3);
    assert.equal(result.sparseInferenceItems.indexing, 1);
    assert.equal(result.sparseInferenceItems.query, 0);
    assert.equal(result.totalDenseChars.indexing, 100);
    assert.equal(result.totalDenseChars.query, 50);
    assert.equal(result.totalDenseChars.total, 150);
  });

  it('N cloud queries produce exactly N dense and N sparse query-phase events (the round-4 regression requirement)', () => {
    const events = [];
    const N = 7;
    for (let i = 0; i < N; i++) {
      events.push({ kind: 'inference', phase: 'query', lane: 'dense', textLength: 10, model: 'e5' });
      events.push({ kind: 'inference', phase: 'query', lane: 'sparse', textLength: 10, model: 'bm25' });
    }
    const result = summarizeTelemetry(writeJsonl(events));
    assert.equal(result.denseInferenceItems.query, N);
    assert.equal(result.sparseInferenceItems.query, N);
  });

  it('tolerates a malformed line without crashing the whole summarize call, and counts it separately', () => {
    const path = writeJsonl([
      { kind: 'qdrant_sdk_op', label: 'a', ok: true, ms: 1 },
      'this is not valid JSON {{{',
      { kind: 'qdrant_sdk_op', label: 'b', ok: true, ms: 1 },
    ]);
    const result = summarizeTelemetry(path);
    assert.equal(result.qdrantSdkOps.total, 2);
    assert.equal(result.malformedLines, 1);
  });

  it('ignores blank lines without counting them as malformed', () => {
    const path = writeJsonl([{ kind: 'qdrant_sdk_op', label: 'a', ok: true, ms: 1 }, '', '   ', '']);
    const result = summarizeTelemetry(path);
    assert.equal(result.qdrantSdkOps.total, 1);
    assert.equal(result.malformedLines, 0);
  });

  it('ignores unknown event kinds (forward-compatible) without counting them as malformed', () => {
    const path = writeJsonl([{ kind: 'some_future_event_type', foo: 'bar' }]);
    const result = summarizeTelemetry(path);
    assert.equal(result.malformedLines, 0);
    assert.equal(result.qdrantSdkOps.total, 0);
  });
});

describe('approxTokensFromChars()', () => {
  it('applies the char/4 heuristic, rounding up', () => {
    assert.equal(approxTokensFromChars(400), 100);
    assert.equal(approxTokensFromChars(401), 101);
    assert.equal(approxTokensFromChars(0), 0);
  });
});
