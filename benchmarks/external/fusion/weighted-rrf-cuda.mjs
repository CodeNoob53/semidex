// Shared, pure strict-CUDA verification helpers for every live weighted-RRF
// benchmark harness that runs a local BGE-M3 ONNX provider
// (run-weighted-rrf-live.mjs for SciFact/MIRACL,
// run-slavic-weighted-rrf.mjs for the Slavic Belebele matrix). Extracted so
// both harnesses enforce the exact same strict-CUDA contract — CUDA is an
// execution ACCELERATOR only; neither function here is ever used to compare
// retrieval quality across execution providers, only to verify that a
// requested accelerator was actually the one that ran.
//
// Every consumed "scope"/"language" item needs only `{ id, provider: { kind
// } }` — `provider.kind === 'local'` triggers CUDA requirements,
// `provider.kind === 'cloud'` (or any other value) is always exempt.

/** Pre-flight gate: a full (non-smoke) benchmark run must refuse to index
 * ANY local item at all unless strict CUDA is actually configured in the
 * environment — ONNX_EXECUTION_PROVIDER=cuda AND ONNX_CUDA_STRICT=1. This
 * is checked BEFORE any collection is created or any embedding call is
 * made, for every local item in the run, not merely verified after the
 * fact. verifyCudaProvenance() below is a separate, complementary check —
 * it catches a silent CPU fallback for an item that DID request CUDA; this
 * function instead ensures CUDA/strict were requested in the first place,
 * so a plain harness invocation against local items can never silently
 * benchmark on CPU with no error at all. Cloud-only runs (no local item
 * requested) are entirely unaffected — this never checks or requires
 * anything about ONNX for a run that has no local item. */
export function verifyStrictCudaConfigured(items, env = process.env) {
  // Field name is localScopeIds (not the more generic "localIds") to match
  // run-weighted-rrf-live.mjs's pre-existing, already-tested public
  // contract for this function — kept unchanged across the extraction into
  // this shared module so no existing caller/test needed to change.
  const localScopeIds = items.filter((s) => s.provider.kind === 'local').map((s) => s.id);
  if (localScopeIds.length === 0) return { ok: true, reason: null, localScopeIds };
  const requestedProvider = (env.ONNX_EXECUTION_PROVIDER ?? '').trim().toLowerCase();
  const strictConfigured = env.ONNX_CUDA_STRICT === '1';
  if (requestedProvider === 'cuda' && strictConfigured) return { ok: true, reason: null, localScopeIds };
  return {
    ok: false,
    localScopeIds,
    reason: `Local items (${localScopeIds.join(', ')}) require strict CUDA: set ONNX_EXECUTION_PROVIDER=cuda and ONNX_CUDA_STRICT=1 in the environment before running the full benchmark. Got ONNX_EXECUTION_PROVIDER=${JSON.stringify(env.ONNX_EXECUTION_PROVIDER ?? null)}, ONNX_CUDA_STRICT=${JSON.stringify(env.ONNX_CUDA_STRICT ?? null)}. Use --smoke to run without CUDA.`,
  };
}

/** Verifies strict-CUDA provenance for a completed local item. Returns
 * `{ ok: true }` when the item is cloud (not applicable), when it did not
 * request CUDA at all, or when CUDA was both requested AND effectively
 * used. Returns `{ ok: false, reason }` when CUDA was requested but the
 * effective provider ended up being something else (cpu fallback, or no
 * embedding call ever recorded a provider state at all — e.g. every
 * query/indexing step failed before the first successful embed call). This
 * is the exact rejection rule required: "reject a local run if CUDA was
 * requested but the effective provider was not CUDA." */
export function verifyCudaProvenance(item, onnxProvenance) {
  if (item.provider.kind !== 'local') return { ok: true, reason: null };
  if (!onnxProvenance) return { ok: false, reason: 'Local item produced no ONNX provenance at all — no embedding call ever completed.' };
  if (onnxProvenance.requestedProvider !== 'cuda') return { ok: true, reason: null };
  if (onnxProvenance.effectiveProvider === 'cuda' && !onnxProvenance.fellBackToCpu) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `CUDA was requested (ONNX_EXECUTION_PROVIDER=cuda) but the effective provider was "${onnxProvenance.effectiveProvider ?? 'unknown'}" (fellBackToCpu=${onnxProvenance.fellBackToCpu}). Strict-CUDA items must fail rather than silently benchmark on CPU.`,
  };
}
