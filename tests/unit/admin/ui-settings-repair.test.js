// Tests for src/admin/ui-src/settings-view.js's runSettingsRepair() —
// specifically its integration with the shared operation store/modal/toast
// stack (Phase 3S code review, P1: "repair не інтегрований у modal/toast
// workflow"). Exercises the REAL operation-store.js/operation-modal.js/
// operation-render.js/toasts.js/settings-view.js wiring together (not
// stubbed), with api()/apiPost() stubbed and timers captured — same
// convention as ui-operation-modal.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSettingsRepairHelpers, withServer } from './ui-test-helpers.js';

const COLLECTION_DETAIL = {
  pointCount: 10, warnings: [], hasSkeleton: false,
  vectorSchema: {}, provider: {}, versions: {},
};

describe('runSettingsRepair() opens the operation modal and fires a completion toast', () => {
  it('a successful repair opens the modal on the repair operation and fires a success toast', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, renderSettingsView, runSettingsRepair, __settle } = loadSettingsRepairHelpers(html, {
        apiImpl: async (url) => {
          if (url.startsWith('/api/operations')) {
            return {
              operations: [{
                id: 'repair-1', kind: 'repair', collection: 'my-docs', path: null, state: 'succeeded',
                startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
                cancellable: false, progress: null, error: null,
              }],
            };
          }
          return { collection: COLLECTION_DETAIL };
        },
        apiPostImpl: async () => ({ id: 'repair-1', collection: 'my-docs', repaired: ['index x'], warnings: [] }),
      });

      mountOperationModal(document.getElementById('operation-modal-host'));
      await renderSettingsView(document.getElementById('main'), 'my-docs');
      await __settle();

      await runSettingsRepair('my-docs');
      await __settle();

      const modalOpen = document.getElementById('op-modal-backdrop')?.style.display === '';
      assert.equal(modalOpen, true, 'runSettingsRepair() must open the operation modal, not leave repair invisible outside the settings page');
      assert.match(document.getElementById('op-modal-body')?.querySelector('.job-title')?.textContent ?? '', /my-docs/);

      const toastHost = document.getElementById('toast-host');
      assert.equal(toastHost.querySelectorAll('.toast').length, 1, 'a successful repair must fire exactly one completion toast, the same as indexing/reindex');
      assert.match(toastHost.querySelector('.toast').className, /toast-success/);
    });
  });

  it('a failed repair still opens the modal (on the failed operation) and fires a failure toast', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, renderSettingsView, runSettingsRepair, __settle } = loadSettingsRepairHelpers(html, {
        apiImpl: async (url) => {
          if (url.startsWith('/api/operations')) {
            return {
              operations: [{
                id: 'repair-2', kind: 'repair', collection: 'my-docs', path: null, state: 'failed',
                startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
                cancellable: false, progress: null, error: 'Qdrant unreachable',
              }],
            };
          }
          return { collection: COLLECTION_DETAIL };
        },
        apiPostImpl: async () => {
          const err = new Error('Qdrant unreachable');
          err.status = 500;
          throw err;
        },
      });

      mountOperationModal(document.getElementById('operation-modal-host'));
      await renderSettingsView(document.getElementById('main'), 'my-docs');
      await __settle();

      await runSettingsRepair('my-docs');
      await __settle();

      const modalOpen = document.getElementById('op-modal-backdrop')?.style.display === '';
      assert.equal(modalOpen, true, 'a FAILED repair must still open the modal — the previous implementation only called pollNow() on success, leaving a failed repair invisible outside the inline settings-page error text');

      const toastHost = document.getElementById('toast-host');
      assert.equal(toastHost.querySelectorAll('.toast').length, 1, 'a failed repair must fire a failure toast, the same as a failed indexing job');
      assert.match(toastHost.querySelector('.toast').className, /toast-error/);
    });
  });

  it('a repair that completes before any poll ever saw it running still produces a transition (not a swallowed first-sighting)', async () => {
    // The core of the P1 fix: repair can finish before a poll ever catches
    // it mid-flight. Simulates exactly that — the store's very FIRST poll
    // of this operation id already shows it succeeded — and confirms the
    // toast still fires (via seedOperationAsRunning(), called by
    // runSettingsRepair() before awaiting the repair call itself).
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      const { document, mountOperationModal, renderSettingsView, runSettingsRepair, __settle } = loadSettingsRepairHelpers(html, {
        apiImpl: async (url) => {
          if (url.startsWith('/api/operations')) {
            return {
              operations: [{
                id: 'fast-repair', kind: 'repair', collection: 'my-docs', path: null, state: 'succeeded',
                startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
                cancellable: false, progress: null, error: null,
              }],
            };
          }
          return { collection: COLLECTION_DETAIL };
        },
        apiPostImpl: async () => ({ id: 'fast-repair', collection: 'my-docs', repaired: [], warnings: [] }),
      });

      mountOperationModal(document.getElementById('operation-modal-host'));
      await renderSettingsView(document.getElementById('main'), 'my-docs');
      await __settle();

      await runSettingsRepair('my-docs');
      await __settle();

      const toastHost = document.getElementById('toast-host');
      assert.equal(toastHost.querySelectorAll('.toast').length, 1,
        'even though the store never observed this operation as "running" before it appeared succeeded, a completion toast must still fire');
    });
  });

  // Why a single poll after the response is sufficient (not a race, unlike
  // the bug this fix replaced): api/collections.js's sync-schema route
  // calls taskRegistry.runTracked() — which creates the task record
  // synchronously, in-memory — BEFORE awaiting the repair work itself, and
  // the HTTP response (success or failure) is only sent once that awaited
  // work finishes. So by the time apiPost() rejects on the frontend, the
  // task has existed on the server for the task's ENTIRE duration already;
  // any GET /api/operations sent only after that rejection (as the catch
  // block below does) cannot possibly race the server into not having
  // created it yet — there is no window for that, unlike the earlier
  // (fixed) bug where pollNow() fired before the POST was even dispatched.
  it('the failure-path lookup does not need to retry — a single post-response poll is causally guaranteed to see the task', async () => {
    await withServer(async (base) => {
      const html = await (await fetch(base + '/')).text();
      let operationsCallCount = 0;
      const { document, mountOperationModal, renderSettingsView, runSettingsRepair, __settle } = loadSettingsRepairHelpers(html, {
        apiImpl: async (url) => {
          if (url.startsWith('/api/operations')) {
            operationsCallCount += 1;
            return {
              operations: [{
                id: 'race-repair', kind: 'repair', collection: 'my-docs', path: null, state: 'failed',
                startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
                cancellable: false, progress: null, error: 'Qdrant unreachable',
              }],
            };
          }
          return { collection: COLLECTION_DETAIL };
        },
        apiPostImpl: async () => {
          const err = new Error('Qdrant unreachable');
          err.status = 500;
          throw err;
        },
      });

      mountOperationModal(document.getElementById('operation-modal-host'));
      await renderSettingsView(document.getElementById('main'), 'my-docs');
      await __settle();

      await runSettingsRepair('my-docs');
      await __settle();

      assert.ok(operationsCallCount >= 1, 'the failure path must poll at least once to locate the failed operation');
      const toastHost = document.getElementById('toast-host');
      assert.equal(toastHost.querySelectorAll('.toast').length, 1);
      const modalOpen = document.getElementById('op-modal-backdrop')?.style.display === '';
      assert.equal(modalOpen, true);
    });
  });
});
