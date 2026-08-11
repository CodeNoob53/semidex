// Phase 5 (docs/design/full-lite-shared-architecture-audit-2026-08-01.md,
// §9.2/§11's "Phase 5 — automated Semidex Lite settings-policy
// completeness"). Proves LITE_SETTINGS_POLICY (src/core/settings/lite-policy.js)
// is a real, exhaustive classification of every key in the real, live
// DEFINITIONS registry (src/core/settings/definitions.js) — not a
// documentation claim. A new DEFINITIONS key with no matching
// LITE_SETTINGS_POLICY entry fails this test, which is the whole point:
// adding, renaming, or removing a setting now forces an explicit Lite
// exposure decision instead of silently defaulting to "excluded" by
// omission. All assertions compare real exported data structures
// (Object.keys(), Set membership) — no source-regex inspection.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFINITIONS } from '../../../src/core/settings/definitions.js';
import { LITE_SETTINGS_POLICY, LITE_SETTINGS_KEYS, LITE_SETTINGS_KEY_SET, LITE_EXCLUSION_REASONS } from '../../../src/core/settings/lite-policy.js';

const DEFINITION_KEYS = Object.keys(DEFINITIONS);
const POLICY_KEYS = Object.keys(LITE_SETTINGS_POLICY);
const RECOGNIZED_REASONS = new Set(Object.values(LITE_EXCLUSION_REASONS));

describe('LITE_SETTINGS_POLICY — exhaustiveness against the real DEFINITIONS registry', () => {
  it('every key in DEFINITIONS appears in the Lite policy exactly once', () => {
    const missing = DEFINITION_KEYS.filter((k) => !POLICY_KEYS.includes(k));
    assert.deepEqual(missing, [], `DEFINITIONS key(s) with no LITE_SETTINGS_POLICY entry — every new/renamed setting must get an explicit Lite exposure decision: ${JSON.stringify(missing)}`);

    const duplicates = POLICY_KEYS.filter((k, i) => POLICY_KEYS.indexOf(k) !== i);
    assert.deepEqual(duplicates, [], `LITE_SETTINGS_POLICY must not declare the same key twice: ${JSON.stringify(duplicates)}`);
  });

  it('the Lite policy contains no unknown/stale keys not present in DEFINITIONS', () => {
    const stale = POLICY_KEYS.filter((k) => !DEFINITION_KEYS.includes(k));
    assert.deepEqual(stale, [], `LITE_SETTINGS_POLICY key(s) with no matching DEFINITIONS entry — a setting was removed/renamed without updating the Lite policy: ${JSON.stringify(stale)}`);
  });

  it('no key is simultaneously exposed and excluded — every policy entry has exactly one status', () => {
    for (const [key, entry] of Object.entries(LITE_SETTINGS_POLICY)) {
      assert.ok(['exposed', 'excluded'].includes(entry.status), `${key}: status must be "exposed" or "excluded", got ${JSON.stringify(entry.status)}`);
      // A plain-object entry structurally cannot hold two statuses at once
      // (status is a single field), but this positively confirms every
      // entry resolves to exactly one of the two real states the runtime
      // (service.lite.js) can actually enforce — no third "maybe" state.
      const isExposed = entry.status === 'exposed';
      const isExcluded = entry.status === 'excluded';
      assert.notEqual(isExposed, isExcluded, `${key}: status must resolve to exactly one of exposed/excluded`);
    }
  });

  it('LITE_SETTINGS_KEYS exactly equals the keys classified "exposed" in the policy (set comparison — order is checked separately below, since LITE_SETTINGS_KEYS is pinned to a specific declared order, not policy-declaration order)', () => {
    const exposedKeys = Object.entries(LITE_SETTINGS_POLICY)
      .filter(([, entry]) => entry.status === 'exposed')
      .map(([key]) => key);
    assert.deepEqual([...LITE_SETTINGS_KEYS].sort(), exposedKeys.sort());
  });

  // Code review finding (P2, two rounds): a first version derived
  // LITE_SETTINGS_KEYS by filtering LITE_SETTINGS_POLICY's own iteration
  // order (which at the time followed DEFINITIONS' category grouping) —
  // same SET as the original hand-maintained array, but a genuinely
  // different ARRAY (the original started QDRANT_URL/QDRANT_KEY/...; the
  // naive derivation started SEMIDEX_GENERATION_BACKEND/ASK_MODEL/...). A
  // second attempt fixed the order by adding a separately-declared
  // LITE_EXPOSED_KEY_ORDER constant — which reintroduced a second source
  // of truth for exactly the "exposed" classification LITE_SETTINGS_POLICY
  // is supposed to be canonical for. The actual fix: LITE_SETTINGS_POLICY
  // itself now declares every 'exposed' entry FIRST, in the pinned
  // original order, before any 'excluded' entry — so
  // Object.entries(LITE_SETTINGS_POLICY).filter(exposed) is once again a
  // real, single-source-of-truth derivation that also happens to preserve
  // the original order, by construction, with no second list. This test
  // pins that exact order explicitly so a future edit that reorders the
  // 'exposed' block in lite-policy.js can never silently reorder the
  // exported array consumers may reasonably render in.
  it('LITE_SETTINGS_KEYS preserves its original declared order exactly (regression pin, not just a set check)', () => {
    assert.deepEqual([...LITE_SETTINGS_KEYS], [
      'QDRANT_URL',
      'QDRANT_KEY',
      'QDRANT_CLOUD_DENSE_MODEL',
      'QDRANT_SPARSE_MODEL',
      'EMBEDDING_BACKEND',
      'DENSE_PROVIDER',
      'SPARSE_PROVIDER',
      'VECTOR_SIZE',
      'SEMIDEX_GENERATION_BACKEND',
      'ASK_MODEL',
      'ASK_NUM_CTX',
      'ASK_HISTORY_MAX_MESSAGES',
      'ASK_HISTORY_MAX_CHARS',
      'ASK_HISTORY_MAX_TOKENS',
      'ASK_SUMMARY_COMPACTION_THRESHOLD',
      'ASK_QUERY_REWRITE_TIMEOUT_MS',
      'ASK_SUMMARY_COMPACTION_TIMEOUT_MS',
      'GEMINI_API_KEY',
      'CONTEXT_MODE',
      'SEMIDEX_STORAGE_BACKEND',
      'ADMIN_HOST',
      'ADMIN_PORT',
      'ADMIN_ALLOW_REMOTE',
      'HYBRID_PREFETCH_LIMIT',
      'RRF_K',
    ]);
  });

  it('there are no duplicate keys among exposed or excluded entries', () => {
    const exposedKeys = POLICY_KEYS.filter((k) => LITE_SETTINGS_POLICY[k].status === 'exposed');
    const excludedKeys = POLICY_KEYS.filter((k) => LITE_SETTINGS_POLICY[k].status === 'excluded');
    assert.equal(new Set(exposedKeys).size, exposedKeys.length, 'exposed keys must be unique');
    assert.equal(new Set(excludedKeys).size, excludedKeys.length, 'excluded keys must be unique');
    // No key can appear in both lists — POLICY_KEYS itself has no
    // duplicates (proven above), and each key maps to exactly one status,
    // so the two lists are disjoint by construction; this assertion pins
    // that invariant explicitly rather than leaving it merely implied.
    const overlap = exposedKeys.filter((k) => excludedKeys.includes(k));
    assert.deepEqual(overlap, []);
  });

  it('every excluded key has a non-empty, recognized reason', () => {
    const badReasons = [];
    for (const [key, entry] of Object.entries(LITE_SETTINGS_POLICY)) {
      if (entry.status !== 'excluded') continue;
      if (typeof entry.reason !== 'string' || entry.reason.length === 0 || !RECOGNIZED_REASONS.has(entry.reason)) {
        badReasons.push({ key, reason: entry.reason });
      }
    }
    assert.deepEqual(badReasons, [], `every excluded key must carry a non-empty reason from LITE_EXCLUSION_REASONS: ${JSON.stringify(badReasons)}`);
  });

  it('critical cloud settings remain exposed', () => {
    const mustBeExposed = [
      'QDRANT_URL', 'QDRANT_KEY', 'QDRANT_CLOUD_DENSE_MODEL', 'QDRANT_SPARSE_MODEL',
      'SEMIDEX_GENERATION_BACKEND', 'ASK_MODEL', 'GEMINI_API_KEY', 'HYBRID_PREFETCH_LIMIT', 'RRF_K',
    ];
    for (const key of mustBeExposed) {
      assert.ok(key in LITE_SETTINGS_POLICY, `expected ${key} to exist in LITE_SETTINGS_POLICY at all`);
      assert.equal(LITE_SETTINGS_POLICY[key].status, 'exposed', `expected ${key} to be exposed in Lite`);
      assert.ok(LITE_SETTINGS_KEYS.includes(key), `expected ${key} to appear in the derived LITE_SETTINGS_KEYS list`);
    }
  });

  it('representative local-only settings remain excluded', () => {
    const mustBeExcluded = ['ONNX_EXECUTION_PROVIDER', 'ONNXRUNTIME_NODE_PATH', 'OLLAMA_URL', 'RERANK_CE_MODEL', 'TAG_PROVIDER'];
    for (const key of mustBeExcluded) {
      assert.ok(key in LITE_SETTINGS_POLICY, `expected ${key} to exist in LITE_SETTINGS_POLICY at all`);
      assert.equal(LITE_SETTINGS_POLICY[key].status, 'excluded', `expected ${key} to be excluded from Lite`);
      assert.ok(!LITE_SETTINGS_KEYS.includes(key), `expected ${key} to NOT appear in the derived LITE_SETTINGS_KEYS list`);
    }
  });

  it('DEFINITIONS itself is non-trivial (sanity check the import actually loaded real data, not an empty stub)', () => {
    assert.ok(DEFINITION_KEYS.length > 50, `expected a substantial real DEFINITIONS registry, got ${DEFINITION_KEYS.length} keys`);
  });
});

// Code review finding (P2): Object.freeze(LITE_SETTINGS_POLICY) only
// prevents reassigning/adding/removing the OUTER object's own top-level
// keys — each { status, reason } entry is a separate, distinct object,
// and was NOT itself frozen, so e.g. LITE_SETTINGS_POLICY.QDRANT_URL.status
// could be reassigned at runtime. Since LITE_SETTINGS_KEYS is computed
// ONCE at module-load time from the pre-mutation values, a later mutation
// of an entry's status would make the policy and the already-derived
// LITE_SETTINGS_KEYS/LITE_SETTINGS_KEY_SET silently disagree with each
// other — exactly the "policy says X, but service.lite.js's actual
// enforcement (built from the stale derived Set) says not-X" split-brain
// this whole phase exists to prevent. Fixed in lite-policy.js by having
// exposed()/excluded() return Object.freeze()d entries. These tests prove
// the mutation is now rejected (strict mode: assignment to a frozen
// object's property throws) rather than merely "does nothing" — either
// behavior would technically prevent drift, but a silent no-op is a much
// easier bug to miss in review than a thrown error.
describe('LITE_SETTINGS_POLICY — entries are deeply immutable, not just the outer object', () => {
  it('LITE_SETTINGS_POLICY itself is frozen (outer object)', () => {
    assert.ok(Object.isFrozen(LITE_SETTINGS_POLICY));
  });

  it('every individual policy entry is frozen, not just the outer object', () => {
    const unfrozen = POLICY_KEYS.filter((k) => !Object.isFrozen(LITE_SETTINGS_POLICY[k]));
    assert.deepEqual(unfrozen, [], `every LITE_SETTINGS_POLICY entry must be frozen, found mutable entries for: ${JSON.stringify(unfrozen)}`);
  });

  it('mutating an exposed entry\'s status throws (this file runs under ESM strict mode)', () => {
    const entry = LITE_SETTINGS_POLICY.QDRANT_URL;
    assert.equal(entry.status, 'exposed');
    assert.throws(() => { entry.status = 'excluded'; }, TypeError);
    assert.equal(entry.status, 'exposed', 'the entry must be unchanged after the rejected mutation attempt');
  });

  it('mutating an excluded entry\'s reason throws', () => {
    const entry = LITE_SETTINGS_POLICY.OLLAMA_URL;
    assert.equal(entry.status, 'excluded');
    assert.throws(() => { entry.reason = 'advanced_tuning'; }, TypeError);
    assert.equal(entry.reason, 'local_runtime', 'the entry must be unchanged after the rejected mutation attempt');
  });

  it('LITE_SETTINGS_KEYS and LITE_SETTINGS_KEY_SET stay consistent with LITE_SETTINGS_POLICY even after a mutation attempt on an entry (no split-brain)', () => {
    // Even though the mutation attempts above throw and are rejected, this
    // positively re-confirms (rather than merely assuming from "the throw
    // means nothing changed") that the derived exports still agree with
    // the policy — the actual failure mode code review flagged.
    for (const key of LITE_SETTINGS_KEYS) {
      assert.equal(LITE_SETTINGS_POLICY[key].status, 'exposed', `${key} is in LITE_SETTINGS_KEYS but LITE_SETTINGS_POLICY now disagrees`);
      assert.ok(LITE_SETTINGS_KEY_SET.has(key));
    }
    for (const key of POLICY_KEYS) {
      if (LITE_SETTINGS_POLICY[key].status === 'exposed') {
        assert.ok(LITE_SETTINGS_KEYS.includes(key), `${key} is exposed in the policy but missing from LITE_SETTINGS_KEYS`);
      }
    }
  });
});
