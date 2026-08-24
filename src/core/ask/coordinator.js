// Ask coordinator (Phase 4A) — orchestrates one grounded-ask turn: evidence
// retrieval -> grounded prompt -> provider generation (streaming) ->
// citation/marker validation -> refusal decision. No HTTP/SSE concerns here
// (src/core/ask-api/v1/route.js owns framing) — this module exposes plain
// async callbacks (onSources/onToken) so it is testable without a real
// HTTP request/response pair. Transport- and provider-neutral: this module
// has no knowledge of the public wire contract's event names or field
// shapes — that projection lives entirely in core/ask-api/v1/contract.js.
//
// Owns the single-generation-at-a-time lock: only one ask() call may be
// "in flight" per coordinator instance at a time. A second call while one is
// running rejects immediately with a typed busy error — the caller (the
// route) turns that into 429 before any streaming starts. The lock is
// always released in `finally`, on every exit path (success, provider
// error, zero-evidence refusal, client abort). The lock itself is a shared,
// injectable SingleFlightGate (single-flight-gate.js), not a bare boolean —
// this is what lets Ask v2's coordinator (coordinator-v2.js) contend on the
// SAME lock as v1, including during v2's own rewrite/compaction steps that
// run outside this file's own critical section.
//
// createAskCore() (below) is the real, ungated logic — an EXPORTED
// INTERNAL factory (@internal), importable by register-neutral-routes.js/
// coordinator-v2.js/tests that need to share one instance across v1 and v2,
// but NEVER attached as a method on the object createAskCoordinator()
// returns. A caller holding only `{ ask, isBusy }` (any v1 route handler,
// any ordinary test) has no path to the ungated logic at all short of
// explicitly importing createAskCore() by name — a deliberate, auditable
// action, never an accidental extra method call on an object already in
// hand.
import { buildEvidence, fitEvidenceToContextBudget, DEFAULT_TOP } from './evidence.js';
import { buildPromptParts, RESERVED_HEADROOM_TOKENS, REFUSAL_SENTINEL } from './prompt.js';
import { validateCitations } from './citations.js';
import { createSingleFlightGate } from './single-flight-gate.js';
import { resolveAnswerMaxOutputTokens } from './budget-ledger.js';

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
 * @internal Exported so register-neutral-routes.js / createAskCoordinatorBundle()
 * (coordinator-v2.js) / coordinator-v2.js's own construction, and tests
 * exercising the shared-core wiring directly, can build ONE instance and
 * hand it to both createAskCoordinator() and createAskCoordinatorV2(). NOT
 * part of the GenerationProvider-adjacent application contract v1's route
 * uses — a route handler, and anything holding only a `{ask, isBusy}`
 * coordinator object, has no path to this function at all unless it
 * explicitly imports it by name, which is a deliberate, auditable action,
 * never an accidental method call on an object already in hand. Has no
 * `busy`/gate concept of its own — gating is entirely the caller's
 * responsibility (createAskCoordinator below, or coordinator-v2.js).
 *
 * @param {{
 *   adapter: import('../storage/adapter.js').StorageAdapter,
 *   embedQuery?: Function,
 *   countTokens: (text: string) => number|Promise<number>,
 *   generationProvider: import('../generation/provider.js').GenerationProvider,
 *   settingsService?: ReturnType<typeof import('../settings/service.js').createSettingsService>,
 *   cloudEmbed?: import('../embedding-profile/cloud-embedding-capability.js').CloudEmbeddingCapability,
 * }} deps
 *   settingsService is optional DI, forwarded to buildEvidence() so
 *   HYBRID_PREFETCH_LIMIT/RRF_K apply to Ask's own retrieval (code review
 *   finding — Ask previously always used qdrant/store.js's own direct env
 *   reads, silently ignoring a settings.json override). cloudEmbed is
 *   optional DI (code review, Phase 8B Step 6), forwarded to
 *   buildEvidence()/runHybridSearch() — only dereferenced when the
 *   resolved collection turns out to be qdrant-cloud.
 * @returns {(req: Object) => Promise<Object>} askCore — see the returned
 *   function's own JSDoc below for the full request/result shape.
 */
export function createAskCore({ adapter, embedQuery, countTokens, generationProvider, settingsService, cloudEmbed }) {
  /**
   * @param {{
   *   collection: string,
   *   question: string,
   *   sourceFile?: string,
   *   top?: number,
   *   retrievalQuery?: string,
   *   conversationContext?: { summary?: string, recentMessages?: Array<{role,content}> },
   *   readiness?: { ok: boolean, reason?: string, model?: string, numCtx?: number },
   *   signal?: AbortSignal,
   *   budget?: ReturnType<typeof import('./budget-ledger.js').createRequestBudgetLedger>,
   *   onSources: (payload: { searchMode: string|null, sources: Array<Object> }) => void,
   *   onToken: (text: string) => void,
   * }} req retrievalQuery/conversationContext/readiness are Ask v2
   *   additions, all optional and defaulted so v1's existing call shape
   *   (which never passes any of them) is completely unaffected:
   *   retrievalQuery is used ONLY for retrieval (buildEvidence), never for
   *   the rendered "Question:" text; conversationContext is threaded into
   *   both the budget check and the final prompt render, as its own
   *   separately-delimited section — `question` itself is NEVER augmented
   *   with history text anywhere in this function. `readiness` lets a
   *   caller that ALREADY resolved generationProvider.ready() (v2's
   *   coordinator, which needs numCtx before this function is even called,
   *   to budget conversation history) pass that SAME readiness through,
   *   instead of this function resolving a second, independent one —
   *   code review finding (P1): calling ready() twice per request risked
   *   history being trimmed against one numCtx/model while evidence and
   *   generation ran against a different one, if readiness changed
   *   between the two calls (e.g. a settings change or provider restart
   *   mid-request). Omitted (v1's own call shape), this function resolves
   *   its own readiness exactly as before.
   * @returns {Promise<
   *   | { status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] }
   *   | { status: 'done', text: string, citations: number[], invalidCitations: number[],
   *       nodeReferences: string[], strippedMarkers: string[], refused: boolean,
   *       provider: string, model: string, tokensIn?: number, tokensOut?: number,
   *       evidenceCount: number, elapsedMs: number }
   *   | { status: 'aborted', elapsedMs: number }
   *   | { status: 'provider_unavailable', reason: string }
   *   | { status: 'error', code?: string, message: string, retryAfterSeconds?: number }
   * >}
   *   A `budget`-denied final answer surfaces as
   *   `{ status: 'error', code: 'budget_exceeded'|'budget_limit_exceeded'|'budget_unenforceable', message, retryAfterSeconds? }` —
   *   see budget-ledger.js's reserve() for the exact denial codes it
   *   produces. Transient aggregate exhaustion uses `budget_exceeded` and
   *   carries Retry-After; structural request/key ceilings use
   *   `budget_limit_exceeded`; the provider capability check below uses
   *   `budget_unenforceable`.
   *   Never returns { status: 'busy' } — this function has no gate of its
   *   own; that status is produced only by createAskCoordinator()'s own
   *   ask() wrapper below.
   */
  return async function askCore({ collection, question, sourceFile, top = DEFAULT_TOP, retrievalQuery, conversationContext, readiness: suppliedReadiness, signal, budget, onSources, onToken }) {
    const startedAt = Date.now();

    const readiness = suppliedReadiness ?? await generationProvider.ready();
    if (!readiness.ok) {
      return { status: 'provider_unavailable', reason: readiness.reason ?? 'Generation provider is not ready.' };
    }

    // Cross-process propagation: a settings.json change saved via the
    // admin UI while this process has been running must be picked up
    // without a restart — same reasoning as MCP's search tool handler
    // and admin /api/search's route handler.
    settingsService?.refreshIfChanged();
    const evidence = await buildEvidence({ adapter, embedQuery, countTokens, collection, question, sourceFile, top, settingsService, cloudEmbed, retrievalQuery });
    if (evidence.error) {
      return { status: 'error', code: evidence.error, message: evidence.message };
    }

    const { searchMode } = evidence;

    // Bound the WHOLE prompt (rules + history + all evidence + question)
    // against the model's real context window (readiness.numCtx) —
    // per-source budgets alone don't guarantee it fits. May drop trailing
    // (lowest-ranked) sources and renumber; onSources reports exactly what
    // survives, so the client only ever sees sources that actually made it
    // into the prompt sent to the model. conversationContext defaults to
    // undefined, so v1's call shape (which omits it) computes an identical
    // budget to before this parameter existed. No separate history-token
    // reservation is subtracted here — conversationContext's own rendered
    // text is already part of what gets counted on every iteration below,
    // so subtracting a reservation on top of that would double-count
    // history (code review finding, P1 — see fitEvidenceToContextBudget()'s
    // own header comment for the full explanation).
    const fitted = await fitEvidenceToContextBudget(evidence.sources, question, readiness.numCtx, countTokens, conversationContext);
    const sources = fitted.sources;

    if (sources.length === 0) {
      // Awaited for the same reason onToken's return value is awaited below
      // — onSources may return a backpressure-drain promise (the sources
      // payload can be large), and not awaiting it would let this coroutine
      // race ahead before the write actually drained.
      await onSources({ searchMode, sources });
      return { status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] };
    }

    // The SAME conversationContext object used for budgeting above — one
    // object, one render, one count, matching what actually gets sent to
    // the provider. `question` is the literal original user question in
    // every case (v1 and v2 alike) — never augmented, never history-bearing.
    const { systemPrompt, userPrompt } = buildPromptParts(sources, question, conversationContext);
    const sentinelGuard = createSentinelGuard(onToken);

    // Spend/token budget reservation — reserve BEFORE calling the provider
    // AND before onSources() streams anything to the client, using a
    // conservative worst-case estimate (the REAL rendered prompt's token
    // count — never a hand-summed estimate, same "measure the actual
    // payload" discipline fitEvidenceToContextBudget() above already
    // follows — plus this call's hard output cap). A denial here therefore
    // produces a clean pre-stream failure with no `sources` event ever
    // sent, exactly like `busy`/`provider_unavailable` — not a partial SSE
    // stream that errors out midway. Ordering note (task requirement:
    // "document exact ordering"): the ONE unavoidable exception is Qdrant
    // retrieval itself (evidence.js, fitEvidenceToContextBudget above) —
    // reserving BEFORE retrieval would mean estimating input tokens from
    // nothing (no evidence yet exists to measure), which is exactly the
    // kind of ungrounded guess this codebase's own evidence-budgeting
    // discipline deliberately avoids. Retrieval is read-only, non-billed
    // Qdrant work, distinct from the billed generation-provider call this
    // ledger exists to gate — see the design doc's "enforcement order"
    // section for the full reasoning.
    //
    // `budget` is optional: production route.js (v1/v2) always supplies
    // one (every Ask route is `audience: integration`, so an authenticated
    // principal — and therefore a keyId to ledger against — always
    // exists); a caller with no budget concept (a future non-billed entry
    // point, or a test exercising unrelated behavior) simply gets no
    // enforcement here, same as before this feature existed.
    let reservation = null;
    if (budget) {
      const caps = generationProvider.capabilities();
      if (caps.hardOutputCap !== true) {
        // Fail closed: this ledger's entire guarantee depends on the
        // provider actually enforcing options.maxOutputTokens server-side.
        // A provider that cannot (or an unverified future one) must never
        // be allowed to run a "budgeted" call uncapped — that would silently
        // claim enforcement this codebase cannot actually provide.
        return {
          status: 'error',
          code: 'budget_unenforceable',
          message: 'The configured generation provider cannot enforce an output-token cap, so this protected Ask request was denied rather than run unbounded.',
        };
      }
      const estimatedInputTokens = await countTokens(`${systemPrompt ?? ''}\n${userPrompt}`);
      const maxOutputTokens = resolveAnswerMaxOutputTokens(settingsService);
      reservation = budget.reserve({ label: 'answer', estimatedInputTokens, maxOutputTokens });
      if (!reservation.ok) {
        return {
          status: 'error',
          code: Number.isFinite(reservation.retryAfterSeconds) ? 'budget_exceeded' : 'budget_limit_exceeded',
          message: reservation.message,
          ...(Number.isFinite(reservation.retryAfterSeconds) ? { retryAfterSeconds: reservation.retryAfterSeconds } : {}),
        };
      }
    }

    // Only reached once the reservation (if any) succeeded — a denied
    // request never streams sources, matching this function's own
    // pre-provider fail-closed contract above.
    await onSources({ searchMode, sources });

    let genResult;
    try {
      genResult = await generationProvider.generate({
        systemPrompt,
        prompt: userPrompt,
        model: readiness.model,
        // Pass the SAME numCtx readiness reported and that
        // fitEvidenceToContextBudget() bounded the prompt against — the
        // coordinator's context-budget math is meaningless if the
        // generation request doesn't ask the provider to actually honor
        // that context size (code review finding: readiness.numCtx and
        // the live request were previously decoupled, so Ollama could run
        // at its own smaller default regardless of what was budgeted for).
        // maxOutputTokens (provider-neutral, see generation/provider.js) is
        // only set when a reservation exists — an unbudgeted caller keeps
        // each provider's own prior uncapped default behavior exactly,
        // including passing `undefined` (not `{}`) when there is neither a
        // numCtx nor a reservation to report.
        options: (Number.isFinite(readiness.numCtx) || reservation)
          ? {
              ...(Number.isFinite(readiness.numCtx) ? { num_ctx: readiness.numCtx } : {}),
              ...(reservation ? { maxOutputTokens: reservation.maxOutputTokens } : {}),
            }
          : undefined,
        signal,
        onToken: (token) => sentinelGuard.push(token),
      });
    } catch (err) {
      // No reconcile() on either return below: a provider error/exception
      // gives no trustworthy usage figure, and the call may already have
      // incurred real, billed upstream work (explicitly true for Gemini —
      // see gemini-provider.js's own capabilities() comment) — the
      // reservation stays fully charged, the conservative default.
      if (signal?.aborted) return { status: 'aborted', elapsedMs: Date.now() - startedAt };
      return { status: 'error', message: `Generation failed: ${err.message}` };
    }

    if (genResult.aborted) {
      // Same reasoning as the catch block above: an abort gives no
      // trustworthy usage figure (Gemini's abortSignal is documented
      // client-only — upstream generation/billing may continue regardless
      // of this process observing `aborted: true`), so the reservation is
      // never reconciled/refunded here either.
      return { status: 'aborted', elapsedMs: Date.now() - startedAt };
    }

    if (reservation) {
      budget.reconcile(reservation.reservationId, { tokensIn: genResult.tokensIn, tokensOut: genResult.tokensOut });
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
  };
}

/**
 * The application-facing coordinator factory — public contract unchanged in
 * shape from before this file's Ask v2 revision (`{ ask, isBusy }`), except
 * for two new optional constructor params (`gate`/`core`), both defaulted
 * so every existing call site (v1's route, every existing test) is
 * unaffected. `gate` defaults to a private SingleFlightGate this function
 * creates for itself when omitted — the exact same single-flight semantics
 * this file always had, just expressed via the shared primitive instead of
 * a bare local `let busy`. `core` defaults to a freshly-constructed
 * createAskCore() built from the same adapter/embedQuery/... params this
 * function already takes.
 *
 * register-neutral-routes.js (via createAskCoordinatorBundle(), see
 * coordinator-v2.js) is the ONE production call site that passes an
 * explicit `core`/`gate` pair, so the SAME instances can also be handed to
 * createAskCoordinatorV2() — this is what makes v1 and v2 traffic
 * genuinely share one single-flight lock.
 *
 * @param {{
 *   adapter?: import('../storage/adapter.js').StorageAdapter,
 *   embedQuery?: Function,
 *   countTokens?: (text: string) => number|Promise<number>,
 *   generationProvider?: import('../generation/provider.js').GenerationProvider,
 *   settingsService?: ReturnType<typeof import('../settings/service.js').createSettingsService>,
 *   cloudEmbed?: import('../embedding-profile/cloud-embedding-capability.js').CloudEmbeddingCapability,
 *   gate?: ReturnType<typeof createSingleFlightGate>,
 *   core?: ReturnType<typeof createAskCore>,
 * }} deps adapter/embedQuery/countTokens/generationProvider/settingsService/
 *   cloudEmbed are only consulted when `core` is omitted (they construct
 *   the default createAskCore() instance) — a caller supplying its own
 *   `core` does not need to repeat them.
 * @returns {{ ask: Function, isBusy: () => boolean }}
 */
export function createAskCoordinator({ adapter, embedQuery, countTokens, generationProvider, settingsService, cloudEmbed, gate = createSingleFlightGate(), core } = {}) {
  const askCore = core ?? createAskCore({ adapter, embedQuery, countTokens, generationProvider, settingsService, cloudEmbed });

  async function ask(args) {
    const outcome = await gate.run(() => askCore(args));
    return outcome.ok ? outcome.value : { status: 'busy' };
  }

  return { ask, isBusy: gate.isBusy };
}

// Re-exported for callers that want the same headroom constant without a
// second import path (e.g. future settings surfaces reading defaults).
export { RESERVED_HEADROOM_TOKENS };
