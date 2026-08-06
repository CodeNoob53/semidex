// indexer/phases/tag-onnx-lazy.js — the lazy loader run.js now imports
// instead of tag-onnx.js directly. Proves the actual isolation guarantee
// Semidex Lite depends on: merely importing tag-onnx-lazy.js (which run.js
// always does, unconditionally) never loads tag-onnx.js (and therefore
// never touches its fork()/WORKER_PATH machinery, which targets
// local/indexer/workers/tag-onnx-worker.js — a file that imports
// @huggingface/transformers). This is what makes local/indexer/phases/
// tag-onnx.js/local/indexer/workers/tag-onnx-worker.js (Phase 8B Step 4 —
// physically relocated from indexer/phases/ and indexer/workers/)
// excludable from the Lite package with zero static importers among kept
// files (Refactor 1's pattern, applied to the ONNX tag path).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('tag-onnx-lazy.js — import isolation', () => {
  it('does not statically import tag-onnx.js anywhere in its executable code', () => {
    const src = readFileSync(new URL('../../../../src/indexer/phases/tag-onnx-lazy.js', import.meta.url), 'utf-8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.ok(!/from ['"]\.\.\/\.\.\/local\/indexer\/phases\/tag-onnx\.js['"]/.test(codeOnly), 'must not statically import ../../local/indexer/phases/tag-onnx.js in executable code');
  });

  it('importing tag-onnx-lazy.js alone (a fresh process, no other test\'s import cache) succeeds and isOnnxTagProvider resolves correctly', async () => {
    // Fresh child process — the only reliable way this assertion isn't
    // polluted by tag-onnx.js already being loaded via some OTHER test file
    // in the same suite run (node:test does not isolate imports across
    // tests within one file/process the way separate files are isolated).
    const { execFileSync } = await import('node:child_process');
    const modUrl = new URL('../../../../src/indexer/phases/tag-onnx-lazy.js', import.meta.url).href;
    const script = `
      import(${JSON.stringify(modUrl)}).then((mod) => {
        if (typeof mod.isOnnxTagProvider !== 'function') throw new Error('isOnnxTagProvider missing');
        if (mod.isOnnxTagProvider({ TAG_PROVIDER: 'onnx' }) !== true) throw new Error('predicate wrong (true case)');
        if (mod.isOnnxTagProvider({ TAG_PROVIDER: 'ollama' }) !== false) throw new Error('predicate wrong (false case)');
        console.log('OK');
      }).catch((err) => { console.error(err); process.exit(1); });
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8', timeout: 10000 });
    assert.match(out, /OK/);
  });

  it('createTagOnnxCapability() is exported as a callable async factory (drop-in for index-full.js)', async () => {
    const mod = await import('../../../../src/indexer/phases/tag-onnx-lazy.js');
    assert.equal(typeof mod.createTagOnnxCapability, 'function');
    assert.equal(typeof mod.isOnnxTagProvider, 'function');
  });

  it('createTagOnnxCapability() returns an object with addTagsOnnxBatch/shutdownOnnxTagWorker, and two calls return two genuinely independent instances (code review, Phase 8B Step 4, second pass)', async () => {
    const mod = await import('../../../../src/indexer/phases/tag-onnx-lazy.js');
    const capA = await mod.createTagOnnxCapability();
    const capB = await mod.createTagOnnxCapability();
    assert.equal(typeof capA.addTagsOnnxBatch, 'function');
    assert.equal(typeof capA.shutdownOnnxTagWorker, 'function');
    assert.notEqual(capA, capB, 'two calls must return two distinct instances, not the same shared object');
    assert.notEqual(capA.shutdownOnnxTagWorker, capB.shutdownOnnxTagWorker, 'each instance\'s methods close over their own independent state, not a shared one');
    // Both are safe no-ops before any worker was ever spawned.
    await assert.doesNotReject(() => capA.shutdownOnnxTagWorker());
    await assert.doesNotReject(() => capB.shutdownOnnxTagWorker());
  });
});

describe('tag-provider.js — pure predicate, no fork/child_process dependency', () => {
  it('has no import of node:child_process or tag-onnx.js', () => {
    const src = readFileSync(new URL('../../../../src/indexer/phases/tag-provider.js', import.meta.url), 'utf-8');
    assert.ok(!src.includes('node:child_process'));
    assert.ok(!/from ['"][^'"]*tag-onnx\.js['"]/.test(src));
  });

  it('isOnnxTagProvider matches tag-onnx.js re-exported behavior exactly (no drift)', async () => {
    const { isOnnxTagProvider: fromNeutral } = await import('../../../../src/indexer/phases/tag-provider.js');
    const { isOnnxTagProvider: fromTagOnnx } = await import('../../../../src/local/indexer/phases/tag-onnx.js');
    assert.equal(fromNeutral, fromTagOnnx, 'tag-onnx.js must re-export the SAME function reference, not a duplicate');
  });
});
