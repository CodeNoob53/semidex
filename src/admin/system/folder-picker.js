// Native folder picker for POST /api/system/pick-folder. Windows-only MVP:
// spawns powershell.exe with a small inline script that opens
// System.Windows.Forms.FolderBrowserDialog and prints the chosen path to
// stdout (nothing if the user cancels) — same "spawn a real process, don't
// add a native dependency" approach already used for the indexer child
// process in src/admin/jobs/registry.js. No Electron/native-module
// dependency added just for this one dialog.
import { spawn as nodeSpawn } from 'node:child_process';
import { platform as osPlatform } from 'node:os';

// -NoProfile/-NonInteractive: don't load the user's PS profile or prompt
// for anything else. STA is required for WinForms dialogs.
//
// [Console]::OutputEncoding is forced to UTF-8 before writing the path.
// Without it, Windows PowerShell 5.1 writes console output using the
// *active console codepage* (e.g. CP866 on a Cyrillic-locale Windows
// install), not UTF-8 — a path like "Тема 13. ..." comes back as mojibake
// bytes that decode() below (which always assumes UTF-8) turns into
// garbage, and downstream fs calls on that garbled path then fail with
// ENOENT. Setting OutputEncoding makes PowerShell itself emit real UTF-8
// bytes regardless of the console's codepage, so the Node-side utf-8
// decode is always correct.
const PICKER_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder to index'
$dialog.ShowNewFolderButton = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`.trim();

const DEFAULT_TIMEOUT_MS = 120_000; // a human choosing a folder can take a while; not a network call

/**
 * Open a native folder-picker dialog and resolve with the chosen path.
 *
 * @param {{ spawnFn?: typeof nodeSpawn, platform?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ path: string | null, cancelled: boolean }>}
 * @throws {Error} with `.code` set:
 *   - 'UNSUPPORTED_PLATFORM' — not running on Windows (win32)
 *   - 'PICKER_UNAVAILABLE'   — powershell.exe could not be spawned (ENOENT etc.)
 *   - 'PICKER_TIMEOUT'       — dialog was left open past timeoutMs
 *   - 'PICKER_FAILED'        — powershell exited non-zero for another reason
 */
export function pickFolder({ spawnFn = nodeSpawn, platform = osPlatform(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (platform !== 'win32') {
    const err = new Error('Native folder picker is only available on Windows.');
    err.code = 'UNSUPPORTED_PLATFORM';
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawnFn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PICKER_SCRIPT,
      ]);
    } catch (err) {
      const wrapped = new Error(`Could not start the folder picker: ${err.message}`);
      wrapped.code = 'PICKER_UNAVAILABLE';
      reject(wrapped);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      const err = new Error('Folder picker timed out.');
      err.code = 'PICKER_TIMEOUT';
      reject(err);
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const wrapped = new Error(`Could not start the folder picker: ${err.message}`);
      wrapped.code = 'PICKER_UNAVAILABLE';
      reject(wrapped);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(`Folder picker exited with code ${code}: ${stderr.trim() || '(no output)'}`);
        err.code = 'PICKER_FAILED';
        reject(err);
        return;
      }
      const path = stdout.trim();
      resolve(path ? { path, cancelled: false } : { path: null, cancelled: true });
    });
  });
}
