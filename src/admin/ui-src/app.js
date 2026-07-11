// semidex admin console — bootstrap/composition only. All view logic lives
// in the sibling modules; see docs/admin-ui-refactor-modules-2026-07-07.md
// for the module map.
'use strict';

import { $ } from './dom.js';
import { initSidebarResize } from './sidebar-resize.js';
import { loadSidebar } from './sidebar.js';
import { loadTopbar, initJobChip } from './topbar.js';
import { route } from './router.js';
import { mountOperationModal } from './operation-modal.js';
import { startPolling } from './operation-store.js';

export function startAdminApp() {
  initSidebarResize();
  window.addEventListener('hashchange', route);

  // Mounted once, at boot, outside #main — the shared operation-status
  // controller (operation-store.js) starts polling here too, independent of
  // route/view lifecycle, so an in-flight operation survives navigation
  // (Phase 3S requirement 1) rather than depending on whichever view
  // happened to start it staying mounted.
  mountOperationModal($('#operation-modal-host'));
  startPolling();

  loadTopbar();
  initJobChip();
  loadSidebar();
  route();
}
