// Phase 8B Step 1, code review P1 fix — proves indexer/index-full.js's real
// main-module branch explicitly wires Full's capabilities via
// applyAllCapabilities(), rather than relying only on each phase module's
// own implicit *-lazy.js default (which is what a prior version of this
// step left unaddressed — applyAllCapabilities() existed but nothing in
// production ever called it).
//
// Round 4: indexer/index.js used to be the ONE shared spawn target for
// both Full and Lite, branching on a SEMIDEX_INDEXER_EDITION env var
// internally — the AST-based Lite package closure validator is
// branch-insensitive, so a literal `import '../local/core/ollama.js'`
// anywhere in a Lite-shipped file's source would be a real static edge
// regardless of which `if` branch it sat in. index.js was split into
// index-full.js (Full's own real capability-injecting entry point,
// excluded from the Lite package) and index-lite.js (Lite's own entry
// point, imports no local-runtime module at all). indexer/index.js is now
// only a thin backward-compatible launcher (`import './index-full.js'`)
// with no capability-building imports of its own.
//
// This test does not spawn the real CLI (that requires live Qdrant/Ollama
// to get past bootstrapping) — it instead proves the STRUCTURAL fact the
// review asked for: index-full.js's source, inside its isMainModule guard,
// builds a real *-lazy.js module object for every capability slot and
// passes the whole bundle into run({ capabilities }) (via index-runtime.js's
// runIndexerCli()), in one step — never a two-step mutate-the-module-then-
// call-bare-run() sequence (Phase 8B Step 3, second review pass: an earlier
// version of runIndexerCli() called `applyAllCapabilities(capabilities)`
// to mutate run.js's own module state, then invoked bare `run()` — even
// though the mutator itself validated correctly, that two-step SHAPE at
// the caller boundary could still interleave with a second composition
// root's own call in the same process. run.js now holds no module-scope
// capability state at all — see run.js's own header comment — and
// run({ capabilities }) is the whole call). Combined with
// tests/unit/indexer/phase-capability-injection.test.js's existing
// behavioral proof that run({ capabilities })'s own buildRunContext()
// correctly validates and threads every phase seam's capability, this
// closes the gap: production Full composition now explicitly selects its
// capability implementations, not merely defaults into them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runFullIndexerComposition } from '../../../src/indexer/index-full.js';

describe('indexer/index-full.js — Full composition explicitly builds and passes its capability bundle to run({ capabilities })', () => {
  const src = readFileSync(new URL('../../../src/indexer/index-full.js', import.meta.url), 'utf-8');
  const runtimeSrc = readFileSync(new URL('../../../src/shared/indexer/index-runtime.js', import.meta.url), 'utf-8');

  it('imports runIndexerCli from index-runtime.js and calls it with a capability bundle', () => {
    assert.match(src, /import \{ isIndexerMainModule, runIndexerCli \} from '\.\.\/shared\/indexer\/index-runtime\.js'/);
    assert.match(src, /await runIndexerCliFn\(\{/);
  });

  it('index-runtime.js\'s runIndexerCli() imports run from run.js and calls run({ capabilities }) directly — never a two-step mutate-then-call sequence', () => {
    assert.match(runtimeSrc, /applyAllSettings,\s*run\s*}\s*=\s*await import\(['"]\.\/run\.js['"]\)/);
    assert.match(runtimeSrc, /run\(\{\s*capabilities\s*\}\)/);
    // The old two-step shape (mutate run.js's module state, then call bare
    // run()) must not be present anywhere as real code — proves the caller
    // boundary itself can't reintroduce the module-scope-state bug class.
    const codeOnly = runtimeSrc.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(codeOnly, /applyAllCapabilities/);
  });

  it('runIndexerCli() delegates run({ capabilities }) to runAndReportExitCode() — genuinely awaited, not fire-and-forget (code review, P2)', () => {
    // The actual await/try-catch/exitCode behavior is proven behaviorally
    // in tests/unit/indexer/index-runtime-run-and-report-exit-code.test.js;
    // this is just the structural wiring check that runIndexerCli() itself
    // delegates to that function rather than reintroducing its own
    // fire-and-forget run().catch(...) call.
    assert.match(runtimeSrc, /await runAndReportExitCode\(\(\) => run\(\{\s*capabilities\s*\}\)\)/);
    // Doesn't grep for the bare substring — runAndReportExitCode()'s own
    // doc comment legitimately quotes the old `run().catch(...)` shape in
    // prose, explaining the bug it replaced. What must be absent is that
    // shape appearing as real (non-comment) code.
    const codeOnly = runtimeSrc.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(codeOnly, /run\(\)\.catch\(/);
  });

  it('the capability objects passed are constructed from dynamically-imported local/ modules (real, working implementations — not stubs; dynamic rather than static so merely importing index.js, without running it as the main module, never triggers local/core/ollama.js\'s own top-level dotenv side effect — see index-full.js\'s own header comment)', () => {
    assert.match(src, /await import\(['"]\.\.\/local\/core\/ollama-capability\.js['"]\)/);
    assert.match(src, /await import\(['"]\.\.\/local\/core\/onnx-embed\.js['"]\)/);
    assert.match(src, /await import\(['"]\.\.\/local\/indexer\/phases\/tag-onnx\.js['"]\)/);
  });

  it('runFullIndexerComposition() is exported and called from inside the isIndexerMainModule guard, never as an import-time side effect', () => {
    assert.match(src, /export async function runFullIndexerComposition/);
    const guardStart = src.indexOf('if (isIndexerMainModule(');
    const compositionCall = src.indexOf('await runFullIndexerComposition();');
    assert.ok(guardStart >= 0, 'expected an isIndexerMainModule() guard in index-full.js');
    assert.ok(compositionCall > guardStart, 'runFullIndexerComposition() must be called inside the guard');
  });
});

// runFullIndexerComposition() — review finding (P2): the indexer CLI is a
// one-shot job; a broken ONNX runtime resolution must fail fast (no job
// starts, exit code 1) rather than silently proceeding to attempt a
// runtime already proven broken. Every test here is BEHAVIORAL: it calls
// the real exported function with fully injected fakes and asserts on
// what it actually does/returns — not source-text regex.
describe('runFullIndexerComposition() — fail-fast on a broken ONNX runtime resolution (review finding, P2)', () => {
  function fakeSettingsService() {
    return { getActiveValue: () => '' };
  }

  it('a successful resolution (prepared.ok: true) proceeds to build capabilities and call runIndexerCliFn — started: true', async () => {
    let runIndexerCliCalled = false;
    let receivedCapabilities = null;
    const result = await runFullIndexerComposition({
      resolveOnnxRuntimeForProcessFn: () => ({ resolved: { source: 'npm' }, resolutionWarning: null, prepared: { ok: true } }),
      bootstrapEnvFn: () => ({ osEnv: {}, dotenvValues: {} }),
      createSettingsServiceFn: fakeSettingsService,
      runIndexerCliFn: async (capabilities) => { runIndexerCliCalled = true; receivedCapabilities = capabilities; },
    });
    assert.equal(result.started, true);
    assert.equal(runIndexerCliCalled, true);
    assert.ok(receivedCapabilities.onnxEmbed);
    assert.ok(receivedCapabilities.tagOnnx);
    assert.ok(receivedCapabilities.cloudEmbed);
  });

  it('a broken resolution (prepared.ok: false) returns started:false, exitCode:1, and NEVER calls runIndexerCliFn — no job starts against a runtime already proven broken', async () => {
    let runIndexerCliCalled = false;
    const errors = [];
    const result = await runFullIndexerComposition({
      resolveOnnxRuntimeForProcessFn: () => ({
        resolved: { source: 'managed', managedId: '1.26.0-cuda13' },
        resolutionWarning: null,
        prepared: { ok: false, reason: 'recorded cuDNN directory no longer exists on disk' },
      }),
      bootstrapEnvFn: () => ({ osEnv: {}, dotenvValues: {} }),
      createSettingsServiceFn: fakeSettingsService,
      runIndexerCliFn: async () => { runIndexerCliCalled = true; },
      errorLogFn: (msg) => errors.push(msg),
    });
    assert.deepEqual(result, { started: false, exitCode: 1 });
    assert.equal(runIndexerCliCalled, false, 'a one-shot job must never start against a runtime already proven broken');
    assert.ok(errors.some((e) => e.includes('recorded cuDNN directory no longer exists on disk')), 'the specific failure reason must be logged, not swallowed');
  });

  // Review finding (P1): an invalid/corrupt EXPLICIT managed selection is
  // no longer a scenario where prepared.ok can be true — real
  // resolveOnnxRuntimeForProcess() now folds that failure into
  // prepared.ok:false (see onnx-runtime-source-resolution.js's own
  // resolutionFailed mechanism and its dedicated test coverage in
  // onnx-runtime-source-resolution.test.js). This test instead proves
  // runFullIndexerComposition() trusts `prepared.ok` alone to decide
  // fail-fast — not resolutionWarning's mere presence — using a
  // resolutionWarning shape that is NOT a broken-selection failure (e.g.
  // a hypothetical future informational note), so the job legitimately
  // proceeds.
  it('a resolutionWarning that is NOT paired with prepared.ok:false is logged but does not by itself fail the job — only prepared.ok decides that', async () => {
    let runIndexerCliCalled = false;
    const warnings = [];
    const result = await runFullIndexerComposition({
      resolveOnnxRuntimeForProcessFn: () => ({
        resolved: { source: 'npm', managedId: null },
        resolutionWarning: 'informational: no ONNX_MANAGED_RUNTIME configured, using default npm package',
        prepared: { ok: true },
      }),
      bootstrapEnvFn: () => ({ osEnv: {}, dotenvValues: {} }),
      createSettingsServiceFn: fakeSettingsService,
      runIndexerCliFn: async () => { runIndexerCliCalled = true; },
      warnLogFn: (msg) => warnings.push(msg),
    });
    assert.equal(result.started, true);
    assert.equal(runIndexerCliCalled, true);
    assert.ok(warnings.some((w) => w.includes('informational')));
  });

  it('an invalid/corrupt EXPLICIT managed selection now produces prepared.ok:false (via resolutionFailed) and fails the job — the exact scenario the review finding closed', async () => {
    let runIndexerCliCalled = false;
    const errors = [];
    const result = await runFullIndexerComposition({
      resolveOnnxRuntimeForProcessFn: () => ({
        resolved: { source: 'npm', managedId: null, resolutionFailed: true },
        resolutionWarning: 'managed runtime selected but invalid/corrupt: invalid managed runtime id "x"',
        prepared: { ok: false, reason: 'managed runtime selected but invalid/corrupt: invalid managed runtime id "x"' },
      }),
      bootstrapEnvFn: () => ({ osEnv: {}, dotenvValues: {} }),
      createSettingsServiceFn: fakeSettingsService,
      runIndexerCliFn: async () => { runIndexerCliCalled = true; },
      errorLogFn: (msg) => errors.push(msg),
    });
    assert.deepEqual(result, { started: false, exitCode: 1 });
    assert.equal(runIndexerCliCalled, false, 'the indexer must never proceed on CPU/npm when the user explicitly selected a managed CUDA runtime that failed to resolve');
    assert.ok(errors.some((e) => e.includes('invalid/corrupt')));
  });

  it('reads settingsService via createSettingsServiceFn({ osEnv, dotenvValues }) from bootstrapEnvFn()\'s own output — real provenance wiring, not a raw process.env read', async () => {
    let receivedBootstrapArgs = undefined;
    let receivedEnvArgs = null;
    await runFullIndexerComposition({
      resolveOnnxRuntimeForProcessFn: () => ({ resolved: { source: 'npm' }, resolutionWarning: null, prepared: { ok: true } }),
      bootstrapEnvFn: (...args) => { receivedBootstrapArgs = args; return { osEnv: { FAKE: '1' }, dotenvValues: { OTHER: '2' } }; },
      createSettingsServiceFn: (args) => { receivedEnvArgs = args; return fakeSettingsService(); },
      runIndexerCliFn: async () => {},
    });
    assert.deepEqual(receivedBootstrapArgs, []);
    assert.deepEqual(receivedEnvArgs, { osEnv: { FAKE: '1' }, dotenvValues: { OTHER: '2' } });
  });
});

describe('indexer/index.js — backward-compatible launcher, no capability imports of its own', () => {
  const src = readFileSync(new URL('../../../src/indexer/index.js', import.meta.url), 'utf-8');

  it('delegates to index-full.js and nothing else', () => {
    assert.match(src.trim(), /^import '\.\/index-full\.js';?$/m);
  });

  it('never imports local/core/ollama-capability.js, local/core/onnx-embed.js, or local/indexer/phases/tag-onnx.js directly', () => {
    assert.doesNotMatch(src, /import\(['"][^'"]*local\/core\/ollama-capability\.js['"]\)/);
    assert.doesNotMatch(src, /import\(['"][^'"]*local\/core\/onnx-embed\.js['"]\)/);
    assert.doesNotMatch(src, /import\(['"][^'"]*local\/indexer\/phases\/tag-onnx\.js['"]\)/);
    assert.doesNotMatch(src, /^import .*local\/core\/ollama-capability\.js/m);
    assert.doesNotMatch(src, /^import .*local\/core\/onnx-embed\.js/m);
    assert.doesNotMatch(src, /^import .*local\/indexer\/phases\/tag-onnx\.js/m);
  });
});

describe('indexer/index-lite.js — Lite composition never imports a local-runtime module', () => {
  const src = readFileSync(new URL('../../../src/indexer/index-lite.js', import.meta.url), 'utf-8');

  it('never imports local/core/ollama-capability.js, local/core/onnx-embed.js, or local/indexer/phases/tag-onnx.js', () => {
    assert.doesNotMatch(src, /import\(['"][^'"]*local\/core\/ollama-capability\.js['"]\)/);
    assert.doesNotMatch(src, /import\(['"][^'"]*local\/core\/onnx-embed\.js['"]\)/);
    assert.doesNotMatch(src, /import\(['"][^'"]*local\/indexer\/phases\/tag-onnx\.js['"]\)/);
    assert.doesNotMatch(src, /^import .*local\/core\/ollama-capability\.js/m);
    assert.doesNotMatch(src, /^import .*local\/core\/onnx-embed\.js/m);
    assert.doesNotMatch(src, /^import .*local\/indexer\/phases\/tag-onnx\.js/m);
  });

  it('supplies a typed-unavailable capability for every slot and calls runIndexerCli() inside its own isIndexerMainModule guard', () => {
    assert.match(src, /import \{ isIndexerMainModule, runIndexerCli \} from '\.\.\/shared\/indexer\/index-runtime\.js'/);
    const guardStart = src.indexOf('if (isIndexerMainModule(');
    const runIndexerCliCall = src.indexOf('await runIndexerCli({');
    assert.ok(guardStart >= 0 && runIndexerCliCall > guardStart);
    const callMatch = src.match(/await runIndexerCli\(\{([\s\S]*?)\}\);/);
    assert.ok(callMatch, 'expected a real runIndexerCli({...}) call in index-lite.js');
    for (const key of ['ollamaGenerate', 'ollamaSummary', 'ollamaEmbed', 'ollamaDiscovery', 'onnxEmbed', 'tagOnnx', 'cloudEmbed']) {
      assert.match(callMatch[1], new RegExp(key));
    }
  });
});

describe('run.js — run({ capabilities }) accepts real local/-backed capabilities for every slot without validation failure', () => {
  it('real local/core/ollama-capability.js factories, plus real local/core/onnx-embed.js/local/indexer/phases/tag-onnx.js capability instances, satisfy every narrow capability contract run({ capabilities })\'s own buildRunContext() validates against', async () => {
    // COLLECTION is read once at run.js's own module-evaluation time (a
    // module-scope const) and main()'s very first check hard process.exit(1)s
    // if it's unset — so COLLECTION must be set, and run.js dynamically
    // (re-)imported with a fresh query string, BEFORE this assertion. A
    // nonexistent process.argv[2] path drives main() to a real, fast throw
    // (statSync path-validation, before any Qdrant call — see run.js's own
    // "Path validation FIRST" comment) — proving validation itself passed
    // without needing a live Qdrant/Ollama server.
    const originalArgv2 = process.argv[2];
    const originalCollection = process.env.COLLECTION;
    process.env.COLLECTION = 'index-capability-wiring-real-lazy-validation-test';
    process.argv[2] = '/definitely/does/not/exist/on/any/machine';
    try {
      const { run } = await import(`../../../src/shared/indexer/run.js?real-lazy-validation-${Date.now()}`);
      const {
        createOllamaGenerateCapability, createOllamaSummaryCapability,
        createOllamaEmbedCapability, createOllamaDiscoveryCapability,
      } = await import('../../../src/local/core/ollama-capability.js');
      const { createOnnxEmbeddingCapability } = await import('../../../src/local/core/onnx-embed.js');
      const { createTagOnnxCapability } = await import('../../../src/local/indexer/phases/tag-onnx.js');
      // local/indexer/phases/tag-onnx.js/local/core/onnx-embed.js each
      // expose a createXCapability() factory (Phase 8B Step 4 / its
      // onnx-embed parity fix), not bare singleton-backed exports — every
      // consumer, including this test, constructs its own instance,
      // exactly like index-full.js does.
      const tagOnnx = createTagOnnxCapability();
      const onnxEmbed = createOnnxEmbeddingCapability({ ortFactory: () => ({ InferenceSession: { create: async () => ({ outputNames: [], run: async () => ({}), release: async () => {} }) } }) });
      const ollamaGenerate = createOllamaGenerateCapability();
      const ollamaSummary = createOllamaSummaryCapability();
      const ollamaEmbed = createOllamaEmbedCapability();
      const ollamaDiscovery = createOllamaDiscoveryCapability();
      // cloudEmbed (code review, Phase 8B Step 6): buildRunContext() now
      // also validates a cloudEmbed capability slot — the real factory is a
      // pure constructor (no network I/O until a method is actually
      // called), so it's supplied here the same way index-full.js does.
      const { createCloudEmbeddingCapability } = await import('../../../src/cloud/embedding/cloud-embedding-provider.js');
      const cloudEmbed = createCloudEmbeddingCapability();
      try {
        // run({ capabilities }) validates all seven slots synchronously,
        // before main() does any real work (fail-fast at construction —
        // see run.js's own buildRunContext()) — so if validation itself
        // passed, the rejection below must be the real path error, never a
        // capability-contract mismatch.
        await assert.rejects(
          () => run({
            capabilities: {
              ollamaGenerate, ollamaSummary, ollamaEmbed, ollamaDiscovery,
              onnxEmbed, tagOnnx, cloudEmbed,
            },
          }),
          (err) => { assert.match(err.message, /does not exist/); return true; }
        );
      } finally {
        // run() itself already calls ctx.tagOnnx.shutdownOnnxTagWorker()
        // and ctx.onnxEmbed.shutdown() in its own finally block (neither
        // instance ever spawned a worker/session anyway — safe no-op
        // either way), but shut down explicitly here too since this test
        // constructed both instances directly, outside run()'s own
        // ownership.
        await tagOnnx.shutdownOnnxTagWorker();
        await onnxEmbed.shutdown();
      }
    } finally {
      process.argv[2] = originalArgv2;
      if (originalCollection === undefined) delete process.env.COLLECTION; else process.env.COLLECTION = originalCollection;
    }
  });
});
