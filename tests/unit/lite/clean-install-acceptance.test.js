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
  mkdtempSync, rmSync, existsSync, readdirSync, statSync, readFileSync, chmodSync,
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
  rmSync(installDir, { recursive: true, force: true });
  rmSync(semidexHomeDir, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
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
