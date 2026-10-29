'use strict';

// Independent of JSON/decision semantics. Only newly frozen hosted reply turns
// opt in; raw provider results remain untouched for durable evidence/replay.
const VERSION = 1;
const EOS = /(?:<\|im_end\|>|\|im_end\|>)\s*$/;
const CONTROL = /<?\|im_(?:end|start)\|>?/g;

function version(value) {
  if (value == null || value === 0) return 0;
  if (value === VERSION) return VERSION;
  throw Object.assign(new Error('Unsupported frozen hosted reply output boundary.'), { code: 'UNSUPPORTED_HOSTED_OUTPUT' });
}

function invalid(code) {
  throw Object.assign(new Error('Hosted reply contained out-of-band framing or model self-instructions. Nothing was published; no regeneration was requested.'), { code });
}

function decisionText(value) {
  let text = String(value || '').trim();
  // Remove only exact terminal protocol tokens, never surrounding prose,
  // embedded objects, incomplete tokens, punctuation or missing JSON fields.
  for (let n = 0; n < 8 && EOS.test(text); n++) text = text.replace(EOS, '').trimEnd();
  return text;
}

function literalMask(text) {
  const mask = new Uint8Array(text.length);
  const mark = (a, b) => mask.fill(1, a, b);
  let fence = null, offset = 0;
  for (const line of text.split('\n')) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      mark(offset, offset + line.length);
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
    } else if (opener) { fence = opener[1]; mark(offset, offset + line.length); }
    else if (/^(?:\s*>| {4}|\t)/.test(line)) mark(offset, offset + line.length);
    offset += line.length + 1;
  }
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) continue;
    const opening = text[i];
    if (opening === '`') {
      let width = 1;
      while (text[i + width] === '`') width++;
      let end = i + width;
      for (; end < text.length; end++) {
        if (text[end] !== '`') continue;
        let closingWidth = 1;
        while (text[end + closingWidth] === '`') closingWidth++;
        if (closingWidth === width) break;
        end += closingWidth - 1;
      }
      mark(i, Math.min(text.length, end + width));
      i = end + width - 1;
      continue;
    }
    if (!['`', '"', "'", '\u201c', '\u2018'].includes(opening)) continue;
    if (opening === "'" && /[\p{L}\p{N}]/u.test(text[i - 1] || '')) continue;
    if (text[i - 1] === '\\') continue;
    const closing = opening === '\u201c' ? '\u201d' : opening === '\u2018' ? '\u2019' : opening;
    let end = i + 1;
    for (; end < text.length; end++) {
      if (text[end] !== closing || text[end - 1] === '\\') continue;
      if (opening === "'" && /[\p{L}\p{N}]/u.test(text[end + 1] || '')) continue;
      break;
    }
    // Unclosed quotations/code are ambiguous, not permission to edit prose.
    mark(i, Math.min(text.length, end + 1));
    i = end;
  }
  return mask;
}

function discussed(text, at) {
  // A literal delimiter may legitimately be discussed in public. Ambiguous
  // metalinguistic prose is retained, not censored for containing the token.
  const prefix = text.slice(Math.max(0, at - 100), at);
  return /\b(?:token|marker|delimiter|literal|string|tags?|ChatML)\b[^\n.!?]{0,80}$/i.test(prefix) ||
    /\b(?:spell|type|write|print|use)\s*$/i.test(prefix);
}

function publicReply(value, { community = '' } = {}) {
  const source = String(value || '');
  const raw = source.trim();
  if (!raw || raw.length > 10000) invalid('HOSTED_PUBLIC_OUTPUT_SIZE');
  const leading = source.length - source.trimStart().length;
  const mask = literalMask(source).subarray(leading, leading + raw.length);
  const note = /(?:^|\n|\\n)\s*Note:\s*/g;
  for (const match of raw.matchAll(note)) {
    const start = match.index + match[0].indexOf('Note:');
    if (mask[start]) continue;
    const introduction = raw.slice(Math.max(0, start - 160), start);
    if (/\b(?:quoted?|quoting|example|instruction|annotation|text)\b[^\n]{0,100}:\s*(?:\n|\\n)\s*$/i.test(introduction)) continue;
    const tail = raw.slice(start);
    const signs = [
      /This is my first response in (?:the|this) thread\b/i,
      /I(?:'m| am) using the provided context\b/i,
      /I(?:'m| am) playing the role of\b/i,
      /The goal is to create a new thread of conversation\b/i,
    ].filter(pattern => {
      return [...tail.matchAll(new RegExp(pattern.source, 'ig'))]
        .some(clause => !mask[start + clause.index]);
    });
    if (signs.length >= 2) invalid('HOSTED_PUBLIC_OUTPUT_META');
  }
  let text = raw;
  for (let n = 0; n < 8; n++) {
    const end = EOS.exec(text);
    if (!end || mask[end.index] || discussed(text, end.index)) break;
    text = text.slice(0, end.index).trimEnd();
  }
  if (!text) invalid('HOSTED_PUBLIC_OUTPUT_SIZE');
  const tags = /\|Feddit\|\s+\|([A-Za-z0-9_-]+)\|\s+\|f\/[A-Za-z0-9_-]+\|\s*$/.exec(text);
  if (tags && tags[1].toLowerCase() === String(community).replace(/^f\//, '').toLowerCase() &&
      !mask[tags.index] && !discussed(text, tags.index)) invalid('HOSTED_PUBLIC_OUTPUT_FRAMING');
  for (const match of text.matchAll(CONTROL)) {
    if (!mask[match.index] && !discussed(text, match.index)) invalid('HOSTED_PUBLIC_OUTPUT_FRAMING');
  }
  return { version: VERSION, text, framingRemoved: text !== raw };
}

module.exports = { VERSION, version, decisionText, publicReply };
