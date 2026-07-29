// src/core/bench-telemetry.js — opt-in benchmark instrumentation, used by
// the production-path benchmark harness (benchmarks/external/production-path/)
// to observe real Qdrant SDK calls and real Cloud Inference descriptors a
// harness has no other way to see (spawned subprocess boundary).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitTelemetry } from '../../../src/core/bench-telemetry.js';

describe('emitTelemetry()', () => {
  it('is a no-op (no file written) when SEMIDEX_BENCH_TELEMETRY_PATH is unset', () => {
    delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
    // Must not throw even though no path is configured.
    assert.doesNotThrow(() => emitTelemetry({ kind: 'qdrant_sdk_op', label: 'test' }));
  });

  it('appends a complete JSONL line, reading the env var fresh on every call (not cached at import time)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-bench-telemetry-test-'));
    const path = join(dir, 'telemetry.jsonl');
    try {
      // The module was already imported above with the env var unset —
      // proves the path is read per-call, not captured at import time.
      process.env.SEMIDEX_BENCH_TELEMETRY_PATH = path;
      emitTelemetry({ kind: 'inference', phase: 'indexing', lane: 'dense', textLength: 42, model: 'intfloat/multilingual-e5-small' });
      assert.ok(existsSync(path));
      const lines = readFileSync(path, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]);
      assert.equal(event.kind, 'inference');
      assert.equal(event.phase, 'indexing');
      assert.equal(event.lane, 'dense');
      assert.equal(event.textLength, 42);
      assert.equal(event.model, 'intfloat/multilingual-e5-small');
      assert.equal(typeof event.ts, 'number');
    } finally {
      delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends multiple sequential calls as separate, individually-parseable JSONL lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-bench-telemetry-test-'));
    const path = join(dir, 'telemetry.jsonl');
    try {
      process.env.SEMIDEX_BENCH_TELEMETRY_PATH = path;
      emitTelemetry({ kind: 'qdrant_sdk_op', label: 'Qdrant upsert failed' });
      emitTelemetry({ kind: 'qdrant_sdk_op', label: 'Qdrant hybridSearch failed' });
      emitTelemetry({ kind: 'inference', phase: 'query', lane: 'sparse', textLength: 10, model: 'qdrant/bm25' });
      const lines = readFileSync(path, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 3);
      const parsed = lines.map((l) => JSON.parse(l));
      assert.equal(parsed[0].label, 'Qdrant upsert failed');
      assert.equal(parsed[1].label, 'Qdrant hybridSearch failed');
      assert.equal(parsed[2].lane, 'sparse');
    } finally {
      delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops writing once the env var is cleared again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-bench-telemetry-test-'));
    const path = join(dir, 'telemetry.jsonl');
    try {
      process.env.SEMIDEX_BENCH_TELEMETRY_PATH = path;
      emitTelemetry({ kind: 'qdrant_sdk_op', label: 'first' });
      delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
      emitTelemetry({ kind: 'qdrant_sdk_op', label: 'second-should-not-be-written' });
      const lines = readFileSync(path, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).label, 'first');
    } finally {
      delete process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
