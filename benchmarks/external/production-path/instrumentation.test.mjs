// core/instrumentation.mjs — offline, no network. sampleChildRss/
// startRssSampler are exercised against THIS test process's own real PID
// (process.pid) — a real, harmless, always-valid target — to prove the
// platform-branched sampling never throws and degrades to null rather
// than crashing, without needing a mocked child_process.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sampleChildRss, startRssSampler, percentile, makeRequestCounter } from './core/instrumentation.mjs';

describe('sampleChildRss()', () => {
  it('never throws for a real, valid PID — resolves a positive byte count or null', async () => {
    const sample = await sampleChildRss(process.pid);
    assert.ok(sample === null || (typeof sample === 'number' && sample > 0));
  });

  it('degrades to null (never throws) for an implausible PID', async () => {
    const sample = await sampleChildRss(999999999);
    assert.ok(sample === null || typeof sample === 'number');
  });
});

describe('startRssSampler()', () => {
  it('stop() resolves without throwing, even if called almost immediately', async () => {
    const sampler = startRssSampler(process.pid, 50);
    const peak = await sampler.stop();
    assert.ok(peak === null || (typeof peak === 'number' && peak > 0));
  });
});

describe('percentile()', () => {
  it('returns null for an empty array', () => {
    assert.equal(percentile([], 50), null);
  });

  it('p50/p95 over a simple ascending array use nearest-rank, never interpolated', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(percentile(values, 50), 50);
    assert.equal(percentile(values, 95), 100);
  });

  it('a single-element array returns that element for any percentile', () => {
    assert.equal(percentile([42], 1), 42);
    assert.equal(percentile([42], 99), 42);
  });
});

describe('makeRequestCounter()', () => {
  it('starts at zero and increments independently for spawns vs queries', () => {
    const counter = makeRequestCounter();
    assert.equal(counter.indexerSpawns, 0);
    assert.equal(counter.queryCalls, 0);
    counter.recordIndexerSpawn();
    counter.recordIndexerSpawn();
    counter.recordQueryCall();
    assert.equal(counter.indexerSpawns, 2);
    assert.equal(counter.queryCalls, 1);
  });
});
