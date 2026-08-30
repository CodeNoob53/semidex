import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  THEME_STORAGE_KEY,
  applyTheme,
  initTheme,
  initThemeControl,
  normalizeTheme,
  readStoredTheme,
  storeTheme,
} from '../../../src/shared/admin/ui-src/shared/theme.js';

const CSS_PATH = fileURLToPath(new URL('../../../src/shared/admin/ui-src/app.css', import.meta.url));
const HTML_PATH = fileURLToPath(new URL('../../../src/admin/ui-src/index.html', import.meta.url));
const LITE_HTML_PATH = fileURLToPath(new URL('../../../src/admin/ui-src/lite-entry/index.html', import.meta.url));

function fakeRoot() {
  const values = new Map();
  return {
    getAttribute: (name) => values.get(name) ?? null,
    removeAttribute: (name) => values.delete(name),
    setAttribute: (name, value) => values.set(name, value),
  };
}

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('admin theme preference', () => {
  it('accepts only system, light, and dark', () => {
    assert.equal(normalizeTheme('system'), 'system');
    assert.equal(normalizeTheme('light'), 'light');
    assert.equal(normalizeTheme('dark'), 'dark');
    assert.equal(normalizeTheme('unexpected'), 'system');
    assert.equal(normalizeTheme(null), 'system');
  });

  it('uses system when storage is absent, invalid, or unavailable', () => {
    assert.equal(readStoredTheme(null), 'system');
    assert.equal(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'sepia' })), 'system');
    assert.equal(readStoredTheme({ getItem() { throw new Error('blocked'); } }), 'system');
  });

  it('applies explicit themes and removes the override for system', () => {
    const root = fakeRoot();
    assert.equal(applyTheme('dark', root), 'dark');
    assert.equal(root.getAttribute('data-theme'), 'dark');
    assert.equal(applyTheme('system', root), 'system');
    assert.equal(root.getAttribute('data-theme'), null);
  });

  it('persists explicit choices but removes storage for system', () => {
    const storage = fakeStorage();
    storeTheme('light', storage);
    assert.equal(storage.getItem(THEME_STORAGE_KEY), 'light');
    storeTheme('system', storage);
    assert.equal(storage.getItem(THEME_STORAGE_KEY), null);
  });

  it('initializes from storage and updates from the select control', () => {
    const root = fakeRoot();
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'dark' });
    const control = new EventTarget();
    control.value = '';

    const initialTheme = initTheme({ root, storage });
    const dispose = initThemeControl(control, { root, storage, initialTheme });
    assert.equal(control.value, 'dark');
    assert.equal(root.getAttribute('data-theme'), 'dark');

    control.value = 'light';
    control.dispatchEvent(new Event('change'));
    assert.equal(root.getAttribute('data-theme'), 'light');
    assert.equal(storage.getItem(THEME_STORAGE_KEY), 'light');

    dispose();
    control.value = 'dark';
    control.dispatchEvent(new Event('change'));
    assert.equal(root.getAttribute('data-theme'), 'light');
  });
});

describe('admin theme CSS contract', () => {
  it('offers System, Light, and Dark in both Full and Lite shells', () => {
    for (const path of [HTML_PATH, LITE_HTML_PATH]) {
      const html = readFileSync(path, 'utf8');
      assert.equal(html.match(/id="theme-select"/g)?.length, 1);
      for (const value of ['system', 'light', 'dark']) {
        assert.match(html, new RegExp(`<option value="${value}">`, 'i'));
      }
    }
  });

  it('keeps one canonical :root and explicit light/dark overrides', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    assert.equal(css.match(/^:root\s*\{/gm)?.length, 1);
    assert.match(css, /^:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;/m);
    assert.match(css, /^:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/m);
    assert.match(css, /--surface-page:\s*light-dark\(/);
  });

  it('keeps theme-affecting color literals inside the canonical root block', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    const rootEnd = css.indexOf('\n}');
    assert.ok(rootEnd > 0, 'expected the canonical root block');
    const componentCss = css.slice(rootEnd + 2);
    assert.doesNotMatch(componentCss, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('does not reintroduce a same-role token alias layer', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    assert.doesNotMatch(css, /--[\w-]+:\s*var\(--[\w-]+\)\s*;/);
  });
});
