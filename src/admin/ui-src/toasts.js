// Minimal by design: one shared host (#toast-host, mounted once in
// index.html, outside #main so it survives every view swap), no queue
// beyond simple stacking, one variant (warn). A fuller toast system
// (variants, action buttons, a real queue) is the design doc's own
// Phase 3C — this only needs to carry collection-open warnings.
import { $ } from './dom.js';

const TOAST_AUTO_DISMISS_MS = 8000;

export function showToast(message, { variant = 'warn' } = {}) {
  const host = $('#toast-host');
  if (!host) return; // toast host missing (e.g. a bare test fixture) — never throw over a UI nicety
  const el = document.createElement('div');
  el.className = `toast toast-${variant}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), TOAST_AUTO_DISMISS_MS);
}

// Dedupe key is (collection name, warning text) — session-lifetime (an
// in-memory Set, not localStorage): re-selecting the same collection later
// in the same page session must not re-spam a warning already shown, but a
// fresh page load is a fresh session, matching how the rest of this app's
// client-side state (expandedCollection, fileViewState) already behaves.
const shownCollectionWarnings = new Set();

export function showCollectionWarnings(name, warnings) {
  for (const w of warnings ?? []) {
    const key = JSON.stringify([name, w]);
    if (shownCollectionWarnings.has(key)) continue;
    shownCollectionWarnings.add(key);
    showToast(w);
  }
}
