// Tests for src/admin/ui-src/jobs-view.js — the collection-creation form at
// #/index. Job manager/API behavior itself is covered in jobs.test.js;
// operation status rendering/polling (Phase 3S) moved to
// ui-operation-render.test.js / ui-operation-store.test.js /
// ui-operation-modal.test.js — the old "Indexing progress" panel that used
// to live in this file (job list, per-job Show details, its own poller) was
// deleted from jobs-view.js, not hidden, so its tests are deleted here too,
// not ported — the behavior they covered is ported to the new modules'
// tests instead (see docs/admin-ui-phase3s-unified-operation-status-2026-07-11.md).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readUiSource, readUiModuleWithPartial } from './ui-test-helpers.js';

describe('collection-creation form (ui-src/jobs-view.js source)', () => {
  it('posts to /api/jobs/index with the four typed options', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /apiPost\(["']\/api\/jobs\/index["']/, 'must POST to /api/jobs/index');
    assert.match(js, /onnxEmbed/);
    assert.match(js, /llmSummaries/);
    assert.match(js, /pruneStale/);
    assert.match(js, /tagGen/);
  });

  it('sends no skeletonChunking/skeletonNav options — skeleton-first indexing is unconditional architecture, not a per-job choice', () => {
    const js = readUiSource('jobs-view.js');
    assert.ok(!/skeletonChunking/.test(js));
    assert.ok(!/skeletonNav/.test(js));
  });

  it('keeps the required safety copy', () => {
    const js = readUiModuleWithPartial('jobs-view.js', 'index-view.html'); // copy lives in index-view.html, ?raw-imported into jobs-view.js
    assert.match(js, /Indexing writes to the selected collection/);
  });

  // ── Phase 3S ────────────────────────────────────────────────────────────
  function startIndexJobSource(js) {
    const start = js.indexOf('async function startIndexJob');
    const end = js.indexOf('\n}', start);
    return js.slice(start, end);
  }

  it('opens the global operation modal after starting a job, instead of rendering its own progress panel', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /import\s*\{\s*openOperationModal\s*\}\s*from ['"]\.\/operation-modal\.js['"]/);
    assert.match(startIndexJobSource(js), /openOperationModal\(job\.id\)/);
  });

  it('forces an immediate store poll (pollNow) right after starting, so the modal is not stuck showing a stale snapshot', () => {
    const js = readUiSource('jobs-view.js');
    assert.match(js, /import\s*\{\s*pollNow\s*\}\s*from ['"]\.\/operation-store\.js['"]/);
    assert.match(startIndexJobSource(js), /pollNow\(\)/);
  });

  it('surfaces the server\'s 409 "already running" message clearly, without a dead-end (#/index no longer has its own progress panel to point at)', () => {
    const js = readUiSource('jobs-view.js');
    const fn = startIndexJobSource(js);
    assert.match(fn, /err\.status === 409/);
    assert.match(fn, /\$\{err\.message\}/);
    assert.ok(!/#\/index/.test(fn), 'must not point the user back at the old #/index jobs list, which no longer exists');
  });

  it('the old job-list rendering machinery (renderJobRow, loadJobs, tickRunningJobRows, per-job cancel/log fetch) is gone from this module', () => {
    const js = readUiSource('jobs-view.js');
    assert.ok(!/function renderJobRow/.test(js));
    assert.ok(!/function loadJobs\(/.test(js));
    assert.ok(!/tickRunningJobRows/.test(js));
    assert.ok(!/loadJobLog/.test(js));
    assert.ok(!/api\(["']\/api\/jobs["']\)/.test(js), 'must not GET the job list — that is operation-store.js\'s job now');
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

  it('keeps ONNX embeddings and LLM summaries visible above the disclosure', () => {
    const js = readUiModuleWithPartial('jobs-view.js', 'index-view.html');
    const range = findAdvancedBoxRange(js);
    assert.ok(range);
    const [detailsStart] = range;
    const onnxIdx = js.indexOf('id="opt-onnx"');
    const llmIdx = js.indexOf('id="opt-llm-summaries"');
    for (const [name, idx] of [['opt-onnx', onnxIdx], ['opt-llm-summaries', llmIdx]]) {
      assert.ok(idx !== -1, `${name} must be present`);
      assert.ok(idx < detailsStart, `${name} must appear before the Advanced options disclosure, not inside/after it`);
    }
  });

  it('no longer offers skeleton chunking/skeleton nav checkboxes — skeleton-first indexing is unconditional, not a per-job option', () => {
    const js = readUiModuleWithPartial('jobs-view.js', 'index-view.html');
    assert.ok(!js.includes('id="opt-skel-chunk"'));
    assert.ok(!js.includes('id="opt-skel-nav"'));
  });

  it('keeps the prune-stale safety caveat, now scoped inside the disclosure with the checkbox it explains', () => {
    const js = readUiModuleWithPartial('jobs-view.js', 'index-view.html');
    const range = findAdvancedBoxRange(js);
    const inside = js.slice(range[0], range[1]);
    assert.match(inside, /Prune stale should be used only with the full source root/);
  });
});

// ── Phase 3S: #/index no longer contains the old jobs console ──────────────
describe('#/index has no legacy jobs console (ui-src source)', () => {
  it('index-view.html has no "Indexing progress" panel/job-list container', () => {
    const html = readUiSource('partials/index-view.html');
    assert.ok(!/Indexing progress/.test(html));
    assert.ok(!/id="idx-jobs"/.test(html));
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
    const end = js.indexOf('\n}', start);
    const fn = js.slice(start, end);
    assert.match(fn, /err\.status === 503/);
    assert.match(fn, /loadOllamaStatus/);
  });
});
