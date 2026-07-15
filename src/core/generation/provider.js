// GenerationProvider contract (Phase 4A) — mirrors storage/adapter.js: a
// small runtime shape validator plus JSDoc typedefs, no backend imports. Any
// generation backend (Ollama now; cloud providers later, per Phase 4A.5)
// implements this shape so the Ask coordinator never branches on provider
// identity.

/**
 * @typedef {Object} GenerationProvider
 * @property {() => string} name
 * @property {() => { streaming: boolean, cancellation: boolean }} capabilities
 * @property {() => Promise<{ ok: boolean, reason?: string, model?: string, numCtx?: number }>} ready
 * @property {(opts: {
 *   prompt: string,
 *   model?: string,
 *   options?: Object,
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
