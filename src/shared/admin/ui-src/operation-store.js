// ── shared operation-status store (Phase 3S) ────────────────────────────────
// The ONE place that polls GET /api/operations. operation-modal.js and
// topbar.js's job chip both subscribe to this module's state instead of
// polling independently — the architecture constraint this phase spells out
// explicitly ("Avoid duplicate polling between the chip and modal. Use one
// shared operation-status controller/store."). Module-level singleton state,
// same pattern already used by state.js (the one other piece of UI state
// more than one module reads/writes) — this file's poller starts once, at
// app boot (see app.js), and keeps running for the lifetime of the page,
// independent of which route is currently rendered, which is exactly what
// lets an operation survive navigation (requirement 1: "preserve its state
// while the user navigates").
import { apiGet } from './shared/api/client.js';
import { validateOperationsListResponse } from './shared/api/contracts/operations.js';

const ACTIVE_STATES = new Set(['queued', 'running', 'cancelling']);
const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 5000;

let operations = []; // last fetched list from GET /api/operations, newest-first
let pollTimer = null;
// Set synchronously the instant startPolling() is called — pollTimer itself
// is only assigned once pollOnce()'s first `await api(...)` resolves, so a
// second startPolling() call made before that first fetch settles would see
// pollTimer still null and (incorrectly) start a second concurrent poll
// loop. isPolling closes that window: it's true from the very first call,
// synchronously, regardless of how far the in-flight fetch has gotten.
let isPolling = false;
// True while a pollOnce() call is between its `await api(...)` and its own
// reschedule — i.e. a fetch is genuinely in flight right now. pollNow()
// checks this (not pollTimer) to decide whether to start a fetch itself or
// just flag that one more is wanted once the in-flight one finishes:
// without this, a call sequence like "startIndexJob() calls pollNow(),
// then openOperationModal() calls pollNow() again before the first fetch
// resolves" (the actual shape of every start-an-operation flow in this
// codebase — see jobs-view.js/settings-view.js) fires two concurrent
// GET /api/operations requests and two full notify() cycles, one of which
// "wins" pollTimer and orphans the other's own reschedule.
let inFlight = false;
// Set by a pollNow()/pollOnce() call that arrived while another was already
// in flight — consumed (and cleared) the moment the in-flight call finishes,
// triggering exactly one more immediate fetch rather than a whole queue of
// them piling up if pollNow() were called many times in a row.
let refreshRequested = false;
let pollGeneration = 0; // bumped by stopPolling() so an in-flight fetch from a stale poll loop can't schedule another tick after being told to stop
const listeners = new Set();
// Resolved (all of them, then cleared) the moment the CURRENT poll cycle's
// store update lands — i.e. right after the notify('update') call inside
// pollOnce(), not after its later reschedule/deferred-follow-up tail. Lets
// a caller `await pollNow()` and know the store actually reflects a fresh
// fetch before reading getOperations()/findLatestOperation() — needed by
// callers that must look up an operation by collection+kind right after
// starting it (no id available yet), where reading the store synchronously
// after a bare `pollNow()` call would race against the fetch still being
// in flight. See settings-view.js's runSettingsRepair() failure path.
let pollWaiters = [];

// Tracks each operation id's last-seen state, so a state TRANSITION (e.g.
// running -> succeeded) can be detected and reported to subscribers exactly
// once — not once per poll tick, which would fire a "completed" toast every
// 1.5s for as long as a finished operation stays in the list. Cleared only
// when the store itself is reset (tests) — an ever-growing Map across a
// long admin session is bounded by how many distinct operations the backend
// registries themselves retain in memory, which is already bounded (no
// eviction beyond process lifetime, matching the backend's own in-memory-
// only job/task history).
const lastSeenState = new Map();

function notify(event) {
  for (const listener of listeners) listener(event);
}

/**
 * Registers an operation id as "already seen, running" BEFORE the store's
 * first real poll of it — used right after starting an operation whose id
 * is already known (repair's response body carries one; see
 * settings-view.js's runSettingsRepair()) but which may complete faster
 * than any poll can observe it mid-flight. Without this, the store's
 * ordinary "first sighting of an id is never a transition" rule (see
 * pollOnce()) would treat that first poll — even though it already shows
 * succeeded/failed — as just the initial discovery of the operation, never
 * firing the completion transition/toast at all. Seeding a 'running'
 * baseline means the very next poll's real state is compared against that
 * assumption, so a repair that finished in the time it took to fire this
 * request still produces a genuine 'running' -> 'succeeded' (or 'failed')
 * transition the first time the store actually sees it.
 */
export function seedOperationAsRunning(id) {
  lastSeenState.set(id, 'running');
}

/**
 * Subscribe to store events. Returns an unsubscribe function. Events:
 *   { type: 'update', operations }              — every successful poll tick
 *   { type: 'transition', operation, from, to }  — one operation's state changed
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOperations() {
  return operations;
}

export function getOperation(id) {
  return operations.find(op => op.id === id) ?? null;
}

/** The most recently started operation still in an active state, or null. */
export function getActiveOperation() {
  return operations.find(op => ACTIVE_STATES.has(op.state)) ?? null;
}

/**
 * The most recent operation matching { collection, kind }, or null.
 * `operations` is always newest-first (server-sorted by startedAt), so a
 * plain .find() already returns the latest match — used for a repair call
 * that fails before the backend response ever carries a task id (unlike
 * the success path, where the response body has one — see
 * settings-view.js's runSettingsRepair()), so the caller has no id to look
 * up directly and instead identifies "the repair I just started" by
 * collection + kind.
 */
export function findLatestOperation({ collection, kind }) {
  return operations.find(op => op.collection === collection && op.kind === kind) ?? null;
}

async function pollOnce() {
  const myGeneration = pollGeneration;
  inFlight = true;
  try {
    const body = validateOperationsListResponse(await apiGet('/api/operations'));
    if (myGeneration !== pollGeneration) return; // stopPolling() ran while this fetch was in flight — drop the stale result, do not reschedule
    const previous = operations;
    operations = body.operations;

    for (const op of operations) {
      const prevState = lastSeenState.get(op.id);
      if (prevState !== undefined && prevState !== op.state) {
        notify({ type: 'transition', operation: op, from: prevState, to: op.state });
      }
      lastSeenState.set(op.id, op.state);
    }

    notify({ type: 'update', operations, previous });
  } catch {
    // Transient API errors shouldn't flip visible UI on/off — keep whatever
    // was last shown and just try again next tick (same tolerance topbar.js's
    // old pollJobChip() already had for /api/jobs failures).
  } finally {
    inFlight = false;
  }

  if (myGeneration !== pollGeneration) return;

  // A pollNow() (or another pollOnce reschedule race) arrived while this
  // fetch was in flight — honor it with exactly one immediate follow-up
  // fetch instead of the normal scheduled delay, and don't ALSO schedule a
  // delayed timer on top of it (the follow-up's own completion schedules
  // the next real delay).
  //
  // Waiters registered by pollNow() are drained here — AFTER this check,
  // not in the finally{} block above — specifically so a pollNow() call
  // that arrived while this fetch was already in flight (setting
  // refreshRequested) has its promise resolved by the DEFERRED follow-up
  // fetch's own completion, not by the fetch that was already running
  // before that caller ever asked for a refresh. Resolving too early there
  // would hand back a still-stale getOperations() snapshot to a caller who
  // explicitly awaited pollNow() expecting a fresh one (e.g.
  // settings-view.js's runSettingsRepair() failure-path lookup).
  if (refreshRequested) {
    refreshRequested = false;
    await pollOnce();
    return;
  }

  const waiters = pollWaiters;
  pollWaiters = [];
  for (const resolve of waiters) resolve();

  const delay = getActiveOperation() ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  pollTimer = setTimeout(pollOnce, delay);
}

/** Starts the shared poller. Safe to call more than once — a second call is
 * a no-op while already polling, so app.js can call this unconditionally at
 * boot without any module needing to coordinate "did someone already start
 * this." */
export function startPolling() {
  if (isPolling) return;
  isPolling = true;
  pollOnce();
}

/** Stops the poller and discards any in-flight fetch's result — test-only
 * (production never stops polling once the app has booted; there is no UI
 * action that should silence the shared store, only the modal/chip choosing
 * not to render). */
export function stopPolling() {
  pollGeneration += 1;
  isPolling = false;
  refreshRequested = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  // Any pollNow() waiters registered for a fetch that's now being
  // invalidated (the generation bump above makes pollOnce() bail out
  // early, before it would otherwise drain these itself) must still be
  // resolved — never left hanging forever just because polling stopped.
  const waiters = pollWaiters;
  pollWaiters = [];
  for (const resolve of waiters) resolve();
}

/** Test-only: clears all in-memory state so each test starts from a clean
 * store instead of leaking transition-detection state across tests (this
 * module is a singleton — importing it fresh per test file is not possible
 * without per-test module isolation, which this codebase's test harness
 * does not use for ui-src modules). */
export function resetForTests() {
  stopPolling();
  operations = [];
  lastSeenState.clear();
  listeners.clear();
}

// Forces the very next poll tick to run immediately instead of waiting out
// whatever delay the last tick scheduled — used right after starting a new
// operation (indexing/reindex/repair) so the modal shows real queued/running
// state within milliseconds instead of up to IDLE_POLL_MS (5s) later.
//
// Every "start an operation" flow in this codebase calls pollNow() twice in
// quick succession without awaiting the first (e.g. jobs-view.js's
// startIndexJob() calls pollNow() then openOperationModal(), which calls
// pollNow() again) — a naive "always fire pollOnce()" implementation ran
// two concurrent GET /api/operations requests and two full notify() cycles
// from that single user action, with only one of the two reschedules
// surviving in pollTimer (the other orphaned, silently wasting a poll
// interval's worth of freshness). Guarded by `inFlight`: if a fetch is
// already running, this only flags refreshRequested — pollOnce()'s own
// completion consumes that flag and fires exactly one immediate follow-up,
// never a queue of them.
//
// Returns a promise that resolves once the store has actually been updated
// by the resulting fetch (not just "a fetch was scheduled") — a caller that
// needs to read getOperations()/findLatestOperation() immediately
// afterward (e.g. a repair failure with no task id to look up directly;
// see settings-view.js's runSettingsRepair()) can `await pollNow()` instead
// of reading stale/in-flight state synchronously.
export function pollNow() {
  const resultPromise = new Promise((resolve) => pollWaiters.push(resolve));
  if (inFlight) { refreshRequested = true; return resultPromise; }
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  pollOnce();
  return resultPromise;
}
