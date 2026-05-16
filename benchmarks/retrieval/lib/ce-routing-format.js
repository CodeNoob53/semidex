// Shared formatting helpers for CE routing benchmarks.

export function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
}

export function f3(v)      { return v == null ? '   n/a' : v.toFixed(3); }
export function pct(v)     { return v == null ? '   n/a' : `${(v*100).toFixed(1)}%`; }
export function pad(s, n)  { return String(s).padEnd(n); }
export function lpad(s, n) { return String(s).padStart(n); }

export function makeSep(char, n) { return char.repeat(n); }
