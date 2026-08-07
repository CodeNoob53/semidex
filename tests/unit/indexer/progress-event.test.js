// Tests for the shared [semidex:progress] line format (src/indexer/
// progress-event.js), used by both the indexer (emits) and the admin job
// registry (parses).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROGRESS_EVENT_PREFIX, parseProgressLine,
  FILE_PROGRESS_WEIGHTS, FILE_PROGRESS_STEP_LABELS, createFileProgressReporter,
} from '../../../src/shared/indexer/progress-event.js';

describe('parseProgressLine', () => {
  it('parses a well-formed progress line', () => {
    const line = PROGRESS_EVENT_PREFIX + JSON.stringify({ processedFiles: 3, totalFiles: 10, currentFile: 'a.md' });
    assert.deepEqual(parseProgressLine(line), { processedFiles: 3, totalFiles: 10, currentFile: 'a.md' });
  });

  it('accepts the phase-aware fields (currentStep, currentFileProgress) alongside the original ones', () => {
    const line = PROGRESS_EVENT_PREFIX + JSON.stringify({
      processedFiles: 1, totalFiles: 4, currentFile: 'b.md',
      currentStep: 'Generating summaries', currentFileProgress: 0.45,
    });
    assert.deepEqual(parseProgressLine(line), {
      processedFiles: 1, totalFiles: 4, currentFile: 'b.md',
      currentStep: 'Generating summaries', currentFileProgress: 0.45,
    });
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

describe('FILE_PROGRESS_WEIGHTS / FILE_PROGRESS_STEP_LABELS', () => {
  it('weights are monotonically increasing from preparing to done, ending at 1.0', () => {
    const order = ['preparing', 'chunking', 'summarizing', 'tagging', 'embedding', 'writing', 'done'];
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        FILE_PROGRESS_WEIGHTS[order[i]] > FILE_PROGRESS_WEIGHTS[order[i - 1]],
        `${order[i]} (${FILE_PROGRESS_WEIGHTS[order[i]]}) must be greater than ${order[i - 1]} (${FILE_PROGRESS_WEIGHTS[order[i - 1]]})`,
      );
    }
    assert.equal(FILE_PROGRESS_WEIGHTS.done, 1.0);
  });

  it('every weight key has a matching human-readable label', () => {
    for (const key of Object.keys(FILE_PROGRESS_WEIGHTS)) {
      assert.equal(typeof FILE_PROGRESS_STEP_LABELS[key], 'string');
      assert.ok(FILE_PROGRESS_STEP_LABELS[key].length > 0);
    }
  });

  it('labels avoid internal/technical phase names', () => {
    const technical = /stage[a-d]\b|upsertPoints|ollamaSem|embedSem/i;
    for (const label of Object.values(FILE_PROGRESS_STEP_LABELS)) {
      assert.ok(!technical.test(label), `label "${label}" looks like an internal name, not a user-facing one`);
    }
  });
});

describe('createFileProgressReporter', () => {
  it('step() emits processedFiles/totalFiles/currentFile plus the step label and weight', () => {
    const emitted = [];
    const reporter = createFileProgressReporter({
      emit: (payload) => emitted.push(payload), fileIndex: 1, totalFiles: 4, currentFile: 'b.md',
    });
    reporter.step('summarizing');
    assert.deepEqual(emitted, [{
      processedFiles: 1, totalFiles: 4, currentFile: 'b.md',
      currentStep: 'Generating summaries', currentFileProgress: 0.45,
    }]);
  });

  it('step() accepts a label override for wording that differs from the default (e.g. deterministic context)', () => {
    const emitted = [];
    const reporter = createFileProgressReporter({
      emit: (payload) => emitted.push(payload), fileIndex: 0, totalFiles: 1, currentFile: 'a.md',
    });
    reporter.step('summarizing', 'Building navigation context');
    assert.equal(emitted[0].currentStep, 'Building navigation context');
    assert.equal(emitted[0].currentFileProgress, FILE_PROGRESS_WEIGHTS.summarizing, 'weight still comes from the step key, only the label is overridden');
  });

  it('emits at least one phase event and a final done event for a typical file', () => {
    const emitted = [];
    const reporter = createFileProgressReporter({
      emit: (payload) => emitted.push(payload), fileIndex: 0, totalFiles: 3, currentFile: 'a.md',
    });
    reporter.step('preparing');
    reporter.step('chunking');
    reporter.step('embedding');
    reporter.step('writing');
    reporter.done();

    assert.ok(emitted.length >= 2, 'at least one phase event plus a done event');
    const last = emitted.at(-1);
    assert.deepEqual(last, {
      processedFiles: 1, totalFiles: 3, currentFile: null, currentStep: null, currentFileProgress: 0,
    });
  });

  it('done() advances processedFiles to fileIndex + 1 and clears currentFile/currentStep', () => {
    const emitted = [];
    const reporter = createFileProgressReporter({
      emit: (payload) => emitted.push(payload), fileIndex: 2, totalFiles: 5, currentFile: 'c.md',
    });
    reporter.done();
    assert.deepEqual(emitted, [{
      processedFiles: 3, totalFiles: 5, currentFile: null, currentStep: null, currentFileProgress: 0,
    }]);
  });
});
