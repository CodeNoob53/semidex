// Shared single-flight execution gate — extracted so v1's coordinator.js
// and v2's coordinator-v2.js can contend on ONE real lock instead of two
// independent `busy` booleans (code review finding: two independent locks
// let a v1 request run concurrently with v2's rewrite/compaction steps,
// which live outside v1's own critical section). A trivial mutual-exclusion
// primitive: at most one holder at a time, `run()` acquires before its
// callback and always releases after (success, throw, or the callback
// resolving to a value) via try/finally.
//
// This is the SAME single-flight semantics coordinator.js's own `busy`
// boolean already implemented before this extraction — pulled into its own
// module so ONE instance can be shared between callers, rather than each
// owning an independent, un-coordinated boolean.

/**
 * `tryAcquire()` (added for agent mode) is the same mutual exclusion with an
 * explicit, caller-held lifetime instead of a callback-scoped one. Agent
 * mode needs the SLOT decided BEFORE it claims a continuation or reserves
 * tokens — with run(), a `busy` refusal could only be discovered after those
 * had already happened, which destroyed a valid continuation and spent
 * budget for zero generations (code review). Ask v1/v2 keep using run() and
 * are completely unaffected; both share the one `busy` flag, so the two
 * styles still exclude each other.
 *
 * @returns {{
 *   isBusy: () => boolean,
 *   run: <T>(fn: () => Promise<T>) => Promise<{ ok: true, value: T } | { ok: false }>,
 *   tryAcquire: () => (() => void) | null,
 * }}
 *   tryAcquire() returns a release function when the slot was free, or null
 *   when it is already held. The caller MUST call the returned release in a
 *   finally; it is idempotent, so releasing twice is safe.
 *   run() returns { ok: false } immediately (never calls fn) if the gate is
 *   already held — callers translate that into their own {status:'busy'}
 *   result shape. { ok: true, value } wraps whatever fn() resolved to, once
 *   the gate is released.
 */
export function createSingleFlightGate() {
  let busy = false;

  async function run(fn) {
    if (busy) return { ok: false };
    busy = true;
    try {
      return { ok: true, value: await fn() };
    } finally {
      busy = false;
    }
  }

  function tryAcquire() {
    if (busy) return null;
    busy = true;
    let released = false;
    // Idempotent: a caller that releases in a finally AND on an early return
    // path must not free a slot someone else has since taken.
    return () => {
      if (released) return;
      released = true;
      busy = false;
    };
  }

  return { isBusy: () => busy, run, tryAcquire };
}
