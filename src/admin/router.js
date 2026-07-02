// Tiny method+path router. No framework, no regex path-to-regexp dependency
// — segment-by-segment matching is enough for the handful of routes this API
// needs. Route params (":name") are URL-decoded before being handed to
// handlers, so a handler never has to think about percent-encoding.
import { sendError, HttpError } from './http.js';

/**
 * @typedef {(ctx: { req, res, params: Object, query: URLSearchParams }) => Promise<void>|void} RouteHandler
 */

export function createRouter() {
  const routes = []; // { method, segments: string[], handler }

  function add(method, path, handler) {
    const segments = path.split('/').filter(Boolean);
    routes.push({ method, segments, handler });
  }

  function match(method, pathname) {
    const reqSegments = pathname.split('/').filter(Boolean);
    let pathMatchedForOtherMethod = false;

    for (const route of routes) {
      if (route.segments.length !== reqSegments.length) continue;

      const params = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const routeSeg = route.segments[i];
        const reqSeg = reqSegments[i];
        if (routeSeg.startsWith(':')) {
          params[routeSeg.slice(1)] = decodeURIComponent(reqSeg);
        } else if (routeSeg !== reqSeg) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      if (route.method !== method) {
        pathMatchedForOtherMethod = true;
        continue;
      }
      return { handler: route.handler, params };
    }

    return pathMatchedForOtherMethod ? { methodNotAllowed: true } : null;
  }

  async function handleRequest(req, res) {
    // Wraps the whole request — not just the handler call — because both
    // `new URL()` (malformed req.url) and `match()`'s decodeURIComponent()
    // on a route param (malformed percent-encoding, e.g. "%E0%A4%A") throw
    // synchronously outside any handler's control. Left uncaught, either one
    // rejects handleRequest() itself with no response ever sent to the client.
    try {
      const url = new URL(req.url, 'http://localhost');
      const found = match(req.method, url.pathname);

      if (!found || found.methodNotAllowed) {
        return sendError(res, 404, 'not_found', `No route for ${req.method} ${url.pathname}`);
      }

      await found.handler({ req, res, params: found.params, query: url.searchParams });
    } catch (err) {
      if (err instanceof HttpError) {
        return sendError(res, err.statusCode, err.code, err.message);
      }
      if (err instanceof URIError) {
        return sendError(res, 400, 'bad_request', 'Malformed URL (invalid percent-encoding)');
      }
      return sendError(res, 500, 'internal_error', err?.message ?? String(err));
    }
  }

  return {
    get(path, handler) { add('GET', path, handler); },
    post(path, handler) { add('POST', path, handler); },
    handleRequest,
  };
}
