// semidex admin console — bootstrap/composition only. All view logic lives
// in the sibling modules; see docs/admin-ui-refactor-modules-2026-07-07.md
// for the module map.
'use strict';

import { $ } from './dom.js';
import { initSidebarResize } from './sidebar-resize.js';
import { loadSidebar } from './sidebar.js';
import { loadTopbar, initJobChip, initGlobalSettingsLink } from './topbar.js';
import { route } from './router.js';
import { mountOperationModal } from './operation-modal.js';
import { startPolling } from './operation-store.js';
import { createViewController } from './shared/lifecycle/view.js';

// The shell's own top-level view controller (design plan §8.4/§8.6) — never
// disposed today (the shell itself never unmounts before a full page
// navigation), but its `signal` is still the correct owner for every
// shell-level listener registered here, matching the one lifecycle
// convention every per-feature view controller will use from S2 onward.
const shellView = createViewController();

export function startAdminApp() {
  initSidebarResize();
  window.addEventListener('hashchange', route, { signal: shellView.signal });

  // Mounted once, at boot, outside #main — the shared operation-status
  // controller (operation-store.js) starts polling here too, independent of
  // route/view lifecycle, so an in-flight operation survives navigation
  // (Phase 3S requirement 1) rather than depending on whichever view
  // happened to start it staying mounted.
  mountOperationModal($('#operation-modal-host'));
  startPolling();

  loadTopbar();
  initJobChip();
  initGlobalSettingsLink();
  loadSidebar();
  route();
}
