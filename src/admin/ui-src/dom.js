// Generic DOM helpers shared by every view module: query shorthand, HTML
// escaping, template cloning, and the error/empty-state box builders that
// depend on it. No domain logic lives here.

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Clones a <template> declared in index.html (via <load ...> from
// partials/templates/*.html) and returns its content fragment. Callers fill
// in data with textContent/dataset/setAttribute, never innerHTML — the
// template markup itself is the only trusted HTML in play.
export function cloneTemplate(id) {
  const tpl = document.getElementById(id);
  if (!tpl) throw new Error(`template #${id} not found — check index.html <load> tags`);
  return tpl.content.cloneNode(true);
}

// Returns an HTML string built from the error-state template + textContent
// (never string interpolation into markup) — err.message is untrusted API/
// network content. Callers still assign the result via innerHTML, but the
// string itself is always produced safely (textContent, not concatenation).
export function errorBox(err) {
  const frag = cloneTemplate('tpl-error-state');
  frag.querySelector('.error-box').textContent = err.message;
  return frag.firstElementChild.outerHTML;
}

// Same idea as errorBox() for the empty-state template.
export function emptyBox(message) {
  const frag = cloneTemplate('tpl-empty-state');
  frag.querySelector('.empty').textContent = message;
  return frag.firstElementChild.outerHTML;
}
