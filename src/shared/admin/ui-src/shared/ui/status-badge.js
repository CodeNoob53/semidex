// Status badge primitive (design plan §7.4, §8.1, §12.3 DoD #10): icon +
// text + color, never color alone. A DOM-producing function, not a class —
// matching every other `shared/ui` primitive and the existing module style
// (there are no UI classes anywhere in ui-src/ today). Callers append the
// returned element directly; the label always goes through textContent, so
// no untrusted status text (e.g. a server-provided readiness `reason`)
// ever passes through innerHTML.
import { iconStatusOk, iconStatusWarn, iconStatusFail, iconStatusUnknown } from '../../icons.js';

const TONE_ICON = { ok: iconStatusOk, warn: iconStatusWarn, fail: iconStatusFail, unknown: iconStatusUnknown };

/**
 * @param {'ok'|'warn'|'fail'|'unknown'} tone
 * @param {string} label — untrusted-safe; rendered via textContent
 * @returns {HTMLElement}
 */
export function createStatusBadge(tone, label) {
  const resolvedTone = Object.hasOwn(TONE_ICON, tone) ? tone : 'unknown';
  const el = document.createElement('span');
  el.className = `status-badge status-badge-${resolvedTone}`;
  const icon = document.createElement('span');
  icon.className = 'status-badge-icon';
  icon.setAttribute('aria-hidden', 'true');
  // Fixed, hand-authored SVG source from icons.js — never user data. Same
  // innerHTML-of-a-static-icon-string convention topbar.js's
  // initGlobalSettingsLink() and every sidebar row icon already use.
  icon.innerHTML = TONE_ICON[resolvedTone]();
  const text = document.createElement('span');
  text.className = 'status-badge-text';
  text.textContent = label;
  el.append(icon, text);
  return el;
}

/** Replaces an existing badge element in place with a freshly built one for
 * a new tone/label, returning the new element (the caller's own reference
 * to the old one is now detached). */
export function updateStatusBadge(el, tone, label) {
  const replacement = createStatusBadge(tone, label);
  el.replaceWith(replacement);
  return replacement;
}
