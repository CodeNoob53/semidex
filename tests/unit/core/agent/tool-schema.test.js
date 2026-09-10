import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateToolDefinition, validateToolDefinitions, validateToolArguments,
  ToolSchemaError, TOOL_LIMITS,
} from '../../../../src/core/agent/tool-schema.js';

const OK_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
};

function expectCode(fn, code) {
  try {
    fn();
    assert.fail('expected a ToolSchemaError');
  } catch (err) {
    assert.ok(err instanceof ToolSchemaError, `expected ToolSchemaError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code, err.message);
  }
}

describe('validateToolDefinition', () => {
  test('accepts a minimal valid tool and returns a frozen normalized copy', () => {
    const tool = validateToolDefinition({ name: 'lookup_items', description: 'Read items', inputSchema: OK_SCHEMA });
    assert.equal(tool.name, 'lookup_items');
    assert.equal(tool.description, 'Read items');
    assert.ok(Object.isFrozen(tool));
    assert.ok(Object.isFrozen(tool.inputSchema));
    assert.ok(Object.isFrozen(tool.inputSchema.properties.query));
  });

  test('the normalized copy is detached from the caller\'s object', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const tool = validateToolDefinition({ name: 'a_tool', inputSchema: schema });
    schema.properties.a.type = 'number';
    assert.equal(tool.inputSchema.properties.a.type, 'string');
  });

  test('rejects a non-object root schema — arguments are always a named-parameter map', () => {
    expectCode(() => validateToolDefinition({ name: 't', inputSchema: { type: 'string' } }), 'invalid_schema');
  });

  test('rejects an unknown top-level tool field', () => {
    expectCode(() => validateToolDefinition({ name: 't', inputSchema: OK_SCHEMA, handler: 'x' }), 'invalid_tool');
  });

  test('rejects a name that is not a plain identifier', () => {
    for (const name of ['has space', 'has-dash', 'has.dot', '9leading', '']) {
      expectCode(() => validateToolDefinition({ name, inputSchema: OK_SCHEMA }), 'invalid_tool');
    }
  });

  describe('unsupported constructs are REJECTED, never silently ignored', () => {
    const unsupported = {
      $ref: { type: 'object', properties: { a: { $ref: '#/$defs/x' } } },
      allOf: { type: 'object', properties: { a: { type: 'string', allOf: [] } } },
      anyOf: { type: 'object', properties: { a: { type: 'string', anyOf: [] } } },
      oneOf: { type: 'object', properties: { a: { type: 'string', oneOf: [] } } },
      not: { type: 'object', properties: { a: { type: 'string', not: {} } } },
      const: { type: 'object', properties: { a: { type: 'string', const: 'x' } } },
      format: { type: 'object', properties: { a: { type: 'string', format: 'email' } } },
      pattern: { type: 'object', properties: { a: { type: 'string', pattern: '^x$' } } },
      minimum: { type: 'object', properties: { a: { type: 'number', minimum: 0 } } },
      maxLength: { type: 'object', properties: { a: { type: 'string', maxLength: 5 } } },
      minItems: { type: 'object', properties: { a: { type: 'array', items: { type: 'string' }, minItems: 1 } } },
      patternProperties: { type: 'object', patternProperties: {} },
      propertyNames: { type: 'object', propertyNames: {} },
      dependentRequired: { type: 'object', dependentRequired: {} },
      nullable: { type: 'object', properties: { a: { type: 'string', nullable: true } } },
      default: { type: 'object', properties: { a: { type: 'string', default: 'x' } } },
      contains: { type: 'object', properties: { a: { type: 'array', items: { type: 'string' }, contains: {} } } },
    };
    for (const [keyword, inputSchema] of Object.entries(unsupported)) {
      test(`rejects "${keyword}"`, () => {
        expectCode(() => validateToolDefinition({ name: 't', inputSchema }), 'unsupported_schema_keyword');
      });
    }

    test('rejects a union type (type as an array)', () => {
      expectCode(() => validateToolDefinition({
        name: 't', inputSchema: { type: 'object', properties: { a: { type: ['string', 'null'] } } },
      }), 'unsupported_schema_keyword');
    });

    test('rejects tuple-form items', () => {
      expectCode(() => validateToolDefinition({
        name: 't', inputSchema: { type: 'object', properties: { a: { type: 'array', items: [{ type: 'string' }] } } },
      }), 'unsupported_schema_keyword');
    });

    test('rejects an unsupported type name', () => {
      expectCode(() => validateToolDefinition({
        name: 't', inputSchema: { type: 'object', properties: { a: { type: 'null' } } },
      }), 'unsupported_schema_type');
    });

    test('rejects additionalProperties given as a sub-schema', () => {
      expectCode(() => validateToolDefinition({
        name: 't', inputSchema: { type: 'object', properties: {}, additionalProperties: { type: 'string' } },
      }), 'unsupported_schema_keyword');
    });
  });

  test('rejects required naming an undeclared property', () => {
    expectCode(() => validateToolDefinition({
      name: 't', inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
    }), 'invalid_schema');
  });

  test('rejects enum on an object/array type, accepts it on scalars', () => {
    expectCode(() => validateToolDefinition({
      name: 't', inputSchema: { type: 'object', properties: { a: { type: 'object', enum: [{}] } } },
    }), 'unsupported_schema_keyword');
    const ok = validateToolDefinition({
      name: 't', inputSchema: { type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'] } } },
    });
    assert.deepEqual(ok.inputSchema.properties.a.enum, ['x', 'y']);
  });

  test('rejects an enum value that does not match its declared type', () => {
    expectCode(() => validateToolDefinition({
      name: 't', inputSchema: { type: 'object', properties: { a: { type: 'string', enum: ['x', 3] } } },
    }), 'invalid_schema');
  });

  test('rejects schemas deeper than the configured limit', () => {
    let deep = { type: 'string' };
    for (let i = 0; i < TOOL_LIMITS.maxSchemaDepth + 2; i++) {
      deep = { type: 'object', properties: { nested: deep } };
    }
    expectCode(() => validateToolDefinition({ name: 't', inputSchema: deep }), 'schema_too_deep');
  });

  test('rejects too many properties on one object node', () => {
    const properties = {};
    for (let i = 0; i <= TOOL_LIMITS.maxProperties; i++) properties[`p${i}`] = { type: 'string' };
    expectCode(() => validateToolDefinition({ name: 't', inputSchema: { type: 'object', properties } }), 'schema_too_large');
  });
});

describe('validateToolDefinitions', () => {
  test('accepts a list and preserves order', () => {
    const tools = validateToolDefinitions([
      { name: 'a_tool', inputSchema: OK_SCHEMA },
      { name: 'b_tool', inputSchema: OK_SCHEMA },
    ]);
    assert.deepEqual(tools.map((t) => t.name), ['a_tool', 'b_tool']);
    assert.ok(Object.isFrozen(tools));
  });

  test('rejects duplicate tool names', () => {
    expectCode(() => validateToolDefinitions([
      { name: 'same', inputSchema: OK_SCHEMA },
      { name: 'same', inputSchema: OK_SCHEMA },
    ]), 'duplicate_tool_name');
  });

  test('rejects an empty or non-array tools value', () => {
    expectCode(() => validateToolDefinitions([]), 'invalid_tool');
    expectCode(() => validateToolDefinitions('nope'), 'invalid_tool');
  });

  test('rejects more tools than the configured maximum', () => {
    const many = Array.from({ length: TOOL_LIMITS.maxTools + 1 }, (_, i) => ({ name: `t_${i}`, inputSchema: OK_SCHEMA }));
    expectCode(() => validateToolDefinitions(many), 'too_many_tools');
  });

  test('rejects a tools payload over the serialized byte ceiling', () => {
    const big = 'x'.repeat(TOOL_LIMITS.maxDescriptionLength);
    const tools = Array.from({ length: TOOL_LIMITS.maxTools }, (_, i) => ({
      name: `t_${i}`,
      description: big,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(Array.from({ length: 40 }, (_, j) => [`p${j}`, { type: 'string', description: big }])),
      },
    }));
    expectCode(() => validateToolDefinitions(tools), 'schema_too_large');
  });
});

describe('validateToolArguments', () => {
  const schema = validateToolDefinition({
    name: 't',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        mode: { type: 'string', enum: ['fast', 'slow'] },
        tags: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { flag: { type: 'boolean' } }, required: ['flag'] },
      },
      required: ['query'],
      additionalProperties: false,
    },
  }).inputSchema;

  test('accepts a matching argument object', () => {
    assert.deepEqual(validateToolArguments(schema, {
      query: 'x', limit: 3, mode: 'fast', tags: ['a'], nested: { flag: true },
    }), { ok: true });
  });

  test('accepts only the required field', () => {
    assert.deepEqual(validateToolArguments(schema, { query: 'x' }), { ok: true });
  });

  test('rejects a missing required field', () => {
    const r = validateToolArguments(schema, { limit: 1 });
    assert.equal(r.ok, false);
    assert.match(r.message, /arguments\.query is required/);
  });

  test('rejects an undeclared argument when additionalProperties is not enabled', () => {
    const r = validateToolArguments(schema, { query: 'x', sneaky: 1 });
    assert.equal(r.ok, false);
    assert.match(r.message, /not declared in the tool schema/);
  });

  test('additionalProperties defaults to FALSE even when the schema omits it', () => {
    const permissive = validateToolDefinition({
      name: 't', inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    }).inputSchema;
    const r = validateToolArguments(permissive, { a: 'x', b: 'y' });
    assert.equal(r.ok, false, 'an omitted additionalProperties must not silently allow extra keys');
  });

  test('additionalProperties: true genuinely allows extra keys', () => {
    const permissive = validateToolDefinition({
      name: 't', inputSchema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
    }).inputSchema;
    assert.deepEqual(validateToolArguments(permissive, { a: 'x', b: 'y' }), { ok: true });
  });

  test('rejects a wrong scalar type, including a non-integer number for "integer"', () => {
    assert.equal(validateToolArguments(schema, { query: 1 }).ok, false);
    assert.equal(validateToolArguments(schema, { query: 'x', limit: 1.5 }).ok, false);
  });

  test('rejects a value outside a declared enum', () => {
    const r = validateToolArguments(schema, { query: 'x', mode: 'medium' });
    assert.equal(r.ok, false);
    assert.match(r.message, /enum/);
  });

  test('rejects a wrong array item type and a non-array', () => {
    assert.equal(validateToolArguments(schema, { query: 'x', tags: [1] }).ok, false);
    assert.equal(validateToolArguments(schema, { query: 'x', tags: 'a' }).ok, false);
  });

  test('rejects a nested object missing its own required field', () => {
    const r = validateToolArguments(schema, { query: 'x', nested: {} });
    assert.equal(r.ok, false);
    assert.match(r.message, /arguments\.nested\.flag is required/);
  });

  test('rejects a non-object arguments value outright', () => {
    for (const bad of ['string', 42, null, [], true]) {
      assert.equal(validateToolArguments(schema, bad).ok, false);
    }
  });
});
