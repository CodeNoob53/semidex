#!/usr/bin/env node
// scripts/audit/build-import-graph.mjs — read-only AST-based import-graph
// builder for the full-lite-shared architecture audit
// (docs/design/full-lite-shared-architecture-audit-2026-08-01.md).
//
// Walks the REAL src/ tree (not the Lite-staged subset packages/lite/
// build.mjs produces) and, for every .js file, extracts the same four
// reference kinds build.mjs's own closure validator already extracts for
// Lite (static import/export-from, literal dynamic import(), require()/
// createRequire()-bound require(), literal fork()/spawn() targets) using
// the same acorn/acorn-walk AST approach — never source-regex scanning —
// per the audit's own requirement to prefer AST analysis over regex.
//
// This script only READS files and WRITES its own JSON output under
// docs/design/artifacts/ — it never modifies src/, packages/lite/, or any
// other production file. Safe to run repeatedly.
import { parse } from 'acorn';
import { simple as walkSimple } from 'acorn-walk';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const LITE_SRC_ROOT = join(REPO_ROOT, 'packages', 'lite', 'lite-src');

// Every graph node's key and every resolved edge is REPO_ROOT-relative
// (e.g. "src/core/config.js", "packages/lite/lite-src/doctor-lite.js") —
// NOT src/-relative. This is what lets packages/lite/lite-src/*.js (which
// live OUTSIDE src/ and import it via '../src/...' specifiers) become
// real, parsed graph nodes with real resolved edges into src/, instead of
// a hand-maintained "these are lite-src's known imports" list a future
// change to lite-src could silently drift out of sync with (the exact gap
// code review flagged: a new import added to a Lite entry point with no
// corresponding update to a hand-copied root list would leave the
// architecture tests green while actually missing the new edge).

const NODE_BUILTINS = new Set([
  'fs', 'path', 'url', 'crypto', 'child_process', 'module', 'util', 'os',
  'http', 'https', 'stream', 'events', 'zlib', 'buffer', 'assert', 'perf_hooks',
]);

function listAllJsFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      listAllJsFiles(full, base, out);
    } else if (extname(full) === '.js') {
      out.push(relative(base, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

function parseFile(absPath) {
  const src = readFileSync(absPath, 'utf-8');
  return parse(src, { sourceType: 'module', ecmaVersion: 'latest', allowImportExportEverywhere: true });
}

// Same literal-relative-path recognizer as packages/lite/build.mjs — kept
// independent (not imported from there) so this audit script has zero
// dependency on the Lite packaging tool's own internals and cannot regress
// if that tool changes its exports.
function findLiteralRelativePathArg(node) {
  if (!node || node.type !== 'CallExpression') return null;
  if (node.callee.type === 'Identifier' && node.callee.name === 'fileURLToPath') {
    const inner = node.arguments[0];
    if (inner?.type === 'NewExpression' && inner.callee.name === 'URL' && inner.arguments[0]?.type === 'Literal') {
      return inner.arguments[0].value;
    }
  }
  if (node.callee.type === 'Identifier' && node.callee.name === 'join') {
    // join(__dirname, 'sibling-file.js') — the last string literal
    // argument is the target. Two shapes: a path fragment containing '/'
    // (e.g. '../workers/x.js', already relative-looking) is returned
    // as-is; a bare filename with NO '/' at all (e.g. 'ce-rerank-worker.js'
    // — a same-directory sibling, core/ce-rerank.js's real shape) is
    // prefixed with './' so resolveRelativeSpecifier() treats it as
    // relative to the CALLING file's own directory, matching what
    // join(__dirname, ...) actually resolves to at runtime. A confirmed
    // real gap in the original extraction (ported from
    // packages/lite/build.mjs, which has the same gap) — the bare-filename
    // case was previously silently rejected (a).value.includes('/')
    // required a slash that a bare sibling filename never has), which
    // made core/ce-rerank.js's own fork(WORKER_PATH, ...) target
    // unresolved (`arg: 'WORKER_PATH', literal: false`) rather than
    // correctly resolved to core/ce-rerank-worker.js. See the audit
    // design doc's Part C/Part K findings.
    const litArgs = node.arguments.filter((a) => a.type === 'Literal' && typeof a.value === 'string');
    const lastLit = litArgs[litArgs.length - 1];
    if (lastLit) {
      return lastLit.value.includes('/') ? lastLit.value : `./${lastLit.value}`;
    }
  }
  return null;
}

function extractReferences(ast) {
  const staticImports = [];
  const dynamicImports = []; // { specifier, literal }
  const requireCalls = [];
  const forkSpawnCalls = []; // { callee, arg, literal }
  const urlPathConsts = new Map();
  const childProcessImportNames = new Set();
  const childProcessLocalToReal = new Map();
  const requireLocalNames = new Set();

  walkSimple(ast, {
    ImportDeclaration(node) {
      staticImports.push(node.source.value);
      if (node.source.value === 'node:child_process' || node.source.value === 'child_process') {
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier' && (spec.imported.name === 'fork' || spec.imported.name === 'spawn')) {
            childProcessImportNames.add(spec.local.name);
            childProcessLocalToReal.set(spec.local.name, spec.imported.name);
          }
        }
      }
    },
    ExportNamedDeclaration(node) {
      if (node.source) staticImports.push(node.source.value);
    },
    ExportAllDeclaration(node) {
      staticImports.push(node.source.value);
    },
    ImportExpression(node) {
      if (node.source.type === 'Literal') {
        dynamicImports.push({ specifier: node.source.value, literal: true });
      } else {
        dynamicImports.push({ specifier: null, literal: false });
      }
    },
    VariableDeclarator(node) {
      if (
        node.init?.type === 'CallExpression'
        && node.init.callee.type === 'Identifier'
        && node.init.callee.name === 'createRequire'
        && node.id.type === 'Identifier'
      ) {
        requireLocalNames.add(node.id.name);
      }
      if (node.id.type === 'Identifier') {
        const literalPath = findLiteralRelativePathArg(node.init);
        if (literalPath) urlPathConsts.set(node.id.name, literalPath);
      }
    },
    // Default-parameter binding to a tracked fork/spawn import — e.g.
    // `function f({ spawnFn = nodeSpawn } = {}) { ... spawnFn(...) }`
    // (the exact shape admin/jobs/registry.js's createJobRegistry() uses).
    // A real, confirmed gap in the ORIGINAL packages/lite/build.mjs
    // closure validator (this file's logic was ported from there) — see
    // the audit design doc's Part C/Part K findings. File-scoped, not
    // properly lexically scoped (a parameter name colliding with an
    // unrelated identifier elsewhere in the same file would be a false
    // positive) — a deliberate, documented approximation sufficient for
    // an audit script, not a hard security boundary.
    AssignmentPattern(node) {
      if (
        node.left?.type === 'Identifier'
        && node.right?.type === 'Identifier'
        && childProcessImportNames.has(node.right.name)
      ) {
        childProcessImportNames.add(node.left.name);
        childProcessLocalToReal.set(node.left.name, childProcessLocalToReal.get(node.right.name));
      }
    },
    CallExpression(node) {
      const callee = node.callee;
      if (callee.type === 'Identifier' && (callee.name === 'require' || requireLocalNames.has(callee.name))) {
        const arg = node.arguments[0];
        // A non-literal require() argument (e.g. core/onnx-runtime.js's
        // require(resolveOnnxRuntimeModule(env)), a CallExpression, not a
        // string literal) was previously silently DROPPED entirely — not
        // recorded as a violation, not recorded at all, indistinguishable
        // from a file with no require() call. Now recorded with
        // literal: false, matching dynamicImports' own shape, so a
        // consumer can tell "no require() here" apart from "a require()
        // here whose target this tool cannot statically verify." A
        // confirmed real gap found while responding to code review's
        // request for an EXACT non-literal-import allow-list rather than
        // a fuzzy count — building that allow-list surfaced this file was
        // invisible to the graph entirely, not merely uncounted.
        if (arg?.type === 'Literal') {
          requireCalls.push({ specifier: arg.value, literal: true });
        } else {
          requireCalls.push({ specifier: null, literal: false });
        }
      }
      if (callee.type === 'Identifier' && childProcessImportNames.has(callee.name)) {
        const real = childProcessLocalToReal.get(callee.name);
        const arg = node.arguments[0];
        // spawn(process.execPath, [ENTRY, ...], opts) — Node's own
        // "re-spawn the current Node binary with an explicit entry-file
        // second argument" pattern (admin/jobs/registry.js's real shape).
        // Distinct from fork(modulePath, args, opts): here the REAL
        // target is arguments[1][0], not arguments[0]. A confirmed gap in
        // the original packages/lite/build.mjs closure validator, which
        // this file's logic was ported from — its own header comment
        // claims to recognize this shape but its extraction never
        // actually looked at the second argument's array. See the audit
        // design doc's Part C/Part K findings.
        const isProcessExecPath = arg?.type === 'MemberExpression'
          && arg.object?.type === 'Identifier' && arg.object.name === 'process'
          && arg.property?.type === 'Identifier' && arg.property.name === 'execPath';
        if (isProcessExecPath && node.arguments[1]?.type === 'ArrayExpression') {
          const entryArg = node.arguments[1].elements[0];
          if (entryArg?.type === 'Literal') {
            forkSpawnCalls.push({ callee: real, arg: entryArg.value, literal: true });
          } else if (entryArg?.type === 'Identifier' && urlPathConsts.has(entryArg.name)) {
            forkSpawnCalls.push({ callee: real, arg: urlPathConsts.get(entryArg.name), literal: true });
          } else if (entryArg?.type === 'Identifier') {
            forkSpawnCalls.push({ callee: real, arg: entryArg.name, literal: false });
          } else {
            forkSpawnCalls.push({ callee: real, arg: null, literal: false });
          }
        } else if (arg?.type === 'Literal') {
          forkSpawnCalls.push({ callee: real, arg: arg.value, literal: true });
        } else if (arg?.type === 'Identifier' && urlPathConsts.has(arg.name)) {
          forkSpawnCalls.push({ callee: real, arg: urlPathConsts.get(arg.name), literal: true });
        } else if (arg?.type === 'Identifier') {
          forkSpawnCalls.push({ callee: real, arg: arg.name, literal: false });
        } else {
          forkSpawnCalls.push({ callee: real, arg: null, literal: false });
        }
      }
    },
  });

  return { staticImports, dynamicImports, requireCalls, forkSpawnCalls };
}

const LITE_STAGING_PREFIX = join(REPO_ROOT, 'packages', 'lite', 'src');

// fromFileRepoRel is REPO_ROOT-relative (e.g. "src/core/config.js" or
// "packages/lite/lite-src/doctor-lite.js") — resolution walks from the
// REAL absolute directory of the importing file, so a lite-src file's
// '../src/core/x.js' specifier correctly lands on "src/core/x.js" in the
// same coordinate space every src/-internal edge uses, with no separate
// "which root am I in" branch needed for the CALLER — EXCEPT for one real
// wrinkle: packages/lite/lite-src/*.js's own '../src/...' specifier
// literally resolves, from ITS OWN directory, to packages/lite/src/... —
// the gitignored, build.mjs-GENERATED staging mirror of src/, which does
// not exist in a fresh checkout and must never be treated as the graph's
// source of truth even when it happens to exist locally (e.g. right after
// running build.mjs). packages/lite/src/ is a verbatim, path-preserving
// copy of src/ (confirmed: `diff -rq src packages/lite/src` shows zero
// content differences beyond build.mjs's own documented exclude-list
// omissions and *-lazy.js shim substitutions) — so any resolved path
// falling under that prefix is redirected here to the equivalent path
// under the REAL src/, which IS a graph node. This is what makes a
// lite-src file's import land on the same "src/core/x.js" node every
// src/-internal edge already uses, rather than a dead-end that only
// resolves when a stale local build artifact happens to be present.
function resolveRelativeSpecifier(specifier, fromFileRepoRel) {
  if (!specifier.startsWith('.')) return null;
  const fromDir = dirname(join(REPO_ROOT, fromFileRepoRel));
  const candidate = resolve(fromDir, specifier);
  const tryPaths = [candidate, `${candidate}.js`, join(candidate, 'index.js')];
  for (const p of tryPaths) {
    if (p.startsWith(LITE_STAGING_PREFIX)) {
      const realSrcEquivalent = join(SRC_ROOT, relative(LITE_STAGING_PREFIX, p));
      if (existsSync(realSrcEquivalent) && statSync(realSrcEquivalent).isFile()) {
        return relative(REPO_ROOT, realSrcEquivalent).replace(/\\/g, '/');
      }
      continue;
    }
    if (existsSync(p) && statSync(p).isFile()) return relative(REPO_ROOT, p).replace(/\\/g, '/');
  }
  return null;
}

function classifySpecifier(specifier, fromFileRepoRel) {
  if (specifier.startsWith('.')) {
    const resolved = resolveRelativeSpecifier(specifier, fromFileRepoRel);
    return { kind: 'relative', resolved };
  }
  if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier)) {
    return { kind: 'builtin', resolved: null };
  }
  const pkgName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  return { kind: 'package', resolved: pkgName };
}

// Builds the full graph across BOTH src/ and packages/lite/lite-src/ — the
// second directory is small (5 files) but is a REAL composition root
// (Lite's actual CLI/server entry points), and parsing it with the same
// AST walker as everything else (rather than hand-transcribing its
// imports into a separate constant list) is what makes Lite reachability
// a genuine regression lock instead of a "someone remembered to update
// the list" lock. Every node key and every resolved edge is REPO_ROOT-
// relative (e.g. "src/core/config.js", "packages/lite/lite-src/doctor-lite.js").
export function buildGraph({ roots = [SRC_ROOT, LITE_SRC_ROOT] } = {}) {
  const files = [];
  for (const root of roots) {
    for (const f of listAllJsFiles(root)) {
      files.push(relative(REPO_ROOT, join(root, f)).replace(/\\/g, '/'));
    }
  }

  const nodes = {};
  const parseErrors = [];

  for (const repoRelFile of files) {
    const absPath = join(REPO_ROOT, repoRelFile);
    let ast;
    try {
      ast = parseFile(absPath);
    } catch (err) {
      parseErrors.push({ file: repoRelFile, error: err.message });
      nodes[repoRelFile] = {
        staticImports: [], dynamicImports: [], requireCalls: [], forkSpawnCalls: [], parseError: err.message,
      };
      continue;
    }
    const refs = extractReferences(ast);

    const staticImports = refs.staticImports.map((s) => ({ specifier: s, ...classifySpecifier(s, repoRelFile) }));
    const dynamicImports = refs.dynamicImports.map((d) => (
      d.literal
        ? { specifier: d.specifier, literal: true, ...classifySpecifier(d.specifier, repoRelFile) }
        : { specifier: null, literal: false, kind: 'non-literal', resolved: null }
    ));
    const requireCalls = refs.requireCalls.map((r) => (
      r.literal
        ? { specifier: r.specifier, literal: true, ...classifySpecifier(r.specifier, repoRelFile) }
        : { specifier: null, literal: false, kind: 'non-literal', resolved: null }
    ));
    const forkSpawnCalls = refs.forkSpawnCalls.map((f) => (
      f.literal
        ? { callee: f.callee, arg: f.arg, literal: true, resolved: resolveRelativeSpecifier(f.arg, repoRelFile) }
        : { callee: f.callee, arg: f.arg, literal: false, resolved: null }
    ));

    nodes[repoRelFile] = { staticImports, dynamicImports, requireCalls, forkSpawnCalls };
  }

  return {
    roots: roots.map((r) => relative(REPO_ROOT, r).replace(/\\/g, '/')),
    files, nodes, parseErrors,
  };
}

function main() {
  const graph = buildGraph();
  const outDir = join(REPO_ROOT, 'docs', 'design', 'artifacts');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'full-lite-import-graph.json');
  writeFileSync(outPath, JSON.stringify(graph, null, 2), 'utf-8');
  console.log(`[audit] parsed ${graph.files.length} files under ${graph.roots.join(', ')}, ${graph.parseErrors.length} parse error(s)`);
  console.log(`[audit] wrote ${relative(REPO_ROOT, outPath)}`);
  if (graph.parseErrors.length) {
    for (const e of graph.parseErrors) console.error(`  [parse-error] ${e.file}: ${e.error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
