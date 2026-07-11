// Tests for src/admin/ui-src/topbar.js's active-operation chip. Phase 3S:
// the chip no longer polls /api/jobs on its own timer — it subscribes to
// the shared operation-store.js (one poller for the whole app) and clicking
// it opens the global operation modal in place, instead of navigating to
// #/index (which is collection-creation only now — the jobs list that used
// to live there is gone; see ui-jobs.test.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTopbarHelpers, readUiSource, withServer } from './ui-test-helpers.js';

describe('topbar operation chip — subscribes to the shared store, never polls on its own', () => {
  it('initJobChip() subscribes to the store instead of calling api(\'/api/jobs\') itself', () => {
    const js = readUiSource('topbar.js');
    assert.match(js, /import\s*\{\s*subscribe,\s*getActiveOperation\s*\}\s*from ['"]\.\/operation-store\.js['"]/);
    assert.ok(!/api\(['"]\/api\/jobs['"]\)/.test(js), 'topbar.js must not poll /api/jobs directly — operation-store.js owns that');
    assert.ok(!/setTimeout/.test(js), 'no independent poll-scheduling timer should exist in this module at all');
  });

  it('stays hidden when the store reports no active operation', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate } = loadTopbarHelpers(html);
      initJobChip();
      __emitUpdate();
      assert.equal(document.getElementById('job-chip').hidden, true);
    });
  });

  it('becomes visible and shows the collection name + kind label with an active operation', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html);
      initJobChip();
      __setActive({ id: 'op1', kind: 'index', collection: 'my-docs', state: 'running', progress: null });
      __emitUpdate();
      const chip = document.getElementById('job-chip');
      assert.equal(chip.hidden, false);
      assert.match(chip.textContent, /my-docs/);
      assert.match(chip.textContent, /Indexing/);
    });
  });

  it('shows a percentage when the operation has known progress', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html);
      initJobChip();
      __setActive({ id: 'op1', kind: 'index', collection: 'my-docs', state: 'running', progress: { percent: 42.7 } });
      __emitUpdate();
      assert.match(document.getElementById('job-chip').textContent, /43%/);
    });
  });

  it('shows no fabricated percentage when progress is unknown (indeterminate) — the dot alone signals activity', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html);
      initJobChip();
      __setActive({ id: 'op1', kind: 'repair', collection: 'my-docs', state: 'running', progress: null });
      __emitUpdate();
      assert.doesNotMatch(document.getElementById('job-chip').textContent, /%/);
    });
  });

  it('labels a reindex operation distinctly from a fresh index', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html);
      initJobChip();
      __setActive({ id: 'op1', kind: 'reindex', collection: 'my-docs', state: 'running', progress: null });
      __emitUpdate();
      assert.match(document.getElementById('job-chip').textContent, /Reindexing/);
    });
  });

  it('labels a repair operation distinctly', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html);
      initJobChip();
      __setActive({ id: 'op1', kind: 'repair', collection: 'my-docs', state: 'running', progress: null });
      __emitUpdate();
      assert.match(document.getElementById('job-chip').textContent, /Repairing/);
    });
  });

  it('clicking the chip opens the operation modal on the active operation, without navigating anywhere', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let openedWith = null;
      const { document, initJobChip, __emitUpdate, __setActive } = loadTopbarHelpers(html, {
        openOperationModalImpl: (id) => { openedWith = id; },
      });
      initJobChip();
      __setActive({ id: 'op1', kind: 'index', collection: 'my-docs', state: 'running', progress: null });
      __emitUpdate();
      document.getElementById('job-chip').click();
      assert.equal(openedWith, 'op1');
      assert.equal(document.location, undefined, 'topbar.js has no location import at all — it must never navigate');
    });
  });

  it('never writes to location.hash anywhere in source (regression: used to navigate to #/index on chip click)', () => {
    const js = readUiSource('topbar.js');
    assert.ok(!/location\.hash\s*=/.test(js), 'topbar.js must never navigate — clicking the chip only opens the modal in place');
  });

  it('renderJobChip escapes an untrusted collection name (XSS-safe)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const { document, renderJobChip } = loadTopbarHelpers(html);
      const chip = document.getElementById('job-chip');
      renderJobChip(chip, { id: 'op1', kind: 'index', collection: malicious, state: 'running', progress: null });
      assert.equal(chip.querySelectorAll('img').length, 0, 'malicious collection name must never be parsed into a real element');
      assert.match(chip.textContent, /<img/, 'the malicious text must render as inert text, not markup');
    });
  });
});

// ── Phase 3D: CSS actually honors the "hidden" attribute (browser-verified) ─
describe('app.css — .job-chip[hidden] actually hides the chip', () => {
  it('has an explicit [hidden] override rule, not just an unconditional "display: flex"', () => {
    const css = readUiSource('app.css');
    assert.match(css, /\.job-chip\[hidden\]\s*\{\s*display:\s*none;?\s*\}/,
      '.job-chip must have an explicit [hidden] rule that actually hides it');
  });
});

describe('topbar operation chip — renderJobChip() pure rendering', () => {
  it('hides and clears the chip for no active operation (null)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, renderJobChip } = loadTopbarHelpers(html);
      const chip = document.getElementById('job-chip');
      chip.hidden = false;
      chip.textContent = 'stale';
      renderJobChip(chip, null);
      assert.equal(chip.hidden, true);
      assert.equal(chip.textContent, '');
    });
  });

  it('reuses the existing job-progress visual language via a small pulsing dot element', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, renderJobChip } = loadTopbarHelpers(html);
      const chip = document.getElementById('job-chip');
      renderJobChip(chip, { id: 'op1', kind: 'index', collection: 'my-docs', state: 'running', progress: null });
      assert.ok(chip.querySelector('.job-chip-dot'), 'chip must render its indicator dot element');
    });
  });
});
