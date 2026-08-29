// Shared view-controller lifecycle (admin dashboard v2, design plan §8.4).
// One instance per mounted feature view. A feature's mount(host, params)
// creates one of these, uses `.signal` for every listener/fetch it
// registers, and calls `.dispose()` when the router navigates away — that is
// the entire mount/dispose contract every other v2 slice builds on.
//
// Ownership/generation pattern (design plan §8.7):
//   const gen = view.nextGeneration();
//   const result = await doSomething();
//   if (!view.isCurrent(gen)) return; // superseded — discard, do not render

export function createViewController() {
  const controller = new AbortController();
  const teardowns = [];
  let generation = 0;
  let disposed = false;

  function nextGeneration() {
    generation += 1;
    return generation;
  }

  // A generation is current only while it matches the counter's latest
  // value AND the view has not been disposed — dispose() bumps the counter
  // past every generation ever issued, so every one of them becomes stale
  // in the same step that aborts in-flight work.
  function isCurrent(gen) {
    return !disposed && gen === generation;
  }

  // Registers `fn` to run on dispose(). Called AFTER the view has already
  // been disposed, `fn` would otherwise sit in `teardowns` forever — dispose()
  // has already run its one drain-and-clear pass and will never run again
  // (it's idempotent-by-`disposed`-flag, see below), so a late registration
  // that just pushed onto the array would leak whatever resource `fn` was
  // meant to release. Run it immediately instead, synchronously, so a
  // caller that does `if (!view.isCurrent(gen)) return;` and only THEN
  // registers cleanup for what it just created still gets that cleanup run,
  // exactly as if dispose() had run one tick later.
  function onDispose(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('onDispose(fn): fn must be a function');
    }
    if (disposed) {
      fn();
      return;
    }
    teardowns.push(fn);
  }

  // Idempotent by construction: a second (or Nth) call sees `disposed`
  // already true and returns before touching the controller or the
  // teardown list again.
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    controller.abort();
    // Reverse order: the last thing registered is torn down first, mirroring
    // normal stack-unwind/cleanup order (a later registration often depends
    // on an earlier one still being alive while it tears itself down).
    const pending = teardowns.splice(0, teardowns.length).reverse();
    for (const teardown of pending) {
      try {
        teardown();
      } catch {
        // A misbehaving teardown must not stop the rest of disposal from
        // running — every other registered teardown still owns real
        // resources (listeners, timers, streams) that need releasing.
      }
    }
  }

  return {
    get signal() { return controller.signal; },
    nextGeneration,
    isCurrent,
    onDispose,
    dispose,
  };
}
