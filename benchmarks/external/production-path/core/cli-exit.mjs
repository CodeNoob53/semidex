// The ONE place the production-path suite runners decide their process
// exit code from a run's outcome. Extracted so it is unit-testable
// directly (an executable-level spawn test then only has to prove the
// runner actually WIRES this in — see run-cli-exit.test.mjs).
//
// Rule (audit 2026-09-06, P1): a run that did not finish as COMPLETE is a
// FAILED run and MUST exit nonzero, so CI checking only `process.exitCode`
// can never mistake an INCOMPLETE eval (query errors, missing profile,
// insufficient depth) for a green one. A `--resume-check` is a read-only
// inspection, not a run, so it never gates the exit code.

/**
 * @param {{ verdict?: string } | null | undefined} state — the checkpoint
 *   state returned by a suite runner (null when the run never started,
 *   e.g. LIVE_BLOCKED).
 * @param {{ resumeCheck?: boolean }} [opts]
 * @returns {0 | 1}
 */
export function exitCodeForSuiteState(state, { resumeCheck = false } = {}) {
  if (resumeCheck) return 0;
  return state && state.verdict === 'COMPLETE' ? 0 : 1;
}

/**
 * Multi-suite variant (run-all / slavic-per-language): nonzero if ANY
 * suite's state is not COMPLETE.
 * @param {Array<{ verdict?: string } | null | undefined>} states
 * @param {{ resumeCheck?: boolean }} [opts]
 * @returns {0 | 1}
 */
export function exitCodeForManySuiteStates(states, { resumeCheck = false } = {}) {
  if (resumeCheck) return 0;
  return states.every((s) => s && s.verdict === 'COMPLETE') ? 0 : 1;
}
