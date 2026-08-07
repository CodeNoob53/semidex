// Lightweight per-file phase timer. Only active when INDEX_PROFILE=1.
// Zero overhead when disabled: mark() and report() are no-ops.
//
// Usage:
//   const p = new Profiler();
//   p.mark('chunk');
//   ...
//   p.mark('context');
//   p.report({ chunksIn, chunksOut, tokensEst });

export class Profiler {
  constructor() {
    this.enabled = process.env.INDEX_PROFILE === '1';
    this.marks = [];   // [{ label, t }]
    this.t0 = this.enabled ? Date.now() : 0;
  }

  mark(label) {
    if (!this.enabled) return;
    this.marks.push({ label, t: Date.now() });
  }

  // Mark with explicit start time — for parallel branches where wall time
  // should be measured from branch start, not from the previous sequential mark.
  markAt(label, startMs) {
    if (!this.enabled) return;
    this.marks.push({ label, t: Date.now(), startOverride: startMs });
  }

  report({ chunksIn, chunksOut, tokensEst }) {
    if (!this.enabled) return;
    const totalMs = Date.now() - this.t0;

    const phases = [];
    let prev = this.t0;
    for (const { label, t, startOverride } of this.marks) {
      phases.push({ label, ms: t - (startOverride ?? prev) });
      prev = t;
    }

    const PAD_LABEL = 14;
    const rows = phases.map(p =>
      `    ${p.label.padEnd(PAD_LABEL)} ${String(p.ms).padStart(6)} ms`
    ).join('\n');

    const cps = chunksOut > 0 && totalMs > 0
      ? (chunksOut / (totalMs / 1000)).toFixed(1)
      : '—';

    console.log(
      `  [profile] ${chunksIn}→${chunksOut} chunks, ~${tokensEst} tokens\n` +
      rows + '\n' +
      `    ${'total'.padEnd(PAD_LABEL)} ${String(totalMs).padStart(6)} ms  (${cps} chunks/s)`
    );
  }
}
