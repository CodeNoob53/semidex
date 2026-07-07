// ── router ────────────────────────────────────────────────────────────────
import { $, errorBox } from './dom.js';
import { api } from './api.js';
import { openFileView, openSectionView } from './file-view.js';
import { markActive } from './sidebar.js';
import { renderCollection, renderOverview } from './collection-view.js';
import { renderSettingsView } from './settings-view.js';
import { renderIndexingView } from './jobs-view.js';
import { applySearchStateFromUrl, syncSearchStateFromUrl } from './search.js';
import { currentRoute } from './routes.js';

export { currentRoute };

// Resolves a bare nodePath (arrived via URL/back-forward, no live sidebar
// DOM node to hand off) into a full skeleton node object, then reuses the
// same anchor-resolution/content-loading path a sidebar click already uses.
export async function openNodeFromPath(name, nodePath) {
  try {
    const { node } = await api(`/api/collections/${encodeURIComponent(name)}/skeleton/node?nodePath=${encodeURIComponent(nodePath)}`);
    return openSectionView(name, node);
  } catch (err) {
    const box = $('#collection-content');
    if (box) box.innerHTML = errorBox(err);
  }
}

export async function route() {
  const main = $('#main');
  const r = currentRoute();
  markActive(r);
  if (r.view === 'settings') await renderSettingsView(main, r.name);
  else if (r.view === 'collection') {
    await renderCollection(main, r.name);
    if (r.openFile) {
      await openFileView(r.name, r.openFile);
      // Keep the search form's fields in sync with "?q=..." even on a
      // file route (e.g. back/forward between two #/c/name/f/x?q=cats and
      // ?q=dogs states) — but never re-run the search here, since that
      // would call hideCollectionContent() and immediately hide the file
      // view this route just opened.
      applySearchStateFromUrl(r.name);
    } else if (r.openNodePath) {
      await openNodeFromPath(r.name, r.openNodePath);
      applySearchStateFromUrl(r.name);
    } else {
      // Bare collection route: no open file/section to protect, so a
      // genuinely new "?q=..." should actually run the search.
      // syncSearchStateFromUrl no-ops if the URL's search params haven't
      // changed since search.js last saw them, so this is safe on every
      // bare-collection navigation, not just the first mount.
      syncSearchStateFromUrl(r.name);
    }
  } else if (r.view === 'index') await renderIndexingView(main);
  else await renderOverview(main);
  // Re-run after the branch above resolves: the sidebar's skeleton-tree/
  // file-list rows for the target collection render asynchronously
  // (loadSidebarTree), so the first markActive(r) call above (made before
  // those awaits) can't yet find the row to highlight.
  markActive(r);
}
