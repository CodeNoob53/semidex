// Managed CUDA runtime ID validation and path-traversal-safe resolution.
// A managed runtime is identified by a strict, validated ID —
// `<ortVersion>-cuda<cudaMajor>` — never a free-form string joined onto a
// directory path directly. ONNX_MANAGED_RUNTIME's setting value is only
// ever populated from the discovered-and-validated list (never typed
// freely by a user — it's a <select>, not a text field), but the
// resolution functions here still re-validate on every call, since
// settings.json is hand-editable on disk and must never be trusted
// blindly.
import { join, relative, isAbsolute, resolve as resolvePath } from 'node:path';

const MANAGED_RUNTIME_ID_RE = /^\d+\.\d+\.\d+-cuda\d+$/;

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidManagedRuntimeId(id) {
  return typeof id === 'string' && MANAGED_RUNTIME_ID_RE.test(id);
}

function assertLexicallyContained(resolvedPath, resolvedRoot, label) {
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} resolves outside the managed-runtimes tree: "${resolvedPath}" is not inside "${resolvedRoot}"`);
  }
}

/**
 * Resolves the canonical, on-disk directory for a managed runtime ID,
 * rejecting anything that isn't a validated id or that would resolve
 * outside `<runtimesDir>/onnxruntime-node-cuda/`. Two independent layers:
 * the format regex (rejects '/', '..', anything not matching the exact
 * shape) plus a lexical-containment check on the resolved absolute path
 * — defends against a pathologically crafted id even if the regex were
 * ever loosened by mistake.
 * @param {string} runtimesDir
 * @param {string} id
 * @returns {string}
 * @throws {Error} if id is invalid or would resolve outside the tree.
 */
export function resolveManagedRuntimePathSafe(runtimesDir, id) {
  if (!isValidManagedRuntimeId(id)) {
    throw new Error(`invalid managed runtime id: ${JSON.stringify(id)}`);
  }
  const root = resolvePath(join(runtimesDir, 'onnxruntime-node-cuda'));
  const target = resolvePath(join(root, id));
  assertLexicallyContained(target, root, 'managed runtime path');
  return target;
}

// The installer's own transactional swap (staging/backup/failed
// siblings) constructs directory names that do NOT match
// MANAGED_RUNTIME_ID_RE at all — a separate, explicit function covers
// exactly those transient-name shapes. The installer script is the only
// caller; it always builds `childName` from a timestamp it generated
// itself, never from external/user input (those only ever flow through
// resolveManagedRuntimePathSafe() above) — but this function still
// enforces the format so a future bug in the timestamp-formatting code
// can't silently produce a path outside the managed-runtimes tree either.
const CHILD_PATH_PATTERNS = {
  installStage: /^install-stage-\d+$/,
  backup: /^\d+\.\d+\.\d+-cuda\d+\.backup-\d+$/,
  failed: /^\d+\.\d+\.\d+-cuda\d+\.failed-\d+$/,
};

/**
 * @param {string} runtimesDir
 * @param {string} childName
 * @param {'installStage'|'backup'|'failed'} kind
 * @returns {string}
 * @throws {Error} if childName doesn't match `kind`'s pattern, or would
 *   resolve outside the managed-runtimes tree.
 */
export function resolveManagedRuntimeChildPathSafe(runtimesDir, childName, kind) {
  const pattern = CHILD_PATH_PATTERNS[kind];
  if (!pattern) {
    throw new Error(`unknown managed runtime child path kind: ${JSON.stringify(kind)}`);
  }
  if (typeof childName !== 'string' || !pattern.test(childName)) {
    throw new Error(`invalid managed runtime child path name for kind "${kind}": ${JSON.stringify(childName)}`);
  }
  const root = resolvePath(join(runtimesDir, 'onnxruntime-node-cuda'));
  const target = resolvePath(join(root, childName));
  assertLexicallyContained(target, root, `managed runtime ${kind} path`);
  return target;
}
