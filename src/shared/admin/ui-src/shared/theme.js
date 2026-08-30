// Local presentation preference only. Theme choice never crosses the API
// boundary and never shares storage with credentials or operational state.
export const THEME_STORAGE_KEY = 'semidex.ui.theme';
export const THEMES = Object.freeze(['system', 'light', 'dark']);

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : 'system';
}

function browserStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
}

function browserRoot() {
  return typeof document === 'undefined' ? null : document.documentElement;
}

export function readStoredTheme(storage = browserStorage()) {
  if (!storage) return 'system';
  try { return normalizeTheme(storage.getItem(THEME_STORAGE_KEY)); }
  catch { return 'system'; }
}

export function applyTheme(theme, root = browserRoot()) {
  const normalized = normalizeTheme(theme);
  if (!root) return normalized;
  if (normalized === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', normalized);
  return normalized;
}

export function storeTheme(theme, storage = browserStorage()) {
  const normalized = normalizeTheme(theme);
  if (!storage) return normalized;
  try {
    if (normalized === 'system') storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, normalized);
  } catch { /* unavailable storage is non-fatal; the active theme still works */ }
  return normalized;
}

export function initTheme({ root = browserRoot(), storage = browserStorage() } = {}) {
  return applyTheme(readStoredTheme(storage), root);
}

export function initThemeControl(control, {
  root = browserRoot(),
  storage = browserStorage(),
  initialTheme = readStoredTheme(storage),
  signal,
} = {}) {
  if (!control) return () => {};
  control.value = normalizeTheme(initialTheme);
  const onChange = () => {
    const selected = storeTheme(control.value, storage);
    applyTheme(selected, root);
    control.value = selected;
  };
  control.addEventListener('change', onChange, signal ? { signal } : undefined);
  return () => control.removeEventListener('change', onChange);
}
