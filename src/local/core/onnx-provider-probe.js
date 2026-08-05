// Truthful ONNX provider probe — runs local/core/onnx-probe-runner.js in an
// ISOLATED CHILD PROCESS, never in this (caller's) process. Used by
// npm run doctor and the Admin API's POST /api/system/onnx-probe endpoint;
// neither of those callers loads onnxruntime-node (default or custom
// build) themselves merely to report status.
//
// Loads the runtime the SAME way local/core/onnx-embed.js does — via
// local/core/onnx-runtime.js's resolveOnnxRuntimeModule()/loadOnnxRuntime(),
// honoring a configured ONNXRUNTIME_NODE_PATH — but that resolution
// actually happens inside the spawned child (onnx-probe-runner.js), so
// this file itself never imports onnxruntime-node directly.
//
// Uses ONLY the requested provider during verification — never silently
// appends 'cpu' to a CUDA probe. Never downloads the model. Has a timeout
// and cleanly terminates the child process on expiry, on early stdout
// close, or on any other failure path. Reads stdout on the child's 'close'
// event — NOT 'exit' — since 'exit' can fire before Node has finished
// draining the last buffered stdout chunk, which reproducibly caused a
// real "probe produced no output" false negative even when the child had
// actually written a complete, valid result. On timeout, kill() is
// followed by a bounded wait for that same 'close' event (not an
// optimistic "kill() was called, assume it worked" resolve) — the child is
// never left running past that wait after this function returns, except
// in the one edge case where the process ignores termination entirely for
// longer than that bounded wait. stdout/stderr are bounded to avoid
// unbounded memory growth from a misbehaving child.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitiseErrorMessage } from '../../core/doctor-checks.js';

const RUNNER_PATH = fileURLToPath(new URL('./onnx-probe-runner.js', import.meta.url));
const DEFAULT_TIMEOUT_MS = 30_000;
// Grace period after kill() to actually observe the child's 'close' event
// (fires once the process has exited AND all stdio streams have ended)
// before giving up and resolving anyway — bounds the wait so a child that
// ignores termination entirely cannot hang the probe forever, while still
// preferring a real, observed completion over an optimistic "kill() was
// called" assumption.
const KILL_GRACE_MS = 3_000;
// Caps unbounded stdout/stderr accumulation from a misbehaving child that
// writes far more than the single expected JSON line — only the last line
// is ever used (see the 'close' handler below), and stderr is only ever
// included truncated in an error message, so there is no reason to buffer
// more than a small bounded window of either stream.
const MAX_BUFFERED_BYTES = 64 * 1024;

function redact(text, secret) {
  return sanitiseErrorMessage(String(text ?? ''), secret);
}

/**
 * Runs the ONNX provider probe in an isolated child process.
 *
 * @param {'cpu'|'dml'|'cuda'} provider — the execution provider to verify.
 * @param {{
 *   env?: NodeJS.ProcessEnv,        // base env for the child (e.g. a
 *                                   // pre-write-back osEnv snapshot);
 *                                   // ONNX_PROBE_PROVIDER is always
 *                                   // overridden on top of this.
 *   spawnFn?: typeof spawn,         // injectable for tests — never a real
 *                                   // child process in a unit test.
 *   timeoutMs?: number,
 *   secret?: string,                // redacted from any error text
 *                                   // (e.g. QDRANT_KEY) before it can
 *                                   // reach a caller/response.
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean, requestedProvider: string, effectiveProvider: string|null,
 *   fellBackToCpu: boolean, runtimeSource: 'npm'|'custom'|null,
 *   runtimeVersion: string|null, modelCached: boolean|null, message: string,
 * }>}
 */
export async function probeOnnxProvider(provider, {
  env = process.env, spawnFn = spawn, timeoutMs = DEFAULT_TIMEOUT_MS, secret,
} = {}) {
  const childEnv = { ...env, ONNX_PROBE_PROVIDER: provider };

  return new Promise((resolveProbe) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer = null;
    let killGraceTimer = null;
    // Set the moment killAndWait() calls kill() — distinguishes "the child
    // exited because we deliberately killed it (timeout)" from "the child
    // exited on its own" so the 'exit' handler below reports the actual
    // timeout reason instead of misreporting a killed process as if it had
    // simply produced no output.
    let killReason = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      resolveProbe(result);
    };

    const failResult = (message) => ({
      ok: false,
      requestedProvider: provider,
      effectiveProvider: null,
      fellBackToCpu: false,
      runtimeSource: null,
      runtimeVersion: null,
      modelCached: null,
      message: redact(message, secret),
    });

    let child;
    try {
      child = spawnFn(process.execPath, [RUNNER_PATH], { env: childEnv, windowsHide: true });
    } catch (err) {
      finish(failResult(`failed to spawn probe process: ${err.message}`));
      return;
    }

    // Waits (bounded by KILL_GRACE_MS) for the child's real 'close' event
    // before resolving, rather than resolving the instant kill() is
    // called — kill() only requests termination, it does not confirm the
    // process is actually gone. If the child ignores termination entirely,
    // this still gives up and resolves after the grace period rather than
    // hanging the caller forever; the child may briefly outlive the
    // returned promise in that one edge case, but every other path (normal
    // exit, spawn error, 'error' event) waits for a real, observed close.
    const killAndWait = (failMessage) => {
      if (settled) return;
      killReason = failMessage;
      try { child.kill(); } catch { /* best effort */ }
      killGraceTimer = setTimeout(() => finish(failResult(failMessage)), KILL_GRACE_MS);
      if (typeof killGraceTimer.unref === 'function') killGraceTimer.unref();
    };

    timer = setTimeout(() => {
      killAndWait(`probe timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    // Keeps only the TAIL of the stream, never the head — the only thing
    // ever read back out is the LAST line (stdout) or a short trailing
    // slice (stderr, in an error message). A head-truncating cap would
    // silently discard the one real JSON line if it happened to arrive
    // after enough noise to fill the buffer; keeping the tail guarantees
    // the most recent (and therefore most relevant) output survives
    // regardless of how much a misbehaving child writes before it.
    const appendBounded = (current, chunk) => (current + chunk).slice(-MAX_BUFFERED_BYTES);
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk.toString('utf-8')); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk.toString('utf-8')); });

    child.on('error', (err) => {
      finish(failResult(`probe process error: ${err.message}`));
    });

    // 'close' — NOT 'exit' — is the event to read stdout on: Node's own
    // docs guarantee 'close' fires only after every stdio stream has fully
    // ended, while 'exit' can fire before stdout has finished being read
    // (the child process object and its underlying OS process can exit
    // before Node has drained the last buffered chunk from the pipe).
    // Reading `stdout` inside an 'exit' handler risks parsing a partial (or
    // in this codebase's case, reproducibly EMPTY) buffer even though the
    // child actually wrote a complete, valid JSON line — 'close' avoids
    // that race entirely.
    child.on('close', (code) => {
      if (settled) return;
      // This exit is the direct result of our own kill() (timeout, or a
      // future caller of killAndWait) — report the actual reason, not a
      // generic "produced no output," even if the child happened to exit
      // before the kill-grace timer elapsed.
      if (killReason) { finish(failResult(killReason)); return; }
      const line = stdout.trim().split('\n').pop() ?? '';
      if (!line) {
        finish(failResult(`probe produced no output (exit code ${code})${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(failResult(`probe produced invalid output (exit code ${code})`));
        return;
      }
      finish({
        ok: Boolean(parsed.ok),
        requestedProvider: parsed.requestedProvider ?? provider,
        effectiveProvider: parsed.effectiveProvider ?? null,
        fellBackToCpu: Boolean(parsed.fellBackToCpu),
        runtimeSource: parsed.runtimeSource ?? null,
        runtimeVersion: parsed.runtimeVersion ?? null,
        modelCached: parsed.modelCached ?? null,
        message: redact(parsed.message ?? '', secret),
      });
    });
  });
}
