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
// imports applyAllCapabilities from run.js (via index-runtime.js's
// runIndexerCli()) and calls it with real *-lazy.js module objects for
// every capability slot, before run() is invoked. Combined with
// tests/unit/indexer/phase-capability-injection.test.js's existing
// behavioral proof that applyAllCapabilities() correctly fans out to every
// phase seam, this closes the gap: production Full composition now
// explicitly selects its capability implementations, not merely defaults
// into them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('indexer/index-full.js — Full composition explicitly calls applyAllCapabilities()', () => {
  const src = readFileSync(new URL('../../../src/indexer/index-full.js', import.meta.url), 'utf-8');
  const runtimeSrc = readFileSync(new URL('../../../src/indexer/index-runtime.js', import.meta.url), 'utf-8');

  it('imports runIndexerCli from index-runtime.js and calls it with a capability bundle', () => {
    assert.match(src, /import \{ isIndexerMainModule, runIndexerCli \} from '\.\/index-runtime\.js'/);
    assert.match(src, /await runIndexerCli\(\{/);
  });

  it('index-runtime.js\'s runIndexerCli() imports applyAllCapabilities from run.js and calls it with the caller-supplied capabilities', () => {
    assert.match(runtimeSrc, /applyAllSettings,\s*applyAllCapabilities,\s*run\s*}\s*=\s*await import\(['"]\.\/run\.js['"]\)/);
    assert.match(runtimeSrc, /applyAllCapabilities\(capabilities\)/);
  });

  it('runIndexerCli() delegates run() to runAndReportExitCode() — genuinely awaited, not fire-and-forget (code review, P2)', () => {
    // The actual await/try-catch/exitCode behavior is proven behaviorally
    // in tests/unit/indexer/index-runtime-run-and-report-exit-code.test.js;
    // this is just the structural wiring check that runIndexerCli() itself
    // delegates to that function rather than reintroducing its own
    // fire-and-forget run().catch(...) call.
    assert.match(runtimeSrc, /await runAndReportExitCode\(run\)/);
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

describe('run.js — applyAllCapabilities() accepts a real *-lazy.js namespace object for every slot without validation failure', () => {
  it('a real ollama-lazy.js/onnx-embed-lazy.js/tag-onnx-lazy.js namespace import satisfies every narrow capability contract applyAllCapabilities() validates against', async () => {
    const { applyAllCapabilities } = await import('../../../src/indexer/run.js');
    const ollamaLazy = await import('../../../src/core/ollama-lazy.js');
    const onnxEmbedLazy = await import('../../../src/core/onnx-embed-lazy.js');
    const tagOnnxLazy = await import('../../../src/indexer/phases/tag-onnx-lazy.js');
    assert.doesNotThrow(() => applyAllCapabilities({
      ollamaGenerate: ollamaLazy, ollamaSummary: ollamaLazy, ollamaEmbed: ollamaLazy, ollamaDiscovery: ollamaLazy,
      onnxEmbed: onnxEmbedLazy, tagOnnx: tagOnnxLazy,
    }));
  });
});
