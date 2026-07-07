// semidex admin console — bootstrap/composition only. All view logic lives
// in the sibling modules; see docs/admin-ui-refactor-modules-2026-07-07.md
// for the module map.
'use strict';

import { initSidebarResize } from './sidebar-resize.js';
import { loadSidebar } from './sidebar.js';
import { loadTopbar } from './topbar.js';
import { route } from './router.js';

export function startAdminApp() {
  initSidebarResize();
  window.addEventListener('hashchange', route);

  loadTopbar();
  loadSidebar();
  route();
}
