// Lazy accessor for local/core/onnx-embed.js and local/core/length-bucket.js
// (Phase 8B Step 2 — physically relocated from core/ to local/core/, this
// file's own dynamic-import specifiers below are the only thing that
// changed then). Every module that needs local ONNX embedding reaches it
// THROUGH this module's dynamic loader instead of statically importing
// onnx-embed.js/length-bucket.js directly — mirrors core/ollama-lazy.js's
// pattern exactly (see that file's own header comment for the full
// rationale).
//
// Why this matters: Semidex Lite hard-pins DENSE_PROVIDER=qdrant-cloud
// unconditionally, so the ONNX dispatch branch in core/embeddings.js
// (cfg.denseProvider === 'bge-m3-onnx') is policy-unreachable in Lite.
// core/embeddings.js itself IS staged in Lite (it also handles the
// qdrant-cloud embedding path run.js/search.js use) — but onnx-embed.js and
// length-bucket.js (which pull onnxruntime-node, a heavy native dependency)
// must not be. With this static edge cut, both files have zero static
// importers among kept files and can be excluded from the staged package
// entirely.
//
// createOnnxEmbeddingCapability() (code review parity with Step 4's
// tag-onnx-lazy.js fix): onnx-embed.js's own coordinator state (tokenizer,
// InferenceSession, in-flight load promise, provider-fallback record) is no
// longer module-scope singleton state — each call to onnx-embed.js's own
// createOnnxEmbeddingCapability() returns a fresh, independent instance
// with its own session lifecycle (see that file's own header comment for
// the full isolation-gap finding and fix).
//
// This wrapper's own createOnnxEmbeddingCapability() is deliberately
// SYNCHRONOUS (returns the capability object immediately, not a Promise of
// one) — admin/server-full.js's createApp() is a synchronous function with
// 16 existing call sites across the codebase that all expect a synchronous
// return, and making createApp() itself async purely to await this
// construction would be a much larger, riskier ripple than necessary. The
// heavy dynamic import of local/core/onnx-embed.js/length-bucket.js (and,
// transitively, the real factory call inside it) is deferred until the
// FIRST real method call (loadOnnx()/loadOnnxBatch()/shutdown()) on the
// returned object, at which point it happens exactly once and is cached —
// matching the original bare-function lazy seam's own "no per-call
// overhead beyond the first" behavior. getOnnxProviderState() returns null
// until a real session has actually been created (the same "no session
// yet" answer it always gave), and shutdown() is a safe no-op if the real
// underlying instance was never constructed (no loadOnnx()/loadOnnxBatch()
// call ever happened) — mirrors the real onnx-embed.js's own shutdown()
// contract exactly.
//
// index-full.js/admin/server-full.js/mcp/server.js each call
// createOnnxEmbeddingCapability() exactly ONCE, at composition time, and
// pass the resulting wrapper object in as `onnxEmbed` — never call it
// per-request, and never share one instance across two
// separately-constructed compositions. Two such wrapper objects each defer
// to their OWN real createOnnxEmbeddingCapability() instance the first
// time they're actually used — never a shared one.

let _onnxEmbedMod = null;
let _lengthBucketMod = null;

async function loadOnnxEmbedModule() {
  if (!_onnxEmbedMod) _onnxEmbedMod = await import('../local/core/onnx-embed.js');
  return _onnxEmbedMod;
}

async function loadLengthBucketModule() {
  if (!_lengthBucketMod) _lengthBucketMod = await import('../local/core/length-bucket.js');
  return _lengthBucketMod;
}

/**
 * Returns a fresh, independent OnnxEmbedCapability wrapper object,
 * synchronously — see this file's own header comment for why. The heavy
 * dynamic import, and construction of the REAL underlying instance (see
 * onnx-embed.js's own createOnnxEmbeddingCapability() for its full
 * session-lifecycle contract), only happens the first time a method on the
 * returned object is actually called.
 * @returns {{
 *   loadOnnx: () => Promise<Function>,
 *   loadOnnxBatch: () => Promise<{ embedOnnxBatch: Function, embedBucketed: Function }>,
 *   getOnnxProviderState: () => Object | null,
 *   shutdown: () => Promise<void>,
 * }}
 */
export function createOnnxEmbeddingCapability(_testOnlyRealFactoryOptions) {
  // `_testOnlyRealFactoryOptions` (deliberately underscore-prefixed and
  // undocumented in this function's own public JSDoc below): forwarded,
  // unchanged, as the real local/core/onnx-embed.js
  // createOnnxEmbeddingCapability()'s own `options` argument (its
  // `ortFactory`/`loadTokenizerAndModel` test-only DI seams). Production
  // callers (index-full.js/admin/server-full.js/mcp/server.js) never pass
  // this — always call createOnnxEmbeddingCapability() with zero
  // arguments, exactly as before. It exists solely so
  // tests/unit/core/onnx-embed-lazy-concurrency.test.js can exercise THIS
  // wrapper's own concurrent-first-call race (below) with a fake, instant
  // ORT/tokenizer, instead of the real one — without it, this file's own
  // dynamic import always resolves to the real module and every test
  // would need the real 2.3GB model to exercise this wrapper's own logic
  // at all, which the task's own constraints (and every other test in
  // this codebase) deliberately avoid.
  //
  // Instance-scoped to THIS wrapper object's own closure — a second
  // createOnnxEmbeddingCapability() call gets its own independent
  // `_instance`/`_instancePromise`/`_lengthBucketMod` binding, never this
  // one's.
  let _instance = null;
  // Code review (P1): ensureInstance() used to memoize only `_instance`,
  // which is not assigned until AFTER the `await Promise.all(...)` below
  // resolves. Two concurrent first calls (e.g. loadOnnx() and
  // loadOnnxBatch() invoked back to back before either has awaited
  // anything, or two concurrent loadOnnx() calls) both saw `_instance`
  // still null, both proceeded past the guard, and both constructed a
  // real underlying local/core/onnx-embed.js capability — the second
  // assignment silently overwrote `_instance`, orphaning the first
  // instance's own ONNX session (no reference to it survives, so
  // shutdown() can never release it). Fixed by memoizing the in-flight
  // PROMISE itself, synchronously, before any `await` — every caller
  // during the construction window (whether the very first call or a
  // concurrent one) awaits the SAME promise and gets the SAME instance.
  let _instancePromise = null;

  function ensureInstance() {
    if (!_instancePromise) {
      _instancePromise = (async () => {
        const [onnxEmbedMod, lengthBucketMod] = await Promise.all([loadOnnxEmbedModule(), loadLengthBucketModule()]);
        const real = onnxEmbedMod.createOnnxEmbeddingCapability(_testOnlyRealFactoryOptions);
        _instance = {
          loadOnnx: real.loadOnnx,
          async loadOnnxBatch() {
            const { embedOnnxBatch } = await real.loadOnnxBatch();
            return { embedOnnxBatch, embedBucketed: lengthBucketMod.embedBucketed };
          },
          getOnnxProviderState: real.getOnnxProviderState,
          shutdown: real.shutdown,
        };
        return _instance;
      })();
    }
    return _instancePromise;
  }

  return {
    async loadOnnx() {
      return (await ensureInstance()).loadOnnx();
    },
    async loadOnnxBatch() {
      return (await ensureInstance()).loadOnnxBatch();
    },
    getOnnxProviderState() {
      // No real instance constructed yet means no session has ever been
      // created either — the same "null" answer the pre-instance-scoped
      // design gave before any embed call ever happened. Deliberately
      // reads `_instance` (set only once construction has actually
      // finished), not `_instancePromise` (set as soon as construction
      // STARTS) — a construction still in flight has no provider state
      // to report yet either.
      return _instance ? _instance.getOnnxProviderState() : null;
    },
    async shutdown() {
      // Code review (P1, same race as above): must not read `_instance`
      // directly here either — a concurrent first call could have already
      // started constructing the real instance (via ensureInstance(),
      // e.g. from a loadOnnx() call racing against this shutdown()) while
      // `_instance` itself is still null, and a naive `if (!_instance)
      // return` would wrongly treat that as "nothing to shut down," later
      // leaking the session construction is about to assign. If a
      // construction was ever started (`_instancePromise` set), always
      // await it — a failed construction (rejected promise) means no
      // real instance/session exists, nothing to release; a successful
      // one is shut down the same as any other.
      if (!_instancePromise) return;
      const instance = await _instancePromise.catch(() => null);
      if (instance) await instance.shutdown();
    },
  };
}
