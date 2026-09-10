import { ApiError } from '../client.js';

function contract(message) {
  throw new ApiError({ kind: 'contract', message });
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) contract(`${path} must be an object`);
  return value;
}

function nullableString(value, path) {
  if (value !== null && value !== undefined && typeof value !== 'string') contract(`${path} must be a string or null`);
}

function requiredString(value, path) {
  if (typeof value !== 'string' || !value) contract(`${path} must be a non-empty string`);
}

function nullableNonNegativeInteger(value, path) {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    contract(`${path} must be a non-negative integer or null`);
  }
}

export function validateReaderNodeResponse(value) {
  const body = object(value, 'response');
  requiredString(body.collection, 'response.collection');
  const node = object(body.node, 'response.node');
  requiredString(node.nodePath, 'response.node.nodePath');
  requiredString(node.nodeType, 'response.node.nodeType');
  nullableString(node.sourceFile, 'response.node.sourceFile');
  if (node.headingPath !== undefined && (!Array.isArray(node.headingPath) || node.headingPath.some(v => typeof v !== 'string'))) {
    contract('response.node.headingPath must be an array of strings');
  }
  return body;
}

export function validateReaderAssemblyResponse(value) {
  const body = object(value, 'response');
  requiredString(body.collection, 'response.collection');
  if (body.scope !== 'file' && body.scope !== 'section') contract('response.scope must be "file" or "section"');
  nullableString(body.sourceFile, 'response.sourceFile');
  nullableString(body.nodePath, 'response.nodePath');
  if (!['entity_refs', 'placeholder_fallback', 'plain_chunks'].includes(body.assemblyMode)) {
    contract('response.assemblyMode is invalid');
  }
  if (!Array.isArray(body.segments)) contract('response.segments must be an array');
  if (!Array.isArray(body.warnings)) contract('response.warnings must be an array');
  for (const [index, warningValue] of body.warnings.entries()) {
    const warning = object(warningValue, `response.warnings[${index}]`);
    requiredString(warning.code, `response.warnings[${index}].code`);
    requiredString(warning.message, `response.warnings[${index}].message`);
  }
  for (const [index, segmentValue] of body.segments.entries()) {
    const segment = object(segmentValue, `response.segments[${index}]`);
    if (segment.kind !== 'prose' && segment.kind !== 'entity') contract(`response.segments[${index}].kind is invalid`);
    nullableNonNegativeInteger(segment.chunkIndex, `response.segments[${index}].chunkIndex`);
    nullableString(segment.nodeId, `response.segments[${index}].nodeId`);
    nullableString(segment.nodePath, `response.segments[${index}].nodePath`);
    nullableString(segment.nodeType, `response.segments[${index}].nodeType`);
    nullableString(segment.context, `response.segments[${index}].context`);
    nullableString(segment.section, `response.segments[${index}].section`);
    if (segment.headingPath !== null && (!Array.isArray(segment.headingPath) || segment.headingPath.some(v => typeof v !== 'string'))) {
      contract(`response.segments[${index}].headingPath must be an array of strings or null`);
    }
    if (segment.kind === 'prose') {
      if (typeof segment.text !== 'string') contract(`response.segments[${index}].text must be a string`);
    } else {
      nullableString(segment.rawContent, `response.segments[${index}].rawContent`);
      nullableString(segment.lang, `response.segments[${index}].lang`);
    }
  }
  return body;
}

export function validateReaderChunksResponse(value) {
  const body = object(value, 'response');
  requiredString(body.collection, 'response.collection');
  requiredString(body.sourceFile, 'response.sourceFile');
  nullableNonNegativeInteger(body.chunkIndex, 'response.chunkIndex');
  if (body.window !== null && (!Number.isInteger(body.window) || body.window < 0)) {
    contract('response.window must be a non-negative integer or null');
  }
  if (!Array.isArray(body.chunks)) contract('response.chunks must be an array');
  for (const [index, chunkValue] of body.chunks.entries()) {
    const chunk = object(chunkValue, `response.chunks[${index}]`);
    if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0) contract(`response.chunks[${index}].chunkIndex must be a non-negative integer`);
    if (typeof chunk.text !== 'string') contract(`response.chunks[${index}].text must be a string`);
  }
  return body;
}
