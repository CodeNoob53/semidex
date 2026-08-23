// packages/lite/bin/semidex-lite.js — the real `semidex-lite serve`/`key`
// entry points. This is a self-executing CLI script (its command switch
// runs unconditionally on import, based on process.argv), not an exported
// composition function, so it cannot be invoked directly with injected
// fakes in a test — the same shape src/admin/bootstrap.js is in (see
// tests/unit/admin/bootstrap.test.js's own header comment). Its OWN
// SIGINT/SIGTERM handler cannot be exercised by actually sending an OS
// signal to a spawned child process either: this test suite runs on
// Windows, where OS signal delivery to a child process is not reliably
// emulated by Node (child.kill('SIGINT') on Windows does not reliably
// invoke the child's own `process.on('SIGINT', ...)` handler the way it
// does on POSIX) — a spawn+signal test here would be flaky/meaningless on
// this platform, not a stronger proof.
//
// So this file proves the wiring STRUCTURALLY (source inspection, exactly
// like bootstrap.test.js's own convention), while the actual BEHAVIOR of
// the mechanism these handlers call — "auditSink.close() makes a queued
// event durable before it resolves" — is proven directly, with real
// disk I/O and no signal emulation needed, in
// tests/unit/lite/serve-lite.test.js's "audit sink shutdown/flush contract"
// describe block.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../../packages/lite/bin/semidex-lite.js', import.meta.url), 'utf-8');

describe('bin/semidex-lite.js — serve shutdown wiring', () => {
  it('captures auditSink from startLite()\'s return value', () => {
    assert.match(src, /const\s*\{\s*server,\s*host,\s*port,\s*auditSink\s*\}\s*=\s*await startLite\(/);
  });

  it('the shutdown handler is idempotent (guards against SIGTERM+SIGINT both firing)', () => {
    const shutdownFn = src.match(/const shutdown = \(\) => \{([\s\S]*?)\n\s*\};/);
    assert.ok(shutdownFn, 'expected a `const shutdown = () => { ... }` handler');
    assert.match(shutdownFn[1], /if\s*\(shuttingDown\)\s*return;/);
    assert.match(shutdownFn[1], /shuttingDown\s*=\s*true;/);
  });

  it('awaits auditSink.close() inside server.close()\'s own callback, before process.exit()', () => {
    const shutdownFn = src.match(/const shutdown = \(\) => \{([\s\S]*?)\n\s*\};/)[1];
    const serverCloseIdx = shutdownFn.indexOf('server.close(');
    const auditCloseIdx = shutdownFn.indexOf('auditSink.close()');
    const exitIdx = shutdownFn.indexOf('process.exit(0)');
    assert.ok(serverCloseIdx >= 0, 'expected a server.close(...) call');
    assert.ok(auditCloseIdx > serverCloseIdx, 'auditSink.close() must run inside/after server.close()\'s own callback');
    assert.ok(exitIdx > auditCloseIdx, 'process.exit(0) must come after auditSink.close(), not race it');
  });

  it('registers the same shutdown handler for both SIGTERM and SIGINT', () => {
    assert.match(src, /process\.on\('SIGTERM',\s*shutdown\);/);
    assert.match(src, /process\.on\('SIGINT',\s*shutdown\);/);
  });
});

describe('bin/semidex-lite.js — key CLI edition tagging', () => {
  it('the `key` subcommand resolves its sync audit sink with edition: \'lite\'', () => {
    const keyBlockStart = src.indexOf("case 'key':");
    const keyBlock = src.slice(keyBlockStart, src.indexOf('break;', keyBlockStart) + 10);
    assert.match(keyBlock, /resolveAuditSink\(\{\s*sync:\s*true,\s*edition:\s*'lite'\s*\}\)/);
  });
});
