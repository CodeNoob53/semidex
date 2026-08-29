// Loading/empty/error/partial state primitives (design plan §5, §8.1,
// §12.3 DoD #3/#7 — the fixed state vocabulary: empty, loading, refreshing,
// ready, degraded, error, partial, unavailable-in-this-edition). DOM-
// producing functions, not classes. Every untrusted string (an ApiError's
// message, a caller-supplied reason) goes through textContent — never
// innerHTML — so a malformed/hostile server message can never become
// markup.
export function createLoadingState(message = 'Loading…') {
  const el = document.createElement('div');
  el.className = 'state-box state-loading';
  el.setAttribute('role', 'status');
  el.textContent = message;
  return el;
}

/**
 * @param {string} message
 * @param {{ href: string, label: string }|null} action — an optional single
 *   navigational call to action (e.g. empty collections -> "Index a
 *   folder"), rendered as a real <a>, never a fake button.
 */
export function createEmptyState(message, action = null) {
  const el = document.createElement('div');
  el.className = 'state-box state-empty';
  const p = document.createElement('p');
  p.className = 'state-message';
  p.textContent = message;
  el.appendChild(p);
  if (action) {
    const a = document.createElement('a');
    a.className = 'state-action';
    a.href = action.href;
    a.textContent = action.label;
    el.appendChild(a);
  }
  return el;
}

/**
 * @param {{ message: string }} err — an ApiError (or any Error-shaped
 *   value); only `.message` is read, and only via textContent. The server
 *   already redacts at capture (sanitiseErrorMessage) — this primitive adds
 *   no second redaction layer and no new un-redacted channel (design plan
 *   §11.2).
 * @param {{ retry: (() => void)|null }} [opts]
 */
export function createErrorState(err, { retry = null } = {}) {
  const el = document.createElement('div');
  el.className = 'state-box state-error';
  el.setAttribute('role', 'alert');
  const p = document.createElement('p');
  p.className = 'state-message';
  p.textContent = err?.message || 'Something went wrong.';
  el.appendChild(p);
  if (retry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost state-retry';
    btn.textContent = 'Retry';
    btn.addEventListener('click', retry);
    el.appendChild(btn);
  }
  return el;
}

/** A subsystem is degraded but the rest of the view is still usable —
 * distinct from `error` (design plan §5: "degraded (partial data usable,
 * banner names the subsystem)"). `role="status"`, not `role="alert"` — a
 * degraded reading is expected/normal in this product (e.g. Lite before a
 * generation key is set), not a failure demanding interruption. */
export function createPartialState(message) {
  const el = document.createElement('div');
  el.className = 'state-box state-partial';
  el.setAttribute('role', 'status');
  el.textContent = message;
  return el;
}
