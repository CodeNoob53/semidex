import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFINITIONS, CATEGORIES, CATEGORY_IDS } from '../../../../src/core/settings/definitions.js';

describe('settings definitions — structural validity', () => {
  test('every definition has a valid category, type, and required functions', () => {
    for (const [key, def] of Object.entries(DEFINITIONS)) {
      assert.ok(CATEGORY_IDS.has(def.category), `${key}: category "${def.category}" is not a known category`);
      assert.ok(['string', 'number', 'boolean', 'enum', 'secret'].includes(def.type), `${key}: unexpected type "${def.type}"`);
      assert.equal(typeof def.parseExternal, 'function', `${key}: missing parseExternal`);
      assert.equal(typeof def.validate, 'function', `${key}: missing validate`);
      assert.equal(typeof def.serialize, 'function', `${key}: missing serialize`);
      assert.equal(typeof def.writable, 'boolean', `${key}: writable must be a boolean`);
      assert.equal(typeof def.secret, 'boolean', `${key}: secret must be a boolean`);
      if (def.writable) {
        assert.ok(
          ['immediate', 'next_search', 'next_index_job', 'next_restart', 'new_collection'].includes(def.appliesAt),
          `${key}: writable field has invalid appliesAt "${def.appliesAt}"`
        );
      }
      assert.equal(typeof def.requiresReindex, 'boolean', `${key}: requiresReindex must be a boolean`);
      assert.equal(typeof def.requiresBackfill, 'boolean', `${key}: requiresBackfill must be a boolean`);
    }
  });

  test('CATEGORIES has exactly 7 entries (status + 6 writable-content categories)', () => {
    assert.equal(CATEGORIES.length, 7);
    assert.deepEqual(CATEGORIES.map((c) => c.id), ['status', 'storage', 'ai', 'embeddings', 'indexing', 'retrieval', 'system']);
  });

  test('excluded fields (ONNX_EMBED, RERANK_DEBUG, RERANK_CE_DEBUG) are absent entirely, not merely non-writable', () => {
    assert.equal(DEFINITIONS.ONNX_EMBED, undefined);
    assert.equal(DEFINITIONS.RERANK_DEBUG, undefined);
    assert.equal(DEFINITIONS.RERANK_CE_DEBUG, undefined);
  });

  test('secrets are never writable and never carry a default value used as a real value', () => {
    assert.equal(DEFINITIONS.QDRANT_KEY.writable, false);
    assert.equal(DEFINITIONS.QDRANT_KEY.secret, true);
    const result = DEFINITIONS.QDRANT_KEY.validate('anything');
    assert.equal(result.ok, false);
  });

  test('single-implementation enums are read-only with a reason', () => {
    assert.equal(DEFINITIONS.SEMIDEX_STORAGE_BACKEND.writable, false);
    assert.match(DEFINITIONS.SEMIDEX_STORAGE_BACKEND.readOnlyReason, /only one/i);
  });

  test('SEMIDEX_GENERATION_BACKEND is writable (Stage B1: ollama and gemini are both real implementations)', () => {
    assert.equal(DEFINITIONS.SEMIDEX_GENERATION_BACKEND.writable, true);
    assert.deepEqual(
      DEFINITIONS.SEMIDEX_GENERATION_BACKEND.options.map((o) => o.value).sort(),
      ['gemini', 'ollama']
    );
  });

  test('code review fix (P1): QDRANT_URL has no default value — core/qdrant/client.js has no fallback of its own and deliberately throws when unset (see tests/unit/core/qdrant-lazy.test.js\'s regression guard); a registry default here would be dishonest and would defeat applyEnvWriteBack()\'s "skip default-sourced values" rule', () => {
    assert.equal(DEFINITIONS.QDRANT_URL.default, undefined);
    assert.equal(DEFINITIONS.QDRANT_URL.parseExternal(undefined), undefined);
    assert.equal(DEFINITIONS.QDRANT_URL.parseExternal(''), undefined);
    assert.equal(DEFINITIONS.QDRANT_URL.parseExternal('https://real-host:6333'), 'https://real-host:6333');
  });
});

describe('settings definitions — UI metadata (Phase 4A.5c registry extension)', () => {
  test('every definition has a non-empty description', () => {
    for (const [key, def] of Object.entries(DEFINITIONS)) {
      assert.equal(typeof def.description, 'string', `${key}: description must be a string`);
      assert.ok(def.description.length > 0, `${key}: description must not be empty`);
    }
  });

  test('every definition has a boolean advanced flag', () => {
    for (const [key, def] of Object.entries(DEFINITIONS)) {
      assert.equal(typeof def.advanced, 'boolean', `${key}: advanced must be a boolean`);
    }
  });

  test('every number definition has min <= max', () => {
    for (const [key, def] of Object.entries(DEFINITIONS)) {
      if (def.type !== 'number') continue;
      assert.equal(typeof def.min, 'number', `${key}: min must be a number`);
      assert.equal(typeof def.max, 'number', `${key}: max must be a number`);
      assert.ok(def.min <= def.max, `${key}: min (${def.min}) must be <= max (${def.max})`);
    }
  });

  test('every enum definition has options matching its validate() acceptance set', () => {
    for (const [key, def] of Object.entries(DEFINITIONS)) {
      if (def.type !== 'enum') continue;
      assert.ok(Array.isArray(def.options), `${key}: options must be an array`);
      for (const opt of def.options) {
        assert.equal(def.validate(opt.value).ok, true, `${key}: option "${opt.value}" must be accepted by validate()`);
      }
    }
  });

  test('every string definition has a boolean allowEmpty consistent with parseExternal(\'\') behavior', () => {
    for (const [key, def] of Object.entries(DEFINITIONS)) {
      if (def.type !== 'string') continue;
      assert.equal(typeof def.allowEmpty, 'boolean', `${key}: allowEmpty must be a boolean`);
      if (def.allowEmpty === false) {
        assert.equal(
          def.parseExternal(''), def.parseExternal(undefined),
          `${key}: with allowEmpty=false, parseExternal('') must equal parseExternal(undefined)`
        );
      }
    }
  });
});

describe('settings definitions — parseExternal preserves current bounds/behavior', () => {
  test('MAX_CHUNK_TOKENS: valid int within [1,100000] parses through; matches chunk.js default of 512', () => {
    const def = DEFINITIONS.MAX_CHUNK_TOKENS;
    assert.equal(def.default, 512);
    assert.equal(def.parseExternal('1000'), 1000);
    assert.equal(def.parseExternal('0'), 512); // below min -> falls back to default
    assert.equal(def.parseExternal('abc'), 512);
  });

  test('MIN_CHUNK_TOKENS default matches chunk.js (160)', () => {
    assert.equal(DEFINITIONS.MIN_CHUNK_TOKENS.default, 160);
  });

  test('CHUNK_OVERLAP_TOKENS default matches chunk.js (80)', () => {
    assert.equal(DEFINITIONS.CHUNK_OVERLAP_TOKENS.default, 80);
  });

  test('OVERLAP_SENTENCES default matches chunk.js (2)', () => {
    assert.equal(DEFINITIONS.OVERLAP_SENTENCES.default, 2);
  });

  test('RERANK_BOOST_SOURCE_FILE: float bounds [0,10], default 0.08 matches rerank.js', () => {
    const def = DEFINITIONS.RERANK_BOOST_SOURCE_FILE;
    assert.equal(def.default, 0.08);
    assert.equal(def.parseExternal('0.5'), 0.5);
    assert.equal(def.parseExternal('-1'), 0.08); // out of bounds -> default
  });

  test('ASK_NUM_CTX: integer bounds [256,1000000] match generation/config.js', () => {
    const def = DEFINITIONS.ASK_NUM_CTX;
    assert.equal(def.default, 8192);
    assert.equal(def.validate(255).ok, false);
    assert.equal(def.validate(256).ok, true);
    assert.equal(def.validate(1_000_000).ok, true);
    assert.equal(def.validate(1_000_001).ok, false);
  });

  test('SKELETON_CHUNKING, SKELETON_NAV, and SKELETON_CONTEXT are not recognized settings — skeleton-first chunking, nav generation, and deterministic structural context are unconditional architecture, not configuration', () => {
    const keys = Object.keys(DEFINITIONS);
    assert.ok(!keys.includes('SKELETON_CHUNKING'));
    assert.ok(!keys.includes('SKELETON_NAV'));
    assert.ok(!keys.includes('SKELETON_CONTEXT'));
    // The fields that DO stay configurable (orthogonal to the toggle removed
    // above) must still be present — this guards against accidentally
    // deleting more than intended.
    assert.ok(keys.includes('SKELETON_SUMMARY'));
    assert.ok(keys.includes('SKELETON_CARRYOVER_CHARS'));
    assert.ok(keys.includes('SUMMARY_LANG'));
  });

  test('invalid-value warning text is preserved verbatim for a representative envInt-backed field', (t) => {
    const originalWarn = console.warn;
    const calls = [];
    console.warn = (msg) => calls.push(msg);
    try {
      DEFINITIONS.MAX_CHUNK_TOKENS.parseExternal('not-a-number');
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0], '[chunk] MAX_CHUNK_TOKENS="not-a-number" is invalid — using default 512');
  });
});

describe('ONNXRUNTIME_NODE_PATH — CUDA-only custom runtime path', () => {
  test('registered in the embeddings category, writable, next_restart, no reindex', () => {
    const def = DEFINITIONS.ONNXRUNTIME_NODE_PATH;
    assert.ok(def, 'ONNXRUNTIME_NODE_PATH must be registered in DEFINITIONS');
    assert.equal(def.category, 'embeddings');
    assert.equal(def.type, 'string');
    assert.equal(def.envVar, 'ONNXRUNTIME_NODE_PATH');
    assert.equal(def.writable, true);
    assert.equal(def.appliesAt, 'next_restart');
    assert.equal(def.requiresReindex, false);
  });

  test('empty string is a valid value (means "use the default npm package")', () => {
    const def = DEFINITIONS.ONNXRUNTIME_NODE_PATH;
    assert.equal(def.allowEmpty, true);
    assert.equal(def.default, '');
    assert.equal(def.validate('').ok, true);
    assert.equal(def.parseExternal(''), '');
    assert.equal(def.parseExternal(undefined), '');
  });

  test('a real path value round-trips through parseExternal/serialize unchanged', () => {
    const def = DEFINITIONS.ONNXRUNTIME_NODE_PATH;
    const path = 'C:/tools/custom-onnxruntime-node';
    assert.equal(def.parseExternal(path), path);
    assert.equal(def.serialize(path), path);
    assert.equal(def.validate(path).ok, true);
  });

  test('visibleWhen is an AND-composed array requiring BGE-M3 ONNX AND cuda', () => {
    const def = DEFINITIONS.ONNXRUNTIME_NODE_PATH;
    assert.ok(Array.isArray(def.visibleWhen), 'visibleWhen must be an array for a multi-condition field');
    assert.deepEqual(def.visibleWhen, [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'cuda' },
    ]);
  });

  test('carries pathPicker: true so the UI renders a Browse control (never a hardcoded key check)', () => {
    assert.equal(DEFINITIONS.ONNXRUNTIME_NODE_PATH.pathPicker, true);
  });

  test('description explains the npm prebuilt has no CUDA EP and a custom build is required', () => {
    const desc = DEFINITIONS.ONNXRUNTIME_NODE_PATH.description.toLowerCase();
    assert.match(desc, /npm/);
    assert.match(desc, /cuda/);
    assert.match(desc, /custom/);
  });
});

describe('ONNX_BATCH_SIZE and ONNX_CUDA_STRICT — multi-condition visibleWhen (DML-only / CUDA-only)', () => {
  test('ONNX_BATCH_SIZE requires BGE-M3 ONNX AND dml', () => {
    assert.deepEqual(DEFINITIONS.ONNX_BATCH_SIZE.visibleWhen, [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'dml' },
    ]);
  });

  test('ONNX_CUDA_STRICT requires BGE-M3 ONNX AND cuda', () => {
    assert.deepEqual(DEFINITIONS.ONNX_CUDA_STRICT.visibleWhen, [
      { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' },
      { key: 'ONNX_EXECUTION_PROVIDER', equals: 'cuda' },
    ]);
  });

  test('ONNX_EXECUTION_PROVIDER itself keeps its original single-condition shape (backward compatible, not converted to an array)', () => {
    assert.deepEqual(DEFINITIONS.ONNX_EXECUTION_PROVIDER.visibleWhen, { key: 'EMBEDDING_BACKEND', equals: 'bge-m3-onnx' });
    assert.ok(!Array.isArray(DEFINITIONS.ONNX_EXECUTION_PROVIDER.visibleWhen));
  });

  test('every other pre-existing single-condition visibleWhen field is unaffected by the array extension (still a plain object, not an array)', () => {
    for (const key of ['TAG_MODEL', 'TAG_ONNX_MODEL', 'OLLAMA_URL', 'GENERATION_DEVICE', 'EMBED_MODEL', 'DENSE_MODEL']) {
      const def = DEFINITIONS[key];
      assert.ok(def.visibleWhen, `${key}: expected a visibleWhen`);
      assert.ok(!Array.isArray(def.visibleWhen), `${key}: visibleWhen must remain a single object, not an array`);
    }
  });
});

describe('settings definitions — validate rejects out-of-bounds typed values', () => {
  test('MAX_CHUNK_TOKENS validate rejects non-integer and out-of-range', () => {
    const def = DEFINITIONS.MAX_CHUNK_TOKENS;
    assert.equal(def.validate(512).ok, true);
    assert.equal(def.validate(0).ok, false);
    assert.equal(def.validate(1.5).ok, false);
    assert.equal(def.validate(100001).ok, false);
  });

  test('TAG_PROVIDER enum validate rejects unknown values', () => {
    const def = DEFINITIONS.TAG_PROVIDER;
    assert.equal(def.validate('ollama').ok, true);
    assert.equal(def.validate('onnx').ok, true);
    assert.equal(def.validate('bogus').ok, false);
  });

  test('TAG_GEN boolean validate rejects non-boolean', () => {
    const def = DEFINITIONS.TAG_GEN;
    assert.equal(def.validate(true).ok, true);
    assert.equal(def.validate('true').ok, false);
  });
});
