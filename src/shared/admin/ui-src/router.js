// ── router ────────────────────────────────────────────────────────────────
import { $, errorBox } from './dom.js';
import { api } from './api.js';
import { openFileView, openSectionView, hideCollectionContent } from './file-view.js';
import { markActive, syncSidebarMode } from './sidebar.js';
import { renderCollection } from './collection-view.js';
import { renderSettingsView } from './settings-view.js';
import { renderGlobalSettingsView, invalidateGlobalSettingsRender } from './global-settings-view.js';
import { renderIndexingView } from './jobs-view.js';
import { applySearchStateFromUrl, syncSearchStateFromUrl } from './search.js';
import { currentRoute } from './routes.js';
import { mount as mountOverview } from './features/overview/view.js';

export { currentRoute };

// The currently-mounted v2 view controller (design plan §8.4), if any —
// Overview is the only v2 lifecycle view in this slice. Tracked here (not
// inside collection-view.js/settings-view.js, which are still the old,
// non-disposable style) so route() can dispose it before mounting whatever
// comes next, regardless of which branch below actually runs.
let currentView = null;

function disposeCurrentView() {
  if (currentView) {
    currentView.dispose();
    currentView = null;
  }
}

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
  // Any in-flight Settings fetch/save that hasn't yet painted must not
  // repaint over whatever non-settings view is about to render here — see
  // global-settings-view.js's own renderGeneration guard. Safe to call
  // even if Settings was never visited (a no-op bump of an unused
  // counter); the router doesn't need to know or track the prior route.
  if (r.view !== 'global-settings') invalidateGlobalSettingsRender();
  syncSidebarMode(r);
  markActive(r);
  // Dispose the outgoing v2 controller (Overview, today) BEFORE doing any
  // work for the next route — synchronously, so its in-flight fetches abort
  // and its generation invalidates before any other branch below starts
  // rendering. This is what stops a superseded Overview mount from ever
  // painting over whatever screen a later route() call is navigating to
  // (design plan §8.4/§13 S1: "Repeated route() calls and rapid hash
  // changes must not let an old Overview paint over another screen").
  disposeCurrentView();
  if (r.view === 'settings') await renderSettingsView(main, r.name);
  else if (r.view === 'global-settings') await renderGlobalSettingsView(main, r.category);
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
      //
      // But syncSearchStateFromUrl() only clears the file/section view as a
      // side effect of actually running a search (runSearch() calls
      // hideCollectionContent()) — it never runs one when the URL has no
      // "?q=" at all. Without this, navigating back (browser Back, or a
      // sidebar click to the bare collection) from an open file/section to
      // a query-less bare collection route left the previous file/section
      // content on screen indefinitely, since renderCollection() itself
      // deliberately skips resetting #collection-content while staying on
      // the same collection (to avoid wiping an in-progress search on every
      // file/section click). Explicitly clear it here for the one case
      // syncSearchStateFromUrl doesn't cover.
      if (!currentRoute().search?.q) hideCollectionContent();
      syncSearchStateFromUrl(r.name);
    }
  } else if (r.view === 'index') await renderIndexingView(main);
  else currentView = mountOverview(main, {});
  // Re-run after the branch above resolves: the sidebar's skeleton-tree/
  // file-list rows for the target collection render asynchronously
  // (loadSidebarTree), so the first markActive(r) call above (made before
  // those awaits) can't yet find the row to highlight.
  markActive(r);
}
