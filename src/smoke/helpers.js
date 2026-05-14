import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export const CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../config.json');

export const SMOKE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Temporarily replace config.json, run fn(), restore.
export async function withConfig(tempConfig, fn) {
  const original = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf-8') : null;
  writeFileSync(CONFIG_PATH, JSON.stringify(tempConfig, null, 2), 'utf-8');
  try { await fn(); } finally {
    if (original !== null) writeFileSync(CONFIG_PATH, original, 'utf-8');
    else rmSync(CONFIG_PATH, { force: true });
  }
}
