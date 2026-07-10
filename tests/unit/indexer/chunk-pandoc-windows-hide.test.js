// Source-level regression guard for src/indexer/phases/chunk.js's pandoc
// execFile call (Phase 3J console-flash audit) — no execFile stub/DI exists
// for this module today, so this pins the actual options object passed to
// execFileAsync rather than exercising a real pandoc invocation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../../../src/indexer/phases/chunk.js', import.meta.url)),
  'utf-8',
);

describe('pandoc execFile call sets windowsHide: true (Phase 3J console-flash audit)', () => {
  it('the execFileAsync("pandoc", ...) call includes windowsHide: true in its options', () => {
    // Regression: this runs once per .docx/.odt/.rtf/.epub/.html/.htm file
    // in an indexing job, inside the already-windowsHide'd indexer child
    // process (src/admin/jobs/registry.js) — a child spawned from a hidden
    // parent still gets its own console window on Windows unless it's also
    // told to hide it. Without this, indexing a folder with several such
    // files flashed one console window per file.
    const start = src.indexOf("execFileAsync('pandoc'");
    assert.ok(start > -1, 'the pandoc execFileAsync call must exist');
    const end = src.indexOf(');', start);
    const call = src.slice(start, end);
    assert.match(call, /windowsHide:\s*true/, 'the pandoc execFile call must set windowsHide: true');
  });
});
