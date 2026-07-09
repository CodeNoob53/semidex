// Tests for src/admin/ui-src/jobs-view.js. Job manager/API behavior itself
// is covered in jobs.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, readUiModuleWithPartial, loadJobsViewRenderHelpers, withServer } from './ui-test-helpers.js';

describe('indexing jobs view (ui-src/jobs-view.js source)', () => {
  it('jobs-view.js posts to /api/jobs/index with the six typed options', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /apiPost\(["']\/api\/jobs\/index["']/, 'must POST to /api/jobs/index');
    assert.match(js, /onnxEmbed/);
    assert.match(js, /llmSummaries/);
    assert.match(js, /skeletonChunking/);
    assert.match(js, /skeletonNav/);
    assert.match(js, /pruneStale/);
    assert.match(js, /tagGen/);
  });

  it('jobs-view.js fetches the job list and a single job\'s detail/log', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /api\(["']\/api\/jobs["']\)/, 'must GET the job list');
    assert.match(js, /\/api\/jobs\/\$\{/, 'must GET a single job by id');
  });

  it('jobs-view.js supports cancelling a job via POST /api/jobs/:id/cancel', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /\/cancel/);
  });

  it('jobs-view.js keeps the required safety copy', () => {
    const js = readUiModuleWithPartial('jobs-view.js', 'index-view.html'); // copy lives in index-view.html, ?raw-imported into jobs-view.js
    assert.match(js, /Indexing writes to the selected collection/);
  });

  it('jobs-view.js refreshes the sidebar after a job succeeds', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /loadSidebar\(\)/);
  });
});

// ── Phase 3A0: simplified create-collection form (happy-path defaults visible,
// prune-stale/generate-tags collapsed behind an Advanced disclosure) ────────
describe('simplified indexing form — advanced options collapsed (ui-src source)', () => {
  // The create-collection form's own <details class="advanced-box"> lives in
  // index-view.html (?raw-inlined into jobs-view.js at build time). Anchor
  // on the "Advanced options" summary text specifically (not just the class,
  // which the search panel's own separate "Advanced" disclosure also uses).
  function findAdvancedBoxRange(js) {
    const summaryStart = js.indexOf('<summary>Advanced options</summary>');
    if (summaryStart === -1) return null;
    const detailsStart = js.lastIndexOf('<details class="advanced-box">', summaryStart);
    if (detailsStart === -1) return null;
    const detailsEnd = js.indexOf('</details>', summaryStart);
    if (detailsEnd === -1) return null;
    return [detailsStart, detailsEnd];
  }

  it('collapses prune-stale and generate-tags behind an "Advanced options" disclosure', () => {
    const js = readUiModuleWithPartial('jobs-view.js', 'index-view.html');
    const range = findAdvancedBoxRange(js);
    assert.ok(range, 'the create-collection form must have an Advanced options disclosure');
    const inside = js.slice(range[0], range[1]);
    assert.match(inside, /Advanced options/);
    assert.match(inside, /id="opt-prune"/, 'prune-stale must be inside the disclosure');
    assert.match(inside, /id="opt-tags"/, 'generate-tags must be inside the disclosure');
  });

  it('keeps ONNX embeddings, LLM summaries, skeleton chunking, and skeleton nav visible above the disclosure', () => {
    const js = readUiModuleWithPartial('jobs-view.js', 'index-view.html');
    const range = findAdvancedBoxRange(js);
    assert.ok(range);
    const [detailsStart] = range;
    const onnxIdx = js.indexOf('id="opt-onnx"');
    const llmIdx = js.indexOf('id="opt-llm-summaries"');
    const chunkIdx = js.indexOf('id="opt-skel-chunk"');
    const navIdx = js.indexOf('id="opt-skel-nav"');
    for (const [name, idx] of [['opt-onnx', onnxIdx], ['opt-llm-summaries', llmIdx], ['opt-skel-chunk', chunkIdx], ['opt-skel-nav', navIdx]]) {
      assert.ok(idx !== -1, `${name} must be present`);
      assert.ok(idx < detailsStart, `${name} must appear before the Advanced options disclosure, not inside/after it`);
    }
  });

  it('keeps the prune-stale safety caveat, now scoped inside the disclosure with the checkbox it explains', () => {
    const js = readUiModuleWithPartial('jobs-view.js', 'index-view.html');
    const range = findAdvancedBoxRange(js);
    const inside = js.slice(range[0], range[1]);
    assert.match(inside, /Prune stale should be used only with the full source root/);
  });
});

// ── indexing progress redesign: user-facing progress, not a raw job console ─
describe('indexing progress panel (ui-src source + built index.html, redesigned)', () => {
  it('the panel is labeled "Indexing progress", not the internal word "Jobs"', () => {
    const indexView = readUiModuleWithPartial('jobs-view.js', 'index-view.html'); // panel heading lives in index-view.html
    assert.match(indexView, /Indexing progress/);
    // "Jobs" as a standalone panel heading must not remain user-visible —
    // internal ids/dataset keys/comments containing "job" are fine (and
    // expected), this only guards the *visible panel heading* text.
    assert.ok(!/panel-head['"]>Jobs</.test(indexView), 'the primary panel heading must not read just "Jobs"');
  });

  it('has a collapsed "Show details" section instead of the log being the primary UI', async () => {
    await withServer(async (base) => {
      // The job-row <template> (with the "Show details" <summary>) lives in
      // partials/templates/job-row.html, inlined into index.html by
      // vite-plugin-html-inject — not in jobs-view.js, which only clones/fills it.
      const html = await (await fetch(base + '/')).text();
      assert.match(html, /Show details/);
      assert.match(html, /class="job-details"/);
    });
  });

  it('a running job never shows "ended", and shows progress bar/current file/count', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadJobsViewRenderHelpers(html);
      const startedAt = new Date(Date.now() - 5000).toISOString();
      const card = renderJobRow({
        id: 'job-1', collection: 'demo', path: './docs', state: 'running',
        startedAt, finishedAt: null, exitCode: null,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: 'b.md', percent: 40 },
      });
      const statusLine = card.querySelector('.job-status-line');
      assert.doesNotMatch(statusLine.textContent + card.querySelector('.job-times').textContent, /ended/);
      assert.equal(card.querySelector('.job-progress-bar').hidden, false);
      assert.match(card.querySelector('.job-progress-fill').style.width, /40%/);
      assert.match(card.querySelector('.job-progress-current').textContent, /Current file: b\.md/);
      assert.match(card.querySelector('.job-progress-count').textContent, /2 \/ 5 files processed/);
    });
  });

  it('tickRunningJobRows fills in "Running · Xs elapsed" / "Queued · Xs elapsed" wording for active jobs', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, renderJobRow, tickRunningJobRows } = loadJobsViewRenderHelpers(html);

      const container = document.createElement('div');
      container.id = 'idx-jobs';
      document.body.appendChild(container);
      const startedAt = new Date(Date.now() - 5000).toISOString();
      const runningCard = renderJobRow({
        id: 'job-1', collection: 'demo', path: './docs', state: 'running',
        startedAt, finishedAt: null, exitCode: null,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: 'b.md', percent: 40 },
      });
      container.appendChild(runningCard);

      tickRunningJobRows();
      assert.match(runningCard.querySelector('.job-status-line').textContent, /^Running · \d+s elapsed$/);
      assert.doesNotMatch(runningCard.querySelector('.job-status-line').textContent, /ended/);
    });
  });

  it('finished (succeeded) job shows "Completed in <duration>" using actual finishedAt, not forecast wording', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadJobsViewRenderHelpers(html);
      const startedAt = new Date(Date.now() - 134_000).toISOString(); // 2m 14s ago
      const finishedAt = new Date().toISOString();
      const card = renderJobRow({
        id: 'job-2', collection: 'demo', path: './docs', state: 'succeeded',
        startedAt, finishedAt, exitCode: 0,
        progress: { processedFiles: 124, totalFiles: 124, currentFile: null, percent: 100 },
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
      const { renderJobRow } = loadJobsViewRenderHelpers(html);
      const startedAt = new Date(Date.now() - 31_000).toISOString();
      const finishedAt = new Date().toISOString();
      const card = renderJobRow({
        id: 'job-3', collection: 'demo', path: './docs', state: 'failed',
        startedAt, finishedAt, exitCode: 1,
        progress: { processedFiles: 37, totalFiles: 124, currentFile: null, percent: 29.8 },
      });
      assert.equal(card.querySelector('.job-title').textContent, 'Indexing failed');
      assert.match(card.querySelector('.job-status-line').textContent, /^Failed after 31s$/);
      assert.match(card.querySelector('.job-progress-count').textContent, /37 \/ 124 files processed/);
      // Details auto-expand on failure so the error is visible without an extra click.
      assert.equal(card.querySelector('.job-details').open, true);
    });
  });

  it('shows an indeterminate progress indicator (not a fake 0%/100% bar) when totalFiles is unknown', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadJobsViewRenderHelpers(html);
      const card = renderJobRow({
        id: 'job-4', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: { processedFiles: null, totalFiles: null, currentFile: null, percent: null },
      });
      assert.equal(card.querySelector('.job-progress-bar').hidden, true);
      assert.equal(card.querySelector('.job-progress-indeterminate').hidden, false);
    });
  });

  it('renders "Step: Generating summaries" for a running job with a currentStep', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadJobsViewRenderHelpers(html);
      const card = renderJobRow({
        id: 'job-7', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: {
          processedFiles: 1, totalFiles: 4, currentFile: 'Тема 13...', currentStep: 'Generating summaries',
          currentFileProgress: 0.45, percent: 36.25,
        },
      });
      const stepEl = card.querySelector('.job-progress-step');
      assert.equal(stepEl.hidden, false);
      assert.equal(stepEl.textContent, 'Step: Generating summaries');
    });
  });

  it('omits the step line (keeps it hidden) when currentStep is null', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadJobsViewRenderHelpers(html);
      const card = renderJobRow({
        id: 'job-8', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: {
          processedFiles: 2, totalFiles: 5, currentFile: 'b.md', currentStep: null,
          currentFileProgress: null, percent: null,
        },
      });
      assert.equal(card.querySelector('.job-progress-step').hidden, true);
    });
  });

  it('still renders an old-shaped progress payload (no currentStep/currentFileProgress keys at all) without throwing', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadJobsViewRenderHelpers(html);
      const card = renderJobRow({
        id: 'job-9', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: 'b.md', percent: 40 },
      });
      assert.equal(card.querySelector('.job-progress-step').hidden, true);
      assert.match(card.querySelector('.job-progress-count').textContent, /2 \/ 5 files processed/);
      assert.match(card.querySelector('.job-progress-current').textContent, /Current file: b\.md/);
    });
  });

  it('shows a cancel button while running/queued, not once finished', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { renderJobRow } = loadJobsViewRenderHelpers(html);
      const running = renderJobRow({
        id: 'job-5', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, progress: null,
      });
      assert.equal(running.querySelector('.job-cancel').hidden, false);

      const done = renderJobRow({
        id: 'job-6', collection: 'demo', path: './docs', state: 'succeeded',
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, progress: null,
      });
      assert.equal(done.querySelector('.job-cancel').hidden, true);
    });
  });

  it('loadJobs() preserves a user-opened <details> on a still-running job across a poll re-render', async () => {
    // Regression test: renderJobRow() always rebuilds a fresh <details>,
    // auto-opening it only for a failed job — every poll tick was silently
    // closing a user-opened details panel on a still-running job.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const job = {
        id: 'job-7', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: { processedFiles: 1, totalFiles: 5, currentFile: 'a.md', percent: 20 },
      };
      const { document, renderIndexingView, loadJobs } = loadJobsViewRenderHelpers(html, {
        apiImpl: async (url) => (url.startsWith('/api/jobs/') ? { log: '' } : { jobs: [job] }),
      });
      await renderIndexingView(document.getElementById('main')); // mounts #idx-jobs via index-view.html
      await loadJobs();
      const details = document.querySelector('.job-details');
      // linkedom doesn't implement <details>.open as a real IDL-property/
      // attribute reflection (confirmed independently of this app's code —
      // setting .open=true never sets the actual "open" attribute, and even
      // a literal open attribute in markup doesn't read back via .open) —
      // so this test observes/drives state via hasAttribute/setAttribute
      // directly rather than the .open property, which is what the
      // production fix's own `[open]` CSS-selector check relies on too.
      assert.equal(details.hasAttribute('open'), false, 'a running job must not auto-open its details');
      details.setAttribute('open', ''); // simulate the user manually expanding it

      await loadJobs(); // a second poll tick, same job data
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), true,
        'the user-opened details must survive a poll re-render');
    });
  });
});

// ── folder picker (developer-form redesign) ──────────────────────────────
describe('folder picker (ui-src/jobs-view.js source)', () => {
  it('has a primary "Choose folder" button wired to POST /api/system/pick-folder', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /idx-choose-folder/);
    assert.match(js, /apiPost\(["']\/api\/system\/pick-folder["']/);
  });

  it('has a manual-path fallback state that is shown when the picker fails', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /idx-path-fallback/);
    assert.match(js, /idx-path-manual/);
    // The fallback must actually be revealed on picker failure, not just present in markup.
    const fnStart = js.indexOf('async function chooseIndexFolder');
    assert.ok(fnStart !== -1, 'chooseIndexFolder should be defined');
    const fn = js.slice(fnStart, fnStart + 800);
    assert.match(fn, /catch/);
    assert.match(fn, /fallback\.style\.display\s*=\s*["']{2}/);
  });
});

describe('LLM summaries — Ollama dependency status (ui-src/jobs-view.js source)', () => {
  it('shows "LLM summaries require Ollama" copy with a status badge, not a silent checkbox', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /LLM summaries require Ollama/);
    assert.match(js, /idx-ollama-status/);
    assert.match(js, /\/api\/system\/ollama-status/);
  });

  it('checking the LLM summaries checkbox triggers an Ollama status check', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /opt-llm-summaries["']\)\.addEventListener\(["']change["']|opt-llm-summaries.*addEventListener\(["']change["']/s);
    assert.match(js, /loadOllamaStatus/);
  });

  it('maps each Ollama status (available/missing/model_missing) to a distinct badge class', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /available:\s*["']badge badge-ok["']/);
    assert.match(js, /missing:\s*["']badge badge-fail["']/);
    assert.match(js, /model_missing:\s*["']badge badge-warn["']/);
  });

  it('surfaces a 503 dependency error from job start back through the Ollama status check, not a generic failure', () => {
    const js = readUiSource('jobs-view.js');
    const start = js.indexOf('async function startIndexJob');
    const fn = js.slice(start, start + 1500);
    assert.match(fn, /err\.status === 503/);
    assert.match(fn, /loadOllamaStatus/);
  });
});
