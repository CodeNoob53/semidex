import { readFileSync, statSync, readdirSync, existsSync } from 'fs';
import { join, extname, relative, matchesGlob } from 'path';

export const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.docx', '.odt', '.rtf', '.epub', '.html', '.htm', '.pdf']);

export function loadIgnorePatterns(dir) {
  const ignoreFile = join(dir, '.semidexignore');
  if (!existsSync(ignoreFile)) return [];
  return readFileSync(ignoreFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

// Returns true if relPath (relative to collection root, forward slashes) matches any pattern.
// Patterns without '/' match against the basename only (like .gitignore).
// Patterns with '/' or glob wildcards are matched against the full relative path.
export function isIgnored(relPath, patterns) {
  const name = relPath.includes('/') ? relPath.slice(relPath.lastIndexOf('/') + 1) : relPath;
  return patterns.some(p => {
    const pat = p.replace(/\/$/, '');
    if (!pat.includes('/') && !pat.includes('*')) return name === pat;
    return matchesGlob(relPath, pat) || matchesGlob(name, pat);
  });
}

export function collectFiles(targetPath, ignorePatterns, _root) {
  const stat = statSync(targetPath);
  if (stat.isFile()) return SUPPORTED_EXTENSIONS.has(extname(targetPath).toLowerCase()) ? [targetPath] : [];
  const root = _root ?? targetPath;
  const patterns = ignorePatterns ?? loadIgnorePatterns(targetPath);
  const files = [];
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(targetPath, entry.name);
    const rel  = relative(root, full).replace(/\\/g, '/');
    if (isIgnored(rel, patterns)) continue;
    if (entry.isDirectory()) files.push(...collectFiles(full, patterns, root));
    else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}
