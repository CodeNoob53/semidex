// serve-lite.js — starts a real createLiteApp() HTTP server. These tests
// bind to an ephemeral port and hit it with real fetch() calls (no network
// egress — 127.0.0.1 only), proving the whole composition root actually
// works end-to-end, not just that its pieces type-check. Uses a temp
// settings.json so a test run never touches the real dev settings.json
// (see tests/unit/admin/lite-app.test.js's own header comment for why this
// matters — a prior version of a similar test polluted the real file).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
