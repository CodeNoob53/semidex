// Tiny fetch client — every view module talks to /api/* exclusively through
// these helpers, never raw fetch() calls of their own. That single choke
// point is why the admin request header below only has to be added here.

// Sent on every non-safe (state-changing) request the dashboard makes.
//
// NOT a secret and NOT authentication — this file ships as plain static JS to
// every visitor, so the value is public and trivially forgeable by any
// non-browser client. Its security value is structural: a custom header is
// not CORS-safelisted, so a cross-origin page that tries to send it triggers
// a preflight, and this server answers no OPTIONS — the preflight fails and
// the real request is never dispatched. Defense in depth behind the router's
// Origin/Sec-Fetch-Site check (src/core/http/request-security.js).
const ADMIN_REQUEST_HEADERS = { 'X-Semidex-Request': 'admin' };

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
    headers: { 'Content-Type': 'application/json', ...ADMIN_REQUEST_HEADERS },
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
  const res = await fetch(path, { method: 'DELETE', headers: { ...ADMIN_REQUEST_HEADERS } });
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

export async function apiPatch(path, payload) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...ADMIN_REQUEST_HEADERS },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON is a bug upstream */ }
  if (!res.ok) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}
