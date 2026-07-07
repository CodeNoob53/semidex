// ── sidebar resize (persisted width, pointer + keyboard) ────────────────
// Long file/section names need more room than the old fixed 240px column —
// width is user-adjustable via a drag handle (or keyboard, for anyone who
// can't/doesn't want to drag) and remembered across sessions.
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 320;
export const SIDEBAR_WIDTH_KEY = 'semidex-admin-sidebar-width';
export const SIDEBAR_STEP = 16;
export const SIDEBAR_LARGE_STEP = 48;

export function clampSidebarWidth(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

export function readSidebarWidth(storage) {
  try {
    const raw = storage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
    return clampSidebarWidth(Number(raw));
  } catch { return SIDEBAR_DEFAULT_WIDTH; }
}

export function writeSidebarWidth(storage, value) {
  try { storage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(value))); } catch { /* storage unavailable — non-fatal */ }
}

export function applySidebarWidth(px) {
  const layout = document.querySelector('.layout');
  if (layout) layout.style.setProperty('--sidebar-width', px + 'px');
}

// Pure: given the current width and a keydown's key/shiftKey, returns the
// new (unclamped — caller clamps) width, or null if the key isn't handled
// by the resize control at all (caller should not preventDefault it).
export function nextSidebarWidth(current, key, shiftKey) {
  const step = shiftKey ? SIDEBAR_LARGE_STEP : SIDEBAR_STEP;
  switch (key) {
    case 'ArrowLeft': return current - step;
    case 'ArrowRight': return current + step;
    case 'Home': return SIDEBAR_MIN_WIDTH;
    case 'End': return SIDEBAR_MAX_WIDTH;
    case 'Enter': case ' ': return SIDEBAR_DEFAULT_WIDTH;
    default: return null;
  }
}

export function updateSidebarResizeAria(handle, width) {
  handle.setAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH));
  handle.setAttribute('aria-valuemax', String(SIDEBAR_MAX_WIDTH));
  handle.setAttribute('aria-valuenow', String(width));
  handle.setAttribute('aria-valuetext', `${width} pixels`);
}

export function initSidebarResize() {
  const handle = document.getElementById('sidebar-resize-handle');
  const layout = document.querySelector('.layout');
  const sidebar = document.querySelector('.sidebar');
  if (!handle || !layout || !sidebar) return;

  // Shared by pointer drag-end, double-click, and keyboard so all three
  // input methods apply/persist/announce width the same way. Pointer
  // drag itself calls applySidebarWidth() directly on every pointermove
  // (persisting/updating ARIA on every move would be wasteful for a
  // continuous drag) and only goes through this shared path once, on
  // drag-end.
  function setSidebarWidth(px, { persist = true } = {}) {
    const width = clampSidebarWidth(px);
    applySidebarWidth(width);
    updateSidebarResizeAria(handle, width);
    if (persist) writeSidebarWidth(localStorage, width);
    return width;
  }

  setSidebarWidth(readSidebarWidth(localStorage));

  let dragging = false;

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.classList.add('is-dragging');
    handle.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // Deliberately applySidebarWidth() only, not the full setSidebarWidth()
    // path — ARIA/persist updates on every pointermove would fire dozens of
    // times per drag for no real benefit (keyboard already gets an
    // immediate per-keypress update, which is the case that actually needs
    // it). aria-valuenow/localStorage catch up once on drag-end.
    const rect = sidebar.getBoundingClientRect();
    applySidebarWidth(clampSidebarWidth(e.clientX - rect.left));
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('is-dragging');
    document.body.style.userSelect = '';
    const rect = sidebar.getBoundingClientRect();
    setSidebarWidth(rect.width);
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  handle.addEventListener('dblclick', () => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  });

  handle.addEventListener('keydown', (e) => {
    const rect = sidebar.getBoundingClientRect();
    const next = nextSidebarWidth(rect.width, e.key, e.shiftKey);
    if (next === null) return; // key not handled by this control
    e.preventDefault();
    setSidebarWidth(next);
  });
}
