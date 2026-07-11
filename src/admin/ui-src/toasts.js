// One shared host (#toast-host, mounted once in index.html, outside #main
// so it survives every view swap), no queue beyond simple stacking.
// Extended in Phase 3S with variants + an optional action button (the
// design doc's own Phase 3C ask: "success toast ... with a View action;
// failure toast ... and a View details action"). Deliberately takes an
// onClick CALLBACK, not a route/hash string — this module must not import
// operation-modal.js (that module already imports toasts.js for the
// completion-toast call, and a back-import would be circular); the caller
// (operation-modal.js itself) supplies the actual "open the modal" behavior.
import { $, esc } from './dom.js';

const TOAST_AUTO_DISMISS_MS = 8000;

/**
 * @param {string} message
 * @param {{ variant?: 'warn'|'success'|'error', action?: { label: string, onClick: () => void } }} [opts]
 */
export function showToast(message, { variant = 'warn', action } = {}) {
  const host = $('#toast-host');
  if (!host) return; // toast host missing (e.g. a bare test fixture) — never throw over a UI nicety
  const el = document.createElement('div');
  el.className = `toast toast-${variant}`;
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  el.appendChild(text);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.onClick(); el.remove(); });
    el.appendChild(btn);
  }
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
