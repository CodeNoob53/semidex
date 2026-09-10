// Tool-definition validation for agent mode — the SUPPORTED JSON Schema
// SUBSET and nothing else.
//
// WHY A SUBSET, DECLARED EXPLICITLY
// ---------------------------------
// A tool's `inputSchema` is application-supplied and is forwarded to a model
// provider AND used to validate model-produced arguments before they reach
// an external executor. Both directions make silent partial support
// dangerous: a construct this file quietly ignored would be a constraint the
// application believes it declared and that nothing actually enforces.
//
// So the rule here is: an unsupported construct is REJECTED, never stripped
// and never ignored. Writing a full JSON Schema engine was rejected for the
// same reason: a partial engine that claims to be complete is worse than a
// small one that says exactly what it covers.
//
// SUPPORTED
//   - type: 'object'   + properties, required, additionalProperties
//   - type: 'array'    + items (a single sub-schema; tuple form is not supported)
//   - type: 'string' | 'number' | 'integer' | 'boolean'
//   - enum on any scalar type
//   - description (any node; ignored for validation, forwarded to the model)
//
// NOT SUPPORTED (rejected): $ref, $defs/definitions, allOf/anyOf/oneOf/not,
// if/then/else, patternProperties, propertyNames, dependencies/dependentX,
// const, format, contains, prefixItems/tuple items, type unions
// (`type: ['string','null']`), numeric/string/array constraints
// (minimum/maxLength/minItems/pattern/multipleOf/...), nullable, default.
//
// These are rejected rather than accepted-and-ignored precisely because
// several of them (const, format, pattern, minimum) LOOK like validation the
// caller can rely on.

/** The root of a tool inputSchema must be an object schema — a function's arguments are always a named-parameter map. */
const ROOT_TYPE = 'object';

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const SUPPORTED_TYPES = new Set([...SCALAR_TYPES, 'object', 'array']);

/** Keys this validator understands. Anything else in a schema node is a hard error. */
const ALLOWED_KEYS = new Set([
  'type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum',
]);

// Bounds — a tool definition is untrusted application input that is
// forwarded to a paid provider, so it is size-bounded before it ever gets
// there. Deliberately generous for real tools and hostile to pathological ones.
export const TOOL_LIMITS = Object.freeze({
  maxTools: 32,
  maxNameLength: 64,
  maxDescriptionLength: 1024,
  maxSchemaDepth: 5,
  maxSchemaNodes: 200,
  maxProperties: 50,
  maxEnumValues: 50,
  maxToolsJsonBytes: 64 * 1024,
});

// Gemini's own documented constraint on a FunctionDeclaration name (see the
// installed @google/genai FunctionDeclaration.name doc comment). Kept
// deliberately NARROWER than Gemini allows (no dots/colons/dashes) so a tool
// name is always a plain identifier that is safe to compare, log and use as
// an allowlist key.
const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ToolSchemaError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ToolSchemaError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ToolSchemaError(code, message);
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function matchesScalarType(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return false;
}

/**
 * Validates ONE schema node against the supported subset.
 * @param {unknown} node
 * @param {string} path dotted path for error messages
 * @param {{ depth: number, nodes: { count: number } }} ctx
 */
function validateNode(node, path, ctx) {
  if (ctx.depth > TOOL_LIMITS.maxSchemaDepth) {
    fail('schema_too_deep', `${path}: schema nesting exceeds the maximum depth of ${TOOL_LIMITS.maxSchemaDepth}.`);
  }
  ctx.nodes.count += 1;
  if (ctx.nodes.count > TOOL_LIMITS.maxSchemaNodes) {
    fail('schema_too_large', `Schema exceeds the maximum of ${TOOL_LIMITS.maxSchemaNodes} nodes.`);
  }

  if (!isPlainObject(node)) {
    fail('invalid_schema', `${path}: each schema node must be a plain object.`);
  }

  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYS.has(key)) {
      fail('unsupported_schema_keyword',
        `${path}: unsupported JSON Schema keyword "${key}". `
        + `Agent tool schemas support only: ${[...ALLOWED_KEYS].join(', ')}. `
        + 'Unsupported keywords are rejected rather than ignored, so a constraint you declare is always one that is actually enforced.');
    }
  }

  const { type } = node;
  if (typeof type !== 'string') {
    if (Array.isArray(type)) {
      fail('unsupported_schema_keyword', `${path}: union types (type as an array) are not supported. Declare exactly one type.`);
    }
    fail('invalid_schema', `${path}: "type" is required and must be a string.`);
  }
  if (!SUPPORTED_TYPES.has(type)) {
    fail('unsupported_schema_type', `${path}: unsupported type "${type}" (supported: ${[...SUPPORTED_TYPES].join(', ')}).`);
  }

  if (node.description !== undefined) {
    if (typeof node.description !== 'string') fail('invalid_schema', `${path}.description must be a string.`);
    if (node.description.length > TOOL_LIMITS.maxDescriptionLength) {
      fail('invalid_schema', `${path}.description exceeds ${TOOL_LIMITS.maxDescriptionLength} characters.`);
    }
  }

  if (node.enum !== undefined) {
    if (type === 'object' || type === 'array') {
      fail('unsupported_schema_keyword', `${path}: enum is supported only on scalar types (string/number/integer/boolean).`);
    }
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      fail('invalid_schema', `${path}.enum must be a non-empty array.`);
    }
    if (node.enum.length > TOOL_LIMITS.maxEnumValues) {
      fail('invalid_schema', `${path}.enum exceeds ${TOOL_LIMITS.maxEnumValues} values.`);
    }
    for (const [i, v] of node.enum.entries()) {
      if (!matchesScalarType(v, type)) {
        fail('invalid_schema', `${path}.enum[${i}] does not match the declared type "${type}".`);
      }
    }
  }

  if (type === 'object') {
    if (node.items !== undefined) fail('invalid_schema', `${path}: "items" is only valid on type "array".`);
    const properties = node.properties;
    if (properties !== undefined) {
      if (!isPlainObject(properties)) fail('invalid_schema', `${path}.properties must be an object.`);
      const names = Object.keys(properties);
      if (names.length > TOOL_LIMITS.maxProperties) {
        fail('schema_too_large', `${path}.properties exceeds the maximum of ${TOOL_LIMITS.maxProperties} properties.`);
      }
      for (const name of names) {
        validateNode(properties[name], `${path}.properties.${name}`, { depth: ctx.depth + 1, nodes: ctx.nodes });
      }
    }
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || !node.required.every((r) => typeof r === 'string')) {
        fail('invalid_schema', `${path}.required must be an array of strings.`);
      }
      const known = new Set(Object.keys(properties ?? {}));
      for (const r of node.required) {
        if (!known.has(r)) fail('invalid_schema', `${path}.required names "${r}", which is not declared in properties.`);
      }
      if (new Set(node.required).size !== node.required.length) {
        fail('invalid_schema', `${path}.required contains duplicate entries.`);
      }
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
      fail('unsupported_schema_keyword',
        `${path}.additionalProperties must be a boolean. A sub-schema value is not supported.`);
    }
    return;
  }

  if (type === 'array') {
    if (node.properties !== undefined || node.required !== undefined || node.additionalProperties !== undefined) {
      fail('invalid_schema', `${path}: properties/required/additionalProperties are only valid on type "object".`);
    }
    if (node.items === undefined) fail('invalid_schema', `${path}: type "array" requires "items".`);
    if (Array.isArray(node.items)) {
      fail('unsupported_schema_keyword', `${path}.items: tuple form (an array of schemas) is not supported; declare one item schema.`);
    }
    validateNode(node.items, `${path}.items`, { depth: ctx.depth + 1, nodes: ctx.nodes });
    return;
  }

  // Scalar
  if (node.properties !== undefined || node.required !== undefined
    || node.additionalProperties !== undefined || node.items !== undefined) {
    fail('invalid_schema', `${path}: properties/required/additionalProperties/items are not valid on scalar type "${type}".`);
  }
}

function deepFreezeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreezeValue(value[key]);
  return Object.freeze(value);
}

/**
 * Validates a single tool definition. Returns a frozen, normalized copy.
 * @param {unknown} tool
 * @param {string} path
 */
export function validateToolDefinition(tool, path = 'tools[]') {
  if (!isPlainObject(tool)) fail('invalid_tool', `${path} must be an object.`);

  const allowed = new Set(['name', 'description', 'inputSchema']);
  for (const key of Object.keys(tool)) {
    if (!allowed.has(key)) fail('invalid_tool', `${path}: unknown field "${key}" (expected: name, description, inputSchema).`);
  }

  const { name, description, inputSchema } = tool;
  if (typeof name !== 'string' || name.length === 0) fail('invalid_tool', `${path}.name is required and must be a non-empty string.`);
  if (name.length > TOOL_LIMITS.maxNameLength) fail('invalid_tool', `${path}.name exceeds ${TOOL_LIMITS.maxNameLength} characters.`);
  if (!TOOL_NAME_RE.test(name)) {
    fail('invalid_tool', `${path}.name "${name}" must be a plain identifier (letters, digits and underscore; not starting with a digit).`);
  }
  if (description !== undefined) {
    if (typeof description !== 'string') fail('invalid_tool', `${path}.description must be a string.`);
    if (description.length > TOOL_LIMITS.maxDescriptionLength) {
      fail('invalid_tool', `${path}.description exceeds ${TOOL_LIMITS.maxDescriptionLength} characters.`);
    }
  }
  if (inputSchema === undefined) fail('invalid_tool', `${path}.inputSchema is required.`);
  if (!isPlainObject(inputSchema)) fail('invalid_tool', `${path}.inputSchema must be an object.`);
  if (inputSchema.type !== ROOT_TYPE) {
    fail('invalid_schema', `${path}.inputSchema.type must be "${ROOT_TYPE}" — a tool's arguments are always a named-parameter map.`);
  }

  validateNode(inputSchema, `${path}.inputSchema`, { depth: 1, nodes: { count: 0 } });

  return Object.freeze({
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema: deepFreezeValue(structuredClone(inputSchema)),
  });
}

/**
 * Validates the whole tools array: per-tool validity, unique names, and the
 * aggregate size bound.
 * @param {unknown} tools
 * @returns {ReadonlyArray<{ name: string, description?: string, inputSchema: Object }>}
 */
export function validateToolDefinitions(tools) {
  if (!Array.isArray(tools)) fail('invalid_tool', 'tools must be an array.');
  if (tools.length === 0) fail('invalid_tool', 'tools must contain at least one tool definition.');
  if (tools.length > TOOL_LIMITS.maxTools) {
    fail('too_many_tools', `tools exceeds the maximum of ${TOOL_LIMITS.maxTools} definitions.`);
  }

  let serialized;
  try {
    serialized = JSON.stringify(tools);
  } catch {
    fail('invalid_tool', 'tools must be JSON-serializable.');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > TOOL_LIMITS.maxToolsJsonBytes) {
    fail('schema_too_large', `tools exceeds the maximum serialized size of ${TOOL_LIMITS.maxToolsJsonBytes} bytes.`);
  }

  const seen = new Set();
  const out = [];
  for (const [i, tool] of tools.entries()) {
    const normalized = validateToolDefinition(tool, `tools[${i}]`);
    if (seen.has(normalized.name)) fail('duplicate_tool_name', `tools[${i}]: duplicate tool name "${normalized.name}".`);
    seen.add(normalized.name);
    out.push(normalized);
  }
  return Object.freeze(out);
}

/**
 * Validates MODEL-PRODUCED arguments against a tool's inputSchema, using the
 * same supported subset. This is what stands between a model's output and an
 * external executor, so it is strict by default: an argument object that does
 * not match is REJECTED, never coerced or partially accepted.
 *
 * `additionalProperties` defaults to FALSE here even when the schema omits
 * it — JSON Schema's own default is true, but for a tool call an undeclared
 * argument is far more likely to be a model mistake than an intentional
 * extension, and forwarding it to an executor is exactly the kind of thing
 * this validation exists to prevent. A schema that genuinely wants extra
 * keys must say `additionalProperties: true` explicitly.
 *
 * @param {Object} inputSchema an already-validated schema
 * @param {unknown} args
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateToolArguments(inputSchema, args) {
  try {
    checkValue(args, inputSchema, 'arguments');
    return { ok: true };
  } catch (err) {
    if (err instanceof ToolSchemaError) return { ok: false, message: err.message };
    throw err;
  }
}

function checkValue(value, schema, path) {
  const { type } = schema;

  if (type === 'object') {
    if (!isPlainObject(value)) fail('invalid_arguments', `${path} must be an object.`);
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const name of required) {
      if (!Object.hasOwn(value, name)) fail('invalid_arguments', `${path}.${name} is required.`);
    }
    const allowAdditional = schema.additionalProperties === true;
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (!allowAdditional) {
          fail('invalid_arguments', `${path}.${key} is not declared in the tool schema (additionalProperties is not enabled).`);
        }
        continue;
      }
      checkValue(value[key], properties[key], `${path}.${key}`);
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) fail('invalid_arguments', `${path} must be an array.`);
    for (const [i, item] of value.entries()) checkValue(item, schema.items, `${path}[${i}]`);
    return;
  }

  if (!matchesScalarType(value, type)) {
    fail('invalid_arguments', `${path} must be of type "${type}".`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    fail('invalid_arguments', `${path} must be one of the declared enum values.`);
  }
}
