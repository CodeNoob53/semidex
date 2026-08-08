// Tests for src/admin/ui-src/operation-modal.js — the global operation
// status modal (Phase 3S). Exercises the REAL store<->modal wiring
// (operation-store.js is evaluated together with operation-modal.js, not
// stubbed) with api()/apiPost() stubbed and setInterval/setTimeout captured
// so tests control both the poll loop and the elapsed-time ticker
// deterministically. Manual Show-details-survives-polling scenarios ported
// from the deleted jobs-view.js tests (see
// docs/admin-ui-phase3s-unified-operation-status-2026-07-11.md) against the
// new modal instead of the old route-bound job list.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadOperationModalHelpers, withServer } from './ui-test-helpers.js';

// linkedom doesn't implement <details>.open as real IDL-property/attribute
// reflection and doesn't fire native `toggle` events on attribute mutation —
// document.createEvent + initEvent is the dispatch path that actually works
// (same workaround jobs-view.js's own now-deleted tests used).
function simulateToggle(document, detailsEl, nextOpen) {
  if (nextOpen) detailsEl.setAttribute('open', '');
  else detailsEl.removeAttribute('open');
  const ev = document.createEvent('Event');
  ev.initEvent('toggle', false, false);
  detailsEl.dispatchEvent(ev);
}

// linkedom implements none of scrollHeight/scrollTop/clientHeight (no
// layout engine) — updateOperationLog()'s wasAtBottom check reads all
// three. Installs plain writable own-properties on the given element so a
// test can set up a concrete "scrolled up" or "at the bottom" geometry and
// later read back wherever updateOperationLog() left scrollTop. A no-op
// setter-free own-property (not a getter/setter pair) is enough since
// production code only ever reads scrollHeight/clientHeight and reads+
// writes scrollTop — the same shape a real element's IDL properties have.
function stubScrollMetrics(el, { scrollHeight = 0, clientHeight = 0, scrollTop = 0 } = {}) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, writable: true, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, writable: true, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
}

describe('operation modal — open/close/escape/focus', () => {
  it('mountOperationModal() renders the modal hidden by default', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal } = loadOperationModalHelpers(html);
      mountOperationModal(document.getElementById('operation-modal-host'));
      assert.equal(document.getElementById('op-modal-backdrop').style.display, 'none');
    });
  });

  it('openOperationModal() shows the backdrop and moves focus to the close button', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{ id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null }] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      // linkedom does not implement document.activeElement at all (confirmed
      // directly in node_modules/linkedom) — .focus() only dispatches a
      // 'focus' event on the target, it never updates any tracked "current
      // focus" state. Listening for that event is the one way this harness
      // can observe "something called .focus() on this element."
      let focusedCloseBtn = false;
      document.getElementById('op-modal-close').addEventListener('focus', () => { focusedCloseBtn = true; });
      openOperationModal('op1');
      await __settle();
      assert.equal(document.getElementById('op-modal-backdrop').style.display, '');
      assert.equal(focusedCloseBtn, true, 'openOperationModal() must call .focus() on the close button');
    });
  });

  it('closeOperationModal() hides the backdrop and returns focus to whatever triggered the open', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, closeOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{ id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null }] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      const trigger = document.createElement('button');
      trigger.id = 'test-trigger-btn';
      document.body.appendChild(trigger);
      let focusedTrigger = false;
      trigger.addEventListener('focus', () => { focusedTrigger = true; });
      trigger.focus();
      focusedTrigger = false; // reset — only the RETURN focus (after close) counts
      openOperationModal('op1');
      await __settle();
      closeOperationModal();
      assert.equal(document.getElementById('op-modal-backdrop').style.display, 'none');
      assert.equal(focusedTrigger, true, 'focus must return to the element that had it before the modal opened');
    });
  });

  it('the close button click closes the modal', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{ id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null }] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      document.getElementById('op-modal-close').click();
      assert.equal(document.getElementById('op-modal-backdrop').style.display, 'none');
    });
  });

  it('clicking the backdrop itself (not the modal box) closes the modal', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{ id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null }] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      const backdrop = document.getElementById('op-modal-backdrop');
      // document.createEvent + initEvent — the one dispatch path that
      // actually works in this harness (linkedom's dispatchEvent throws on
      // a plain `new Event()` instance; see simulateToggle() above for the
      // same pattern already established for <details> toggle events).
      const ev = document.createEvent('Event');
      ev.initEvent('click', true, true);
      backdrop.dispatchEvent(ev);
      assert.equal(backdrop.style.display, 'none');
    });
  });

  it('Escape closes the modal when open', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{ id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null }] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      const ev = document.createEvent('Event');
      ev.initEvent('keydown', true, true);
      ev.key = 'Escape';
      document.dispatchEvent(ev);
      assert.equal(document.getElementById('op-modal-backdrop').style.display, 'none');
    });
  });

  it('has an accessible title (aria-labelledby) and role="dialog" aria-modal="true"', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal } = loadOperationModalHelpers(html);
      mountOperationModal(document.getElementById('operation-modal-host'));
      const dialog = document.getElementById('op-modal');
      assert.equal(dialog.getAttribute('role'), 'dialog');
      assert.equal(dialog.getAttribute('aria-modal'), 'true');
      assert.equal(dialog.getAttribute('aria-labelledby'), 'op-modal-title');
      assert.ok(document.getElementById('op-modal-title'));
    });
  });
});

// Regression (P1, code review): openOperationModal(id) calls pollNow() (a
// fetch not yet resolved) and render() SYNCHRONOUSLY, back to back — so the
// very first render() runs against the store's snapshot from BEFORE this
// call, which for a brand-new operation started later in the session does
// not contain the requested id yet. The old render() unconditionally fell
// back to operations[0] whenever the requested id wasn't found, AND
// permanently rebound openOperationId to that fallback — so opening the
// modal on a second operation within the same session could silently show
// (and get stuck showing) a completely different, older operation.
describe('operation modal — a specific id not yet in the store\'s snapshot shows loading, never a stale fallback operation', () => {
  it('shows a loading state (not operations[0]) when the requested id has not been polled yet, then resolves once it has', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      // The store's snapshot starts with an OLDER, unrelated operation
      // already in it (as if a previous openOperationModal() call earlier
      // in the session had already polled once) — apiCallCount controls
      // when the NEW operation ("op-new") actually appears in a fetch
      // response, simulating the real race: the fetch triggered by this
      // openOperationModal() call hasn't resolved by the time render()
      // first runs.
      let apiCallCount = 0;
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => {
          apiCallCount += 1;
          if (apiCallCount === 1) {
            // Simulates the store already having a snapshot from before
            // this openOperationModal() call — the FIRST synchronous
            // render() inside openOperationModal() reads this.
            return { operations: [{ id: 'op-old', kind: 'index', collection: 'old-docs', state: 'succeeded', startedAt: new Date(Date.now() - 60000).toISOString(), finishedAt: new Date(Date.now() - 55000).toISOString(), cancellable: false, progress: null }] };
          }
          // From the second poll onward, the new operation is visible —
          // simulating the concurrent pollNow() finally resolving.
          return { operations: [
            { id: 'op-new', kind: 'index', collection: 'new-docs', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null },
            { id: 'op-old', kind: 'index', collection: 'old-docs', state: 'succeeded', startedAt: new Date(Date.now() - 60000).toISOString(), finishedAt: new Date(Date.now() - 55000).toISOString(), cancellable: false, progress: null },
          ] };
        },
      });
      mountOperationModal(document.getElementById('operation-modal-host'));

      // Seed the store with the "old" snapshot first (as if a prior
      // openOperationModal() call had already run one poll).
      openOperationModal('op-old');
      await __settle();
      assert.match(document.getElementById('op-modal-body').querySelector('.job-title')?.textContent ?? '', /old-docs/, 'sanity: the modal is showing the old operation first');

      // Now open on the brand-new id — its poll hasn't resolved by the time
      // openOperationModal()'s own synchronous render() call runs.
      openOperationModal('op-new');
      const bodyRightAfterCall = document.getElementById('op-modal-body').textContent;
      assert.doesNotMatch(bodyRightAfterCall, /old-docs/,
        'the modal must NEVER show the stale "old-docs" operation as a fallback for a specific id that has not been polled yet — it must show a loading state instead');
      assert.match(bodyRightAfterCall, /Loading operation/);

      await __settle();
      assert.match(document.getElementById('op-modal-body').querySelector('.job-title')?.textContent ?? '', /new-docs/,
        'once the poll resolves with the requested operation, the modal must show it');
    });
  });

  it('a second render tick after the loading state still does not get stuck on a stale fallback if the id keeps being absent', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        // The requested id is NEVER present — an extreme edge case (e.g. the
        // backend genuinely never created it, or it was evicted) — the
        // modal must keep showing "loading", never silently swap to
        // whatever operation happens to be in the list.
        apiImpl: async () => ({ operations: [{ id: 'unrelated', kind: 'repair', collection: 'other', state: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), cancellable: false, progress: null }] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('never-appears');
      await __settle();
      const body = document.getElementById('op-modal-body');
      assert.doesNotMatch(body.textContent, /other/, 'must never fall back to an unrelated operation for a pinned, specific id');
      assert.match(body.textContent, /Loading operation/);
    });
  });
});

describe('operation modal — rendering', () => {
  it('renders the current operation with known progress: percentage, phase, and file count', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{
          id: 'op1', kind: 'index', collection: 'demo', state: 'running',
          startedAt: new Date().toISOString(), finishedAt: null, cancellable: true,
          progress: { percent: 55, phase: 'Embedding chunks', currentFile: 'b.md', processedFiles: 2, totalFiles: 4 },
        }] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      const body = document.getElementById('op-modal-body');
      assert.match(body.querySelector('.job-progress-fill').style.width, /55%/);
      assert.match(body.querySelector('.job-progress-step').textContent, /Embedding chunks/);
      assert.match(body.querySelector('.job-progress-count').textContent, /2 \/ 4 files processed/);
    });
  });

  it('renders an indeterminate bar when progress is unavailable (e.g. a repair task)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{
          id: 'op1', kind: 'repair', collection: 'demo', state: 'running',
          startedAt: new Date().toISOString(), finishedAt: null, cancellable: false, progress: null,
        }] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      const body = document.getElementById('op-modal-body');
      assert.equal(body.querySelector('.job-progress-bar').hidden, true);
      assert.equal(body.querySelector('.job-progress-indeterminate').hidden, false);
    });
  });

  it('shows a cancel button only for a cancellable active operation', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{
          id: 'op1', kind: 'repair', collection: 'demo', state: 'running',
          startedAt: new Date().toISOString(), finishedAt: null, cancellable: false, progress: null,
        }] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      assert.equal(document.getElementById('op-modal-body').querySelector('.job-cancel').hidden, true,
        'repair is never cancellable, even while running');
    });
  });

  it('cancel button click POSTs to /api/jobs/:id/cancel', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const posted = [];
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{
          id: 'op1', kind: 'index', collection: 'demo', state: 'running',
          startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null,
        }] }),
        apiPostImpl: async (url) => { posted.push(url); return {}; },
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      document.getElementById('op-modal-body').querySelector('.job-cancel').click();
      await __settle();
      assert.ok(posted.some(u => u.includes('/api/jobs/op1/cancel')));
    });
  });

  it('renders a compact recent-operations history list (operation, collection, status, duration only)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [
          { id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null },
          { id: 'op2', kind: 'repair', collection: 'other', state: 'succeeded', startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(), cancellable: false, progress: null },
        ] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      const historyList = document.getElementById('op-history-list');
      const rows = historyList.querySelectorAll('.op-history-row');
      assert.equal(rows.length, 1, 'the currently-open operation must not also appear in its own history list');
      assert.match(rows[0].querySelector('.op-history-label').textContent, /repair.*other|other.*repair/);
      assert.doesNotMatch(historyList.textContent, /job-path|job-log/, 'history rows must not carry per-row log/path fields');
    });
  });

  it('selecting a history row switches the modal to that operation', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [
          { id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null },
          { id: 'op2', kind: 'repair', collection: 'other', state: 'succeeded', startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(), cancellable: false, progress: null },
        ] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      document.querySelector('.op-history-row').click();
      await __settle();
      assert.match(document.getElementById('op-modal-body').querySelector('.job-title').textContent, /other/);
    });
  });
});

describe('operation modal — manual "Show details" state survives polling (ported from jobs-view.js)', () => {
  it('a running operation with details left untouched stays closed across polling, including as progress changes', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const op = {
        id: 'op1', kind: 'index', collection: 'demo', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true,
        progress: { percent: 20, phase: null, currentFile: 'a.md', processedFiles: 1, totalFiles: 5 },
      };
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...op, sourcePath: './docs', log: [] } } : { operations: [op] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), false);

      op.progress = { ...op.progress, processedFiles: 3, percent: 60 };
      __runTimeouts(); // next scheduled poll tick
      await __settle();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), false,
        'an untouched running operation must stay closed even as its progress updates');
    });
  });

  it('a user-opened details on a still-running operation survives a poll re-render', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const op = {
        id: 'op1', kind: 'index', collection: 'demo', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true,
        progress: { percent: 20, phase: null, currentFile: 'a.md', processedFiles: 1, totalFiles: 5 },
      };
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...op, sourcePath: './docs', log: ['line one'] } } : { operations: [op] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      const details = document.querySelector('.job-details');
      assert.equal(details.hasAttribute('open'), false);
      simulateToggle(document, details, true);

      op.progress = { ...op.progress, processedFiles: 4, percent: 80 };
      __runTimeouts();
      await __settle();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), true,
        'the user-opened details must survive a poll re-render with new progress');
    });
  });

  it('a failed operation auto-expands details when the user has never manually toggled it', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const op = {
        id: 'op1', kind: 'index', collection: 'demo', state: 'failed',
        startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(), cancellable: false,
        progress: null, error: 'boom',
      };
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...op, sourcePath: './docs', log: ['[stderr] boom'] } } : { operations: [op] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), true,
        'a failed operation must auto-expand its details when the user has no prior manual state');
    });
  });

  it('a user manually closing a failed operation\'s details is respected — polling does not reopen it', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const op = {
        id: 'op1', kind: 'index', collection: 'demo', state: 'failed',
        startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(), cancellable: false,
        progress: null, error: 'boom',
      };
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...op, sourcePath: './docs', log: ['[stderr] boom'] } } : { operations: [op] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      const details = document.querySelector('.job-details');
      assert.equal(details.hasAttribute('open'), true, 'sanity: auto-opened since it starts failed');
      simulateToggle(document, details, false);

      __runTimeouts();
      await __settle();
      assert.equal(document.querySelector('.job-details').hasAttribute('open'), false,
        'a manual close on a failed operation must not be reopened by the next poll');
    });
  });
});

describe('operation modal — completion toast', () => {
  it('fires a success toast exactly once when an operation transitions to succeeded, not once per poll tick', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let state = 'running';
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{
          id: 'op1', kind: 'index', collection: 'demo', state,
          startedAt: new Date().toISOString(), finishedAt: state === 'succeeded' ? new Date().toISOString() : null,
          cancellable: state === 'running', progress: null,
        }] }),
      });
      // #toast-host already exists in the real built index.html this test
      // parses (see index.html) — reused directly rather than creating a
      // second one (a manually-created duplicate id confuses linkedom's
      // getElementById query cache and silently breaks showToast()'s own
      // $('#toast-host') lookup).
      const toastHost = document.getElementById('toast-host');

      // Counts actual toast-creation calls rather than currently-present DOM
      // nodes — showToast() schedules its own 8s auto-dismiss setTimeout,
      // which __runTimeouts() (a blunt "fire every captured timeout"
      // helper) also ends up triggering, so a snapshot of toastHost's
      // CURRENT children after a second __runTimeouts() call conflates "did
      // a second toast get created" with "did the first one just get
      // auto-dismissed." A MutationObserver-free child-count delta across
      // each step sidesteps that entirely.
      let toastsSeen = 0;
      const originalAppendChild = toastHost.appendChild.bind(toastHost);
      toastHost.appendChild = (node) => { toastsSeen += 1; return originalAppendChild(node); };

      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle(); // first sighting — no transition yet
      assert.equal(toastsSeen, 0);

      state = 'succeeded';
      __runTimeouts();
      await __settle();
      assert.equal(toastsSeen, 1);
      assert.match(toastHost.textContent, /demo/);

      __runTimeouts(); // further polls of the same succeeded state must not re-toast
      await __settle();
      assert.equal(toastsSeen, 1,
        'a completion toast must fire once per transition, not once per poll tick');
    });
  });

  it('a failure toast never exposes a raw log, env var, or URL-with-credentials — only the short sanitised error field', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let state = 'running';
      const secretLog = 'connecting to https://user:sk-super-secret-token@qdrant.example.com/collections';
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{
          id: 'op1', kind: 'index', collection: 'demo', state,
          startedAt: new Date().toISOString(), finishedAt: state === 'failed' ? new Date().toISOString() : null,
          cancellable: state === 'running', progress: null,
          error: state === 'failed' ? 'Qdrant unreachable' : null, // the sanitised field the backend actually exposes — see api/operations.js
        }] }),
      });
      const toastHost = document.getElementById('toast-host');

      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();

      state = 'failed';
      __runTimeouts();
      await __settle();
      const toastText = toastHost.querySelector('.toast').textContent;
      assert.match(toastText, /Qdrant unreachable/);
      assert.doesNotMatch(toastText, /sk-super-secret-token|user:.*@|QDRANT_KEY|process\.env/i,
        'the toast must never surface a raw secret/credential/env-var, even if one somehow ended up in a log line');
    });
  });

  it('the toast\'s "View" action reopens the modal on that exact completed operation', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let state = 'running';
      const { document, mountOperationModal, openOperationModal, closeOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async () => ({ operations: [{
          id: 'op1', kind: 'index', collection: 'demo', state,
          startedAt: new Date().toISOString(), finishedAt: state === 'succeeded' ? new Date().toISOString() : null,
          cancellable: state === 'running', progress: null,
        }] }),
      });
      const toastHost = document.getElementById('toast-host');

      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      closeOperationModal();

      state = 'succeeded';
      __runTimeouts();
      await __settle();
      assert.equal(document.getElementById('op-modal-backdrop').style.display, 'none', 'sanity: modal is closed before clicking the toast action');

      toastHost.querySelector('.toast-action').click();
      assert.equal(document.getElementById('op-modal-backdrop').style.display, '', 'clicking the toast action must reopen the modal');
    });
  });
});

describe('operation modal — stable DOM across poll updates for the same operation', () => {
  it('two poll updates for the same id leave the same .job-card DOM node in place', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const op = {
        id: 'op1', kind: 'index', collection: 'demo', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true,
        progress: { percent: 20, phase: null, currentFile: 'a.md', processedFiles: 1, totalFiles: 5 },
      };
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...op, sourcePath: './docs', log: [] } } : { operations: [op] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      const firstCard = document.querySelector('.job-card');
      assert.ok(firstCard);

      op.progress = { ...op.progress, processedFiles: 2, percent: 40 };
      __runTimeouts();
      await __settle();
      op.progress = { ...op.progress, processedFiles: 3, percent: 60 };
      __runTimeouts();
      await __settle();

      const secondCard = document.querySelector('.job-card');
      assert.equal(secondCard, firstCard, 'the .job-card DOM node must be reused across poll updates for the same operation id');
      assert.match(secondCard.querySelector('.job-progress-fill').style.width, /60%/, 'the in-place update must still reflect the latest progress');
    });
  });

  it('switching to a different operation creates a new .job-card node', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => {
          if (url.includes('/api/operations/')) return { operation: { id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null, sourcePath: '.', log: [] } };
          return { operations: [
            { id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null },
            { id: 'op2', kind: 'repair', collection: 'other', state: 'succeeded', startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(), cancellable: false, progress: null },
          ] };
        },
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      const firstCard = document.querySelector('.job-card');

      openOperationModal('op2');
      await __settle();
      const secondCard = document.querySelector('.job-card');
      assert.notEqual(secondCard, firstCard, 'switching to a different operation id must create a brand-new .job-card node');
      assert.match(secondCard.querySelector('.job-title').textContent, /other/);
    });
  });

  it('polling does not create duplicate event listeners (cancel button fires exactly one POST per click, across many in-place updates)', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const op = {
        id: 'op1', kind: 'index', collection: 'demo', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true,
        progress: { percent: 10, phase: null, currentFile: null, processedFiles: 0, totalFiles: 5 },
      };
      const posted = [];
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...op, sourcePath: '.', log: [] } } : { operations: [op] }),
        apiPostImpl: async (url) => { posted.push(url); return {}; },
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();

      for (let i = 0; i < 5; i += 1) {
        op.progress = { ...op.progress, processedFiles: i, percent: 10 + i * 10 };
        __runTimeouts();
        await __settle();
      }

      document.querySelector('.job-cancel').click();
      await __settle();
      assert.equal(posted.filter(u => u.includes('/api/jobs/op1/cancel')).length, 1,
        'many in-place poll updates must never stack additional click listeners on the cancel button — exactly one POST per click');
    });
  });

  it('cancel button works after many in-place updates', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const op = {
        id: 'op1', kind: 'index', collection: 'demo', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null,
      };
      const posted = [];
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...op, sourcePath: '.', log: [] } } : { operations: [op] }),
        apiPostImpl: async (url) => { posted.push(url); return {}; },
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      __runTimeouts();
      await __settle();
      __runTimeouts();
      await __settle();

      document.querySelector('.job-cancel').click();
      await __settle();
      assert.ok(posted.some(u => u.includes('/api/jobs/op1/cancel')), 'cancel must still work after multiple in-place updates');
    });
  });
});

describe('operation modal — log scroll preservation', () => {
  it('a log scrolled up preserves its scrollTop after new lines are appended', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let logLines = ['line 1', 'line 2', 'line 3'];
      const op = {
        id: 'op1', kind: 'index', collection: 'demo', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null,
      };
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...op, sourcePath: '.', log: logLines } } : { operations: [op] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();

      const pre = document.querySelector('.job-log');
      // User has scrolled up, away from the bottom.
      stubScrollMetrics(pre, { scrollHeight: 200, clientHeight: 50, scrollTop: 40 });

      logLines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'];
      __runTimeouts();
      await __settle();

      assert.match(pre.textContent, /line 5/, 'sanity: the log text was actually updated');
      assert.equal(pre.scrollTop, 40, 'a log the user scrolled up in must keep its scrollTop after new lines are appended');
    });
  });

  it('a log near the bottom stays pinned to the bottom after new lines are appended', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let logLines = ['line 1', 'line 2', 'line 3'];
      const op = {
        id: 'op1', kind: 'index', collection: 'demo', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null,
      };
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...op, sourcePath: '.', log: logLines } } : { operations: [op] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();

      const pre = document.querySelector('.job-log');
      // scrollHeight - scrollTop - clientHeight === 0 -> at the bottom.
      // linkedom has no real layout engine, so scrollHeight is a static
      // stubbed value here rather than something that would genuinely grow
      // as new lines are appended (as it would in a real browser) — the
      // behavior under test is "scrollTop is pinned to scrollHeight",
      // which holds regardless of what scrollHeight's actual value is.
      stubScrollMetrics(pre, { scrollHeight: 200, clientHeight: 50, scrollTop: 150 });

      logLines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'];
      __runTimeouts();
      await __settle();

      assert.match(pre.textContent, /line 5/, 'sanity: the log text was actually updated');
      assert.equal(pre.scrollTop, pre.scrollHeight, 'a log the user was at the bottom of must be scrolled to the new bottom after new lines are appended');
    });
  });

  it('an unchanged log does not receive a redundant textContent update', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const logLines = ['line 1', 'line 2'];
      const op = {
        id: 'op1', kind: 'index', collection: 'demo', state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, cancellable: true,
        progress: { percent: 10, phase: null, currentFile: null, processedFiles: 0, totalFiles: 5 },
      };
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...op, sourcePath: '.', log: logLines } } : { operations: [op] }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();

      const pre = document.querySelector('.job-log');
      let textContentSets = 0;
      // textContent's real getter/setter live on some prototype in pre's
      // chain (Element.prototype in linkedom) — walk up until found, rather
      // than assuming a fixed depth, so this stays correct regardless of
      // exactly which class in the chain defines it.
      let proto = Object.getPrototypeOf(pre);
      let originalDescriptor;
      while (proto && !originalDescriptor) {
        originalDescriptor = Object.getOwnPropertyDescriptor(proto, 'textContent');
        proto = Object.getPrototypeOf(proto);
      }
      assert.ok(originalDescriptor?.set, 'sanity: textContent must be a real accessor somewhere in the prototype chain');
      Object.defineProperty(pre, 'textContent', {
        configurable: true,
        get() { return originalDescriptor.get.call(pre); },
        set(value) { textContentSets += 1; originalDescriptor.set.call(pre, value); },
      });

      // Same log content, only unrelated progress fields change.
      op.progress = { ...op.progress, processedFiles: 1, percent: 20 };
      __runTimeouts();
      await __settle();

      assert.equal(textContentSets, 0, 'an unchanged log must not receive a redundant textContent write');
    });
  });
});

describe('operation modal — stale async log response protection', () => {
  it('a stale log response for a previously-open operation does not overwrite the currently-open one\'s log', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let resolveOp1Detail;
      const op1DetailPromise = new Promise((resolve) => { resolveOp1Detail = resolve; });
      const { document, mountOperationModal, openOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => {
          if (url.includes('/api/operations/op1')) {
            await op1DetailPromise; // never resolves until the test says so — simulates a slow in-flight detail fetch
            return { operation: { id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null, sourcePath: '.', log: ['op1 stale log line'] } };
          }
          if (url.includes('/api/operations/op2')) {
            return { operation: { id: 'op2', kind: 'index', collection: 'other', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null, sourcePath: '.', log: ['op2 fresh log line'] } };
          }
          return { operations: [
            { id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null },
            { id: 'op2', kind: 'index', collection: 'other', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null },
          ] };
        },
      });
      mountOperationModal(document.getElementById('operation-modal-host'));

      // Open op1 — its detail fetch (including the log) starts but never
      // resolves yet (blocked on op1DetailPromise).
      openOperationModal('op1');
      await __settle();

      // Switch to op2 before op1's detail fetch has resolved.
      openOperationModal('op2');
      await __settle();
      assert.match(document.querySelector('.job-log')?.textContent ?? '', /op2 fresh log line/, 'sanity: op2 is now showing its own log');

      // Now let op1's stale detail fetch finally resolve.
      resolveOp1Detail();
      await __settle();

      assert.doesNotMatch(document.querySelector('.job-log')?.textContent ?? '', /op1 stale log line/,
        'a stale log response for a previously-open operation must never overwrite the currently-open operation\'s log');
      assert.match(document.querySelector('.job-log')?.textContent ?? '', /op2 fresh log line/,
        'op2\'s own log must remain intact after op1\'s stale response lands');
    });
  });

  it('a stale log response arriving after the modal has closed does not touch any DOM', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let resolveDetail;
      const detailPromise = new Promise((resolve) => { resolveDetail = resolve; });
      const { document, mountOperationModal, openOperationModal, closeOperationModal, __settle } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => {
          if (url.includes('/api/operations/op1')) {
            await detailPromise;
            return { operation: { id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null, sourcePath: '.', log: ['late log line'] } };
          }
          return { operations: [{ id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null }] };
        },
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      closeOperationModal();

      resolveDetail();
      await __settle();

      // No crash and no stray text applied anywhere — the body was already
      // torn down by close (openOperationModal() clears backdrop/state);
      // reopening should show a clean state, not a leftover from the
      // pre-close fetch.
      assert.equal(document.getElementById('op-modal-backdrop').style.display, 'none');
    });
  });
});

describe('operation modal — recent operations history isolation', () => {
  it('a history-list-only data change (unrelated to the open card) does not rebuild history DOM rows unnecessarily', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const ops = [
        { id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: { percent: 10, phase: null, currentFile: null, processedFiles: 0, totalFiles: 5 } },
        { id: 'op2', kind: 'repair', collection: 'other', state: 'succeeded', startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(), cancellable: false, progress: null },
      ];
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...ops[0], sourcePath: '.', log: [] } } : { operations: ops }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();
      const firstHistoryRow = document.querySelector('.op-history-row');
      assert.ok(firstHistoryRow);

      // Only the OPEN card's progress changes — op2 (the only history row)
      // is untouched.
      ops[0].progress = { ...ops[0].progress, processedFiles: 2, percent: 40 };
      __runTimeouts();
      await __settle();

      const secondHistoryRow = document.querySelector('.op-history-row');
      assert.equal(secondHistoryRow, firstHistoryRow, 'history DOM rows must not be rebuilt when the history list\'s own data is unchanged');
    });
  });

  it('history list updates do not affect the open card\'s details state or log scroll', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const ops = [
        { id: 'op1', kind: 'index', collection: 'demo', state: 'running', startedAt: new Date().toISOString(), finishedAt: null, cancellable: true, progress: null },
        { id: 'op2', kind: 'repair', collection: 'other', state: 'running', startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: null, cancellable: false, progress: null },
      ];
      const { document, mountOperationModal, openOperationModal, __settle, __runTimeouts } = loadOperationModalHelpers(html, {
        apiImpl: async (url) => (url.includes('/api/operations/') ? { operation: { ...ops[0], sourcePath: '.', log: ['a line'] } } : { operations: ops }),
      });
      mountOperationModal(document.getElementById('operation-modal-host'));
      openOperationModal('op1');
      await __settle();

      const details = document.querySelector('.job-details');
      simulateToggle(document, details, true);
      const pre = document.querySelector('.job-log');
      stubScrollMetrics(pre, { scrollHeight: 200, clientHeight: 50, scrollTop: 40 });

      // Change something in the history-only operation (op2) — its state
      // changes, which changes the history row's rendered badge/label.
      ops[1] = { ...ops[1], state: 'succeeded', finishedAt: new Date().toISOString() };
      __runTimeouts();
      await __settle();

      assert.equal(document.querySelector('.job-details').hasAttribute('open'), true,
        'a history-list-only change must not affect the open card\'s details state');
      assert.equal(document.querySelector('.job-log').scrollTop, 40,
        'a history-list-only change must not affect the open card\'s log scroll position');
    });
  });
});
