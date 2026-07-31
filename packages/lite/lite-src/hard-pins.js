// Semidex Lite hard cloud-only pins — pure data/function, no I/O. The CLI
// (bin/semidex-lite.js) applies these to process.env UNCONDITIONALLY,
// before bootstrapEnv() runs, so a stray local env var (ONNX_EMBED=1 left
// over from a full-Semidex .env a user copied by habit, for example) can
// never re-enable a local-only code path in a Lite install. See the plan's
// "Hard cloud-only enforcement" section: the CLI sets these first and
// unconditionally; the Lite settings/jobs APIs separately reject any
// attempt to change them at runtime (service.lite.js / jobs.js jobPolicy).
export const LITE_HARD_PINS = Object.freeze({
  DENSE_PROVIDER: 'qdrant-cloud',
  SPARSE_PROVIDER: 'qdrant-cloud',
  SEMIDEX_GENERATION_BACKEND: 'gemini',
  CONTEXT_MODE: 'deterministic',
  TAG_GEN: '0',
  SKELETON_SUMMARY: 'deterministic',
  COMBINED_LLM: '0',
  ONNX_EMBED: '0',
});

/**
 * Applies LITE_HARD_PINS to `env` in place, overwriting any existing value
 * — the whole point is that these are not overridable by the ambient
 * environment. Returns `env` for convenience.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function applyLiteHardPins(env = process.env) {
  for (const [key, value] of Object.entries(LITE_HARD_PINS)) {
    env[key] = value;
  }
  return env;
}
