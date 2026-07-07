// Tiny fetch client — every view module talks to /api/* exclusively through
// these three helpers, never raw fetch() calls of their own.

export async function api(path) {
  const res = await fetch(path);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON is a bug upstream */ }
  if (!res.ok) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON is a bug upstream */ }
  if (!res.ok) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE' });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON is a bug upstream */ }
  if (!res.ok) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}
