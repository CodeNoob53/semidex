// Tests for src/admin/ui-src/topbar.js's active-job chip (Phase 3C) — a
// small always-reachable-from-any-route indicator, distinct from the full
// jobs list at #/index.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTopbarHelpers, withServer } from './ui-test-helpers.js';

describe('topbar job chip', () => {
  it('stays hidden when there are no active jobs', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, pollJobChip } = loadTopbarHelpers(html, {
        apiImpl: async () => ({ jobs: [] }),
      });
      await pollJobChip();
      assert.equal(document.getElementById('job-chip').hidden, true);
    });
  });

  it('becomes visible and shows the collection name with exactly one active job', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, pollJobChip } = loadTopbarHelpers(html, {
        apiImpl: async () => ({ jobs: [{ id: 'j1', collection: 'my-docs', state: 'running' }] }),
      });
      await pollJobChip();
      const chip = document.getElementById('job-chip');
      assert.equal(chip.hidden, false);
      assert.match(chip.textContent, /my-docs/);
    });
  });

  it('filters out terminal-state jobs (succeeded/failed/cancelled) — only queued/running/cancelling count as active', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, pollJobChip } = loadTopbarHelpers(html, {
        apiImpl: async () => ({
          jobs: [
            { id: 'j1', collection: 'done-docs', state: 'succeeded' },
            { id: 'j2', collection: 'failed-docs', state: 'failed' },
            { id: 'j3', collection: 'cancelled-docs', state: 'cancelled' },
          ],
        }),
      });
      await pollJobChip();
      assert.equal(document.getElementById('job-chip').hidden, true);
    });
  });

  it('shows a "+N" suffix when more than one job is active', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, pollJobChip } = loadTopbarHelpers(html, {
        apiImpl: async () => ({
          jobs: [
            { id: 'j1', collection: 'a-docs', state: 'running' },
            { id: 'j2', collection: 'b-docs', state: 'queued' },
          ],
        }),
      });
      await pollJobChip();
      assert.match(document.getElementById('job-chip').textContent, /\+1/);
    });
  });

  it('clicking the chip navigates to #/index', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const helpers = loadTopbarHelpers(html, {
        apiImpl: async () => ({ jobs: [{ id: 'j1', collection: 'my-docs', state: 'running' }] }),
      });
      await helpers.pollJobChip();
      helpers.document.getElementById('job-chip').onclick();
      assert.equal(helpers.location.hash, '#/index');
    });
  });

  it('does not call /api/jobs while already on the #/index route (jobs-view.js owns polling there)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let calls = 0;
      const { pollJobChip } = loadTopbarHelpers(html, {
        apiImpl: async () => { calls++; return { jobs: [] }; },
        route: { view: 'index' },
      });
      await pollJobChip();
      assert.equal(calls, 0, 'topbar must not double-poll /api/jobs while jobs-view.js is already polling on #/index');
    });
  });

  it('hides a stale chip when the user navigates to #/index while a job is showing', async () => {
    // Regression: the chip must not just stop polling on #/index — without
    // clearing it, clicking the chip to reach #/index and then having that
    // job finish would leave "Indexing ..." showing indefinitely, since the
    // chip's own poll loop never runs on this route to notice.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let onIndex = false;
      const { document, pollJobChip } = loadTopbarHelpers(html, {
        apiImpl: async () => ({ jobs: [{ id: 'j1', collection: 'my-docs', state: 'running' }] }),
        route: { get view() { return onIndex ? 'index' : 'overview'; } },
      });
      await pollJobChip();
      assert.equal(document.getElementById('job-chip').hidden, false, 'sanity: chip is visible before navigating');

      onIndex = true;
      await pollJobChip();
      assert.equal(document.getElementById('job-chip').hidden, true, 'chip must hide once the user is on #/index');
    });
  });

  it('renderJobChip escapes an untrusted collection name (XSS-safe)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const malicious = '<img src=x onerror="window.__pwned=true">';
      const { document, pollJobChip } = loadTopbarHelpers(html, {
        apiImpl: async () => ({ jobs: [{ id: 'j1', collection: malicious, state: 'running' }] }),
      });
      await pollJobChip();
      const chip = document.getElementById('job-chip');
      assert.equal(chip.querySelectorAll('img').length, 0, 'malicious collection name must never be parsed into a real element');
      assert.match(chip.textContent, /<img/, 'the malicious text must render as inert text, not markup');
    });
  });

  it('a transient /api/jobs error does not throw and leaves the chip in its prior state', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, pollJobChip } = loadTopbarHelpers(html, {
        apiImpl: async () => { throw new Error('network error'); },
      });
      await assert.doesNotReject(() => pollJobChip());
      assert.equal(document.getElementById('job-chip').hidden, true);
    });
  });
});

describe('topbar job chip — renderJobChip() pure rendering', () => {
  it('hides and clears the chip for an empty active-jobs list', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, renderJobChip } = loadTopbarHelpers(html);
      const chip = document.getElementById('job-chip');
      chip.hidden = false;
      chip.textContent = 'stale';
      renderJobChip(chip, []);
      assert.equal(chip.hidden, true);
      assert.equal(chip.textContent, '');
    });
  });

  it('reuses the existing job-progress visual language via a small pulsing dot element', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, renderJobChip } = loadTopbarHelpers(html);
      const chip = document.getElementById('job-chip');
      renderJobChip(chip, [{ id: 'j1', collection: 'my-docs', state: 'running' }]);
      assert.ok(chip.querySelector('.job-chip-dot'), 'chip must render its indicator dot element');
    });
  });
});
