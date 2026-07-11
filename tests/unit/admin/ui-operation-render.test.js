// Tests for src/admin/ui-src/operation-render.js — pure rendering of one
// operation (index/reindex/repair) into a .job-card element, reusing the
// tpl-job-row template. Ported from the deleted jobs-view.js renderJobRow()
// tests (Phase 3S — see docs/admin-ui-phase3s-unified-operation-status-2026-07-11.md)
// against the new operation shape: progress.percent/phase/currentFile/
// processedFiles/totalFiles (from GET /api/operations), not the old raw
// job.progress shape.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadOperationRenderHelpers, withServer } from './ui-test-helpers.js';

describe('renderOperationCard() — indexing operations', () => {
  it('a running job never shows "ended", and shows progress bar/current file/count', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderOperationCard } = loadOperationRenderHelpers(html);
      const startedAt = new Date(Date.now() - 5000).toISOString();
      const card = renderOperationCard({
        id: 'op-1', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'running',
        startedAt, finishedAt: null, cancellable: true,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: 'b.md', phase: null, percent: 40 },
      });
      const statusLine = card.querySelector('.job-status-line');
      assert.doesNotMatch(statusLine.textContent + card.querySelector('.job-times').textContent, /ended/);
      assert.equal(card.querySelector('.job-progress-bar').hidden, false);
      assert.match(card.querySelector('.job-progress-fill').style.width, /40%/);
      assert.match(card.querySelector('.job-progress-current').textContent, /Current file: b\.md/);
      assert.match(card.querySelector('.job-progress-count').textContent, /2 \/ 5 files processed/);
    });
  });

  it('tickElapsedRows fills in "Running · Xs elapsed" / "Queued · Xs elapsed" wording for active operations', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, renderOperationCard, tickElapsedRows } = loadOperationRenderHelpers(html);

      const container = document.createElement('div');
      document.body.appendChild(container);
      const startedAt = new Date(Date.now() - 5000).toISOString();
      const runningCard = renderOperationCard({
        id: 'op-1', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'running',
        startedAt, finishedAt: null, cancellable: true,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: 'b.md', phase: null, percent: 40 },
      });
      container.appendChild(runningCard);

      tickElapsedRows(container);
      assert.match(runningCard.querySelector('.job-status-line').textContent, /^Running · \d+s elapsed$/);
      assert.doesNotMatch(runningCard.querySelector('.job-status-line').textContent, /ended/);
    });
  });

  it('finished (succeeded) job shows "Completed in <duration>" using actual finishedAt, not forecast wording', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderOperationCard } = loadOperationRenderHelpers(html);
      const startedAt = new Date(Date.now() - 134_000).toISOString(); // 2m 14s ago
      const finishedAt = new Date().toISOString();
      const card = renderOperationCard({
        id: 'op-2', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'succeeded',
        startedAt, finishedAt, cancellable: false,
        progress: { processedFiles: 124, totalFiles: 124, currentFile: null, phase: null, percent: 100 },
      });
      assert.match(card.querySelector('.job-title').textContent, /^Indexed demo/);
      assert.match(card.querySelector('.job-status-line').textContent, /^Completed in 2m 14s$/);
      assert.doesNotMatch(card.querySelector('.job-status-line').textContent, /will finish|estimated|forecast/i);
      assert.match(card.querySelector('.job-progress-count').textContent, /124 \/ 124 files processed/);
      // The actual finished timestamp only shows inside the collapsed
      // details ("Show details"), not as a primary-UI "ended" label.
      assert.match(card.querySelector('.job-times').textContent, /ended/);
    });
  });

  it('failed job shows "Failed after <duration>" and an error summary', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderOperationCard } = loadOperationRenderHelpers(html);
      const startedAt = new Date(Date.now() - 31_000).toISOString();
      const finishedAt = new Date().toISOString();
      const card = renderOperationCard({
        id: 'op-3', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'failed',
        startedAt, finishedAt, cancellable: false, error: 'Qdrant unreachable',
        progress: { processedFiles: 37, totalFiles: 124, currentFile: null, phase: null, percent: 29.8 },
      });
      assert.equal(card.querySelector('.job-title').textContent, 'Indexing failed');
      assert.match(card.querySelector('.job-status-line').textContent, /^Failed after 31s$/);
      assert.match(card.querySelector('.job-progress-count').textContent, /37 \/ 124 files processed/);
      assert.match(card.querySelector('.job-error-summary').textContent, /Qdrant unreachable/);
      assert.equal(card.querySelector('.job-error-summary').hidden, false);
      // Details auto-expand on failure so the error is visible without an
      // extra click (caller-supplied via detailsOpen — operation-render.js
      // itself is pure and does not decide this; see ui-operation-modal.test.js
      // for the caller-side default-open-on-failure behavior).
      const card2 = renderOperationCard({
        id: 'op-3', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'failed',
        startedAt, finishedAt, cancellable: false, error: 'Qdrant unreachable', progress: null,
      }, { detailsOpen: true });
      assert.equal(card2.querySelector('.job-details').hasAttribute('open'), true);
    });
  });

  it('shows an indeterminate progress indicator (not a fake 0%/100% bar) when progress is null', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderOperationCard } = loadOperationRenderHelpers(html);
      const card = renderOperationCard({
        id: 'op-4', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null,
      });
      assert.equal(card.querySelector('.job-progress-bar').hidden, true);
      assert.equal(card.querySelector('.job-progress-indeterminate').hidden, false);
    });
  });

  it('renders "Step: Generating summaries" for a running operation with a phase', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderOperationCard } = loadOperationRenderHelpers(html);
      const card = renderOperationCard({
        id: 'op-7', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true,
        progress: { processedFiles: 1, totalFiles: 4, currentFile: 'Тема 13...', phase: 'Generating summaries', percent: 36.25 },
      });
      const stepEl = card.querySelector('.job-progress-step');
      assert.equal(stepEl.hidden, false);
      assert.equal(stepEl.textContent, 'Step: Generating summaries');
    });
  });

  it('omits the step line (keeps it hidden) when phase is null', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderOperationCard } = loadOperationRenderHelpers(html);
      const card = renderOperationCard({
        id: 'op-8', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: 'b.md', phase: null, percent: null },
      });
      assert.equal(card.querySelector('.job-progress-step').hidden, true);
    });
  });

  it('still renders an operation with no progress field at all (old-shaped API response) without throwing', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderOperationCard } = loadOperationRenderHelpers(html);
      assert.doesNotThrow(() => {
        const card = renderOperationCard({
          id: 'op-9', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'running',
          startedAt: new Date().toISOString(), finishedAt: null, cancellable: true,
        });
        assert.equal(card.querySelector('.job-progress-step').hidden, true);
      });
    });
  });

  it('shows a cancel button only when cancellable is true, not once finished', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderOperationCard } = loadOperationRenderHelpers(html);
      const running = renderOperationCard({
        id: 'op-5', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null,
      });
      assert.equal(running.querySelector('.job-cancel').hidden, false);

      const done = renderOperationCard({
        id: 'op-6', kind: 'index', collection: 'demo', sourcePath: './docs', state: 'succeeded',
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), cancellable: false, progress: null,
      });
      assert.equal(done.querySelector('.job-cancel').hidden, true);
    });
  });

  it('a repair operation (running, cancellable: false) never shows a cancel button even while active', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderOperationCard } = loadOperationRenderHelpers(html);
      const card = renderOperationCard({
        id: 'op-10', kind: 'repair', collection: 'demo', sourcePath: null, state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: false, progress: null,
      });
      assert.equal(card.querySelector('.job-cancel').hidden, true, 'repair has no genuine cancel point — must never show cancel while active');
      assert.equal(card.querySelector('.job-progress-indeterminate').hidden, false, 'repair always shows the indeterminate bar while running');
    });
  });

  it('distinguishes index/reindex/repair titles', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderOperationCard } = loadOperationRenderHelpers(html);
      const base_ = { collection: 'demo', sourcePath: './docs', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null };
      assert.match(renderOperationCard({ ...base_, id: 'i', kind: 'index' }).querySelector('.job-title').textContent, /^Indexing demo/);
      assert.match(renderOperationCard({ ...base_, id: 'r', kind: 'reindex' }).querySelector('.job-title').textContent, /^Reindexing demo/);
      assert.match(renderOperationCard({ ...base_, id: 'p', kind: 'repair', cancellable: false }).querySelector('.job-title').textContent, /^Repairing demo/);
    });
  });
});
