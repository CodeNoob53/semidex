// Ollama GenerationProvider (Phase 4A/4A.5a) — the only generation backend
// today. Reuses src/core/ollama.js for URL resolution, request/response
// handling, and error text extraction; this file adds only the
// GenerationProvider shape (name/capabilities/ready/generate) on top. Never
// spawns `ollama serve` — readiness is a check, not a lifecycle action.
//
// No process.env reads anywhere in this file (Phase 4A.5a) — model,
// baseUrl, and askNumCtx are supplied by the caller (generation/runtime.js,
// via generation/registry.js's options passthrough), which is the one place
// resolved configuration is allowed to originate. This keeps the provider
// itself reusable for a config source other than env vars later (e.g. a
// future Settings UI) without touching this file.
//
// Never imports ../ollama.js directly, not even indirectly through a
// *-lazy.js default (Semidex Lite package boundary; code review, round 4 —
// this file used to default its five `*Fn` opts to ../ollama-lazy.js's
// exports, which meant generation/registry.js's BACKENDS map referencing
// createOllamaProvider — unconditionally, even though it is only ever
// CALLED when backend === 'ollama' — gave this file a real static edge
// onto core/ollama.js via the *-lazy.js re-export chain, reachable from
// Lite's own serve-lite.js -> generation/runtime.js -> registry.js graph
// regardless of Lite's SEMIDEX_GENERATION_BACKEND=gemini hard pin, which
// only prevents the ollama backend from ever being CONSTRUCTED, not from
// this module being statically resolved into the closure). Does not
// consume any of ./ollama-capability.js's shared contract objects directly
// — it already had its own working per-method DI seam since Phase 4A.5a
// (the five `*Fn` opts below), spanning what those contracts call the
// generate-shaped and discovery-shaped methods (readiness needs discovery
// methods, generate() needs a generate method), since this file is the one
// real consumer that genuinely needs both.
//
// The five `*Fn` opts now default to typed-unavailable stubs (mirroring
// indexer/phases/context.js's own applyContextCapability() pattern) —
// calling any of them without an override throws a clear
// "OllamaProviderNotConfiguredError" instead of silently reaching a real
// network call. The REAL, working functions are supplied by
// core/generation/registry.js's own createOllamaProvider wrapper (below
// this file, unchanged export name) ONLY when Full's own composition root
// constructs the 'ollama' backend — see registry.js's own header comment
// for exactly where those real functions are injected from.
class OllamaProviderNotConfiguredError extends Error {
  constructor(fnName) {
    super(`createOllamaProvider: ${fnName}() has no real implementation — this provider was constructed with no *Fn overrides. Full's own composition root must supply the real ollama-lazy.js-backed functions via generation/registry.js.`);
    this.name = 'OllamaProviderNotConfiguredError';
  }
}
function unavailable(fnName) {
  return async () => { throw new OllamaProviderNotConfiguredError(fnName); };
}
const isOllamaReachable = unavailable('isOllamaReachable');
const listOllamaModels = unavailable('listOllamaModels');
const validateOllamaModels = unavailable('validateOllamaModels');
const generateStream = unavailable('generateStream');
const getModelContextLength = unavailable('getModelContextLength');

const FALLBACK_MODEL = 'gemma3:4b';
const FALLBACK_BASE_URL = 'http://localhost:11434';

// The effective Ask context we ask Ollama to actually allocate
// (options.num_ctx on the generation request), capped at the model's own
// architectural maximum (getModelContextLength()). Ollama does NOT use a
// model's full architectural context by default — an unset num_ctx commonly
// runs at a much smaller runtime window (often 4096) regardless of what the
// model could support (per Ollama's own docs: "Show model details" reports
// the maximum, "Context length" is a separate, request-level setting) — so
// readiness must report the SAME number generate() actually requests, or
// the coordinator's context-budget math (fitEvidenceToContextBudget) bounds
// against a number Ollama was never told to honor (code review finding,
// Phase 4A round 3). Used only when the caller doesn't supply askNumCtx —
// the real production caller (generation/runtime.js) always does, sourced
// from resolveGenerationRuntimeConfig()'s ASK_NUM_CTX.
const FALLBACK_ASK_NUM_CTX = 8192;

/**
 * @param {{
 *   baseUrl?: string,
 *   model?: string,
 *   askNumCtx?: number,
 *   isOllamaReachableFn?: typeof isOllamaReachable,
 *   listOllamaModelsFn?: typeof listOllamaModels,
 *   validateOllamaModelsFn?: typeof validateOllamaModels,
 *   generateStreamFn?: typeof generateStream,
 *   getModelContextLengthFn?: typeof getModelContextLength,
 * }} [opts] baseUrl/model/askNumCtx fall back to fixed, non-env-derived
 *   constants ONLY so this factory remains safely callable in isolation
 *   (tests, or a future caller that hasn't resolved config yet) — the real
 *   production path always supplies all three from
 *   resolveGenerationRuntimeConfig(). fn overrides are DI-only (tests stub
 *   the network; production callers never pass them, so real requests
 *   always go through ollama.js). validateOllamaModelsFn (code review,
 *   round 4 follow-up): this file's own ready() used to call the module-
 *   scope validateOllamaModels directly, un-overridable, because the
 *   original import was always the real ollama-lazy.js-backed function —
 *   safe at the time, but once that default became a typed-unavailable
 *   stub (see this file's own header comment), any DI-based caller that
 *   supplied every OTHER *Fn override still hit the stub here. Added as a
 *   sixth DI seam so the whole five-network-call surface is consistently
 *   overridable.
 * @returns {import('./provider.js').GenerationProvider}
 */
export function createOllamaProvider({
  baseUrl = FALLBACK_BASE_URL,
  model = FALLBACK_MODEL,
  askNumCtx = FALLBACK_ASK_NUM_CTX,
  isOllamaReachableFn = isOllamaReachable,
  listOllamaModelsFn = listOllamaModels,
  validateOllamaModelsFn = validateOllamaModels,
  generateStreamFn = generateStream,
  getModelContextLengthFn = getModelContextLength,
} = {}) {
  return {
    name: () => 'ollama',

    // upstreamCancellation: true — generate()'s fetch() call passes the
    // caller's signal straight to Ollama's own HTTP request (see below),
    // so aborting it genuinely tears down that connection and Ollama
    // itself stops generating, not just this process's own consumption.
    capabilities: () => ({ streaming: true, clientAbort: true, upstreamCancellation: true }),

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
      // validateOllamaModels() is synchronous in core/ollama.js but the
      // lazy wrapper this file now imports from (../ollama-lazy.js) always
      // returns a Promise (matching ollama-lazy.js's own uniform async
      // signature) — this await is required, not stylistic; omitting it
      // would make `missing` a truthy Promise object and every ready()
      // call would incorrectly report the model as not installed.
      const missing = await validateOllamaModelsFn([model], available);
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
      // targets THIS provider's configured Ollama instance, not any other.
      const modelMax = await getModelContextLengthFn(model, undefined, baseUrl);
      const numCtx = Math.min(askNumCtx, modelMax);
      return { ok: true, model, numCtx };
    },

    async generate({ systemPrompt, prompt, model: requestedModel, options, signal, onToken }) {
      // num_ctx defaults to this provider's own askNumCtx when the caller
      // doesn't specify one — but the intended caller (the Ask coordinator)
      // always passes readiness.numCtx explicitly, since that is the exact
      // figure its own context-budget trimming (fitEvidenceToContextBudget)
      // bounded the prompt against. Without this default, a caller that
      // skipped ready() (or a future caller) would silently fall back to
      // whatever undocumented runtime default Ollama itself applies,
      // decoupling the request from any budget guarantee.
      const resolvedOptions = { num_ctx: askNumCtx, ...options };
      // systemPrompt forwards straight to generateStream()'s own `system`
      // option, which maps onto Ollama's native top-level `system` request
      // field — never concatenated into `prompt` here or in generateStream()
      // itself, and simply omitted when the caller supplied none (optional,
      // for backward-compatible non-Ask callers).
      return generateStreamFn(requestedModel ?? model, prompt, { system: systemPrompt, baseUrl, signal, onToken, options: resolvedOptions });
    },
  };
}
