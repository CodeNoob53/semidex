import { readFileSync, statSync, readdirSync, existsSync } from 'fs';
import { join, extname } from 'path';

export const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.docx', '.odt', '.rtf', '.epub', '.html', '.htm', '.pdf']);

export function loadIgnorePatterns(dir) {
  const ignoreFile = join(dir, '.semidexignore');
  if (!existsSync(ignoreFile)) return [];
  return readFileSync(ignoreFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

export function isIgnored(entryName, patterns) {
  return patterns.some(p => entryName === p.replace(/\/$/, '') || entryName === p);
}

export function collectFiles(targetPath, ignorePatterns) {
  const stat = statSync(targetPath);
  if (stat.isFile()) return SUPPORTED_EXTENSIONS.has(extname(targetPath).toLowerCase()) ? [targetPath] : [];
  const patterns = ignorePatterns ?? loadIgnorePatterns(targetPath);
  const files = [];
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (isIgnored(entry.name, patterns)) continue;
    const full = join(targetPath, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full, patterns));
    else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}
