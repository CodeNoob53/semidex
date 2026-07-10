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
      // Details auto-expand on failure so the error is visible without an
      // extra click. hasAttribute (not the .open IDL property) — see the
      // linkedom note on the "manual close" tests below.
      assert.equal(card.querySelector('.job-details').hasAttribute('open'), true);
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

  // ── Phase 3J: job details open/closed state must survive polling ────────
  // linkedom doesn't implement <details>.open as a real IDL-property/
  // attribute reflection (setting .open=true never sets the actual "open"
  // attribute, and a literal open attribute in markup doesn't read back via
  // .open — confirmed independently of this app's code), and it does not
  // fire native `toggle` events on attribute mutation, click, or `new
  // Event('toggle')` dispatch either (linkedom's dispatchEvent throws on a
  // plain Event instance). document.createEvent + initEvent is the one
  // dispatch path that actually works in this harness — simulateToggle()
  // below is the one place that workaround lives, so every test uses the
  // exact same "a real user opened/closed this" simulation the production
  // toggle listener (jobs-view.js's `detailsEl.addEventListener('toggle', ...)`)
  // is written to receive from a real browser.
  //
  // Order matters: in a real browser, clicking <summary> changes the
  // open/closed state FIRST, and the `toggle` event fires after — the
  // listener reads the already-updated state. This mirrors that order
  // (attribute change, then dispatch), not the reverse.
  function simulateToggle(document, detailsEl, nextOpen) {
    if (nextOpen) detailsEl.setAttribute('open', '');
    else detailsEl.removeAttribute('open');
    const ev = document.createEvent('Event');
    ev.initEvent('toggle', false, false);
    detailsEl.dispatchEvent(ev);
  }

  it('a running job with details left untouched (never manually toggled) stays closed across polling, including as progress changes', async () => {
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
      await renderIndexingView(document.getElementById('main'));
      await loadJobs();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), false);

      job.progress = { ...job.progress, processedFiles: 3, percent: 60 }; // progress changed
      await loadJobs();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), false,
        'an untouched running job must stay closed even as its progress updates');
    });
  });

  it('a user-opened <details> on a still-running job survives a poll re-render, including as progress/log content changes', async () => {
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
        apiImpl: async (url) => (url.startsWith('/api/jobs/') ? { log: 'line one\nline two' } : { jobs: [job] }),
      });
      await renderIndexingView(document.getElementById('main')); // mounts #idx-jobs via index-view.html
      await loadJobs();
      const details = document.querySelector('.job-details');
      assert.equal(details.hasAttribute('open'), false, 'a running job must not auto-open its details');
      simulateToggle(document, details, true); // simulate the user clicking <summary> to expand it

      await loadJobs(); // a second poll tick — progress changed, new log lines
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), true,
        'the user-opened details must survive a poll re-render with new progress');

      job.progress = { ...job.progress, processedFiles: 4, currentFile: 'd.md', percent: 80 };
      await loadJobs(); // a third tick — progress changed again
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), true,
        'new progress/log content must not collapse an already-open details block');
    });
  });

  it('a failed job auto-expands details when the user has never manually toggled it', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const job = {
        id: 'job-8', collection: 'demo', path: './docs', state: 'failed',
        startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(), exitCode: 1,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: null, percent: 40 },
      };
      const { document, renderIndexingView, loadJobs } = loadJobsViewRenderHelpers(html, {
        apiImpl: async (url) => (url.startsWith('/api/jobs/') ? { log: '[stderr] boom' } : { jobs: [job] }),
      });
      await renderIndexingView(document.getElementById('main'));
      await loadJobs();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), true,
        'a failed job must auto-expand its details when the user has no prior manual state');
    });
  });

  it('a user manually closing a failed job\'s details is respected — polling does not reopen it', async () => {
    // The bug this fix targets: renderJobRow() used to unconditionally set
    // `.open = state === 'failed'` on every rebuilt <details>, so a manual
    // close on an already-failed job was silently undone on the very next
    // poll tick, even though the user just closed it.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const job = {
        id: 'job-9', collection: 'demo', path: './docs', state: 'failed',
        startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(), exitCode: 1,
        progress: { processedFiles: 2, totalFiles: 5, currentFile: null, percent: 40 },
      };
      const { document, renderIndexingView, loadJobs } = loadJobsViewRenderHelpers(html, {
        apiImpl: async (url) => (url.startsWith('/api/jobs/') ? { log: '[stderr] boom' } : { jobs: [job] }),
      });
      await renderIndexingView(document.getElementById('main'));
      await loadJobs();
      const details = document.querySelector('.job-details');
      assert.equal(details.hasAttribute('open'), true, 'sanity check: auto-opened on first load since it starts failed');

      simulateToggle(document, details, false); // simulate the user clicking <summary> to collapse it

      await loadJobs(); // a second poll tick — same failed job, same state
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), false,
        'a manual close on a failed job must not be reopened by the next poll');
    });
  });

  it('a running job that fails between polls still auto-expands if the user never manually touched it', async () => {
    // The auto-open-on-failure default only applies while jobDetailsManualState
    // has no entry for this job id — this confirms a state TRANSITION
    // (running -> failed) between two polls still gets the auto-open
    // behavior when nothing manual happened in between, distinct from the
    // "user already closed it" case above.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const job = {
        id: 'job-10', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: { processedFiles: 1, totalFiles: 5, currentFile: 'a.md', percent: 20 },
      };
      const { document, renderIndexingView, loadJobs } = loadJobsViewRenderHelpers(html, {
        apiImpl: async (url) => (url.startsWith('/api/jobs/') ? { log: '' } : { jobs: [job] }),
      });
      await renderIndexingView(document.getElementById('main'));
      await loadJobs();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), false);

      job.state = 'failed';
      job.finishedAt = new Date().toISOString();
      job.exitCode = 1;
      await loadJobs();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), true,
        'a job that transitions to failed must auto-expand if the user never manually toggled it');
    });
  });

  // ── Phase 3N: the remaining task-listed scenarios not yet directly
  // exercised — a manual close on a RUNNING (not failed) job, per-job-id
  // keying with two independent jobs, and log-duplication across renders.
  it('a user manually closing a RUNNING job\'s details stays closed across polling (distinct from the "never touched" case)', async () => {
    // Deliberately opens then closes, rather than just leaving it closed —
    // this exercises the actual manual-close code path (jobDetailsManualState
    // set to false) rather than merely the "no entry yet" default, which the
    // "left untouched" test above already covers for a running job.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const job = {
        id: 'job-11', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: { processedFiles: 1, totalFiles: 5, currentFile: 'a.md', percent: 20 },
      };
      const { document, renderIndexingView, loadJobs } = loadJobsViewRenderHelpers(html, {
        apiImpl: async (url) => (url.startsWith('/api/jobs/') ? { log: '' } : { jobs: [job] }),
      });
      await renderIndexingView(document.getElementById('main'));
      await loadJobs();
      const details = document.querySelector('.job-details');

      simulateToggle(document, details, true); // user opens it
      await loadJobs();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), true, 'sanity check: open after the user opened it');

      simulateToggle(document, document.querySelector('.job-details'), false); // user closes it again
      job.progress = { ...job.progress, processedFiles: 3, percent: 60 };
      await loadJobs();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), false,
        'a manual close on a running job must stay closed across further polling, even as progress changes');
    });
  });

  it('open/closed state is keyed per job id — two jobs never share or overwrite each other\'s state', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const jobs = [
        { id: 'job-a', collection: 'demo-a', path: './a', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, progress: null },
        { id: 'job-b', collection: 'demo-b', path: './b', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, progress: null },
      ];
      const { document, renderIndexingView, loadJobs } = loadJobsViewRenderHelpers(html, {
        apiImpl: async (url) => (url.startsWith('/api/jobs/') ? { log: '' } : { jobs }),
      });
      await renderIndexingView(document.getElementById('main'));
      await loadJobs();

      const cardFor = (id) => [...document.querySelectorAll('.job-card')].find(c => c.dataset.id === id);
      // Open job-a's details only — job-b must remain untouched/closed.
      simulateToggle(document, cardFor('job-a').querySelector('.job-details'), true);

      await loadJobs(); // poll tick — both jobs re-rendered
      assert.equal(cardFor('job-a').querySelector('.job-details').hasAttribute('open'), true,
        'job-a must stay open — it was explicitly opened');
      assert.equal(cardFor('job-b').querySelector('.job-details').hasAttribute('open'), false,
        'job-b must stay closed — opening job-a must not affect it');

      // Now close job-a and open job-b — confirm each job's state is
      // independently keyed, not e.g. a single shared "last toggled" flag.
      simulateToggle(document, cardFor('job-a').querySelector('.job-details'), false);
      simulateToggle(document, cardFor('job-b').querySelector('.job-details'), true);
      await loadJobs();
      assert.equal(cardFor('job-a').querySelector('.job-details').hasAttribute('open'), false, 'job-a: closed');
      assert.equal(cardFor('job-b').querySelector('.job-details').hasAttribute('open'), true, 'job-b: open');
    });
  });

  it('logs are not duplicated between renders — the log <pre> is replaced, not appended to, on each poll', async () => {
    // loadJobLog() is fire-and-forget from loadJobs() (not awaited — see
    // the source's `for (const card ...) loadJobLog(card);` with no
    // `await`), so tests need one microtask tick after loadJobs() resolves
    // before the log <pre> actually has its fetched content. job.log itself
    // is an array of pre-formatted "[stream] line" strings in the real API
    // (src/admin/api/jobs.js), not a raw joined string — matched here.
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const job = {
        id: 'job-12', collection: 'demo', path: './docs', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        progress: { processedFiles: 1, totalFiles: 5, currentFile: 'a.md', percent: 20 },
      };
      let logLines = ['[stdout] line one', '[stdout] line two'];
      const { document, renderIndexingView, loadJobs } = loadJobsViewRenderHelpers(html, {
        apiImpl: async (url) => (url.startsWith('/api/jobs/') ? { job: { log: logLines, state: 'running' } } : { jobs: [job] }),
      });
      await renderIndexingView(document.getElementById('main'));
      await loadJobs();
      await Promise.resolve(); await Promise.resolve(); // let the un-awaited loadJobLog() fetch settle
      const firstLog = document.querySelector('.job-log').textContent;
      assert.equal(firstLog, '[stdout] line one\n[stdout] line two');

      // New lines arrive on the next poll — the full log (job.log.slice(-30))
      // is authoritative each time, not appended client-side, so the log
      // element's content must reflect exactly the new fetch, not the old
      // text plus the new text concatenated.
      logLines = ['[stdout] line one', '[stdout] line two', '[stdout] line three'];
      await loadJobs();
      await Promise.resolve(); await Promise.resolve();
      const secondLog = document.querySelector('.job-log').textContent;
      assert.equal(secondLog, '[stdout] line one\n[stdout] line two\n[stdout] line three',
        'the log must be replaced with the authoritative server copy, not have new lines appended onto stale client-side text');
      assert.equal((secondLog.match(/line one/g) ?? []).length, 1, 'each line must appear exactly once — no duplication across renders');
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
