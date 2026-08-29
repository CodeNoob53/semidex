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
import { bootCapabilities } from './shared/capabilities/boot.js';

// The shell's own top-level view controller (design plan §8.4/§8.6) — never
// disposed today (the shell itself never unmounts before a full page
// navigation), but its `signal` is still the correct owner for every
// shell-level listener registered here, matching the one lifecycle
// convention every per-feature view controller will use from S2 onward.
const shellView = createViewController();

/**
 * @param {{ edition: 'full'|'lite' }} opts — build-time edition constant,
 *   supplied ONLY by the Full/Lite composition entry point (entries/full.js
 *   -> 'full', entries/lite.js -> 'lite'). Kept at this one call site
 *   (design plan §6) rather than scattered through views.
 */
export function startAdminApp({ edition } = {}) {
  initSidebarResize();
  window.addEventListener('hashchange', route, { signal: shellView.signal });

  // Mounted once, at boot, outside #main — the shared operation-status
  // controller (operation-store.js) starts polling here too, independent of
  // route/view lifecycle, so an in-flight operation survives navigation
  // (Phase 3S requirement 1) rather than depending on whichever view
  // happened to start it staying mounted.
  mountOperationModal($('#operation-modal-host'));
  startPolling();

  // Boot capability object (design plan §6): resolved once, here, from the
  // real GET /api/capabilities response plus this entry's own edition
  // constant. A rejected boot fetch is not fatal to the rest of the app —
  // every reader (topbar, Overview) treats a still-null capabilities()
  // as "checking…" and degrades honestly rather than throwing.
  bootCapabilities({ edition }).catch(() => {});

  loadTopbar();
  initJobChip();
  initGlobalSettingsLink();
  loadSidebar();
  route();
}
