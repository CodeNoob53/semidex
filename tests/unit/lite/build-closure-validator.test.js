// Regression tests for packages/lite/build.mjs's own AST-based dependency
// extraction (extractReferences()/findLiteralRelativePathArg()/
// resolveRelativeSpecifier()/runValidator()) — the REAL production
// closure validator, not the separate scripts/audit/*.mjs research
// tooling that found the two gaps these tests pin down.
//
// Background: docs/design/full-lite-shared-architecture-audit-2026-08-01.md
// found (and a prior task ported the fix for) two real gaps in this
// validator's fork()/spawn() extraction:
//   1. admin/jobs/registry.js spawns the indexer CLI as
//      spawn(process.execPath, [INDEXER_ENTRY, path], ...) where `spawn`
//      is imported aliased (`spawn as nodeSpawn`) and flows through a
//      default parameter (`spawnFn = nodeSpawn`) before being called —
//      the validator's own header comment claimed to recognize this
//      shape, but the extraction never actually traced the alias through
//      the default parameter, so the target was silently never checked.
//   2. core/ce-rerank.js's fork(WORKER_PATH, ...) where
//      WORKER_PATH = join(__dirname, 'ce-rerank-worker.js') — a bare
//      same-directory sibling filename with no '/' in it — was rejected
//      by the literal-path extraction's own `.includes('/')` check.
//
// A subsequent code review round found and fixed three further real
// gaps this file's tests now also cover:
//   3. The default-param alias tracking was FILE-scoped, not lexically
//      scoped — an unrelated function elsewhere in the same file with
//      its own same-named default parameter (e.g. another `spawnFn`) was
//      misclassified as a child_process binding. Fixed via a real
//      lexical-scope resolution pass (walk.ancestor, per-function
//      binding maps) — see extractReferences()'s own header comment.
//   4. A hardcoded TRUSTED_OS_SPAWN_TARGETS allow-list of specific
//      program names (e.g. 'powershell.exe') was replaced by a semantic
//      classification (isBareOsCommand()) matching Node's own PATH-search
//      rule — no name is ever compared against a list.
//   5. Two of this file's own tests were not actually testing what they
//      claimed: one asserted a string against itself without ever
//      calling runValidator(); another (the "validation fails when the
//      target is removed" test for ce-rerank.js) could not possibly work
//      because both ce-rerank.js and ce-rerank-worker.js are permanently
//      excluded from Lite's tarball, so neither is ever staged to remove
//      in the first place. Both fixed below, using a REAL, ISOLATED
//      temporary fixture directory rather than mutating the shared
//      packages/lite/src/ staged tree in place.
//
// These tests exercise the REAL, exported functions from build.mjs
// directly (extractReferences, parseFile, resolveRelativeSpecifier,
// runValidator, stageSrc, substituteLazyShims, listAllFiles) — never a
// reimplementation, never a copy of the logic under test.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import {
  readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  extractReferences, parseFile, resolveRelativeSpecifier, runValidator,
  listAllFiles, stageSrc, substituteLazyShims,
} from '../../../packages/lite/build.mjs';

const LITE_DIR = dirname(fileURLToPath(new URL('../../../packages/lite/build.mjs', import.meta.url)));
const REPO_ROOT = resolve(LITE_DIR, '..', '..');
const REPO_SRC = join(REPO_ROOT, 'src');
const STAGED_SRC = join(LITE_DIR, 'src');

function parseSource(src) {
  return parse(src, { sourceType: 'module', ecmaVersion: 'latest', allowImportExportEverywhere: true });
}

describe('build.mjs extractReferences() — real-source regression (code review, closure validator gap)', () => {
  it('admin/jobs/registry.js: spawn(process.execPath, [INDEXER_ENTRY, ...]) resolves to a literal fork/spawn edge onto ../../indexer/index.js', () => {
    const ast = parseFile(join(REPO_SRC, 'admin', 'jobs', 'registry.js'));
    const refs = extractReferences(ast);
    const spawnCalls = refs.forkSpawnCalls.filter((c) => c.callee === 'spawn');
    assert.ok(spawnCalls.length > 0, 'expected at least one spawn() call to be extracted from registry.js');
    assert.ok(
      spawnCalls.some((c) => c.literal === true && c.arg === '../../indexer/index.js'),
      `expected a literal spawn() edge onto ../../indexer/index.js, got: ${JSON.stringify(spawnCalls)}`,
    );
  });

  it('core/ce-rerank.js: fork(join(__dirname, "ce-rerank-worker.js")) resolves to a literal fork edge onto ./ce-rerank-worker.js', () => {
    const ast = parseFile(join(REPO_SRC, 'core', 'ce-rerank.js'));
    const refs = extractReferences(ast);
    const forkCalls = refs.forkSpawnCalls.filter((c) => c.callee === 'fork');
    assert.ok(forkCalls.length > 0, 'expected at least one fork() call to be extracted from ce-rerank.js');
    assert.ok(
      forkCalls.every((c) => c.literal === true && c.arg === './ce-rerank-worker.js'),
      `expected every fork() call to resolve to ./ce-rerank-worker.js, got: ${JSON.stringify(forkCalls)}`,
    );
  });

  it('registry.js\'s spawn edge resolves (via resolveRelativeSpecifier, against the REAL staged tree) to indexer/index.js as a repo-relative path', () => {
    // registry.js IS staged in Lite (it is genuinely needed), so this can
    // be checked against the real packages/lite/src/ tree without staging
    // a fresh copy.
    assert.ok(existsSync(join(STAGED_SRC, 'admin', 'jobs', 'registry.js')), 'expected packages/lite/src/admin/jobs/registry.js to already be staged — run `node packages/lite/build.mjs` first if this fails');
    const resolved = resolveRelativeSpecifier('../../indexer/index.js', 'admin/jobs/registry.js');
    assert.equal(resolved, 'indexer/index.js');
  });
});

describe('build.mjs extractReferences() — lexical scoping of default-parameter aliases (code review, P2)', () => {
  it('an unrelated function elsewhere in the same file with its OWN same-named default parameter is never misclassified as a child_process binding', () => {
    const src = `
      import { spawn as nodeSpawn } from 'node:child_process';
      function realSpawner({ spawnFn = nodeSpawn } = {}) {
        spawnFn('./real-entry.js');
      }
      function unrelatedFunction({ spawnFn = someOtherDefault } = {}) {
        spawnFn('not-a-real-dependency-just-a-callback');
      }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.equal(refs.forkSpawnCalls.length, 1, `expected exactly one real spawn edge, got: ${JSON.stringify(refs.forkSpawnCalls)}`);
    assert.equal(refs.forkSpawnCalls[0].arg, './real-entry.js');
  });

  it('a nested function with no shadowing parameter of its own still resolves via closure over the enclosing function\'s binding', () => {
    const src = `
      import { spawn as nodeSpawn } from 'node:child_process';
      function outer({ spawnFn = nodeSpawn } = {}) {
        function inner() {
          spawnFn('./nested-entry.js');
        }
        inner();
      }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.equal(refs.forkSpawnCalls.length, 1);
    assert.equal(refs.forkSpawnCalls[0].arg, './nested-entry.js');
  });

  it('two SEPARATE functions each with their own real child_process-bound default parameter are both tracked independently, without cross-contamination', () => {
    const src = `
      import { spawn as nodeSpawn, fork as nodeFork } from 'node:child_process';
      function spawnerA({ spawnFn = nodeSpawn } = {}) { spawnFn('./a.js'); }
      function forkerB({ forkFn = nodeFork } = {}) { forkFn('./b.js'); }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.equal(refs.forkSpawnCalls.length, 2);
    assert.ok(refs.forkSpawnCalls.some((c) => c.callee === 'spawn' && c.arg === './a.js'));
    assert.ok(refs.forkSpawnCalls.some((c) => c.callee === 'fork' && c.arg === './b.js'));
  });

  it('an ORDINARY (non-default) parameter on an intervening function correctly SHADOWS an outer child_process binding of the same name — no false positive (code review, P1)', () => {
    // The exact scenario code review reported: outer() binds spawnFn to a
    // real child_process.spawn via a default parameter; inner() declares
    // its OWN spawnFn as a plain parameter (no default at all) — real JS
    // scoping means inner's spawnFn shadows outer's for the entire body of
    // inner(), so inner's spawnFn('./not-child-process.js') call must NOT
    // be attributed to child_process.spawn. The previous version of this
    // extractor only recorded names bound via a traced-to-child_process
    // AssignmentPattern, so an ordinary (defaultless) parameter named
    // spawnFn was invisible to the outward search and let it "see
    // through" inner's shadowing straight to outer's real binding.
    const src = `
      import { spawn as nodeSpawn } from 'node:child_process';
      function outer({ spawnFn = nodeSpawn } = {}) {
        function inner(spawnFn) {
          spawnFn('./not-child-process.js');
        }
        inner(() => {});
      }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.deepEqual(refs.forkSpawnCalls, [], `expected zero fork/spawn edges — inner's own spawnFn parameter shadows outer's, so this call must never be classified as child_process.spawn, got: ${JSON.stringify(refs.forkSpawnCalls)}`);
  });

  it('shadowing via a destructured/array-pattern parameter is also detected, not just a plain Identifier parameter', () => {
    // Same shadowing rule, exercised against the OTHER parameter shapes
    // collectFunctionParamNames() must recurse into (ObjectPattern,
    // ArrayPattern, RestElement) — not just the simple Identifier case
    // covered by the test above.
    const src = `
      import { spawn as nodeSpawn } from 'node:child_process';
      function outer({ spawnFn = nodeSpawn } = {}) {
        function innerDestructured({ spawnFn }) {
          spawnFn('./also-not-child-process.js');
        }
        innerDestructured({ spawnFn: () => {} });
      }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.deepEqual(refs.forkSpawnCalls, [], `expected zero fork/spawn edges — destructured shadowing must be detected too, got: ${JSON.stringify(refs.forkSpawnCalls)}`);
  });

  it('shadowing does not affect a SIBLING function that has no shadowing parameter of its own — only the specifically-shadowing function loses the binding', () => {
    const src = `
      import { spawn as nodeSpawn } from 'node:child_process';
      function outer({ spawnFn = nodeSpawn } = {}) {
        function shadower(spawnFn) {
          spawnFn('./shadowed-out.js');
        }
        function nonShadower() {
          spawnFn('./real-outer-entry.js');
        }
        shadower(() => {});
        nonShadower();
      }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.equal(refs.forkSpawnCalls.length, 1, `expected exactly one real edge (from nonShadower only), got: ${JSON.stringify(refs.forkSpawnCalls)}`);
    assert.equal(refs.forkSpawnCalls[0].arg, './real-outer-entry.js');
  });

  it('a plain (non-default, non-aliased) parameter shadowing the DIRECT module import binding is correctly excluded — code review, second-round P1 finding', () => {
    // The exact scenario code review reported in the second review round:
    // BOTH resolution passes previously checked the file-scope
    // childProcessImportNames/childProcessLocalToReal maps FIRST,
    // unconditionally, before ever consulting the enclosing-function
    // chain — so this shadow (no alias at all, no default parameter at
    // all, just `import { spawn }` followed by a plain `function
    // run(spawn)`) was still misclassified, even after the first
    // shadowing fix (which only handled the alias+default-parameter
    // case, e.g. `spawnFn = nodeSpawn`). Fixed by making
    // resolveChildProcessBinding() search the enclosing-function chain
    // FIRST, unconditionally, and only fall through to the file-scope
    // import binding once NO enclosing function declares the name as a
    // parameter at all.
    const src = `
      import { spawn } from 'node:child_process';
      function run(spawn) {
        spawn('./callback.js');
      }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.deepEqual(refs.forkSpawnCalls, [], `expected zero fork/spawn edges — run's own spawn parameter shadows the direct child_process import, got: ${JSON.stringify(refs.forkSpawnCalls)}`);
  });

  it('a destructured parameter shadowing the DIRECT (non-aliased) module import binding is also correctly excluded', () => {
    const src = `
      import { fork } from 'node:child_process';
      function run({ fork }) {
        fork('./callback.js');
      }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.deepEqual(refs.forkSpawnCalls, [], `expected zero fork/spawn edges — run's destructured fork parameter shadows the direct import, got: ${JSON.stringify(refs.forkSpawnCalls)}`);
  });

  it('a DIRECT (non-aliased) module import binding still resolves correctly when nothing shadows it — sanity check the fix did not break the ordinary case', () => {
    const src = `
      import { spawn } from 'node:child_process';
      function run() {
        spawn('./real-entry.js');
      }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.equal(refs.forkSpawnCalls.length, 1, `expected exactly one real edge, got: ${JSON.stringify(refs.forkSpawnCalls)}`);
    assert.equal(refs.forkSpawnCalls[0].arg, './real-entry.js');
  });
});

describe('build.mjs extractReferences() — non-literal specifiers never become invented dependencies', () => {
  it('fork(computeWorkerPath()) — a non-literal call-expression argument — is recorded as literal:false with arg:null, never fabricates a path', () => {
    const src = `
      import { fork } from 'node:child_process';
      function computeWorkerPath() { return './whatever.js'; }
      fork(computeWorkerPath());
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.equal(refs.forkSpawnCalls.length, 1);
    assert.deepEqual(refs.forkSpawnCalls[0], { callee: 'fork', arg: null, literal: false });
  });

  it('spawn(someRuntimeVariable) — an identifier never traced to a literal/urlPathConsts entry — is recorded as literal:false with the RAW identifier name, not resolved to a file', () => {
    const src = `
      import { spawn } from 'node:child_process';
      function run(target) {
        spawn(target);
      }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.equal(refs.forkSpawnCalls.length, 1);
    assert.deepEqual(refs.forkSpawnCalls[0], { callee: 'spawn', arg: 'target', literal: false });
  });

  it('spawn(process.execPath, someRuntimeArray) — second argument not a literal array — is recorded as literal:false, never guesses at an entry file', () => {
    const src = `
      import { spawn } from 'node:child_process';
      function run(argsArray) {
        spawn(process.execPath, argsArray);
      }
    `;
    const ast = parseSource(src);
    const refs = extractReferences(ast);
    assert.equal(refs.forkSpawnCalls.length, 1);
    // Falls through to the plain arg[0] branch since arguments[1] is not
    // an ArrayExpression — arg[0] here is the process.execPath
    // MemberExpression itself, which is neither a Literal nor a tracked
    // Identifier, so it lands in the final `arg: null, literal: false` case.
    assert.deepEqual(refs.forkSpawnCalls[0], { callee: 'spawn', arg: null, literal: false });
  });
});

describe('build.mjs extractReferences() — third-party OS executables are never treated as local JS entry points', () => {
  it('admin/system/folder-picker.js: spawn("powershell.exe", ...) is extracted as a literal string, but resolveRelativeSpecifier() correctly refuses to resolve it as a repo path', () => {
    const ast = parseFile(join(REPO_SRC, 'admin', 'system', 'folder-picker.js'));
    const refs = extractReferences(ast);
    const spawnCalls = refs.forkSpawnCalls.filter((c) => c.callee === 'spawn');
    assert.ok(spawnCalls.some((c) => c.arg === 'powershell.exe' && c.literal === true), `expected a literal spawn('powershell.exe', ...) call, got: ${JSON.stringify(spawnCalls)}`);
    const resolved = resolveRelativeSpecifier('powershell.exe', 'admin/system/folder-picker.js');
    assert.equal(resolved, null, 'a bare OS-command name (no leading "." ) must never resolve to a staged file path');
  });

  it('a hypothetical spawn("./powershell.exe") WOULD be treated as a local path attempt (proves the guard is startsWith(".") based, not a name-based allow-list) and correctly fails to resolve since no such staged file exists', () => {
    const resolved = resolveRelativeSpecifier('./powershell.exe', 'admin/system/folder-picker.js');
    assert.equal(resolved, null);
  });

  it('a hardcoded OS-command-name allow-list must not be reintroduced — structural regression pin only, NOT the primary proof (see the behavioral fixture test below for that)', () => {
    // Code review (second round) correctly flagged that a prior version
    // of this "test" was ONLY this structural source-grep, despite its
    // own name/comment CLAIMING to be a behavioral runValidator() proof —
    // it never actually called runValidator() at all. This structural
    // check is kept (it is a real, cheap, useful regression pin against
    // literally reintroducing a TRUSTED_OS_SPAWN_TARGETS-shaped Set), but
    // is now explicitly named and commented as secondary — the actual
    // behavioral proof is
    // 'runValidator() accepts an ARBITRARY bare OS command name...' below,
    // inside the isolated temp-directory fixtures block.
    const src = readFileSync(new URL('../../../packages/lite/build.mjs', import.meta.url), 'utf-8');
    assert.ok(!/\bconst\s+\w*TRUSTED\w*\s*=\s*new\s+Set/.test(src), 'a hardcoded OS-command-name allow-list (a Set of literal program names) must not be reintroduced — classification must stay semantic (isBareOsCommand), not a name lookup');
    assert.ok(/function\s+isBareOsCommand\s*\(/.test(src), 'expected the semantic isBareOsCommand() classifier to exist');
  });
});

describe('build.mjs runValidator() — isolated temp-directory fixtures (code review, P1/P2)', () => {
  // Code review finding: the previous version of this describe block
  // mutated the SHARED, real packages/lite/src/ staged tree in place
  // (renaming the real staged indexer/index.js aside, and creating a
  // fixture subdirectory directly inside it) — a real risk of corrupting
  // that tree for any OTHER test file running in the same process (npm
  // test has no concurrency isolation between test files sharing one
  // filesystem location), and of leaving it damaged if the process were
  // killed mid-test, before the try/finally restore could run.
  //
  // Fixed by using a genuinely separate mkdtemp() directory (real OS temp
  // space, e.g. under os.tmpdir(), never inside packages/lite/ at all)
  // for every fixture below, combined with resolveRelativeSpecifier()/
  // runValidator()'s new optional `root` parameter (defaults to the real
  // STAGED_SRC for every production call site — see build.mjs's own
  // comment on that parameter) so the SAME real validator logic under
  // test can be pointed at the isolated directory instead. No test in
  // this block ever touches packages/lite/src/ at all.
  let tmpRoot;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'semidex-lite-closure-validator-'));
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('registry.js -> indexer/index.js shape (spawn(process.execPath, [ENTRY, ...]) via alias + default parameter)', () => {
    // A minimal, faithful REPRODUCTION of admin/jobs/registry.js's real
    // shape — not a copy of the real file (which has unrelated logic this
    // test doesn't need) — exercising the exact AST pattern finding #1
    // fixed: `spawn as nodeSpawn` import alias, flowing through a default
    // parameter (`spawnFn = nodeSpawn`), called as
    // `spawnFn(process.execPath, [ENTRY, path], opts)`.
    const registryRelPath = 'registry-fixture.js';
    const entryRelPath = 'entry-fixture.js';

    function writeFixture() {
      writeFileSync(join(tmpRoot, registryRelPath), [
        "import { spawn as nodeSpawn } from 'node:child_process';",
        "import { fileURLToPath } from 'node:url';",
        "const ENTRY = fileURLToPath(new URL('./entry-fixture.js', import.meta.url));",
        'export function run({ spawnFn = nodeSpawn } = {}) {',
        '  return spawnFn(process.execPath, [ENTRY, "some-arg"], { windowsHide: true });',
        '}',
        '',
      ].join('\n'), 'utf-8');
      writeFileSync(join(tmpRoot, entryRelPath), '// fixture entry point, never actually run\n', 'utf-8');
    }

    before(() => { writeFixture(); });

    it('extraction finds the alias+default-param+process.execPath spawn edge onto entry-fixture.js', () => {
      const ast = parseFile(join(tmpRoot, registryRelPath));
      const refs = extractReferences(ast);
      const spawnCalls = refs.forkSpawnCalls.filter((c) => c.callee === 'spawn');
      assert.equal(spawnCalls.length, 1);
      assert.deepEqual(spawnCalls[0], { callee: 'spawn', arg: './entry-fixture.js', literal: true });
    });

    it('validation passes (no [spawn:*] error) when entry-fixture.js is present', () => {
      const files = listAllFiles(tmpRoot).map((f) => f.replace(/\\/g, '/'));
      assert.ok(files.includes(entryRelPath), 'expected the fixture entry point to be listed');
      const errors = runValidator(files, tmpRoot);
      const spawnErrors = errors.filter((e) => e.includes(registryRelPath) && e.includes('spawn'));
      assert.deepEqual(spawnErrors, [], `expected zero spawn-related errors, got: ${JSON.stringify(spawnErrors)}`);
    });

    it('validation FAILS with a specific [spawn:missing-target] diagnostic when entry-fixture.js is removed', () => {
      rmSync(join(tmpRoot, entryRelPath), { force: true });
      try {
        const files = listAllFiles(tmpRoot).map((f) => f.replace(/\\/g, '/'))
          .filter((f) => f !== entryRelPath);
        const errors = runValidator(files, tmpRoot);
        const spawnErrors = errors.filter((e) => e.startsWith('[spawn:missing-target]') && e.includes(registryRelPath));
        assert.equal(spawnErrors.length, 1, `expected exactly one [spawn:missing-target] error, got: ${JSON.stringify(errors)}`);
        assert.match(spawnErrors[0], /entry-fixture\.js/);
      } finally {
        writeFileSync(join(tmpRoot, entryRelPath), '// fixture entry point, never actually run\n', 'utf-8');
      }
    });
  });

  describe('ce-rerank.js -> ce-rerank-worker.js shape (fork(join(__dirname, bareFilename)))', () => {
    const callerRelPath = 'caller-fixture.js';
    const workerRelPath = 'worker-fixture.js';

    function writeFixture() {
      writeFileSync(join(tmpRoot, callerRelPath), [
        "import { fork } from 'node:child_process';",
        "import { dirname, join } from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        'const __dirname = dirname(fileURLToPath(import.meta.url));',
        "const WORKER_PATH = join(__dirname, 'worker-fixture.js');",
        'fork(WORKER_PATH);',
        '',
      ].join('\n'), 'utf-8');
      writeFileSync(join(tmpRoot, workerRelPath), '// fixture worker, never actually run\n', 'utf-8');
    }

    before(() => { writeFixture(); });

    it('extraction finds the bare-filename fork() edge', () => {
      const ast = parseFile(join(tmpRoot, callerRelPath));
      const refs = extractReferences(ast);
      assert.equal(refs.forkSpawnCalls.length, 1);
      assert.deepEqual(refs.forkSpawnCalls[0], { callee: 'fork', arg: './worker-fixture.js', literal: true });
    });

    it('validation passes with zero errors when worker-fixture.js is present', () => {
      const files = listAllFiles(tmpRoot).map((f) => f.replace(/\\/g, '/'));
      assert.ok(files.includes(workerRelPath), 'expected the fixture worker to be listed');
      const errors = runValidator(files, tmpRoot);
      const forkErrors = errors.filter((e) => e.includes(callerRelPath));
      assert.deepEqual(forkErrors, [], `expected zero errors when worker-fixture.js is present, got: ${JSON.stringify(forkErrors)}`);
    });

    it('validation FAILS with [fork:missing-target] naming worker-fixture.js when the target is removed — proves the validator genuinely re-checks the file system, not merely re-uses a cached extraction result (code review, P1)', () => {
      rmSync(join(tmpRoot, workerRelPath), { force: true });
      try {
        const files = listAllFiles(tmpRoot).map((f) => f.replace(/\\/g, '/'))
          .filter((f) => f !== workerRelPath);
        const errors = runValidator(files, tmpRoot);
        const forkErrors = errors.filter((e) => e.includes(callerRelPath));
        assert.equal(forkErrors.length, 1, `expected exactly one error, got: ${JSON.stringify(forkErrors)}`);
        assert.match(forkErrors[0], /^\[fork:missing-target\]/);
        assert.match(forkErrors[0], /worker-fixture\.js/);
      } finally {
        writeFileSync(join(tmpRoot, workerRelPath), '// fixture worker, never actually run\n', 'utf-8');
      }
    });
  });

  describe('bare OS-command spawn() target — behavioral proof of no hardcoded allow-list (code review, second round)', () => {
    // Code review (second round) correctly flagged that the ONLY existing
    // test for this case was a source-text grep asserting a hardcoded
    // Set doesn't exist — it never actually called runValidator() at all,
    // despite its own name claiming to. This is the real behavioral
    // fixture: a genuinely ARBITRARY, made-up command name (deliberately
    // NOT 'powershell.exe' — a name this validator's code has never seen
    // before, in a comment or otherwise) proves the classification is
    // truly semantic (isBareOsCommand()'s shape-based rule: no '.'
    // prefix, no '/' or '\\') and not a lookup against any list of known
    // names, allowed or otherwise.
    const callerRelPath = 'arbitrary-spawn-fixture.js';
    const ARBITRARY_COMMAND_NAME = 'totally-made-up-tool-xyz123';

    function writeFixture() {
      writeFileSync(join(tmpRoot, callerRelPath), [
        "import { spawn } from 'node:child_process';",
        `spawn('${ARBITRARY_COMMAND_NAME}', ['--flag']);`,
        '',
      ].join('\n'), 'utf-8');
    }

    before(() => { writeFixture(); });

    it('extraction finds the literal bare-command spawn() call', () => {
      const ast = parseFile(join(tmpRoot, callerRelPath));
      const refs = extractReferences(ast);
      assert.equal(refs.forkSpawnCalls.length, 1);
      assert.deepEqual(refs.forkSpawnCalls[0], { callee: 'spawn', arg: ARBITRARY_COMMAND_NAME, literal: true });
    });

    it('runValidator() accepts an ARBITRARY bare OS command name with ZERO errors, even though it has never appeared in build.mjs before — proves the classification is semantic (shape-based), never a name lookup', () => {
      const files = listAllFiles(tmpRoot).map((f) => f.replace(/\\/g, '/'));
      assert.ok(files.includes(callerRelPath), 'expected the fixture caller to be listed');
      // Deliberately no corresponding file for ARBITRARY_COMMAND_NAME
      // exists anywhere in tmpRoot — if runValidator() ever again tried
      // to resolve it as a repo-relative path, it would correctly fail
      // to find one and report [spawn:missing-target]. Zero errors here
      // is only possible because isBareOsCommand() classifies it as an
      // OS command BEFORE any file-resolution attempt is made at all.
      const errors = runValidator(files, tmpRoot);
      const relevantErrors = errors.filter((e) => e.includes(callerRelPath));
      assert.deepEqual(relevantErrors, [], `expected zero errors for a bare OS-command spawn() target, got: ${JSON.stringify(relevantErrors)}`);
    });
  });
});

describe('build.mjs runValidator() — real staged-tree sanity check (read-only, no mutation)', () => {
  // A single, non-destructive confirmation that the REAL staged tree
  // (as produced by a real `node packages/lite/build.mjs` run, or by
  // stageSrc()+substituteLazyShims() here) contains zero spawn/fork
  // errors for the two real production edges — the mkdtemp()-based
  // fixtures above are what actually exercise failure-diagnostic
  // behavior; this test only confirms the real tree is currently clean,
  // without renaming or deleting anything in it.
  before(() => {
    stageSrc();
    substituteLazyShims();
  });

  it('the real staged tree has zero [spawn:*]/[fork:*] errors for registry.js', () => {
    const files = listAllFiles(STAGED_SRC).map((f) => f.replace(/\\/g, '/'));
    const errors = runValidator(files);
    const registryErrors = errors.filter((e) => e.includes('registry.js') && (e.includes('spawn') || e.includes('fork')));
    assert.deepEqual(registryErrors, [], `expected zero spawn/fork errors for the real staged registry.js, got: ${JSON.stringify(registryErrors)}`);
  });
});
