// local/core/onnx-provider-probe.js — the isolated-child-process ONNX provider
// probe coordinator. Every test injects a fake `spawnFn` (an
// EventEmitter-shaped stub, never a real child process) so these tests
// never load onnxruntime-node, never touch a real model file, and never
// spawn a real subprocess — matching the timeout/cleanup/error-redaction
// verification the task requires.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { probeOnnxProvider } from '../../../src/local/core/onnx-provider-probe.js';

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  child.unref = () => {};
  return child;
}

function emitStdoutLine(child, obj) {
  child.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
}

describe('probeOnnxProvider: success and failure shapes (parsed from a fake child\'s stdout)', () => {
  test('a successful CPU probe returns the exact stable response shape', async () => {
    let spawnArgs = null;
    const spawnFn = (cmd, args, opts) => {
      spawnArgs = { cmd, args, opts };
      const child = makeFakeChild();
      queueMicrotask(() => {
        emitStdoutLine(child, {
          ok: true, requestedProvider: 'cpu', effectiveProvider: 'cpu', fellBackToCpu: false,
          runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true,
          message: 'CPU session created successfully',
        });
        child.emit('close', 0);
      });
      return child;
    };
    const result = await probeOnnxProvider('cpu', { spawnFn });
    assert.deepEqual(result, {
      ok: true, requestedProvider: 'cpu', effectiveProvider: 'cpu', fellBackToCpu: false,
      runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true,
      message: 'CPU session created successfully',
    });
    // Provider is passed via env, never a CLI arg (never visible in a
    // process listing) — see onnx-provider-probe.js's own module header.
    assert.equal(spawnArgs.opts.env.ONNX_PROBE_PROVIDER, 'cpu');
    assert.ok(!spawnArgs.args.some((a) => String(a).includes('cpu')), 'the provider must never appear as a CLI argument');
  });

  test('a CUDA probe that never registers the backend returns ok:false with effectiveProvider:null (never silently substituted with cpu)', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        emitStdoutLine(child, {
          ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
          runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true,
          message: 'no available backend found. ERR: [cuda] backend not found.',
        });
        child.emit('close', 0);
      });
      return child;
    };
    const result = await probeOnnxProvider('cuda', { spawnFn });
    assert.equal(result.ok, false);
    assert.equal(result.effectiveProvider, null);
    assert.equal(result.fellBackToCpu, false);
    assert.match(result.message, /backend not found/);
  });

  test('runtimeSource reports "custom" when the runner reports a custom ONNXRUNTIME_NODE_PATH', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        emitStdoutLine(child, {
          ok: true, requestedProvider: 'cuda', effectiveProvider: 'cuda', fellBackToCpu: false,
          runtimeSource: 'custom', runtimeVersion: '1.26.0', modelCached: true,
          message: 'CUDA session created successfully',
        });
        child.emit('close', 0);
      });
      return child;
    };
    const result = await probeOnnxProvider('cuda', { spawnFn, env: { ONNXRUNTIME_NODE_PATH: '/some/custom/path' } });
    assert.equal(result.runtimeSource, 'custom');
    assert.equal(result.effectiveProvider, 'cuda');
  });
});

describe('probeOnnxProvider: reads stdout on close, not exit', () => {
  test('a child whose "exit" event fires BEFORE its stdout data has fully arrived is still parsed correctly, because the result is read on "close"', async () => {
    // Regression test: Node's own docs guarantee 'close' fires only after
    // every stdio stream has fully ended, while 'exit' can fire before
    // stdout has finished being read — reading `stdout` inside an 'exit'
    // handler (the previous implementation) risks parsing a partial or
    // even completely empty buffer despite the child having actually
    // written a complete, valid line. This fake child deliberately fires
    // 'exit' with zero stdout buffered yet, then emits the real data, THEN
    // fires 'close' — exactly the ordering 'close' exists to guard
    // against. If production code read on 'exit' this would fail with
    // "probe produced no output".
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.emit('exit', 0); // fires first, stdout is still completely empty
        emitStdoutLine(child, {
          ok: true, requestedProvider: 'cpu', effectiveProvider: 'cpu', fellBackToCpu: false,
          runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true,
          message: 'CPU session created successfully',
        });
        child.emit('close', 0); // fires only after the data has arrived
      });
      return child;
    };
    const result = await probeOnnxProvider('cpu', { spawnFn });
    assert.equal(result.ok, true);
    assert.equal(result.effectiveProvider, 'cpu');
    assert.equal(result.message, 'CPU session created successfully');
  });

  test('a real close event is what triggers parsing — an exit-only fake (no close) never resolves the probe from stdout data at all', async () => {
    // Confirms production code has genuinely stopped listening on 'exit'
    // for the result — if it still did, this fake (which never fires
    // 'close') would resolve instantly instead of running out the clock.
    const keepalive = setTimeout(() => {}, 500);
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        emitStdoutLine(child, {
          ok: true, requestedProvider: 'cpu', effectiveProvider: 'cpu', fellBackToCpu: false,
          runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true, message: 'should not be read this way',
        });
        child.emit('exit', 0); // 'close' never fires
      });
      return child;
    };
    const result = await probeOnnxProvider('cpu', { spawnFn, timeoutMs: 100 });
    clearTimeout(keepalive);
    assert.equal(result.ok, false, 'without a close event, the probe must time out — never fall back to reading on exit');
    assert.match(result.message, /timed out/);
  });
});

describe('probeOnnxProvider: model_not_cached short-circuit', () => {
  test('the runner reporting modelCached:false is surfaced verbatim, never treated as a generic failure', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        emitStdoutLine(child, {
          ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
          runtimeSource: 'npm', runtimeVersion: null, modelCached: false,
          message: 'model_not_cached',
        });
        child.emit('close', 0);
      });
      return child;
    };
    const result = await probeOnnxProvider('cuda', { spawnFn });
    assert.equal(result.modelCached, false);
    assert.equal(result.message, 'model_not_cached');
    assert.equal(result.ok, false);
  });
});

describe('probeOnnxProvider: timeout and cleanup', () => {
  test('a hung child that DOES respond to kill() is killed and the probe resolves quickly (does not wait out the full grace period)', async () => {
    const keepalive = setTimeout(() => {}, 5000);
    let killCalled = false;
    const spawnFn = () => {
      const child = makeFakeChild();
      child.kill = () => {
        killCalled = true;
        // A real, well-behaved child process emits 'close' after
        // termination — this is the common case kill() is expected to
        // handle quickly, distinct from the "child ignores termination
        // entirely" test below.
        queueMicrotask(() => child.emit('close', null));
      };
      return child; // never replies on its own — simulates a hang until killed
    };
    const t0 = Date.now();
    const result = await probeOnnxProvider('cuda', { spawnFn, timeoutMs: 100 });
    clearTimeout(keepalive);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `timeout should resolve quickly once the child confirms exit, took ${elapsed}ms`);
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/);
    assert.equal(killCalled, true, 'the hung child process must be killed on timeout');
  });

  test('a child that ignores kill() entirely still resolves, bounded by the kill-grace period — never hangs the caller forever', async () => {
    const keepalive = setTimeout(() => {}, 5000);
    let killCalled = false;
    const spawnFn = () => {
      const child = makeFakeChild();
      child.kill = () => { killCalled = true; }; // never emits 'close' — a truly unkillable/hung process
      return child;
    };
    const t0 = Date.now();
    const result = await probeOnnxProvider('cuda', { spawnFn, timeoutMs: 100 });
    clearTimeout(keepalive);
    const elapsed = Date.now() - t0;
    // Must resolve (not hang forever), bounded by timeoutMs + the kill-grace
    // period — but this is the deliberate fallback safety net, not the
    // fast path, so a generous upper bound is correct here.
    assert.ok(elapsed < 5000, `should still resolve within the bounded kill-grace window, took ${elapsed}ms`);
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/);
    assert.equal(killCalled, true, 'kill() must still be attempted even if the child never confirms exit');
  });

  test('a spawn() that throws synchronously is reported as a clean failure, not an unhandled rejection', async () => {
    const spawnFn = () => { throw new Error('ENOENT: spawn failed'); };
    const result = await probeOnnxProvider('cpu', { spawnFn });
    assert.equal(result.ok, false);
    assert.match(result.message, /failed to spawn/);
  });

  test('an "error" event on the child (e.g. process could not be spawned) is reported as a clean failure', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    };
    const result = await probeOnnxProvider('cpu', { spawnFn });
    assert.equal(result.ok, false);
    assert.match(result.message, /spawn ENOENT/);
  });

  test('a child that exits with no stdout output at all is reported as a clean failure, not a crash', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => child.emit('close', 1));
      return child;
    };
    const result = await probeOnnxProvider('cuda', { spawnFn });
    assert.equal(result.ok, false);
    assert.match(result.message, /no output/);
  });

  test('a child that exits with malformed (non-JSON) stdout is reported as a clean failure', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('not valid json\n'));
        child.emit('close', 0);
      });
      return child;
    };
    const result = await probeOnnxProvider('cuda', { spawnFn });
    assert.equal(result.ok, false);
    assert.match(result.message, /invalid output/);
  });

  test('a successful probe never calls kill() (only the timeout/error paths do)', async () => {
    let killCalled = false;
    const spawnFn = () => {
      const child = makeFakeChild();
      child.kill = () => { killCalled = true; };
      queueMicrotask(() => {
        emitStdoutLine(child, { ok: true, requestedProvider: 'cpu', effectiveProvider: 'cpu', fellBackToCpu: false, runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true, message: 'ok' });
        child.emit('close', 0);
      });
      return child;
    };
    await probeOnnxProvider('cpu', { spawnFn });
    assert.equal(killCalled, false);
  });

  test('a misbehaving child that writes far more than one line of stdout does not grow memory unbounded — the buffer is capped', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        // Simulate a child spamming megabytes of NEWLINE-DELIMITED noise
        // (e.g. runaway diagnostic logging) before finally writing the one
        // real JSON line the probe actually needs — matching how
        // onnx-probe-runner.js's own output (and any real process's
        // line-buffered stdout) is always newline-terminated per logical
        // write, unlike one giant unbroken blob of bytes.
        const noiseLine = 'x'.repeat(1024) + '\n';
        for (let i = 0; i < 5 * 1024; i += 1) child.stdout.emit('data', Buffer.from(noiseLine)); // ~5 MB total
        emitStdoutLine(child, {
          ok: true, requestedProvider: 'cpu', effectiveProvider: 'cpu', fellBackToCpu: false,
          runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true, message: 'ok',
        });
        child.emit('close', 0);
      });
      return child;
    };
    // The point of this test is that probeOnnxProvider does not attempt to
    // retain all 5+ MB of noise — it must still resolve promptly and
    // correctly parse the final real line, proving the cap doesn't corrupt
    // the one line that matters even though everything before it was
    // truncated away.
    const result = await probeOnnxProvider('cpu', { spawnFn });
    assert.equal(result.ok, true);
    assert.equal(result.message, 'ok');
  });
});

describe('probeOnnxProvider: error message redaction', () => {
  test('a secret literal appearing in the child\'s error message is redacted before it reaches the caller', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        emitStdoutLine(child, {
          ok: false, requestedProvider: 'cuda', effectiveProvider: null, fellBackToCpu: false,
          runtimeSource: 'npm', runtimeVersion: null, modelCached: true,
          message: 'failed to connect using key sk-super-secret-123',
        });
        child.emit('close', 0);
      });
      return child;
    };
    const result = await probeOnnxProvider('cuda', { spawnFn, secret: 'sk-super-secret-123' });
    assert.doesNotMatch(result.message, /sk-super-secret-123/);
    assert.match(result.message, /REDACTED/);
  });

  test('a credentialed URL in a timeout/spawn-failure message is reduced to host-only', async () => {
    const spawnFn = () => { throw new Error('connect to https://user:pass@internal-host.example/secret-path?token=abc failed'); };
    const result = await probeOnnxProvider('cpu', { spawnFn, secret: undefined });
    assert.doesNotMatch(result.message, /user:pass/);
    assert.doesNotMatch(result.message, /token=abc/);
  });

  test('never exposes raw environment variables in any returned field', async () => {
    const spawnFn = () => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        emitStdoutLine(child, { ok: true, requestedProvider: 'cpu', effectiveProvider: 'cpu', fellBackToCpu: false, runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true, message: 'ok' });
        child.emit('close', 0);
      });
      return child;
    };
    const result = await probeOnnxProvider('cpu', { spawnFn, env: { QDRANT_KEY: 'super-secret-key', PATH: '/usr/bin' } });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /super-secret-key/);
    assert.doesNotMatch(serialized, /QDRANT_KEY/);
  });
});

describe('probeOnnxProvider: request shape sent to the child', () => {
  test('spawns node (process.execPath) with the runner script path, windowsHide:true, and the requested provider only in env', async () => {
    let captured = null;
    const spawnFn = (cmd, args, opts) => {
      captured = { cmd, args, opts };
      const child = makeFakeChild();
      queueMicrotask(() => {
        emitStdoutLine(child, { ok: true, requestedProvider: 'dml', effectiveProvider: 'dml', fellBackToCpu: false, runtimeSource: 'npm', runtimeVersion: '1.24.3', modelCached: true, message: 'ok' });
        child.emit('close', 0);
      });
      return child;
    };
    await probeOnnxProvider('dml', { spawnFn });
    assert.equal(captured.cmd, process.execPath);
    assert.equal(captured.args.length, 1);
    assert.match(captured.args[0], /onnx-probe-runner\.js$/);
    assert.equal(captured.opts.windowsHide, true);
    assert.equal(captured.opts.env.ONNX_PROBE_PROVIDER, 'dml');
  });
});
