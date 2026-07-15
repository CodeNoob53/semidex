// Ask coordinator (Phase 4A) — orchestrates one grounded-ask turn: evidence
// retrieval -> grounded prompt -> provider generation (streaming) ->
// citation/marker validation -> refusal decision. No HTTP/SSE concerns here
// (src/admin/api/ask.js owns framing) — this module exposes plain async
// callbacks (onSources/onToken) so it is testable without a real HTTP
// request/response pair.
//
// Owns the single-generation-at-a-time lock: only one ask() call may be
// "in flight" per coordinator instance at a time. A second call while one is
// running rejects immediately with a typed busy error — the caller (the
// route) turns that into 429 before any streaming starts. The lock is
// always released in `finally`, on every exit path (success, provider
// error, zero-evidence refusal, client abort).
import { buildEvidence, fitEvidenceToContextBudget, DEFAULT_TOP } from './evidence.js';
import { buildPrompt, RESERVED_HEADROOM_TOKENS, REFUSAL_SENTINEL } from './prompt.js';
import { validateCitations } from './citations.js';

// Holds back streamed tokens until the accumulated text can no longer be a
// prefix of REFUSAL_SENTINEL — the model is instructed to emit that exact
// sentinel and NOTHING else on refusal, so as long as accumulated text stays
// a prefix of it, forwarding tokens to the client risks leaking the
// sentinel mid-stream (it was previously forwarded raw via onToken before
// citations.js ever got a chance to strip it — a real leak, confirmed live:
// 9 streamed fragments spelling out "[[INSUFFICIENT_EVIDENCE]]" reached the
// client). Once the buffered text diverges from being a sentinel prefix (or
// generation ends), flush() releases everything held so far and every
// subsequent token streams through immediately, same as before.
//
// Comparison against the sentinel uses held.trim(), never raw `held` — a
// response of "\n[[INSUFFICIENT_EVIDENCE]]\n" (leading/trailing whitespace,
// which validateCitations() already tolerates via its own text.trim()
// check) was previously treated as diverging on the very first character
// (a bare "\n" is not a prefix of "[["), flushing the leading newline AND
// leaving `diverged` permanently true — so the entire sentinel that
// followed streamed through raw too (code review finding, confirmed at
// runtime). Held text is only ever flushed once trimming it proves it can
// never equal the sentinel; trailing whitespace after a would-be sentinel
// is never released early, since more non-whitespace could still follow
// before generation ends.
function createSentinelGuard(onToken) {
  let held = '';
  let diverged = false; // true once trimmed accumulated text can no longer equal the sentinel
  return {
    // Returns whatever onToken returns (a backpressure-drain promise, or
    // undefined) so the caller can await it — held tokens resolve
    // immediately (nothing was written yet), a flush/passthrough resolves
    // to the real write's backpressure signal.
    push(token) {
      if (diverged) return onToken?.(token);
      held += token;
      const trimmed = held.trim();
      // Still a possible sentinel-in-progress (including an exact match so
      // far, or all-whitespace-so-far) — keep holding. Only forward once
      // the trimmed text is neither a prefix of the sentinel nor a prefix
      // OF the sentinel from the sentinel's own side (i.e. genuinely
      // cannot become the sentinel with more tokens).
      if (trimmed === '' || trimmed === REFUSAL_SENTINEL || REFUSAL_SENTINEL.startsWith(trimmed)) {
        return undefined; // unresolved, exact-so-far, or still all whitespace — hold
      }
      diverged = true;
      const toFlush = held;
      held = '';
      return onToken?.(toFlush);
    },
    // Called once generation is complete, with the full raw text. If it IS
    // exactly the sentinel (after trim), nothing is flushed — the client
    // never saw any part of it, and validateCitations reports refused: true.
    // Otherwise flushes whatever remained held (a short answer, or text that
    // starts like the sentinel but the full response diverges from it).
    finalize(fullText) {
      if (diverged) return undefined; // already flushed everything as it streamed
      if (held && fullText.trim() !== REFUSAL_SENTINEL) {
        const toFlush = held;
        held = '';
        return onToken?.(toFlush);
      }
      held = '';
      return undefined;
    },
  };
}

/**
 * @param {{
 *   adapter: import('../storage/adapter.js').StorageAdapter,
 *   embedQuery?: Function,
 *   countTokens: (text: string) => number|Promise<number>,
 *   generationProvider: import('../generation/provider.js').GenerationProvider,
 *   settingsService?: ReturnType<typeof import('../settings/service.js').createSettingsService>,
 * }} deps
 *   settingsService is optional DI, forwarded to buildEvidence() so
 *   HYBRID_PREFETCH_LIMIT/RRF_K apply to Ask's own retrieval (code review
 *   finding — Ask previously always used qdrant/store.js's own direct env
 *   reads, silently ignoring a settings.json override).
 */
export function createAskCoordinator({ adapter, embedQuery, countTokens, generationProvider, settingsService }) {
  let busy = false;

  /**
   * @param {{
   *   collection: string,
   *   question: string,
   *   sourceFile?: string,
   *   top?: number,
   *   signal?: AbortSignal,
   *   onSources: (payload: { searchMode: string|null, sources: Array<Object> }) => void,
   *   onToken: (text: string) => void,
   * }} req
   * @returns {Promise<
   *   | { status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] }
   *   | { status: 'done', text: string, citations: number[], invalidCitations: number[],
   *       nodeReferences: string[], strippedMarkers: string[], refused: boolean,
   *       provider: string, model: string, tokensIn?: number, tokensOut?: number,
   *       evidenceCount: number, elapsedMs: number }
   *   | { status: 'aborted', elapsedMs: number }
   *   | { status: 'busy' }
   *   | { status: 'provider_unavailable', reason: string }
   *   | { status: 'error', code?: string, message: string }
   * >}
   */
  async function ask({ collection, question, sourceFile, top = DEFAULT_TOP, signal, onSources, onToken }) {
    if (busy) return { status: 'busy' };
    busy = true;
    const startedAt = Date.now();

    try {
      const readiness = await generationProvider.ready();
      if (!readiness.ok) {
        return { status: 'provider_unavailable', reason: readiness.reason ?? 'Generation provider is not ready.' };
      }

      // Cross-process propagation: a settings.json change saved via the
      // admin UI while this process has been running must be picked up
      // without a restart — same reasoning as MCP's search tool handler
      // and admin /api/search's route handler.
      settingsService?.refreshIfChanged();
      const evidence = await buildEvidence({ adapter, embedQuery, countTokens, collection, question, sourceFile, top, settingsService });
      if (evidence.error) {
        return { status: 'error', code: evidence.error, message: evidence.message };
      }

      const { searchMode } = evidence;

      // Bound the WHOLE prompt against the model's real context window
      // (readiness.numCtx) — per-source budgets alone don't guarantee the
      // reconstructed prompt (rules + all evidence + question) fits. May
      // drop trailing (lowest-ranked) sources and renumber; onSources
      // reports exactly what survives, so the client only ever sees sources
      // that actually made it into the prompt sent to the model.
      const fitted = await fitEvidenceToContextBudget(evidence.sources, question, readiness.numCtx, countTokens);
      const sources = fitted.sources;
      // Awaited for the same reason onToken's return value is awaited below
      // — onSources may return a backpressure-drain promise (the sources
      // payload can be large), and not awaiting it would let this coroutine
      // race ahead into generation before the write actually drained.
      await onSources({ searchMode, sources });

      if (sources.length === 0) {
        return { status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] };
      }

      const prompt = buildPrompt(sources, question);
      const sentinelGuard = createSentinelGuard(onToken);

      let genResult;
      try {
        genResult = await generationProvider.generate({
          prompt,
          model: readiness.model,
          // Pass the SAME numCtx readiness reported and that
          // fitEvidenceToContextBudget() bounded the prompt against — the
          // coordinator's context-budget math is meaningless if the
          // generation request doesn't ask the provider to actually honor
          // that context size (code review finding: readiness.numCtx and
          // the live request were previously decoupled, so Ollama could run
          // at its own smaller default regardless of what was budgeted for).
          options: Number.isFinite(readiness.numCtx) ? { num_ctx: readiness.numCtx } : undefined,
          signal,
          onToken: (token) => sentinelGuard.push(token),
        });
      } catch (err) {
        if (signal?.aborted) return { status: 'aborted', elapsedMs: Date.now() - startedAt };
        return { status: 'error', message: `Generation failed: ${err.message}` };
      }

      if (genResult.aborted) {
        return { status: 'aborted', elapsedMs: Date.now() - startedAt };
      }

      await sentinelGuard.finalize(genResult.text ?? '');

      const validated = validateCitations(genResult.text, sources);

      return {
        status: 'done',
        text: validated.text,
        citations: validated.citations,
        invalidCitations: validated.invalidCitations,
        nodeReferences: validated.nodeReferences,
        strippedMarkers: validated.strippedMarkers,
        refused: validated.refused,
        provider: generationProvider.name(),
        model: readiness.model,
        tokensIn: genResult.tokensIn,
        tokensOut: genResult.tokensOut,
        evidenceCount: sources.length,
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      busy = false;
    }
  }

  return { ask, isBusy: () => busy };
}

// Re-exported for callers that want the same headroom constant without a
// second import path (e.g. future settings surfaces reading defaults).
export { RESERVED_HEADROOM_TOKENS };
