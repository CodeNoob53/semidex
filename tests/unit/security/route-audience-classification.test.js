// Supports: docs/security/semidex-lite-public-api-audit-2026-08.md §10 step 3
// — the Admin/Integration trust boundary that must exist BEFORE bearer keys,
// collection scopes or rate limiting are introduced.
//
// These tests assert against the LIVE route registry of real composition
// roots (createLiteApp / createApp), not against a hand-maintained list, so
// the classification can never silently drift from what is actually served.
//
// The boundary itself:
//   integration = stable, versioned, application-facing routes a third-party
//                 backend calls. Search v1 and Ask v1/v2, today.
//   admin       = dashboard/management. Everything else, including the
//                 dashboard's own internal /api/search (unversioned, consumed
//                 only by ui-src/search.js — see the classification note in
//                 the audit).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiteApp } from '../../../src/admin/composition/lite.js';
import { createApp } from '../../../src/admin/server-full.js';
import { createRouter } from '../../../src/shared/admin/router.js';
import { createJobRegistry } from '../../../src/shared/admin/jobs/registry.js';
import {
  AUDIENCE, OPERATION, COST_CLASS, COLLECTION_SOURCE, EDITION, validateRouteMeta,
} from '../../../src/core/http/route-audience.js';

function stubAdapter() {
  return {
    name: () => 'stub',
    capabilities: () => ({}),
    ping: async () => ({ ok: true }),
    listCollections: async () => [],
    getCollection: async (name) => ({ name, vectorsCount: 0 }),
  };
}

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

const jobRegistry = () => createJobRegistry({ spawnIndexer: () => fakeChild(), baseEnv: {} });

function liteRoutes() {
  const app = createLiteApp({
    adapter: stubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }), jobRegistry: jobRegistry(),
  });
  return app.listRoutes();
}

function fullRoutes() {
  const app = createApp({
    adapter: stubAdapter(), embedQuery: async () => ({ dense: [], sparse: {} }), jobRegistry: jobRegistry(),
  });
  return app.listRoutes();
}

const INTEGRATION_ROUTES = [
  'POST /api/v1/search',
  'POST /api/v1/ask',
  'POST /api/v2/ask',
];

const key = (r) => `${r.method} ${r.path}`;

describe('Part A — every route carries explicit, valid metadata (exhaustive, no route left unclassified)', () => {
  for (const [label, get] of [['Lite', liteRoutes], ['Full', fullRoutes]]) {
    it(`${label}: every registered route has an audience, operation and costClass`, () => {
      const routes = get();
      assert.ok(routes.length > 0, 'expected the composition root to register routes');
      for (const r of routes) {
        assert.ok(r.audience, `${key(r)} has no audience`);
        assert.ok(
          r.audience === AUDIENCE.ADMIN || r.audience === AUDIENCE.INTEGRATION,
          `${key(r)} has an unrecognized audience "${r.audience}"`
        );
        assert.ok(Object.values(OPERATION).includes(r.operation), `${key(r)} has invalid operation "${r.operation}"`);
        assert.ok(Object.values(COST_CLASS).includes(r.costClass), `${key(r)} has invalid costClass "${r.costClass}"`);
        assert.ok(Object.values(COLLECTION_SOURCE).includes(r.collectionSource), `${key(r)} has invalid collectionSource`);
        assert.ok(Object.values(EDITION).includes(r.edition), `${key(r)} has invalid edition`);
      }
    });

    it(`${label}: route metadata is frozen (a handler cannot mutate its own classification at runtime)`, () => {
      for (const r of get()) assert.ok(Object.isFrozen(r), `${key(r)} metadata is not frozen`);
    });
  }
});

describe('Part C — the Admin/Integration classification is exactly as designed', () => {
  it('Search v1 and Ask v1/v2 are the ONLY integration routes', () => {
    const integration = liteRoutes().filter((r) => r.audience === AUDIENCE.INTEGRATION).map(key).sort();
    assert.deepEqual(integration, INTEGRATION_ROUTES.slice().sort(),
      'the integration surface must not grow without an explicit decision — see the audit\'s classification note');
  });

  it('Ask routes are classified as billed generation against a body-supplied collection', () => {
    for (const r of liteRoutes().filter((r) => r.audience === AUDIENCE.INTEGRATION && r.path !== '/api/v1/search')) {
      assert.equal(r.operation, OPERATION.GENERATE, `${key(r)} should be a generate operation`);
      assert.equal(r.costClass, COST_CLASS.LLM, `${key(r)} is billed generation`);
      // This is what the next phase's object-level authorization (OWASP
      // API1:2023) keys off: the collection identifier arrives in the body.
      assert.equal(r.collectionSource, COLLECTION_SOURCE.BODY, `${key(r)} takes its collection from the request body`);
    }
  });

  it('Search v1 is classified as a Qdrant-only operation against a body-supplied collection — never billed generation', () => {
    const search = liteRoutes().find((r) => key(r) === 'POST /api/v1/search');
    assert.ok(search, 'expected POST /api/v1/search to be registered');
    assert.equal(search.audience, AUDIENCE.INTEGRATION);
    assert.equal(search.operation, OPERATION.SEARCH);
    assert.equal(search.costClass, COST_CLASS.QDRANT, 'Search never calls a generation provider');
    assert.equal(search.collectionSource, COLLECTION_SOURCE.BODY);
  });

  it('settings read/write are admin', () => {
    const settings = liteRoutes().filter((r) => r.path === '/api/settings');
    assert.equal(settings.length, 2, 'expected GET and PATCH /api/settings');
    for (const r of settings) assert.equal(r.audience, AUDIENCE.ADMIN, `${key(r)} must be admin`);
    assert.equal(settings.find((r) => r.method === 'PATCH').operation, OPERATION.MUTATE);
  });

  it('indexing job creation is admin, and classified as indexing cost', () => {
    const job = liteRoutes().find((r) => key(r) === 'POST /api/jobs/index');
    assert.ok(job, 'expected POST /api/jobs/index to be registered');
    assert.equal(job.audience, AUDIENCE.ADMIN);
    assert.equal(job.operation, OPERATION.INDEX);
    assert.equal(job.costClass, COST_CLASS.INDEXING);
  });

  it('collection mutation and deletion are admin', () => {
    const routes = liteRoutes();
    const sync = routes.find((r) => key(r) === 'POST /api/collections/:name/sync-schema');
    const del = routes.find((r) => key(r) === 'DELETE /api/collections/:name');
    assert.equal(sync.audience, AUDIENCE.ADMIN);
    assert.equal(sync.operation, OPERATION.MUTATE);
    assert.equal(del.audience, AUDIENCE.ADMIN);
    assert.equal(del.operation, OPERATION.DELETE);
    // Both take the collection from the path — the other half of the
    // object-level-authorization surface.
    assert.equal(sync.collectionSource, COLLECTION_SOURCE.PATH);
    assert.equal(del.collectionSource, COLLECTION_SOURCE.PATH);
  });

  it('/api/search stays ADMIN — it is the dashboard\'s own unversioned search, not a published API', () => {
    const search = liteRoutes().find((r) => key(r) === 'POST /api/search');
    assert.ok(search, 'expected POST /api/search to be registered');
    assert.equal(search.audience, AUDIENCE.ADMIN,
      'promoting /api/search to the integration surface is a deliberate product decision requiring a versioned path — see the audit');
    assert.equal(search.operation, OPERATION.SEARCH);
  });

  it('no integration route performs a destructive or management operation', () => {
    const forbidden = new Set([OPERATION.DELETE, OPERATION.MUTATE, OPERATION.INDEX, OPERATION.PROBE]);
    for (const r of liteRoutes().filter((r) => r.audience === AUDIENCE.INTEGRATION)) {
      assert.equal(forbidden.has(r.operation), false,
        `${key(r)} is integration but performs "${r.operation}" — management operations must stay admin`);
    }
  });

  it('every non-integration route is admin (the two audiences are exhaustive)', () => {
    for (const r of [...liteRoutes(), ...fullRoutes()]) {
      if (INTEGRATION_ROUTES.includes(key(r))) continue;
      assert.equal(r.audience, AUDIENCE.ADMIN, `${key(r)} should be admin`);
    }
  });
});

describe('Part C — Full-only routes still do not leak into Lite', () => {
  it('the Full-only local-runtime routes are absent from the Lite registry', () => {
    const lite = new Set(liteRoutes().map(key));
    for (const path of [
      'GET /api/ollama-models',
      'GET /api/system/ollama-status',
      'POST /api/system/onnx-probe',
      'GET /api/system/onnx-managed-runtimes',
    ]) {
      assert.equal(lite.has(path), false, `${path} must not be registered in the Lite composition`);
    }
  });

  it('Full-only routes declare edition: full, and every one of them is admin', () => {
    for (const r of fullRoutes().filter((r) => r.edition === EDITION.FULL)) {
      assert.equal(r.audience, AUDIENCE.ADMIN, `${key(r)} is a local-runtime route and must be admin`);
    }
  });

  it('Lite and Full agree on the classification of every route they share', () => {
    const lite = new Map(liteRoutes().map((r) => [key(r), r]));
    for (const f of fullRoutes()) {
      const l = lite.get(key(f));
      if (!l) continue;
      assert.equal(l.audience, f.audience, `${key(f)} is classified differently in Lite and Full`);
      assert.equal(l.operation, f.operation, `${key(f)} has a different operation in Lite and Full`);
      assert.equal(l.costClass, f.costClass, `${key(f)} has a different costClass in Lite and Full`);
    }
  });
});

describe('Part B — fail-closed registration contract', () => {
  const noop = () => {};

  it('a route registered with NO metadata throws', () => {
    const r = createRouter();
    assert.throws(() => r.get('/api/x', noop), /audience/i);
  });

  it('a route registered with metadata but no audience throws', () => {
    const r = createRouter();
    assert.throws(
      () => r.post('/api/x', noop, { operation: OPERATION.READ, costClass: COST_CLASS.LOW }),
      /missing the required "audience" field/
    );
  });

  it('an unknown audience value throws rather than being coerced', () => {
    const r = createRouter();
    assert.throws(
      () => r.post('/api/x', noop, { audience: 'public', operation: OPERATION.READ, costClass: COST_CLASS.LOW }),
      /unknown audience "public"/
    );
  });

  it('a missing or unknown operation throws', () => {
    const r = createRouter();
    assert.throws(
      () => r.get('/api/x', noop, { audience: AUDIENCE.ADMIN, costClass: COST_CLASS.LOW }),
      /missing the required "operation" field/
    );
    assert.throws(
      () => r.get('/api/y', noop, { audience: AUDIENCE.ADMIN, operation: 'frobnicate', costClass: COST_CLASS.LOW }),
      /unknown operation "frobnicate"/
    );
  });

  it('a missing or unknown costClass throws', () => {
    const r = createRouter();
    assert.throws(
      () => r.get('/api/x', noop, { audience: AUDIENCE.ADMIN, operation: OPERATION.READ }),
      /missing the required "costClass" field/
    );
    assert.throws(
      () => r.get('/api/y', noop, { audience: AUDIENCE.ADMIN, operation: OPERATION.READ, costClass: 'free' }),
      /unknown costClass "free"/
    );
  });

  it('there is NO default audience — neither admin nor integration is assumed', () => {
    // Defaulting either way silently mis-scopes a new route: "admin" would
    // hide a genuinely public endpoint behind the wrong policy, "integration"
    // would expose a management endpoint. A startup error is the safe outcome.
    assert.throws(() => validateRouteMeta('GET', '/api/x', {}), /missing the required "audience" field/);
    assert.throws(() => validateRouteMeta('GET', '/api/x', undefined), /audience is mandatory/);
  });

  it('the failure message points at the boundary documentation', () => {
    try {
      validateRouteMeta('GET', '/api/x', {});
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /route-audience\.js/);
      assert.match(err.message, /semidex-lite-public-api-audit/);
    }
  });

  it('validated metadata is frozen and carries method/path for audit use', () => {
    const meta = validateRouteMeta('POST', '/api/v1/ask', {
      audience: AUDIENCE.INTEGRATION, operation: OPERATION.GENERATE, costClass: COST_CLASS.LLM,
    });
    assert.ok(Object.isFrozen(meta));
    assert.equal(meta.method, 'POST');
    assert.equal(meta.path, '/api/v1/ask');
    assert.equal(meta.collectionSource, COLLECTION_SOURCE.NONE, 'collectionSource defaults to none');
    assert.equal(meta.edition, EDITION.SHARED, 'edition defaults to shared');
  });
});
