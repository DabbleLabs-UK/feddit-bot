'use strict';

// This version belongs to a logical turn, not the storage-file format. Missing
// versions on persisted turns must keep their original replay semantics.
const CURRENT_VERSION = 2;

function version(value, fallback = CURRENT_VERSION) {
  const selected = value == null ? fallback : value;
  if (selected !== 1 && selected !== CURRENT_VERSION) {
    const error = new Error('Unsupported durable decision contract version. No decision effects were applied.');
    error.code = 'UNSUPPORTED_DECISION_CONTRACT';
    throw error;
  }
  return selected;
}

function parseObject(text) {
  // Retain the established complete code-fence wrapper, but never extract an
  // embedded object, infer a direction, or accept duplicate JSON member names.
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // JSON.parse already validates syntax. Scan only structural tokens to
    // reject ambiguous repeated keys, including differently escaped spellings.
    const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) || [];
    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '{') stack.push(new Set());
      else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token[0] === '"' && tokens[i + 1] === ':') {
        const keys = stack[stack.length - 1];
        const key = JSON.parse(token);
        if (!keys || keys.has(key)) return null;
        keys.add(key);
      }
    }
    return parsed;
  } catch { return null; }
}

module.exports = { CURRENT_VERSION, version, parseObject };
