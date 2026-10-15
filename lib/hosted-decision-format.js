'use strict';

// Independent from prompt construction and semantic decision contracts. Only
// offered stable IDs cross the durable boundary, never a caller-supplied schema.
const VERSION = 2;

// Canonical single spaces make the length constraint match validReason's
// normalized length. Keep every JavaScript whitespace character out of words.
// Native grammar backends may not enforce combined pattern/minLength keywords;
// the existing semantic validator remains authoritative after generation.
const REASON_WORD = '[^\\t\\n\\u000b\\u000c\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+';
const REASON_PATTERN = '^' + REASON_WORD + '( ' + REASON_WORD + '){2,}$';

function failure(message, code = 'HOSTED_DECISION_FORMAT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function version(value) {
  if (value == null) return 0; // Frozen legacy turns have no native format.
  if (value === 0 || value === 1 || value === VERSION) return value;
  throw failure('Unsupported hosted decision format version. The durable turn remains blocked.', 'UNSUPPORTED_HOSTED_DECISION_FORMAT');
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 3 || !['version', 'candidateIds', 'voteIds'].every((key) => Object.hasOwn(value, key))) {
    throw failure('Unsupported or malformed hosted decision format descriptor. No inference was sent.');
  }
  const formatVersion = version(value.version);
  if (!formatVersion) throw failure('Hosted decision format descriptor requires a native version. No inference was sent.');
  function ids(items, prefix, limit) {
    if (!Array.isArray(items) || items.length > limit) throw failure('Invalid hosted decision format slate. No inference was sent.');
    const pattern = new RegExp('^' + prefix + '[1-9][0-9]*$');
    const result = [];
    for (const item of items) {
      if (typeof item !== 'string' || item.length > 16 || item.trim() !== item || !pattern.test(item) ||
          Number(item.slice(1)) > limit || result.includes(item)) {
        throw failure('Invalid or duplicate hosted decision format candidate ID. No inference was sent.');
      }
      result.push(item);
    }
    return result;
  }
  const candidateIds = ids(value.candidateIds, 'C', 12);
  const voteIds = ids(value.voteIds, 'V', 8);
  if (!candidateIds.length && !voteIds.length) throw failure('Hosted decision format has no offered candidates. No inference was sent.');
  return { version: formatVersion, candidateIds, voteIds };
}

function schema(value) {
  const descriptor = validate(value);
  function vote(id, directions, reason) {
    return {
      type: 'object',
      properties: {
        id: { type: 'string', enum: [id] },
        direction: { type: 'string', enum: directions },
        reason,
      },
      required: ['id', 'direction', 'reason'],
      additionalProperties: false,
    };
  }
  const votes = descriptor.voteIds.map((id) => descriptor.version === 1 ?
    vote(id, ['up', 'down', 'nil'], { type: 'string' }) :
    { oneOf: [
      vote(id, ['up', 'down'], { type: 'string', minLength: 15, pattern: REASON_PATTERN }),
      vote(id, ['nil'], { type: 'string' }),
    ] });
  return {
    type: 'object',
    properties: {
      choice: { type: 'string', enum: ['WAIT', ...descriptor.candidateIds] },
      reason: { type: 'string' },
      votes: {
        type: 'array',
        items: votes.length ? votes : { type: 'object' },
        minItems: votes.length,
        maxItems: votes.length,
        additionalItems: false,
      },
    },
    required: ['choice', 'reason', 'votes'],
    additionalProperties: false,
  };
}

module.exports = { VERSION, version, failure, validate, schema };
