'use strict';

const contract = require('./decision-contract');
const VERSION = 1;

function version(value) {
  if (value == null || value === 0) return 0;
  if (value === VERSION) return VERSION;
  throw Object.assign(new Error('Unsupported frozen hosted decision envelope. No decision effects were applied.'),
    { code: 'UNSUPPORTED_HOSTED_DECISION_ENVELOPE' });
}

function fields(object, names) {
  return object && Object.keys(object).length === names.length && names.every(name => Object.hasOwn(object, name));
}

function completeDecision(text) {
  try { JSON.parse(text); } catch { return false; }
  const object = contract.parseObject(text);
  return fields(object, ['choice', 'reason', 'votes']) && typeof object.choice === 'string' &&
    typeof object.reason === 'string' && Array.isArray(object.votes);
}

function decode(value, { outputTokens, outputLimit } = {}) {
  const text = String(value || '').trim();
  const unchanged = { text, repair: null };
  // Never reinterpret already valid JSON, prose, code fences or exhausted output.
  // The semantic validator below this boundary remains the only action/vote authority.
  if (contract.parseObject(text) || !Number.isInteger(outputTokens) || outputTokens < 1 ||
      !Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > 4096 || outputTokens >= outputLimit ||
      text.length > 32000 || !text.startsWith('{')) return unchanged;
  const alternatives = [];
  // Only the outer object may be unfinished. A strict parse must prove all
  // existing strings, members, arrays and vote objects already complete.
  if (text.endsWith(']') && completeDecision(text + '}')) {
    alternatives.push({ text: text + '}', repair: 'missing-root-close' });
  }
  // The attested malformed key has its closing quote, colon and array opener.
  // Parsing the primary prefix proves this location is outside a quoted reason.
  for (const match of text.matchAll(/,\s*votes"\s*:\s*\[/g)) {
    const prefix = contract.parseObject(text.slice(0, match.index) + '}');
    if (!fields(prefix, ['choice', 'reason']) || typeof prefix.choice !== 'string' || typeof prefix.reason !== 'string') continue;
    const at = match.index + match[0].indexOf('votes');
    const repaired = text.slice(0, at) + '"' + text.slice(at);
    if (completeDecision(repaired)) alternatives.push({ text: repaired, repair: 'missing-votes-key-opening-quote' });
  }
  // No best-effort salvage or composition of repairs. Ambiguity fails closed.
  return alternatives.length === 1 ? alternatives[0] : unchanged;
}

module.exports = { VERSION, version, decode };
