// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md
// Finding P1-2 "No collection allow-list — any request-supplied collection
// name that exists in the target Qdrant instance is queryable/askable" and
// the deployment-scenario analysis for "one instance serving multiple
// users/assistants" (cross-collection isolation is NOT enforced by
// Semidex itself).
//
// src/core/ask-api/v1/request.js and v2/request.js both require `collection`
// to be a non-empty string with NO further shape/allow-list constraint
// (contrast with `requireCollectionNameField` in shared/admin/api/jobs.js,
// which at least rejects "/"/"\\" for NEW collections — Ask has no such
// check at all since it only ever READS an existing collection). The route
// handlers (v1/route.js, v2/route.js) call adapter.getCollection(collection)
// and proceed if it exists — there is no per-caller / per-API-key scoping
// of which collections a given request is allowed to touch. This is
// consistent with the documented "single trusted user" design assumption,
// but is a real, unenforced trust boundary the moment more than one
// party's documents live in the same Qdrant Cloud project.
//
// This test proves the ABSENCE of any allow-list check: an arbitrary
// collection name that happens to exist is accepted by parseAskRequestV1/V2
// with no rejection, and a collection name is never checked against any
// configured allow-list (because none exists in the codebase — confirmed by
// reading src/core/settings/definitions.js and lite-policy.js, neither of
// which defines an ASK_COLLECTION_ALLOWLIST-shaped setting).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAskRequestV1 } from '../../../src/core/ask-api/v1/request.js';
import { parseAskRequestV2 } from '../../../src/core/ask-api/v2/request.js';
import { registerAskRoutesV1 } from '../../../src/core/ask-api/v1/route.js';
import { createRouter } from '../../../src/shared/admin/router.js';

describe('Ask v1/v2 request parsing — no collection allow-list (confirmed-absence characterization)', () => {
  it('parseAskRequestV1 accepts ANY non-empty collection string, including one that looks like another tenant\'s private collection name', () => {
    const parsed = parseAskRequestV1({ collection: 'other-tenant-private-notes', question: 'what is in here?' });
    assert.equal(parsed.collection, 'other-tenant-private-notes');
  });

  it('parseAskRequestV2 accepts ANY non-empty collection string the same way', () => {
    const parsed = parseAskRequestV2({ collection: 'someone-elses-hr-records', question: 'salaries?' });
    assert.equal(parsed.collection, 'someone-elses-hr-records');
  });

  it('parseAskRequestV1 places no format restriction on collection beyond non-empty-string (unlike the indexing path\'s requireCollectionNameField, which at least blocks "/" and "\\\\")', () => {
    // A collection name containing a path separator is accepted by Ask's
    // parser even though the INDEXING path (shared/admin/api/jobs.js)
    // would reject the same string for a NEW collection — proving these
    // are two independently-implemented validators with different rules,
    // not one shared allow-list.
    const parsed = parseAskRequestV1({ collection: 'weird/looking/name', question: 'x' });
    assert.equal(parsed.collection, 'weird/looking/name');
  });
});

describe('POST /api/v1/ask route — reaches the coordinator for any collection the adapter reports as existing, no allow-list gate in between', () => {
  it('a collection the stub adapter says exists is passed straight to askCoordinator.ask() unfiltered', async () => {
    let askCalledWith = null;
    const fakeAdapter = {
      getCollection: async (name) => ({ name, pointCount: 1 }), // "exists" for ANY name
    };
    const fakeCoordinator = {
      ask: async (args) => {
        askCalledWith = args;
        return { status: 'refused', reason: 'no_evidence', evidenceCount: 0, sources: [] };
      },
    };
    const router = createRouter();
    registerAskRoutesV1(router, fakeAdapter, { askCoordinator: fakeCoordinator });

    // Minimal fake req/res compatible with router.handleRequest — avoids
    // spinning up a real HTTP server for this one assertion.
    const { Readable } = await import('node:stream');
    const req = Readable.from([Buffer.from(JSON.stringify({ collection: 'not-mine-at-all', question: 'q' }))]);
    req.method = 'POST';
    req.url = '/api/v1/ask';
    // A realistic same-origin, non-browser request: the router now enforces
    // Host/cross-site policy before dispatch (request-security.js), so the
    // fake must carry a valid Host. This test is about collection scoping,
    // not transport security — the transport checks have their own tests in
    // csrf-state-changing-routes.test.js / cors-headers.test.js.
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:8642' };

    let statusCode = null;
    const headers = {};
    const chunks = [];
    const res = {
      writeHead(code, h) { statusCode = code; Object.assign(headers, h ?? {}); },
      write(chunk) { chunks.push(chunk); return true; },
      end(chunk) { if (chunk) chunks.push(chunk); },
      on() {}, // res.on('close', ...) — no-op for this fake
      destroyed: false,
      writableEnded: false,
    };

    await router.handleRequest(req, res);

    assert.ok(askCalledWith, 'askCoordinator.ask() must have been called');
    assert.equal(askCalledWith.collection, 'not-mine-at-all');
    assert.equal(statusCode, 200); // SSE started — the "collection_not_found" 404 branch never fired
  });
});
