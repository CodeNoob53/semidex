// Ask API v2 — public request parsing/validation (pure, no I/O, no
// dependency injection). Structural ceilings enforced here are FIXED,
// non-configurable protocol constants — never read from SettingsService.
// The aggregate, operator-tunable history budget (ASK_HISTORY_MAX_CHARS
// and friends) is a genuinely different concept, consulted only later,
// inside conversation-context.js's budgetConversationContext() — conflating
// the two was an earlier draft's defect; this file must stay dependency-
// free and synchronous, matching v1's request.js exactly in that respect.
//
// Code review finding (P2), fixed: contract.js declares INVALID_CONVERSATION/
// INVALID_MESSAGE_ROLE/MESSAGE_TOO_LARGE as distinct, machine-readable error
// codes, but every validation failure here used to go through badRequest()
// unconditionally, which always hardcodes 'bad_request' — the declared codes
// were dead, unreachable contract surface. HttpError's own constructor
// already accepts an arbitrary code; badRequest() is just badRequest(message)
// = new HttpError(400, 'bad_request', message), so most failures still use
// it, but conversation-shaped/role/size failures now construct HttpError
// directly with the matching v2 code so a caller can actually distinguish
// them (e.g. retry after fixing a role vs. after fixing an oversized field).
import { badRequest, HttpError } from '../../http/http.js';
import { ERROR_CODES } from './contract.js';

function invalidConversation(message) {
  return new HttpError(400, ERROR_CODES.INVALID_CONVERSATION, message);
}

function invalidMessageRole(message) {
  return new HttpError(400, ERROR_CODES.INVALID_MESSAGE_ROLE, message);
}

function messageTooLarge(message) {
  return new HttpError(400, ERROR_CODES.MESSAGE_TOO_LARGE, message);
}

// Fixed, non-configurable structural ceiling on a single message's content
// length — a DoS/sanity bound checked at parse time, distinct from the
// aggregate ASK_HISTORY_MAX_CHARS setting (which governs only the TOTAL
// trimmed-history character budget, consumed later by
// conversation-context.js). Exported so tests/other modules can reference
// the same literal without duplicating it.
export const PROTOCOL_MAX_MESSAGE_CHARS = 50_000;
export const PROTOCOL_MAX_RECENT_MESSAGES = 200;
const PROTOCOL_MAX_SUMMARY_CHARS = 8_000;
const PROTOCOL_MAX_CONVERSATION_ID_CHARS = 256;

const KNOWN_ROOT_KEYS = new Set(['collection', 'question', 'conversation']);
const KNOWN_CONVERSATION_KEYS = new Set(['id', 'summary', 'recentMessages']);
const KNOWN_MESSAGE_KEYS = new Set(['role', 'content']);

function parseConversation(conversation) {
  if (conversation === null || typeof conversation !== 'object' || Array.isArray(conversation)) {
    throw invalidConversation('Body field "conversation" must be an object when provided');
  }

  const unknownKeys = Object.keys(conversation).filter((k) => !KNOWN_CONVERSATION_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw invalidConversation(`Body field "conversation" has unknown key(s): ${unknownKeys.join(', ')}. Only "id", "summary", and "recentMessages" are supported.`);
  }

  const { id, summary, recentMessages } = conversation;

  if (typeof id !== 'string' || id.trim() === '') {
    throw invalidConversation('Body field "conversation.id" is required and must be a non-empty string when "conversation" is present');
  }
  if (id.length > PROTOCOL_MAX_CONVERSATION_ID_CHARS) {
    throw invalidConversation(`Body field "conversation.id" must not exceed ${PROTOCOL_MAX_CONVERSATION_ID_CHARS} characters`);
  }

  if (summary !== undefined) {
    if (typeof summary !== 'string') {
      throw invalidConversation('Body field "conversation.summary" must be a string when provided');
    }
    if (summary.length > PROTOCOL_MAX_SUMMARY_CHARS) {
      throw invalidConversation(`Body field "conversation.summary" must not exceed ${PROTOCOL_MAX_SUMMARY_CHARS} characters`);
    }
  }

  let messages;
  if (recentMessages !== undefined) {
    if (!Array.isArray(recentMessages)) {
      throw invalidConversation('Body field "conversation.recentMessages" must be an array when provided');
    }
    if (recentMessages.length > PROTOCOL_MAX_RECENT_MESSAGES) {
      throw invalidConversation(`Body field "conversation.recentMessages" must not exceed ${PROTOCOL_MAX_RECENT_MESSAGES} entries`);
    }
    messages = recentMessages.map((message, index) => parseMessage(message, index));
  }

  return {
    id,
    ...(summary !== undefined ? { summary } : {}),
    ...(messages !== undefined ? { recentMessages: messages } : {}),
  };
}

function parseMessage(message, index) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw invalidConversation(`Body field "conversation.recentMessages[${index}]" must be an object`);
  }
  const unknownKeys = Object.keys(message).filter((k) => !KNOWN_MESSAGE_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw invalidConversation(`Body field "conversation.recentMessages[${index}]" has unknown key(s): ${unknownKeys.join(', ')}. Only "role" and "content" are supported.`);
  }
  const { role, content } = message;
  // Only 'user'/'assistant' are ever accepted — 'system'/'developer'/'tool'/
  // any unknown role is rejected outright. This is a deliberate, explicit
  // safety boundary: conversation history must never be able to smuggle a
  // system-role message that could be confused with Semidex's own system
  // instructions by a provider that concatenates roles into one channel.
  if (role !== 'user' && role !== 'assistant') {
    throw invalidMessageRole(`Body field "conversation.recentMessages[${index}].role" must be exactly "user" or "assistant" — got ${JSON.stringify(role)}`);
  }
  if (typeof content !== 'string' || content.trim() === '') {
    throw invalidConversation(`Body field "conversation.recentMessages[${index}].content" is required and must be a non-empty string`);
  }
  if (content.length > PROTOCOL_MAX_MESSAGE_CHARS) {
    throw messageTooLarge(`Body field "conversation.recentMessages[${index}].content" must not exceed ${PROTOCOL_MAX_MESSAGE_CHARS} characters`);
  }
  return { role, content };
}

/**
 * @param {unknown} body — parsed JSON request body
 * @returns {{ collection: string, question: string, conversation?: { id: string, summary?: string, recentMessages?: Array<{role,content}> } }}
 * @throws {HttpError} 400 — code is 'bad_request' for a malformed root body
 *   or missing/invalid collection/question; 'invalid_conversation' for a
 *   malformed conversation/message shape; 'invalid_message_role' for a
 *   role other than "user"/"assistant"; 'message_too_large' for a message
 *   exceeding PROTOCOL_MAX_MESSAGE_CHARS.
 */
export function parseAskRequestV2(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  const { collection, question, conversation } = body;

  const unknownKeys = Object.keys(body).filter((k) => !KNOWN_ROOT_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw badRequest(`Unknown body field(s): ${unknownKeys.join(', ')}. The v2 Ask API accepts only "collection", "question", and "conversation".`);
  }

  if (typeof collection !== 'string' || collection.trim() === '') {
    throw badRequest('Body field "collection" is required and must be a non-empty string');
  }
  if (typeof question !== 'string' || question.trim() === '') {
    throw badRequest('Body field "question" is required and must be a non-empty string');
  }

  const parsedConversation = conversation !== undefined ? parseConversation(conversation) : undefined;

  return {
    collection,
    question,
    ...(parsedConversation !== undefined ? { conversation: parsedConversation } : {}),
  };
}
