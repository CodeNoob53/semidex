// Shared shell-owned health/generation status store (design plan §8.3:
// "Global health/generation status | Shell-owned store, polled | One
// poller, many subscribers"). The ONE place that polls GET /api/health and
// GET /api/generation/status — topbar.js and the Overview v2 controller
// both subscribe to this module's state instead of each fetching those two
// endpoints on their own, which is exactly the duplicate-polling-loops
// outcome the design plan's topbar/Overview consolidation (§13 S1) forbids.
// Same module-level-singleton pattern as operation-store.js (this file's
// own poller starts once, at app boot — see app.js — and keeps running for
// the lifetime of the page, independent of which route is currently
// mounted, so a view that merely subscribes never needs to start/stop it).
import { apiGet } from '../api/client.js';
import { validateHealthResponse } from '../api/contracts/health.js';
import { validateGenerationStatusResponse } from '../api/contracts/generation.js';

// Provisional (design plan §11.6: every unmeasured bound is provisional
// until profiled on real hardware) — no measured cadence exists yet for
// this pair of cheap, local-only reads. Deliberately slower than
// operation-store.js's active cadence: health/generation readiness changes
// far less often than a running job's progress.
const POLL_MS = 10_000;

let health = null; // last successful GET /api/health body, or null before the first successful poll
let healthError = null; // ApiError from the most recent failed health fetch, or null — cleared the moment a later poll succeeds
let generation = null; // last successful GET /api/generation/status body, or null
let generationError = null; // ApiError from the most recent failed generation-status fetch, or null
let pollTimer = null;
let isPolling = false;
let pollGeneration = 0; // bumped by stopPolling() so an in-flight fetch from a stale poll loop can't schedule another tick after being told to stop
const listeners = new Set();

function notify() {
  const snapshot = getStatus();
  for (const listener of listeners) listener(snapshot);
}

/** One failed source must never erase the other's last-known-good value —
 * each field degrades independently (design plan §5.1's `degraded` state:
 * "Qdrant up, generation provider not ready" is a normal, expected shape,
 * not a reason to blank out the storage row too). */
export function getStatus() {
  return { health, healthError, generation, generationError };
}

/** Subscribe to store updates. Returns an unsubscribe function. Called
 * after every poll tick (success or partial failure alike) — never on a
 * per-field basis, so a subscriber always sees a consistent snapshot. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function pollOnce() {
  const myGeneration = pollGeneration;
  const [healthResult, generationResult] = await Promise.allSettled([
    apiGet('/api/health').then(validateHealthResponse),
    apiGet('/api/generation/status').then(validateGenerationStatusResponse),
  ]);
  if (myGeneration !== pollGeneration) return; // stopPolling() ran while these were in flight — drop the stale result, do not reschedule

  if (healthResult.status === 'fulfilled') { health = healthResult.value; healthError = null; }
  else { healthError = healthResult.reason; }

  if (generationResult.status === 'fulfilled') { generation = generationResult.value; generationError = null; }
  else { generationError = generationResult.reason; }

  notify();
  if (myGeneration !== pollGeneration) return;
  pollTimer = setTimeout(pollOnce, POLL_MS);
}

/** Starts the shared poller. Safe to call more than once — a second call
 * while already polling is a no-op, so any subscriber (topbar, Overview)
 * can call this unconditionally without coordinating "did someone already
 * start this." */
export function startPolling() {
  if (isPolling) return;
  isPolling = true;
  pollOnce();
}

/** Stops the poller and discards any in-flight fetch's result — test-only
 * (production never stops polling once the app has booted). */
export function stopPolling() {
  pollGeneration += 1;
  isPolling = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

/** Forces an immediate poll tick, bypassing whatever delay the last tick
 * scheduled. Returns the pollOnce() promise so a caller can await a fresh
 * snapshot. */
export function pollNow() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  return pollOnce();
}

/** Test-only: clears all in-memory state so each test starts from a clean
 * store (this module is a singleton — see operation-store.js's own
 * resetForTests() for the identical rationale). */
export function resetForTests() {
  stopPolling();
  health = null; healthError = null; generation = null; generationError = null;
  listeners.clear();
}

/** Test-only: current subscriber count — used by leak-soak tests to prove
 * repeated mount/dispose of a subscribing view does not grow this store's
 * listener set. */
export function listenerCount() {
  return listeners.size;
}
