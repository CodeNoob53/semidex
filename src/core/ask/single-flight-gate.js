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
 * @returns {{
 *   isBusy: () => boolean,
 *   run: <T>(fn: () => Promise<T>) => Promise<{ ok: true, value: T } | { ok: false }>,
 * }}
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

  return { isBusy: () => busy, run };
}
