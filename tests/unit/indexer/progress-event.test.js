// Tests for the shared [semidex:progress] line format (src/indexer/
// progress-event.js), used by both the indexer (emits) and the admin job
// registry (parses).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRESS_EVENT_PREFIX, parseProgressLine } from '../../../src/indexer/progress-event.js';

describe('parseProgressLine', () => {
  it('parses a well-formed progress line', () => {
    const line = PROGRESS_EVENT_PREFIX + JSON.stringify({ processedFiles: 3, totalFiles: 10, currentFile: 'a.md' });
    assert.deepEqual(parseProgressLine(line), { processedFiles: 3, totalFiles: 10, currentFile: 'a.md' });
  });

  it('preserves Unicode currentFile paths exactly', () => {
    const currentFile = 'Тема 13. Контроль відповідності вимогам (Compliance-by-Design)/1. Вступ.md';
    const line = PROGRESS_EVENT_PREFIX + JSON.stringify({ processedFiles: 0, totalFiles: 4, currentFile });
    const parsed = parseProgressLine(line);
    assert.equal(parsed.currentFile, currentFile);
  });

  it('returns null for a line without the progress prefix', () => {
    assert.equal(parseProgressLine('some ordinary log line'), null);
    assert.equal(parseProgressLine('{"processedFiles":1,"totalFiles":2}'), null);
  });

  it('returns null (never throws) for invalid JSON after the prefix', () => {
    assert.equal(parseProgressLine(PROGRESS_EVENT_PREFIX + '{not valid json'), null);
    assert.equal(parseProgressLine(PROGRESS_EVENT_PREFIX + ''), null);
    assert.equal(parseProgressLine(PROGRESS_EVENT_PREFIX + 'null'), null);
    assert.equal(parseProgressLine(PROGRESS_EVENT_PREFIX + '42'), null);
    assert.equal(parseProgressLine(PROGRESS_EVENT_PREFIX + '"just a string"'), null);
    assert.equal(parseProgressLine(PROGRESS_EVENT_PREFIX + '[1,2,3]'), null);
  });

  it('does not throw on empty or oddly-typed input', () => {
    assert.equal(parseProgressLine(''), null);
  });
});
