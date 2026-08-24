// GenerationProvider contract (Phase 4A) — mirrors storage/adapter.js: a
// small runtime shape validator plus JSDoc typedefs, no backend imports. Any
// generation backend (Ollama now; cloud providers later, per Phase 4A.5)
// implements this shape so the Ask coordinator never branches on provider
// identity.

/**
 * capabilities().cancellation was a single boolean until Stage B1 added
 * Gemini — that flattened two genuinely different guarantees into one
 * name. Ollama's fetch-based stream passes the AbortSignal straight to
 * the underlying HTTP request, so aborting it genuinely tears down the
 * connection and stops Ollama's own generation (upstreamCancellation:
 * true). Gemini's SDK accepts the signal only as `config.abortSignal`,
 * documented by the SDK itself as client-only — it stops this process
 * from consuming further output, but does NOT stop Google's servers from
 * continuing to generate or from billing for it (code review finding:
 * reporting a flat `cancellation: true` for both backends overclaimed
 * what Gemini can actually do). clientAbort is true for every current
 * provider (both always stop consuming/reading on abort);
 * upstreamCancellation is the one that varies by backend and is the field
 * a caller must check before promising a user "cancel" actually stops
 * the underlying model run.
 * generate()'s `systemPrompt` is OPTIONAL — non-Ask callers (or any future
 * caller with nothing provider-agnostic to say about role/behavior) may omit
 * it entirely and pass only `prompt`, exactly as before this field existed.
 * When present, it must reach the provider's own NATIVE system-instruction
 * transport (Gemini: config.systemInstruction; Ollama: the top-level
 * `system` body field on /api/generate) — a provider implementation must
 * never concatenate systemPrompt back into prompt/contents itself; doing so
 * would silently degrade a real system instruction back into ordinary user
 * content, exactly the problem this field exists to fix. Runtime forwarding
 * (generation/runtime.js) must pass systemPrompt through unchanged. The Ask
 * coordinator never branches on provider identity to decide how to send
 * it — that mapping is entirely each provider's own concern.
 * capabilities().hardOutputCap (spend/token ceiling feature — see
 * docs/security/ask-spend-token-budget-design-2026-08.md) declares whether
 * this provider can genuinely ENFORCE options.maxOutputTokens below, at the
 * provider's own request-construction step, before any output is generated —
 * i.e. whether generate() actually maps maxOutputTokens onto the backend's
 * own official hard-limit request option (Gemini: generationConfig.
 * maxOutputTokens; Ollama: options.num_predict), not merely a client-side
 * truncation of an already-generated/already-billed stream (a local stream
 * cutoff is NOT a spend control — the provider may already have generated
 * and billed more output by the time this process stops reading). A
 * provider reporting hardOutputCap:false must be treated as UNABLE to
 * enforce a spend ceiling for a billed/protected Ask call — callers on that
 * path fail closed (core/ask/coordinator.js) rather than silently
 * proceeding uncapped.
 *
 * options.maxOutputTokens (spend/token ceiling feature) is the ONE
 * provider-neutral field every generate() call site on the Ask path now
 * sets: a hard ceiling on the number of output tokens this call may
 * produce, mapped by each concrete provider onto its own native option (see
 * hardOutputCap above and each provider file's own generate()). Optional
 * for non-Ask callers that have no budget concept — omitting it preserves
 * each provider's own prior default behavior exactly.
 * @typedef {Object} GenerationProvider
 * @property {() => string} name
 * @property {() => { streaming: boolean, clientAbort: boolean, upstreamCancellation: boolean, hardOutputCap: boolean }} capabilities
 * @property {() => Promise<{ ok: boolean, reason?: string, model?: string, numCtx?: number }>} ready
 * @property {(opts: {
 *   systemPrompt?: string,
 *   prompt: string,
 *   model?: string,
 *   options?: { maxOutputTokens?: number, [key: string]: unknown },
 *   signal?: AbortSignal,
 *   onToken?: (token: string) => void,
 * }) => Promise<{ text: string, tokensIn?: number, tokensOut?: number, aborted?: boolean }>} generate
 */

export const REQUIRED_PROVIDER_METHODS = ['name', 'capabilities', 'ready', 'generate'];

/**
 * Verify an object satisfies the GenerationProvider shape. Shallow, like
 * validateStorageAdapter — a shape check, not a type system.
 * @param {Object} provider
 * @throws {Error} with an actionable message naming the missing/invalid piece
 */
export function validateGenerationProvider(provider) {
  if (typeof provider !== 'object' || provider === null) {
    throw new Error('validateGenerationProvider: provider must be a non-null object');
  }

  const missing = REQUIRED_PROVIDER_METHODS.filter(m => typeof provider[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `validateGenerationProvider: provider is missing required method(s): ${missing.join(', ')}`
    );
  }

  const caps = provider.capabilities();
  if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
    throw new Error('validateGenerationProvider: capabilities() must return a plain object');
  }

  return true;
}
