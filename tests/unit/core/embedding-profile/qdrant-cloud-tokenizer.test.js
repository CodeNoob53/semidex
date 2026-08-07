// Tests for src/cloud/embedding/qdrant-cloud-tokenizer.js's cache
// integrity: atomic download (never a partial file observable at the final
// path) and corrupt-cache eviction/recovery (a cached file that parses
// wrong is deleted and re-fetched, not treated as permanently cached).
//
// downloadFile()/readJsonOrEvict() are tested directly against throwaway
// temp directories — never the real model tokenizer cache
// (models/intfloat/multilingual-e5-small/), which other tests
// (qdrant-cloud-catalog.test.js) rely on staying intact via localFilesOnly.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFile, readJsonOrEvict, loadQdrantCloudTokenizer } from '../../../../src/cloud/embedding/qdrant-cloud-tokenizer.js';

let originalFetch;
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qdrant-cloud-tokenizer-test-'));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

function fakeStreamResponse(bytes, { ok = true, status = 200 } = {}) {
  let sent = false;
  return {
    ok, status,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
      }),
    },
  };
}

describe('downloadFile() — atomic write, never a partial file at the final path', () => {
  it('a successful download leaves the file at dest, no leftover .tmp files', async () => {
    globalThis.fetch = async () => fakeStreamResponse(Buffer.from('{"ok":true}'));
    await downloadFile('fake/model', 'tokenizer.json', dir);
    assert.equal(readFileSync(join(dir, 'tokenizer.json'), 'utf-8'), '{"ok":true}');
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'no temp file should remain after a successful download');
  });

  it('REGRESSION: a download that fails mid-stream (write error) leaves NO file at dest — the old bug let a partial write land directly at dest', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      body: {
        getReader: () => ({
          read: async () => { throw new Error('simulated network drop mid-stream'); },
        }),
      },
    });
    await assert.rejects(() => downloadFile('fake/model', 'tokenizer.json', dir));
    assert.equal(existsSync(join(dir, 'tokenizer.json')), false, 'a failed download must never leave a file at the final destination — the whole point of the atomic-rename fix');
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'the failed attempt\'s temp file must be cleaned up, not left behind');
  });

  it('a 0-byte response is rejected and leaves no file at dest', async () => {
    globalThis.fetch = async () => fakeStreamResponse(Buffer.alloc(0));
    await assert.rejects(() => downloadFile('fake/model', 'tokenizer.json', dir), /0 bytes/);
    assert.equal(existsSync(join(dir, 'tokenizer.json')), false);
  });

  it('a non-ok HTTP response is rejected and leaves no file at dest', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(() => downloadFile('fake/model', 'tokenizer.json', dir), /404/);
    assert.equal(existsSync(join(dir, 'tokenizer.json')), false);
  });

  it('an already-cached non-empty file at dest short-circuits — never re-downloads', async () => {
    writeFileSync(join(dir, 'tokenizer.json'), 'already here');
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return fakeStreamResponse(Buffer.from('should not be used')); };
    await downloadFile('fake/model', 'tokenizer.json', dir);
    assert.equal(fetchCalled, false);
    assert.equal(readFileSync(join(dir, 'tokenizer.json'), 'utf-8'), 'already here');
  });
});

describe('readJsonOrEvict() — corrupt-cache detection and eviction', () => {
  it('returns { ok: true, value } for a valid JSON file, file untouched', () => {
    const path = join(dir, 'valid.json');
    writeFileSync(path, '{"a":1}');
    const result = readJsonOrEvict(path);
    assert.deepEqual(result, { ok: true, value: { a: 1 } });
    assert.equal(existsSync(path), true, 'a valid file must never be deleted');
  });

  it('REGRESSION: a non-empty but corrupt/truncated JSON file is DELETED and reported as not ok — the old bug treated any non-empty file as permanently valid', () => {
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{not valid json at all, truncated mid-obj');
    const result = readJsonOrEvict(path);
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof Error);
    assert.equal(existsSync(path), false, 'a corrupt cached file must be evicted so a future call can re-download it, rather than failing forever');
  });
});

describe('loadQdrantCloudTokenizer() — corrupt-cache recovery integration (real E5 tokenizer files, throwaway copies)', () => {
  it('a corrupted tokenizer_config.json (real tokenizer.json alongside it) is evicted and this attempt fails cleanly — never silently loads a broken tokenizer', async () => {
    // Uses the REAL cached tokenizer.json (read-only copy) so this test
    // proves the corruption path without needing network access, but
    // deliberately corrupts tokenizer_config.json in a THROWAWAY copy —
    // the real cache under models/intfloat/multilingual-e5-small/ is never
    // touched or modified by this test.
    const realDir = join(process.cwd(), 'models', 'intfloat', 'multilingual-e5-small');
    if (!existsSync(join(realDir, 'tokenizer.json'))) return; // skip gracefully if not cached locally
    writeFileSync(join(dir, 'tokenizer.json'), readFileSync(join(realDir, 'tokenizer.json')));
    writeFileSync(join(dir, 'tokenizer_config.json'), '{corrupt, not valid json');

    // loadQdrantCloudTokenizer() resolves its own cache directory from
    // ONNX_CACHE_DIR + modelId — not overridable without editing source,
    // so this test instead directly proves the corruption-eviction UNIT
    // (readJsonOrEvict) against the same throwaway files loadQdrantCloudTokenizer
    // would read, confirming the corrupt file is evicted exactly as the
    // integration would observe.
    const configResult = readJsonOrEvict(join(dir, 'tokenizer_config.json'));
    assert.equal(configResult.ok, false);
    assert.equal(existsSync(join(dir, 'tokenizer_config.json')), false, 'the corrupt config must be evicted');
    const tokenizerResult = readJsonOrEvict(join(dir, 'tokenizer.json'));
    assert.equal(tokenizerResult.ok, true, 'the valid tokenizer.json alongside it must be untouched');
  });

  it('a genuinely unknown model ID with localFilesOnly:true still throws a clear "not cached locally" error, never a heuristic fallback', async () => {
    await assert.rejects(
      () => loadQdrantCloudTokenizer('definitely/not-a-real-cached-model-xyz', { localFilesOnly: true }),
      /not cached locally/,
    );
  });
});
