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
// branch-insensitive, so a literal `await import('../core/ollama-lazy.js')`
// anywhere in a Lite-shipped file's source was a real static edge
// regardless of which `if` branch it sat in. index.js was split into
// index-full.js (Full's own real capability-injecting entry point,
// excluded from the Lite package) and index-lite.js (Lite's own entry
// point, imports no local-runtime module at all — see
// tests/unit/architecture/lite-lazy-shim-necessity.test.js for the
// absence-of-Lite-to-local-runtime-edges proof). indexer/index.js is now
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

describe('indexer/index-full.js — Full composition explicitly builds and passes its capability bundle to run({ capabilities })', () => {
  const src = readFileSync(new URL('../../../src/indexer/index-full.js', import.meta.url), 'utf-8');
  const runtimeSrc = readFileSync(new URL('../../../src/indexer/index-runtime.js', import.meta.url), 'utf-8');

  it('imports runIndexerCli from index-runtime.js and calls it with a capability bundle', () => {
    assert.match(src, /import \{ isIndexerMainModule, runIndexerCli \} from '\.\/index-runtime\.js'/);
    assert.match(src, /await runIndexerCli\(\{/);
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

  it('index-full.js supplies a real capability for every slot (ollamaGenerate, ollamaSummary, ollamaEmbed, ollamaDiscovery, onnxEmbed, tagOnnx)', () => {
    const callMatch = src.match(/await runIndexerCli\(\{([\s\S]*?)\}\);/);
    assert.ok(callMatch, 'expected a real runIndexerCli({...}) call in index-full.js');
    const callBody = callMatch[1];
    for (const key of ['ollamaGenerate', 'ollamaSummary', 'ollamaEmbed', 'ollamaDiscovery', 'onnxEmbed', 'tagOnnx']) {
      assert.match(callBody, new RegExp(key), `runIndexerCli() call must supply ${key}`);
    }
  });

  it('the call happens INSIDE the isIndexerMainModule guard — never as an import-time side effect', () => {
    const guardStart = src.indexOf('if (isIndexerMainModule(');
    // lastIndexOf, not indexOf: this file's own header comment ALSO
    // mentions `await import('../core/ollama-lazy.js')` in prose (as an
    // example of the pattern), which sits BEFORE the guard — the real
    // code import is the LAST occurrence in the file.
    const ollamaLazyImport = src.lastIndexOf("import('../core/ollama-lazy.js')");
    const runIndexerCliCall = src.indexOf('await runIndexerCli({');
    assert.ok(guardStart >= 0, 'expected an isIndexerMainModule() guard in index-full.js');
    assert.ok(ollamaLazyImport > guardStart, 'the ollama-lazy.js import must be inside the isIndexerMainModule guard');
    assert.ok(runIndexerCliCall > ollamaLazyImport, 'runIndexerCli() must be called after the capability imports');
  });

  it('the capability objects passed are dynamically imported *-lazy.js modules (real, working implementations — not stubs)', () => {
    assert.match(src, /await import\(['"]\.\.\/core\/ollama-lazy\.js['"]\)/);
    assert.match(src, /await import\(['"]\.\.\/core\/onnx-embed-lazy\.js['"]\)/);
    assert.match(src, /await import\(['"]\.\/phases\/tag-onnx-lazy\.js['"]\)/);
  });
});

describe('indexer/index.js — backward-compatible launcher, no capability imports of its own', () => {
  const src = readFileSync(new URL('../../../src/indexer/index.js', import.meta.url), 'utf-8');

  it('delegates to index-full.js and nothing else', () => {
    assert.match(src.trim(), /^import '\.\/index-full\.js';?$/m);
  });

  it('never imports core/ollama-lazy.js, core/onnx-embed-lazy.js, or phases/tag-onnx-lazy.js directly', () => {
    assert.doesNotMatch(src, /import\(['"][^'"]*ollama-lazy\.js['"]\)/);
    assert.doesNotMatch(src, /import\(['"][^'"]*onnx-embed-lazy\.js['"]\)/);
    assert.doesNotMatch(src, /import\(['"][^'"]*tag-onnx-lazy\.js['"]\)/);
    assert.doesNotMatch(src, /^import .*ollama-lazy\.js/m);
    assert.doesNotMatch(src, /^import .*onnx-embed-lazy\.js/m);
    assert.doesNotMatch(src, /^import .*tag-onnx-lazy\.js/m);
  });
});

describe('indexer/index-lite.js — Lite composition never imports a local-runtime module', () => {
  const src = readFileSync(new URL('../../../src/indexer/index-lite.js', import.meta.url), 'utf-8');

  it('never imports core/ollama-lazy.js, core/onnx-embed-lazy.js, or phases/tag-onnx-lazy.js — real OR .lite shim paths', () => {
    assert.doesNotMatch(src, /import\(['"][^'"]*ollama-lazy\.js['"]\)/);
    assert.doesNotMatch(src, /import\(['"][^'"]*onnx-embed-lazy\.js['"]\)/);
    assert.doesNotMatch(src, /import\(['"][^'"]*tag-onnx-lazy\.js['"]\)/);
    assert.doesNotMatch(src, /^import .*ollama-lazy\.js/m);
    assert.doesNotMatch(src, /^import .*onnx-embed-lazy\.js/m);
    assert.doesNotMatch(src, /^import .*tag-onnx-lazy\.js/m);
  });

  it('supplies a typed-unavailable capability for every slot and calls runIndexerCli() inside its own isIndexerMainModule guard', () => {
    assert.match(src, /import \{ isIndexerMainModule, runIndexerCli \} from '\.\/index-runtime\.js'/);
    const guardStart = src.indexOf('if (isIndexerMainModule(');
    const runIndexerCliCall = src.indexOf('await runIndexerCli({');
    assert.ok(guardStart >= 0 && runIndexerCliCall > guardStart);
    const callMatch = src.match(/await runIndexerCli\(\{([\s\S]*?)\}\);/);
    assert.ok(callMatch, 'expected a real runIndexerCli({...}) call in index-lite.js');
    for (const key of ['ollamaGenerate', 'ollamaSummary', 'ollamaEmbed', 'ollamaDiscovery', 'onnxEmbed', 'tagOnnx']) {
      assert.match(callMatch[1], new RegExp(key));
    }
  });
});

describe('run.js — run({ capabilities }) accepts a real *-lazy.js namespace object for every slot without validation failure', () => {
  it('a real ollama-lazy.js/onnx-embed-lazy.js/tag-onnx-lazy.js namespace import satisfies every narrow capability contract run({ capabilities })\'s own buildRunContext() validates against', async () => {
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
      const { run } = await import(`../../../src/indexer/run.js?real-lazy-validation-${Date.now()}`);
      const ollamaLazy = await import('../../../src/core/ollama-lazy.js');
      const onnxEmbedLazy = await import('../../../src/core/onnx-embed-lazy.js');
      const tagOnnxLazy = await import('../../../src/indexer/phases/tag-onnx-lazy.js');
      // run({ capabilities }) validates all six slots synchronously, before
      // main() does any real work (fail-fast at construction — see run.js's
      // own buildRunContext()) — so if validation itself passed, the
      // rejection below must be the real path error, never a
      // capability-contract mismatch.
      await assert.rejects(
        () => run({
          capabilities: {
            ollamaGenerate: ollamaLazy, ollamaSummary: ollamaLazy, ollamaEmbed: ollamaLazy, ollamaDiscovery: ollamaLazy,
            onnxEmbed: onnxEmbedLazy, tagOnnx: tagOnnxLazy,
          },
        }),
        (err) => { assert.match(err.message, /does not exist/); return true; }
      );
    } finally {
      process.argv[2] = originalArgv2;
      if (originalCollection === undefined) delete process.env.COLLECTION; else process.env.COLLECTION = originalCollection;
    }
  });
});
