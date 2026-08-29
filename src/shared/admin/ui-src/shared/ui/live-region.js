// Accessible live-region primitive (design plan §11.5: "Status
// announcements are meaningful units, not per-token or per-tick; colour is
// never the only signal"). A DOM-producing function — callers append the
// returned element into the view's DOM (visually hidden, per app.css's
// .visually-hidden utility) and call announce() only on meaningful
// transitions (ready, degraded, error), never on every poll tick.
export function createLiveRegion({ assertive = false } = {}) {
  const el = document.createElement('div');
  el.className = 'visually-hidden';
  el.setAttribute('role', assertive ? 'alert' : 'status');
  if (!assertive) el.setAttribute('aria-live', 'polite');
  let last = null;
  return {
    el,
    /** No-ops on a message identical to the last one announced — avoids
     * re-announcing the same state on every unrelated store update. */
    announce(message) {
      if (message === last) return;
      last = message;
      el.textContent = message;
    },
  };
}
