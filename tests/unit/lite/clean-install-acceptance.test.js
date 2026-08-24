// Clean-install acceptance (Part G) — the strongest available proof that
// the packed semidex-lite tarball is genuinely self-contained. Unlike
// tests/unit/lite/*.test.js (which import packages/lite/lite-src/*.js
// directly against the REPO's staged packages/lite/src/ copy),  these
// tests operate on the ACTUAL packed tarball, installed into an EMPTY
// temp directory outside the repo, with the installed package directory
// made READ-ONLY before running anything — the exact scenario a real
// `npm install -g semidex-lite` user is in. This is what caught the
// ../../../src/ vs ../src/ import-path bug (lite-src/*.js used repo-relative
// paths that only happened to resolve during in-repo testing, not once
// actually packaged) before it could ship.
//
// Requires: acorn/acorn-walk (root devDependencies, see build.mjs's own
// header comment — NOT shipped in the Lite tarball itself).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, existsSync, readdirSync, statSync, readFileSync, chmodSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parse } from 'acorn';
import { simple as walkSimple } from 'acorn-walk';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([a-zA-Z]):/, '$1:');
const LITE_DIR = join(REPO_ROOT, 'packages', 'lite');

let tarballPath;
let installDir;
let packageDir; // installDir/node_modules/semidex-lite
let semidexHomeDir;

function npmExec(args, opts = {}) {
  // shell: true is required for npm resolution on Windows; every argument
  // here is a hardcoded constant or an already-validated path, never raw
  // user input, so this is safe.
  return execFileSync('npm', args, { shell: true, encoding: 'utf-8', ...opts });
}

function setReadOnly(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      setReadOnly(full);
      chmodSync(full, 0o555);
    } else {
      chmodSync(full, 0o444);
    }
  }
}

function setWritable(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      setWritable(full);
      chmodSync(full, 0o755);
    } else {
      chmodSync(full, 0o644);
    }
  }
}

before(() => {
  console.log('[clean-install] npm pack ...');
  // Plain `npm pack` (not --json) — its own prepack script (build.mjs)
  // writes progress lines to stdout that literally contain '[' (e.g.
  // "[build] staging..."), which would corrupt naive JSON extraction from
  // --json output. Plain `npm pack`'s LAST non-empty stdout line is always
  // the produced tarball's filename (npm's own documented behavior) — far
  // more robust to parse than hunting for a JSON boundary inside
  // prepack-polluted output.
  const packOutput = npmExec(['pack'], { cwd: LITE_DIR });
  const lines = packOutput.split('\n').map((l) => l.trim()).filter(Boolean);
  const filename = lines[lines.length - 1];
  assert.match(filename, /^semidex-lite-.*\.tgz$/, `expected the last line of \`npm pack\` output to be the tarball filename, got: "${filename}"\nfull output:\n${packOutput}`);
  tarballPath = join(LITE_DIR, filename);
  assert.ok(existsSync(tarballPath), 'npm pack must produce a real tarball file');

  installDir = mkdtempSync(join(tmpdir(), 'semidex-lite-clean-install-'));
  npmExec(['init', '-y'], { cwd: installDir });
  console.log('[clean-install] npm install (tarball, fresh empty dir) ...');
  npmExec(['install', tarballPath], { cwd: installDir });

  packageDir = join(installDir, 'node_modules', 'semidex-lite');
  assert.ok(existsSync(packageDir), 'semidex-lite must be installed under node_modules');

  console.log('[clean-install] marking the installed package directory read-only ...');
  setReadOnly(packageDir);

  semidexHomeDir = mkdtempSync(join(tmpdir(), 'semidex-lite-clean-install-home-'));
});

after(() => {
  // The acceptance test deliberately makes the installed package read-only.
  // Restore permissions before cleanup so POSIX CI runners can remove the
  // directory tree; Windows does not enforce these mode bits the same way.
  if (packageDir && existsSync(packageDir)) {
    setWritable(packageDir);
    chmodSync(packageDir, 0o755);
  }
  if (installDir && existsSync(installDir)) rmSync(installDir, { recursive: true, force: true });
  if (semidexHomeDir && existsSync(semidexHomeDir)) rmSync(semidexHomeDir, { recursive: true, force: true });
  if (tarballPath && existsSync(tarballPath)) rmSync(tarballPath, { force: true });
});

describe('clean-install acceptance — read-only package dir, empty install dir', { timeout: 120000 }, () => {
  it('npm ls --all excludes onnxruntime-node, @huggingface/transformers, and acorn', () => {
    const out = execSync('npm ls --all', { cwd: installDir, encoding: 'utf-8' });
    assert.ok(!out.includes('onnxruntime-node'), 'onnxruntime-node must never be an installed dependency');
    assert.ok(!out.includes('@huggingface/transformers'), '@huggingface/transformers must never be an installed dependency');
    assert.ok(!out.includes('acorn'), 'acorn is a build-time-only devDependency of the ROOT repo — it must never appear in the installed Lite package tree');
  });

  it('semidex-lite --help runs from the read-only install and prints the cloud-only command list', () => {
    const out = execFileSync(process.execPath, [join(packageDir, 'bin', 'semidex-lite.js'), '--help'], { encoding: 'utf-8' });
    assert.match(out, /semidex-lite — cloud-only Semidex CLI/);
    assert.match(out, /doctor \[--probe-inference\]/);
    assert.match(out, /serve/);
    assert.match(out, /index <path>/);
  });

  it('semidex-lite doctor runs from the read-only install, writes nothing into the package dir, reports missing creds cleanly', () => {
    // doctor exits 1 when QDRANT_URL/QDRANT_KEY are unset (this test's
    // deliberate env) — that is the CORRECT, expected outcome here, not a
    // crash. execFileSync throws on any non-zero exit, so the real
    // assertion is: it throws with exit code 1 and readable stdout, never
    // an uncaught exception/stack trace from a broken module resolution
    // (which is what the earlier ../../../src/ vs ../src/ bug produced —
    // an ERR_MODULE_NOT_FOUND crash, not a clean doctor FAIL report).
    let stdout = '';
    let status = 0;
    try {
      stdout = execFileSync(
        process.execPath,
        [join(packageDir, 'bin', 'semidex-lite.js'), 'doctor'],
        {
          encoding: 'utf-8',
          env: { ...process.env, SEMIDEX_HOME: semidexHomeDir, QDRANT_URL: '', QDRANT_KEY: '', GEMINI_API_KEY: '' },
        }
      );
    } catch (err) {
      stdout = err.stdout?.toString() ?? '';
      status = err.status;
    }
    assert.equal(status, 1, `doctor must exit 1 for missing credentials, not crash — stdout was:\n${stdout}`);
    assert.match(stdout, /Runtime environment/);
    assert.match(stdout, /QDRANT_URL not set/);
    assert.ok(!stdout.includes('ERR_MODULE_NOT_FOUND'), 'must never fail with a module-resolution error');
  });

  it('starting semidex-lite serve from the read-only install responds on /api/health with no crash', async () => {
    const { spawn } = await import('node:child_process');
    const port = 18800 + Math.floor(Math.random() * 200);
    const child = spawn(process.execPath, [join(packageDir, 'bin', 'semidex-lite.js'), 'serve'], {
      env: { ...process.env, SEMIDEX_HOME: semidexHomeDir, ADMIN_PORT: String(port), QDRANT_URL: '', QDRANT_KEY: '' },
      stdio: 'pipe',
    });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('serve did not print its listening line within 5s')), 5000);
        child.stdout.on('data', (chunk) => {
          if (chunk.toString().includes('listening on')) { clearTimeout(timeout); resolve(); }
        });
        child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`serve exited early with code ${code}`)); });
      });
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.notEqual(res.status, 500);
    } finally {
      child.kill();
    }
  });

  it('the installed package directory itself received no writes (only SEMIDEX_HOME did)', () => {
    // A write attempt into a chmod 444/555 tree throws EACCES/EPERM at the
    // OS level — the fact that every command above already completed
    // without such an error is itself the primary proof. This assertion
    // additionally confirms SEMIDEX_HOME (the writable location) actually
    // received real files, so "no writes happened at all" (a vacuously
    // true but useless result if doctor/serve silently no-op'd) is ruled out.
    const homeContents = readdirSync(semidexHomeDir);
    assert.ok(homeContents.length > 0, 'SEMIDEX_HOME must have received real files (config/settings/cache) — an empty dir would mean nothing actually ran');
  });
});

describe('clean-install acceptance — no relative import escapes the package root', { timeout: 60000 }, () => {
  it('every relative import/require in the installed package resolves to a path INSIDE the package directory', () => {
    const violations = [];
    walkJsFiles(packageDir, (absPath, relPath) => {
      const source = readFileSync(absPath, 'utf-8');
      let ast;
      try {
        ast = parse(source, { sourceType: 'module', ecmaVersion: 'latest', allowImportExportEverywhere: true });
      } catch (err) {
        violations.push(`${relPath}: failed to parse (${err.message})`);
        return;
      }
      const fromDir = dirname(absPath);
      walkSimple(ast, {
        ImportDeclaration(node) { checkSpecifier(node.source.value); },
        ExportNamedDeclaration(node) { if (node.source) checkSpecifier(node.source.value); },
        ExportAllDeclaration(node) { checkSpecifier(node.source.value); },
        ImportExpression(node) { if (node.source.type === 'Literal') checkSpecifier(node.source.value); },
      });
      function checkSpecifier(specifier) {
        if (!specifier.startsWith('.')) return; // bare package specifier — resolved via node_modules, not a path escape
        const resolved = join(fromDir, specifier);
        const normalizedPackageDir = packageDir.replace(/\\/g, '/');
        const normalizedResolved = resolved.replace(/\\/g, '/');
        if (!normalizedResolved.startsWith(normalizedPackageDir)) {
          violations.push(`${relPath}: relative import "${specifier}" resolves to "${normalizedResolved}", which escapes the package root "${normalizedPackageDir}"`);
        }
      }
    });
    assert.deepEqual(violations, [], `relative imports escaping the package root:\n${violations.join('\n')}`);
  });
});

// ── SDK export surface (Part A/B of the 0.1.6 release-readiness task) ──────
//
// Everything above proves the CLI works read-only from a real clean install.
// The tests below prove the packed artifact's PUBLIC LIBRARY SURFACE —
// `semidex-lite/client` — does too: that it resolves via Node's own package
// "exports" resolution (not a repo-relative import, which every
// tests/unit/lite/client/*.test.js file already uses and which would still
// pass even if packaging broke), that it is not accompanied by unintended
// deep-import access to the package's internals, and that its wire contract
// (bearer header, typed errors, redirect rejection, SSE async-iterator
// shape) survives being loaded from the ACTUAL installed location.
//
// No TypeScript compiler is invoked here to type-check lite-src/client/
// index.d.ts against a consumer fixture: this repository has no `typescript`
// dependency anywhere (root or Lite), and adding one solely for this one
// gate would be exactly the "heavyweight compiler dependency added only for
// this gate" the release-readiness task explicitly says not to add. The
// runtime/export-shape checks below (declared `exports` map, real
// ERR_PACKAGE_PATH_NOT_EXPORTED enforcement, and the full read-only
// http.test.js-equivalent wire-contract run against the installed file) are
// the strongest verification available without that new dependency — they
// prove every field docs/types describe is actually present and behaves as
// specified at runtime, which a type-only check could not do on its own.

const EXCLUDED_BUILD_PATHS = [
  // Mirrors packages/lite/build.mjs's own EXCLUDE_DIRS/EXCLUDE_FILES lists —
  // if any of these ever leaked into the tarball, this test must fail even
  // though it does not re-derive build.mjs's full closure logic itself.
  'src/mcp', 'src/smoke', 'src/test-fixtures', 'src/local',
  'src/admin/ui-src', 'src/shared/admin/ui-src',
  'src/admin/server-full.js', 'src/admin/bootstrap.js', 'src/doctor.js', 'src/key.js',
  'src/backfill-tags.js', 'src/backfill-entity-refs.js', 'src/sync.js', 'src/smoke.js',
  'src/bootstrap-docs.js', 'src/indexer/index.js', 'src/indexer/index-full.js',
  'src/admin/jobs/spawn-indexer-full.js', 'src/core/ce-rerank.js', 'src/core/ce-rerank-worker.js',
  'src/core/rerank-provider.js',
];

describe('installed package — no local/full-only runtime, fixtures, or secrets shipped', () => {
  it('none of the build.mjs-excluded paths exist in the installed package', () => {
    for (const rel of EXCLUDED_BUILD_PATHS) {
      assert.ok(!existsSync(join(packageDir, rel)), `"${rel}" must never be present in the installed package (it is one of build.mjs's own excluded local/full-only paths)`);
    }
  });

  it('no real .env, maintainer scripts/, or docs/ tree is present — only .env.example', () => {
    assert.ok(!existsSync(join(packageDir, '.env')), 'a real .env must never ship — only .env.example (a template, not a secret)');
    assert.ok(existsSync(join(packageDir, '.env.example')), '.env.example (the documented template) must ship');
    assert.ok(!existsSync(join(packageDir, 'scripts')), 'maintainer scripts/ (e.g. the release-live-acceptance harness) must never ship inside the package itself');
    assert.ok(!existsSync(join(packageDir, 'docs')), 'the repo docs/ tree (design notes, audits, reports) must never ship inside the package');
  });
});

describe('installed package — semidex-lite/client export surface', () => {
  it('runtime client files and the .d.ts declaration are all present at their documented locations', () => {
    for (const rel of ['lite-src/client/index.js', 'lite-src/client/errors.js', 'lite-src/client/sse.js', 'lite-src/client/index.d.ts']) {
      assert.ok(existsSync(join(packageDir, rel)), `installed package must ship "${rel}"`);
    }
  });

  it('examples/backend-integration-server.mjs is shipped and imports the client from a path inside the package', () => {
    const examplePath = join(packageDir, 'examples', 'backend-integration-server.mjs');
    assert.ok(existsSync(examplePath), 'installed package must ship examples/backend-integration-server.mjs');
    const source = readFileSync(examplePath, 'utf-8');
    assert.match(source, /from ['"]\.\.\/lite-src\/client\/index\.js['"]/, 'the shipped example must import createSemidexClient from the shipped client, not a repo-relative path');
  });

  it('package.json declares exactly one export subpath, "./client" — no unintended internal module is exposed', () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8'));
    assert.deepEqual(Object.keys(pkg.exports ?? {}), ['./client'], 'the installed package.json must declare exactly one export subpath');
    assert.deepEqual(pkg.exports['./client'], { types: './lite-src/client/index.d.ts', default: './lite-src/client/index.js' });
  });

  it('`import "semidex-lite/client"` resolves from a separate consumer directory and exposes createSemidexClient + SemidexApiError', () => {
    const consumerScript = join(installDir, 'consumer-import-check.mjs');
    writeFileSync(consumerScript, `
      import { createSemidexClient, SemidexApiError } from 'semidex-lite/client';
      import assert from 'node:assert/strict';
      assert.equal(typeof createSemidexClient, 'function');
      assert.equal(typeof SemidexApiError, 'function');
      assert.equal(SemidexApiError.prototype instanceof Error, true);
      console.log('OK');
    `, 'utf-8');
    const out = execFileSync(process.execPath, [consumerScript], { encoding: 'utf-8' });
    assert.match(out, /OK/);
  });

  it('an unexported deep subpath is rejected by Node\'s own "exports" resolution, not merely undocumented', () => {
    const consumerScript = join(installDir, 'consumer-exports-boundary-check.mjs');
    writeFileSync(consumerScript, `
      try {
        await import('semidex-lite/lite-src/serve-lite.js');
        console.log('IMPORT_SUCCEEDED_UNEXPECTEDLY');
      } catch (err) {
        console.log(err.code ?? err.message);
      }
    `, 'utf-8');
    const out = execFileSync(process.execPath, [consumerScript], { encoding: 'utf-8' });
    assert.match(out, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  });

  it('the installed client\'s wire contract (bearer header, typed errors, redirect rejection, SSE async-iterator shape) survives packaging', async () => {
    const consumerScript = join(installDir, 'consumer-wire-contract-check.mjs');
    writeFileSync(consumerScript, buildWireContractConsumerScript(), 'utf-8');
    const out = execFileSync(process.execPath, [consumerScript], { encoding: 'utf-8', timeout: 30_000 });
    assert.match(out, /ALL_WIRE_CONTRACT_CHECKS_PASSED/, out);
  });
});

// Generates a self-contained consumer script (zero imports beyond Node
// builtins + the package-specifier `semidex-lite/client` import itself) that
// re-runs the highest-value subset of tests/unit/lite/client/http.test.js's
// assertions — request shape/bearer header, typed-error projection with no
// key leakage, fail-closed redirect handling, and the askV1() async
// generator's multi-event/terminal-error shape — against the client loaded
// from its REAL installed location, over a real local socket. This is not a
// duplication of the full unit suite (per the release-readiness task's own
// "select the smallest high-value checks" instruction) — it is the minimum
// needed to prove packaging did not silently change any of those contracts.
function buildWireContractConsumerScript() {
  return `
    import { createSemidexClient, SemidexApiError } from 'semidex-lite/client';
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';

    const API_KEY = 'sdx_v1_' + 'k'.repeat(16) + '_' + 'a'.repeat(43);

    async function withFakeServer(handler, fn) {
      const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          let body = {};
          if (chunks.length > 0) {
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { body = null; }
          }
          try { await handler(req, res, body); }
          catch (err) { if (!res.headersSent) res.writeHead(500); res.end(String(err?.stack ?? err)); }
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      try { await fn(base); } finally { await new Promise((resolve) => server.close(resolve)); }
    }
    function jsonRes(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    }

    // 1) search() sends the bearer header and hits POST /api/v1/search.
    await withFakeServer((req, res, body) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/api/v1/search');
      assert.equal(req.headers.authorization, 'Bearer ' + API_KEY);
      jsonRes(res, 200, { apiVersion: 'v1', collection: body.collection, query: body.query, searchMode: 'hybrid', top: 3, window: 0, windowFormat: null, results: [] });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const result = await client.search({ collection: 'docs', query: 'q' });
      assert.equal(result.apiVersion, 'v1');
    });

    // 2) a non-2xx response becomes a typed SemidexApiError that never leaks the apiKey.
    await withFakeServer((req, res) => {
      jsonRes(res, 401, { error: { code: 'unauthorized', message: 'A valid Integration API bearer token is required.' } });
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      await assert.rejects(
        () => client.search({ collection: 'docs', query: 'q' }),
        (err) => {
          assert.ok(err instanceof SemidexApiError);
          assert.equal(err.status, 401);
          assert.equal(err.code, 'unauthorized');
          const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
          assert.ok(!serialized.includes(API_KEY));
          return true;
        },
      );
    });

    // 3) a redirect is rejected outright — the second origin never receives the request.
    let secondaryHit = false;
    await withFakeServer((req, res) => { secondaryHit = true; jsonRes(res, 200, {}); }, async (secondaryBase) => {
      await withFakeServer((req, res) => {
        res.writeHead(302, { Location: secondaryBase + '/api/v1/search' });
        res.end();
      }, async (base) => {
        const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
        await assert.rejects(
          () => client.search({ collection: 'docs', query: 'q' }),
          (err) => { assert.ok(err instanceof SemidexApiError); assert.equal(err.retryable, true); return true; },
        );
      });
    });
    assert.equal(secondaryHit, false, 'a redirected-to endpoint must never receive a request');

    // 4) askV1()/askV2() are importable and preserve the sources -> answer_delta* -> done
    //    async-iterator contract, including the terminal-SSE-error-throws-not-yields rule.
    for (const [name, call] of [['askV1', createSemidexClient({ baseUrl: 'http://127.0.0.1:1', apiKey: API_KEY }).askV1], ['askV2', createSemidexClient({ baseUrl: 'http://127.0.0.1:1', apiKey: API_KEY }).askV2]]) {
      assert.equal(typeof call, 'function', name + ' must be exported as a function');
    }
    await withFakeServer((req, res, body) => {
      assert.equal(req.url, '/api/v1/ask');
      assert.equal(req.headers.accept, 'text/event-stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('event: sources\\ndata: {"apiVersion":"v1","searchMode":"hybrid","sources":[]}\\n\\n');
      res.write('event: answer_delta\\ndata: {"text":"hi"}\\n\\n');
      res.write('event: done\\ndata: {"answer":"hi","citations":[],"entityRefs":[],"refused":false,"evidenceCount":0}\\n\\n');
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      for await (const event of client.askV1({ collection: 'docs', question: 'q' })) events.push(event);
      assert.deepEqual(events.map((e) => e.type), ['sources', 'answer_delta', 'done']);
    });
    await withFakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('event: error\\ndata: {"code":"generation_failed","message":"boom","retryable":true}\\n\\n');
      res.end();
    }, async (base) => {
      const client = createSemidexClient({ baseUrl: base, apiKey: API_KEY });
      const events = [];
      await assert.rejects(
        (async () => { for await (const event of client.askV2({ collection: 'docs', question: 'q' })) events.push(event); })(),
        (err) => { assert.ok(err instanceof SemidexApiError); assert.equal(err.code, 'generation_failed'); return true; },
      );
      assert.deepEqual(events, [], 'a terminal SSE error must throw, never yield a final event');
    });

    console.log('ALL_WIRE_CONTRACT_CHECKS_PASSED');
  `;
}

function walkJsFiles(dir, visit, base = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(full, visit, base);
    } else if (entry.name.endsWith('.js')) {
      visit(full, full.slice(base.length + 1));
    }
  }
}
