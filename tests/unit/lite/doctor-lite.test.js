// doctor-lite.js — read-only Lite doctor. checkQdrantReachableFn/
// probeQdrantCloudInferenceFn are injected stubs, so these tests never
// issue a real Qdrant Cloud request. The core contract under test: doctor
// runs Tier 1 by default and NEVER calls the Tier 2 (mutating) probe unless
// probeInference: true is explicitly passed — this is the actual
// read-only-by-default guarantee, not just documentation.
//
// Tier 1's real success status is 'ok' (core/qdrant/store.js's
// checkQdrantReachable()); Tier 2's real success status is
// 'inference_available' (core/qdrant/store.js's probeInference()) — these
// are DIFFERENT strings, not a shared 'ok' convention. A live vertical
// slice against real Qdrant Cloud caught doctor-lite.js itself checking
// `result.status === 'ok'` for Tier 2 (always false against the real API,
// silently reporting FAIL for a genuinely successful probe) — the original
// version of these stubs matched that same wrong assumption, so this
// exact class of bug is invisible to DI-stub tests alone; use `npm run
// admin:build:lite` region's real-build tests or an actual live run to
// catch a stub/implementation shared-wrong-assumption bug like this one.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../../../packages/lite/lite-src/doctor-lite.js';

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  process.env = savedEnv;
});

function captureConsole() {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return { lines, restore: () => { console.log = orig; } };
}

describe('runDoctor() — read-only by default', () => {
  it('never calls probeQdrantCloudInferenceFn when probeInference is omitted', async () => {
    process.env.QDRANT_URL = 'https://cluster.example.com';
    process.env.QDRANT_KEY = 'test-key';
    let probeCalled = false;
    const cap = captureConsole();
    try {
      await runDoctor({
        checkQdrantReachableFn: async () => ({ status: 'ok' }),
        probeQdrantCloudInferenceFn: async () => { probeCalled = true; return { status: 'inference_available' }; },
      });
    } finally {
      cap.restore();
    }
    assert.equal(probeCalled, false);
  });

  it('calls checkQdrantReachableFn (Tier 1) but never probeQdrantCloudInferenceFn (Tier 2) by default', async () => {
    process.env.QDRANT_URL = 'https://cluster.example.com';
    process.env.QDRANT_KEY = 'test-key';
    let tier1Called = false;
    const cap = captureConsole();
    try {
      await runDoctor({
        checkQdrantReachableFn: async () => { tier1Called = true; return { status: 'ok' }; },
        probeQdrantCloudInferenceFn: async () => { throw new Error('must never be called'); },
      });
    } finally {
      cap.restore();
    }
    assert.equal(tier1Called, true);
  });
});

describe('runDoctor() — --probe-inference gating', () => {
  it('calls probeQdrantCloudInferenceFn only when probeInference: true AND a supported dense model is configured', async () => {
    process.env.QDRANT_URL = 'https://cluster.example.com';
    process.env.QDRANT_KEY = 'test-key';
    process.env.QDRANT_CLOUD_DENSE_MODEL = 'intfloat/multilingual-e5-small';
    let probeCalled = false;
    const cap = captureConsole();
    let exitCode;
    try {
      exitCode = await runDoctor({
        probeInference: true,
        checkQdrantReachableFn: async () => ({ status: 'ok' }),
        probeQdrantCloudInferenceFn: async () => { probeCalled = true; return { status: 'inference_available' }; },
      });
    } finally {
      cap.restore();
    }
    assert.equal(probeCalled, true);
    assert.equal(exitCode, 0);
  });

  it('uses the supported catalog default when QDRANT_CLOUD_DENSE_MODEL is unset', async () => {
    process.env.QDRANT_URL = 'https://cluster.example.com';
    process.env.QDRANT_KEY = 'test-key';
    delete process.env.QDRANT_CLOUD_DENSE_MODEL;
    let receivedProfile;
    const cap = captureConsole();
    let exitCode;
    try {
      exitCode = await runDoctor({
        probeInference: true,
        checkQdrantReachableFn: async () => ({ status: 'ok' }),
        probeQdrantCloudInferenceFn: async ({ profile }) => {
          receivedProfile = profile;
          return { status: 'inference_available' };
        },
      });
    } finally {
      cap.restore();
    }
    assert.equal(receivedProfile?.embedding?.dense?.model, 'intfloat/multilingual-e5-small');
    assert.equal(exitCode, 0);
  });

  it('skips the probe (FAIL) when an explicitly configured dense model is unsupported', async () => {
    process.env.QDRANT_URL = 'https://cluster.example.com';
    process.env.QDRANT_KEY = 'test-key';
    process.env.QDRANT_CLOUD_DENSE_MODEL = 'unknown/model';
    let probeCalled = false;
    const cap = captureConsole();
    let exitCode;
    try {
      exitCode = await runDoctor({
        probeInference: true,
        checkQdrantReachableFn: async () => ({ status: 'ok' }),
        probeQdrantCloudInferenceFn: async () => { probeCalled = true; return { status: 'inference_available' }; },
      });
    } finally {
      cap.restore();
    }
    assert.equal(probeCalled, false);
    assert.equal(exitCode, 1);
    assert.match(cap.lines.join('\n'), /unknown\/model/);
  });
});

describe('runDoctor() — missing config', () => {
  it('reports FAIL and exit code 1 when QDRANT_URL/QDRANT_KEY are unset', async () => {
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_KEY;
    const cap = captureConsole();
    let exitCode;
    try {
      exitCode = await runDoctor({
        checkQdrantReachableFn: async () => { throw new Error('must not be called without credentials'); },
      });
    } finally {
      cap.restore();
    }
    assert.equal(exitCode, 1);
  });

  it('never throws, never crashes, even with every var unset', async () => {
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_KEY;
    delete process.env.GEMINI_API_KEY;
    const cap = captureConsole();
    try {
      await assert.doesNotReject(() => runDoctor({}));
    } finally {
      cap.restore();
    }
  });
});

describe('runDoctor() — secret redaction', () => {
  it('redacts QDRANT_KEY and GEMINI_API_KEY from a failure message', async () => {
    process.env.QDRANT_URL = 'https://cluster.example.com';
    process.env.QDRANT_KEY = 'super-secret-qdrant-key';
    process.env.GEMINI_API_KEY = 'super-secret-gemini-key';
    const cap = captureConsole();
    try {
      await runDoctor({
        checkQdrantReachableFn: async () => ({ status: 'unreachable', message: 'failed: super-secret-qdrant-key and super-secret-gemini-key both leaked' }),
      });
    } finally {
      cap.restore();
    }
    const output = cap.lines.join('\n');
    assert.ok(!output.includes('super-secret-qdrant-key'));
    assert.ok(!output.includes('super-secret-gemini-key'));
  });
});
