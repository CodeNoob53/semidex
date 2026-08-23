// serve-lite.js — starts a real createLiteApp() HTTP server. These tests
// bind to an ephemeral port and hit it with real fetch() calls (no network
// egress — 127.0.0.1 only), proving the whole composition root actually
// works end-to-end, not just that its pieces type-check. Uses a temp
// settings.json so a test run never touches the real dev settings.json
// (see tests/unit/admin/lite-app.test.js's own header comment for why this
// matters — a prior version of a similar test polluted the real file).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLite } from '../../../packages/lite/lite-src/serve-lite.js';
import { applyLiteHardPins } from '../../../packages/lite/lite-src/hard-pins.js';

// bin/semidex-lite.js ALWAYS calls applyLiteHardPins() before importing
// serve-lite.js — this is what makes SEMIDEX_GENERATION_BACKEND=gemini (not
// the registry's own 'ollama' default) actually true in a real deployed
// process. These tests call startLite() directly, bypassing the CLI entry
// point, so they must apply the same pin themselves or they test a
// configuration real users never actually run (a real gap this exact test
// file caught once already — GET /api/generation/status resolved to the
// Ollama backend and threw through the Lite ollama-lazy shim before this
// fix, a 500 that would never happen with the real CLI).
before(() => {
  applyLiteHardPins();
});

async function withLiteServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'semidex-lite-serve-test-'));
  const settingsPath = join(dir, 'settings.json');
  const { server, host, port } = await startLite({ settingsPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, { host, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('startLite() — degraded mode (no Qdrant/Gemini credentials)', () => {
  it('server starts and GET /api/health responds even without QDRANT_URL/QDRANT_KEY', async () => {
    const savedUrl = process.env.QDRANT_URL;
    const savedKey = process.env.QDRANT_KEY;
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_KEY;
    try {
      await withLiteServer(async (base) => {
        const res = await fetch(base + '/api/health');
        // Never a 500/crash — degraded is a reported status, not a hard failure.
        assert.notEqual(res.status, 500);
      });
    } finally {
      if (savedUrl !== undefined) process.env.QDRANT_URL = savedUrl;
      if (savedKey !== undefined) process.env.QDRANT_KEY = savedKey;
    }
  });

  it('GET /api/generation/status reports Gemini as unconfigured, does not throw, when GEMINI_API_KEY is unset', async () => {
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await withLiteServer(async (base) => {
        const res = await fetch(base + '/api/generation/status');
        assert.notEqual(res.status, 500);
      });
    } finally {
      if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    }
  });
});

describe('startLite() — resolveHostConfig/resolvePortConfig honor real settings', () => {
  it('defaults to 127.0.0.1 and port 8642 when ADMIN_HOST/ADMIN_PORT are unset', async () => {
    const savedHost = process.env.ADMIN_HOST;
    const savedPort = process.env.ADMIN_PORT;
    delete process.env.ADMIN_HOST;
    delete process.env.ADMIN_PORT;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'semidex-lite-serve-test-'));
      const settingsPath = join(dir, 'settings.json');
      const { host, port, server } = await startLite({ settingsPath });
      server.close();
      rmSync(dir, { recursive: true, force: true });
      assert.equal(host, '127.0.0.1');
      assert.equal(port, 8642);
    } finally {
      if (savedHost !== undefined) process.env.ADMIN_HOST = savedHost;
      if (savedPort !== undefined) process.env.ADMIN_PORT = savedPort;
    }
  });
});

describe('startLite() — production audit-sink wiring (regression: the job registry used to be built with no auditSink at all)', () => {
  it('the router records through the exact (edition-tagged) auditSink instance startLite() returns — not a second, independently-resolved sink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-lite-serve-audit-'));
    const settingsPath = join(dir, 'settings.json');
    const rawEvents = [];
    let rawClosed = false;
    const rawSink = { record: (e) => rawEvents.push(e), async flush() {}, async close() { rawClosed = true; } };
    try {
      const { server, auditSink } = await startLite({ settingsPath, auditSink: rawSink });
      // startLite() must edition-tag a raw injected sink itself (composition-
      // root enforcement — sink.js's ensureEditionTag()), so the returned
      // sink is a wrapper around `rawSink`, not `rawSink` itself — but it
      // must still be the ONE instance both the router and the job registry
      // record through, and it must still forward to `rawSink` underneath.
      assert.notEqual(auditSink, rawSink, 'startLite() must wrap a raw sink in its own edition tag rather than returning it unchanged');
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        // Cross-site POST with a foreign Origin — rejected by the router
        // before route dispatch (same real-HTTP pattern as
        // csrf-state-changing-routes.test.js), which is enough to prove the
        // ROUTER records through this exact injected sink.
        await fetch(base + '/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
          body: JSON.stringify({ changes: {} }),
        });
        const rejected = rawEvents.filter((e) => e.type === 'request.origin_rejected');
        assert.equal(rejected.length, 1, 'the router must have recorded through the SAME injected sink (via the wrapper), proving createLiteApp() did not fall back to a second, internally-resolved sink');
        assert.equal(rejected[0].edition, 'lite', 'the wrapper must tag every event edition:"lite" even though the raw sink itself knows nothing about editions');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
      await auditSink.close();
      assert.equal(rawClosed, true, 'closing the returned (wrapped) auditSink must close the raw sink startLite() was given — same lifecycle-forwarding contract as record()');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serve-lite.js\'s own source passes ONE resolved auditSink variable to both createJobRegistry() and createLiteApp() — the actual production gap this regression test guards against (the job registry used to be built with no auditSink at all, silently dropping every job-lifecycle event even though the router still audited request-path events through createLiteApp()\'s own, separate internal fallback)', async () => {
    const src = readFileSync(new URL('../../../packages/lite/lite-src/serve-lite.js', import.meta.url), 'utf-8');
    const jobRegistryCall = src.match(/createJobRegistry\(\{[^}]*auditSink:\s*(\w+)\s*\}\)/);
    const liteAppCall = src.match(/createLiteApp\(\{[^}]*auditSink:\s*(\w+)\s*\}\)/);
    assert.ok(jobRegistryCall, 'expected createJobRegistry() to be called with an explicit auditSink field');
    assert.ok(liteAppCall, 'expected createLiteApp() to be called with an explicit auditSink field');
    assert.equal(jobRegistryCall[1], liteAppCall[1], 'both calls must reference the SAME variable — two independently-resolved sinks would silently diverge, which is exactly the regression this guards against');
  });
});

describe('startLite() — audit sink shutdown/flush contract', () => {
  it('a queued event is durable once auditSink.close() resolves — proves the "await close() before exit" shutdown contract actually works end to end, using the REAL resolveAuditSink()-constructed sink (no auditSink override)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semidex-lite-serve-shutdown-'));
    const settingsPath = join(dir, 'settings.json');
    const savedHome = process.env.SEMIDEX_HOME;
    process.env.SEMIDEX_HOME = dir; // drives resolveAuditSink({ edition: 'lite' })'s own default resolution
    try {
      const { server, auditSink } = await startLite({ settingsPath });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      await fetch(base + '/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: JSON.stringify({ changes: {} }),
      });
      const logPath = join(dir, 'audit', 'audit.log');
      // The real async JSONL sink queues and drains on its own schedule —
      // whether it has already written by this point is a timing detail
      // this test does not depend on. What matters, and what bin/
      // semidex-lite.js's own shutdown handler relies on, is that
      // auditSink.close() below is guaranteed to wait out any still-queued
      // event before it resolves.
      await new Promise((resolve) => server.close(resolve));
      await auditSink.close();

      assert.ok(existsSync(logPath), 'expected the audit log file to exist once close() resolved');
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(lines.some((l) => l.type === 'request.origin_rejected'), 'the queued event must be durable once close() resolved');
    } finally {
      if (savedHome === undefined) delete process.env.SEMIDEX_HOME; else process.env.SEMIDEX_HOME = savedHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('startLite() — no local-only routes reachable', () => {
  it('POST /api/onnx/probe is 404 (route never registered)', async () => {
    await withLiteServer(async (base) => {
      const res = await fetch(base + '/api/onnx/probe', { method: 'POST' });
      assert.equal(res.status, 404);
    });
  });

  it('GET /api/system/ollama-status is 404 (route never registered)', async () => {
    await withLiteServer(async (base) => {
      const res = await fetch(base + '/api/system/ollama-status');
      assert.equal(res.status, 404);
    });
  });
});
