// buildFileSkeleton() — file-level navigation nodes + JSON inspect artifact.
// Contract: impl spec §3.5 (task 4), design §9, §14.
//
// HARD CONSTRAINT (impl spec §11 order 4→5→6): this module NEVER writes to
// Qdrant. navPoints are returned for a FUTURE upsert step that activates only
// after the point_kind search filter is live. Until then the only side effect
// is the inspect JSON under .tmp/semidex-inspect/ — and JSON is never a source
// of truth (design §14).
//
// MVP summaries are LLM-free (impl spec §3.5): a section summary is its
// heading plus a child inventory ("3 paragraphs, 2 code blocks"); the file
// summary is the title heading (or first prose line) plus totals. LLM
// summaries replace these in a later task without changing the node shape.
//
// node_id parity: section nav nodes derive their node_id EXACTLY like
// chunkFromSkeleton derives chunk parent_id (structuralPath = section slug
// path, nodeType 'section', ordinal 1) — so nav nodes and content chunks link
// into one graph. Known limitation: duplicate sibling headings share a slug
// and therefore an id; acceptable for MVP, tracked in design §18.

import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import { makeNodeId } from '../../shared/core/node-id.js';
import { POINT_KINDS } from './node-policy.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../');

function inventoryLabel(counts) {
  const parts = [];
  for (const [type, n] of Object.entries(counts)) {
    if (n > 0) parts.push(`${n} ${type}${n === 1 ? '' : 's'}`);
  }
  return parts.join(', ') || 'empty';
}

/**
 * Build file + section navigation nodes from a parsed skeleton.
 * Pure aside from id derivation — no I/O, no Qdrant.
 *
 * @param {SkeletonNode[]} nodes — output of parseSkeleton()
 * @param {{ sourceFile: string, collection?: string }} ctx
 * @returns {{ navPoints: object[], json: object }}
 */
export function buildFileSkeleton(nodes, ctx = {}) {
  const sourceFile = ctx.sourceFile ?? '';

  // Group content nodes under their section (by parentStructuralPath).
  const sections = nodes.filter(n => n.nodeType === 'section');
  const bySection = new Map(); // structuralPath → { counts, childPaths }
  for (const s of sections) bySection.set(s.structuralPath, { section: s, counts: {}, childPaths: [] });

  let preambleCounts = {};  // content before any heading
  for (const n of nodes) {
    if (n.nodeType === 'section' || n.nodeType === 'frontmatter') continue;
    const home = bySection.get(n.parentStructuralPath);
    const counts = home ? home.counts : preambleCounts;
    counts[n.nodeType] = (counts[n.nodeType] ?? 0) + 1;
    if (home) home.childPaths.push(`${sourceFile}#${n.parentStructuralPath}/${n.nodeType}-${n.ordinalWithinParent}`);
  }

  const sectionNodes = sections.map(s => {
    const entry = bySection.get(s.structuralPath);
    return {
      point_kind:   POINT_KINDS.NAV,
      node_type:    'section',
      // Parity with chunkFromSkeleton parent_id derivation (ordinal fixed at 1).
      node_id: makeNodeId({
        collection: '', sourceFile,
        structuralPath: s.structuralPath, nodeType: 'section', ordinalWithinParent: 1,
      }),
      node_path:    `${sourceFile}#${s.structuralPath}`,
      source_file:  sourceFile,
      heading_path: s.headingPath,
      summary:      `${s.text} — ${inventoryLabel(entry.counts)}`,
      summary_kind: 'inventory',
      children:     entry.childPaths,
      chunking_model: 'skeleton-v1',
    };
  });

  // File node: title = first section heading or first prose line.
  const title = sections[0]?.text
    ?? String(nodes.find(n => n.text?.trim())?.text ?? '').split('\n')[0].slice(0, 80);
  const totals = {};
  for (const n of nodes) {
    if (n.nodeType === 'frontmatter') continue;
    totals[n.nodeType] = (totals[n.nodeType] ?? 0) + 1;
  }
  const fileNode = {
    point_kind:   POINT_KINDS.NAV,
    node_type:    'file',
    node_id: makeNodeId({
      collection: '', sourceFile, structuralPath: '', nodeType: 'file', ordinalWithinParent: 1,
    }),
    node_path:    `${sourceFile}#file`,
    source_file:  sourceFile,
    heading_path: [],
    summary:      `${title || sourceFile} — ${inventoryLabel(totals)}`,
    summary_kind: 'inventory',
    children:     sectionNodes.map(s => s.node_path),
    chunking_model: 'skeleton-v1',
  };

  const navPoints = [fileNode, ...sectionNodes];
  const json = {
    schema: 'semidex-file-skeleton/v1',
    inspect_only: true,                  // never a source of truth (design §14)
    source_file: sourceFile,
    generated_at: new Date().toISOString(),
    file: fileNode,
    sections: sectionNodes,
  };
  return { navPoints, json };
}

function splitDirParts(sourceFile) {
  const parts = String(sourceFile ?? '').split('/').filter(Boolean);
  parts.pop();
  return parts;
}

function directoryNodeId(dirPath) {
  return makeNodeId({
    collection: '',
    sourceFile: '',
    structuralPath: `dir/${dirPath}`,
    nodeType: 'directory',
    ordinalWithinParent: 1,
  });
}

function collectionNodeId() {
  return makeNodeId({
    collection: '',
    sourceFile: '',
    structuralPath: '',
    nodeType: 'collection',
    ordinalWithinParent: 1,
  });
}

function fileNodePath(sourceFile) {
  return `${sourceFile}#file`;
}

function dirNodePath(collection, dirPath) {
  return `${collection}#dir/${dirPath}`;
}

/**
 * Build directory navigation nodes from file nav summaries.
 * Directory nodes are collection-level navigation only: source_file is empty,
 * so they do not pollute source-file lists or PRUNE_STALE file accounting.
 *
 * @param {string} collection
 * @param {Array<{ source_file: string, summary: string }>} fileNodes
 * @returns {{ directoryNodes: object[], topChildren: string[] }}
 */
export function buildDirectoryNavPoints(collection, fileNodes = []) {
  const dirs = new Map(); // dirPath -> { files:Set, childDirs:Set }
  const ensure = (dirPath) => {
    if (!dirs.has(dirPath)) dirs.set(dirPath, { files: new Set(), childDirs: new Set() });
    return dirs.get(dirPath);
  };

  const rootFiles = [];
  const topDirs = new Set();

  for (const file of fileNodes) {
    const sourceFile = file.source_file ?? '';
    if (!sourceFile) continue;
    const parts = splitDirParts(sourceFile);
    if (parts.length === 0) {
      rootFiles.push(fileNodePath(sourceFile));
      continue;
    }

    let current = '';
    for (let i = 0; i < parts.length; i++) {
      const parent = current;
      current = current ? `${current}/${parts[i]}` : parts[i];
      ensure(current);
      if (parent) ensure(parent).childDirs.add(current);
      else topDirs.add(current);
    }
    ensure(current).files.add(sourceFile);
  }

  const collectionId = collectionNodeId();
  const directoryNodes = [...dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dirPath, entry]) => {
      const childDirs = [...entry.childDirs].sort((a, b) => a.localeCompare(b));
      const files = [...entry.files].sort((a, b) => a.localeCompare(b));
      const children = [
        ...childDirs.map(d => dirNodePath(collection, d)),
        ...files.map(fileNodePath),
      ];
      const directFileCount = files.length;
      const directDirCount = childDirs.length;
      const label = dirPath.split('/').at(-1) || dirPath;
      const summary = `${label} — ${directFileCount} file${directFileCount === 1 ? '' : 's'}, ${directDirCount} director${directDirCount === 1 ? 'y' : 'ies'}`;
      const parentPath = dirPath.includes('/') ? dirPath.slice(0, dirPath.lastIndexOf('/')) : '';
      return {
        point_kind: POINT_KINDS.NAV,
        node_type: 'directory',
        node_id: directoryNodeId(dirPath),
        node_path: dirNodePath(collection, dirPath),
        parent_id: parentPath ? directoryNodeId(parentPath) : collectionId,
        source_file: '',
        heading_path: dirPath.split('/'),
        summary,
        children,
        chunking_model: 'skeleton-v1',
      };
    });

  const topChildren = [
    ...[...topDirs].sort((a, b) => a.localeCompare(b)).map(d => dirNodePath(collection, d)),
    ...rootFiles.sort((a, b) => a.localeCompare(b)),
  ];
  return { directoryNodes, topChildren };
}

let _writeFailureLogged = false;

const INSPECT_ROOT = resolve(ROOT, '.tmp', 'semidex-inspect');

export function skeletonArtifactPathFor(collection, sourceFile) {
  const safeCollection = String(collection || 'unknown-collection').replace(/\\/g, '/');
  const safeFile       = String(sourceFile ?? 'unknown').replace(/\\/g, '/');
  const candidate = resolve(INSPECT_ROOT, safeCollection, `${safeFile}.skeleton.json`);
  // Guard: resolved path must stay inside INSPECT_ROOT — no ../.. escapes.
  if (!candidate.startsWith(INSPECT_ROOT + sep) && candidate !== INSPECT_ROOT) {
    throw new Error(
      `[skeleton] artifact path escapes inspect root: "${candidate}" not under "${INSPECT_ROOT}"`
    );
  }
  return candidate;
}

/**
 * Write the inspect artifact. Failure-safe: any I/O error is logged once per
 * process and swallowed — indexing never breaks because of an inspect file.
 */
export function writeFileSkeletonArtifact(json, { collection, sourceFile } = {}) {
  try {
    const path = skeletonArtifactPathFor(collection, sourceFile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8');
    return path;
  } catch (err) {
    if (!_writeFailureLogged) {
      _writeFailureLogged = true;
      process.stderr.write(`[skeleton] inspect artifact write failed (${err.message}) — continuing\n`);
    }
    return null;
  }
}

// Test hook.
export function _resetSkeletonIndexForTest() { _writeFailureLogged = false; }
