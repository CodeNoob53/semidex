// Pure string-formatting helpers for skeleton-node display labels. Kept
// neutral (not part of sidebar.js) specifically so file-view.js can import
// nodeDisplayLabel() without creating a file-view <-> sidebar coupling —
// sidebar.js never needs to import from file-view.js in return.

/**
 * Human-readable label for a skeleton node, per node type — node_path is a
 * synthetic key ("<file>#file", "<collection>#dir/<path>",
 * "<file>#<slug>") meant for API lookups, not for display; showing it
 * directly used to render literal fragments like "file" for every file node
 * (the tail after the "#" in "pitch-en.md#file" is just the string "file").
 * node_path/node_id remain available only via the tooltip (see sidebarNodeRow).
 *   - file:      basename of sourceFile (or the node_path's file segment)
 *   - section:   last entry of heading_path, falling back to summary/node_path
 *   - directory: last path segment of the directory's own path
 *   - anything else: shortLabel(node_path) as before
 */
export function nodeDisplayLabel(n) {
  if (n.nodeType === 'file') {
    const src = n.sourceFile || String(n.nodePath ?? '').replace(/#file$/, '');
    return basename(src) || shortLabel(n.nodePath ?? n.nodeId ?? '?');
  }
  if (n.nodeType === 'section') {
    const last = Array.isArray(n.headingPath) ? n.headingPath.at(-1) : null;
    if (last) return shortLabel(last);
    return shortLabel(n.summary || n.nodePath || n.nodeId || '?');
  }
  if (n.nodeType === 'directory') {
    // node_path is "<collection>#dir/<dirPath>" where dirPath may itself
    // contain "/" for nested directories — the display name is just the
    // last segment of dirPath, not the whole nested path.
    const dirPath = String(n.nodePath ?? '').replace(/^[^#]*#dir\//, '');
    return basename(dirPath) || shortLabel(n.nodePath ?? n.nodeId ?? '?');
  }
  return shortLabel(n.nodePath ?? n.nodeId ?? '?');
}

export function basename(path) {
  return String(path ?? '').split('/').filter(Boolean).at(-1) ?? '';
}

export function shortLabel(path) {
  const tail = String(path).split('/').filter(Boolean).slice(-1)[0] ?? path;
  const clean = tail.replace(/^[^#]*#/, ''); // drop "collection#" prefix if present
  return clean.length > 46 ? clean.slice(0, 43) + '…' : clean;
}
