// Ollama GenerationProvider (Phase 4A) — the only generation backend today.
// Reuses src/core/ollama.js for URL resolution, request/response handling,
// and error text extraction; this file adds only the GenerationProvider
// shape (name/capabilities/ready/generate) on top. Never spawns `ollama
// serve` — readiness is a check, not a lifecycle action.
import { isOllamaReachable, listOllamaModels, validateOllamaModels, generateStream, getModelContextLength } from '../ollama.js';

const DEFAULT_MODEL = process.env.CONTEXT_MODEL || 'gemma3:4b';

// The effective Ask context we ask Ollama to actually allocate
// (options.num_ctx on the generation request), capped at the model's own
// architectural maximum (getModelContextLength()). Ollama does NOT use a
// model's full architectural context by default — an unset num_ctx commonly
// runs at a much smaller runtime window (often 4096) regardless of what the
// model could support (per Ollama's own docs: "Show model details" reports
// the maximum, "Context length" is a separate, request-level setting) — so
// readiness must report the SAME number generate() actually requests, or
// the coordinator's context-budget math (fitEvidenceToContextBudget) bounds
// against a number Ollama was never told to honor (code review finding).
const DEFAULT_ASK_NUM_CTX = 8192;

/**
 * @param {{
 *   baseUrl?: string,
 *   model?: string,
 *   isOllamaReachableFn?: typeof isOllamaReachable,
 *   listOllamaModelsFn?: typeof listOllamaModels,
 *   generateStreamFn?: typeof generateStream,
 *   getModelContextLengthFn?: typeof getModelContextLength,
 * }} [opts] fn overrides are DI-only (tests stub the network; production
 *   callers never pass them, so real requests always go through ollama.js).
 * @returns {import('./provider.js').GenerationProvider}
 */
export function createOllamaProvider({
  baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434',
  model = DEFAULT_MODEL,
  isOllamaReachableFn = isOllamaReachable,
  listOllamaModelsFn = listOllamaModels,
  generateStreamFn = generateStream,
  getModelContextLengthFn = getModelContextLength,
} = {}) {
  return {
    name: () => 'ollama',

    capabilities: () => ({ streaming: true, cancellation: true }),

    async ready() {
      const reachable = await isOllamaReachableFn(baseUrl);
      if (!reachable) {
        return { ok: false, reason: `Ollama is not reachable at ${baseUrl}. Start it with "ollama serve".`, model };
      }
      let available;
      try {
        available = await listOllamaModelsFn(baseUrl);
      } catch (err) {
        return { ok: false, reason: `Failed to list Ollama models: ${err.message}`, model };
      }
      const missing = validateOllamaModels([model], available);
      if (missing) {
        return { ok: false, reason: `Model "${model}" is not installed. Pull it with "ollama pull ${model}".`, model };
      }
      // numCtx is the EFFECTIVE context this provider will actually request
      // from Ollama (generate() below passes this exact value as
      // options.num_ctx) — never larger than the model's own architectural
      // maximum. This is deliberately the same value on both ends: the
      // coordinator's context-budget math means nothing if the generation
      // request itself doesn't ask Ollama to honor that size.
      // getModelContextLengthFn() falls back to a safe default (4096)
      // internally if /api/show is unreachable or the field is missing, so
      // this never throws; baseUrl is passed through so the /api/show call
      // targets THIS provider's configured Ollama instance, not the
      // module-level default.
      const modelMax = await getModelContextLengthFn(model, undefined, baseUrl);
      const numCtx = Math.min(DEFAULT_ASK_NUM_CTX, modelMax);
      return { ok: true, model, numCtx };
    },

    async generate({ prompt, model: requestedModel, options, signal, onToken }) {
      // num_ctx defaults to DEFAULT_ASK_NUM_CTX when the caller doesn't
      // specify one — but the intended caller (the Ask coordinator) always
      // passes readiness.numCtx explicitly, since that is the exact figure
      // its own context-budget trimming (fitEvidenceToContextBudget) bounded
      // the prompt against. Without this default, a caller that skipped
      // ready() (or a future caller) would silently fall back to whatever
      // undocumented runtime default Ollama itself applies, decoupling the
      // request from any budget guarantee.
      const resolvedOptions = { num_ctx: DEFAULT_ASK_NUM_CTX, ...options };
      return generateStreamFn(requestedModel ?? model, prompt, { baseUrl, signal, onToken, options: resolvedOptions });
    },
  };
}
