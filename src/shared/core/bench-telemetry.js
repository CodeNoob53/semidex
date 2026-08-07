import { appendFileSync } from 'fs';

// Opt-in benchmark instrumentation. No I/O when disabled (negligible
// overhead — one process.env read per call) unless
// SEMIDEX_BENCH_TELEMETRY_PATH is set AT THE TIME OF THE CALL (read fresh
// every call, never cached at import time — a benchmark harness sets this
// per-spawn via child-process env, and any import-time caching could see a
// stale/absent value depending on module load order). Inactive in normal
// runtime unless the benchmark-only SEMIDEX_BENCH_TELEMETRY_PATH env var
// is explicitly set — the emitTelemetry() calls ARE present inline in
// real production code paths (qdrantCall, embedForIndexCloud,
// runHybridSearch), they are simply no-ops for every real user, admin, or
// MCP invocation that never sets this var.
//
// Node is single-threaded and appendFileSync is a blocking syscall, so
// concurrent in-flight Promises (e.g. under PIPELINE_MODE=1) can never
// have two appendFileSync calls physically overlap — each emitted event
// is a complete, atomic JSONL line. The benchmark harness assigns a fresh
// path per profile run, so this process is always the file's sole writer.
export function emitTelemetry(event) {
  const path = process.env.SEMIDEX_BENCH_TELEMETRY_PATH;
  if (!path) return;
  appendFileSync(path, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
}
