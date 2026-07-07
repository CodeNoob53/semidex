// ── router ────────────────────────────────────────────────────────────────
import { $, errorBox } from './dom.js';
import { api } from './api.js';
import { openFileView, openSectionView } from './file-view.js';
import { markActive } from './sidebar.js';
import { renderCollection, renderOverview } from './collection-view.js';
import { renderSettingsView } from './settings-view.js';
import { renderIndexingView } from './jobs-view.js';
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
    if (r.openFile) await openFileView(r.name, r.openFile);
    else if (r.openNodePath) await openNodeFromPath(r.name, r.openNodePath);
  } else if (r.view === 'index') await renderIndexingView(main);
  else await renderOverview(main);
}
