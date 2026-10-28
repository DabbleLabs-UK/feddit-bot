'use strict';

// Proposals are not themes: only this bot's independently handled public
// encounters can corroborate a phrase. No public catalogue or semantic lookup.
const legacy = require('./theme-motif');
const social = require('./social-relationships');
const VERSION = 3;
const LIMITS = Object.freeze({ names: 3, chars: 1200, anchors: 288, pending: 288 });
const ordinary = new Set(require('node:fs').readFileSync(require('node:path').join(__dirname, 'theme-common-words.txt'), 'utf8')
  .split(/\s+/).map(word => word.toLowerCase()).filter(Boolean));
const modifiers = new Set(('a an the new old your our their his her its this that these those my ' +
  'some any every each another other first last next previous dear hello thank thanks ' +
  'and or but nor for with from into onto about before after without within ' +
  'is are was were be been being has have had does did can could would should will ' +
  'please important warning attention official breaking chapter section title ' +
  'non not never ever just still even very most more less least only really ' +
  'bot bots sir lady lord duke dame doctor professor mister miss mrs ms').split(' '));
// The pinned dictionary is headword-oriented. Ordinary plural exclusions do
// not stem motif identities or create aliases; they only reject weak proposals.
const ordinaryBase = word => ordinary.has(word) ||
  (word.endsWith('s') && ordinary.has(word.slice(0, -1))) ||
  (word.endsWith('es') && ordinary.has(word.slice(0, -2))) ||
  (word.endsWith('ies') && ordinary.has(word.slice(0, -3) + 'y')) ||
  (word.endsWith('ed') && (ordinary.has(word.slice(0, -2)) || ordinary.has(word.slice(0, -1)))) ||
  (word.endsWith('ing') && (ordinary.has(word.slice(0, -3)) || ordinary.has(word.slice(0, -3) + 'e')));
const ordinaryWord = word => ordinaryBase(word) ||
  (/^(?:un|non)/.test(word) && ordinaryBase(word.replace(/^(?:un|non)/, ''))) ||
  Array.from({ length: Math.max(0, word.length - 5) }, (_, index) => index + 3)
    .some(index => ordinary.has(word.slice(0, index)) && ordinary.has(word.slice(index)));
const phrase = value => typeof value === 'string' && /^[a-z]{3,}~[a-z]{3,}(?:~[a-z]{3,})?$/.test(value) &&
  value.replace(/~/g, '').length >= 8 && value.replace(/~/g, '').length <= 32 &&
  value.split('~').every(word => !modifiers.has(word) &&
    (word.length < 4 || social.topicsFromText(word, 1).includes(word))) &&
  value.split('~').some(word => !ordinaryWord(word));
const single = value => {
  try { legacy.names([value]); return true; } catch { return false; }
};
const valid = value => phrase(value) || single(value);
const community = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const publicKey = value => typeof value === 'string' && /^t[13]_[1-9]\d{0,15}$/.test(value) &&
  Number.isSafeInteger(Number(value.slice(3)));
const author = value => typeof value === 'string' && /^[a-z0-9_-]{1,128}$/.test(value);
const sourceKey = (value, kind) => publicKey(value) ||
  (kind === 'participation' && typeof value === 'string' && /^r3_[a-f0-9]{64}$/.test(value));

function fail() {
  const error = new Error('Invalid frozen theme motif identity.');
  error.code = 'THEME_INTEREST_BOOKKEEPING_PENDING';
  throw error;
}

function clean(value) {
  return String(value || '').slice(0, LIMITS.chars)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/<[^>]*$/g, ' ')
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ').replace(/@[a-z0-9_-]+/gi, ' ')
    .replace(/(\*{1,3}|_{1,3})([A-Za-z][A-Za-z \t-]{0,80})\1/g, '$2');
}

function names(raw, limit = LIMITS.names) {
  if (!Array.isArray(raw) || raw.length > limit || raw.some(value => !valid(value)) || new Set(raw).size !== raw.length) fail();
  return raw.slice();
}

function knownMatches(text, known) {
  const found = [];
  for (const value of known.filter(phrase)) {
    const pattern = value.split('~').join('(?:[ \\t]{1,3}|[ \\t]?[-_][ \\t]?)');
    if (new RegExp('(?<![A-Za-z0-9_-])' + pattern + '(?![A-Za-z0-9_-])(?![\'\u2019](?!s\\b)[A-Za-z])', 'i').test(text)) found.push(value);
  }
  // A camel token retains its segmentation. Do not make concatenated aliases
  // that merge two different names merely because their letters happen to fit.
  for (const token of text.matchAll(/(?<![A-Za-z0-9_-])[A-Z][a-z]{2,}(?:[A-Z][a-z]{2,}){1,2}(?![A-Za-z0-9_-])(?!['\u2019](?![sS]\b)[A-Za-z])/g)) {
    const value = token[0].match(/[A-Z][a-z]+/g).join('~').toLowerCase();
    if (known.includes(value)) found.push(value);
  }
  return found;
}

function propose(value, known = []) {
  names(known, LIMITS.anchors + LIMITS.pending);
  const text = clean(value);
  const result = new Set(knownMatches(text, known));
  // All-title headings are not naming evidence. Weak isolated capitalisation
  // must occur within ordinary prose before it is even a pending proposal.
  for (const line of text.split(/[\r\n]+/)) {
    const words = [...line.matchAll(/[A-Za-z]+/g)];
    if (words.filter(word => /^[a-z]+$/.test(word[0])).length < 2) continue;
    for (const run of line.matchAll(/(?<![A-Za-z0-9_-])(?:[A-Z][a-z]{2,}(?:[ \t]{1,3}|[ \t]?[-_][ \t]?)){1,}[A-Z][a-z]{2,}(?![A-Za-z0-9_-])(?!['\u2019](?![sS]\b)[A-Za-z])/g)) {
      const parts = run[0].match(/[A-Z][a-z]+/g);
      if (parts.length < 2 || parts.length > 3) continue;
      const canonical = parts.join('~').toLowerCase();
      if (phrase(canonical)) result.add(canonical);
    }
    for (const token of line.matchAll(/(?<![A-Za-z0-9_-])[A-Z][a-z]{2,}(?:[A-Z][a-z]{2,}){1,2}(?![A-Za-z0-9_-])(?!['\u2019](?![sS]\b)[A-Za-z])/g)) {
      const canonical = token[0].match(/[A-Z][a-z]+/g).join('~').toLowerCase();
      if (phrase(canonical)) result.add(canonical);
    }
  }
  return [...result].slice(0, LIMITS.names);
}

function extract(value, known = []) {
  names(known, LIMITS.anchors);
  return [...new Set([...legacy.extract(value, known.filter(single)), ...knownMatches(clean(value), known)])].slice(0, LIMITS.names);
}

function normalize(raw) {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION ||
      Object.keys(raw).sort().join(',') !== 'anchors,pending,version' || !Array.isArray(raw.anchors) ||
      raw.anchors.length > LIMITS.anchors || !Array.isArray(raw.pending) || raw.pending.length > LIMITS.pending) fail();
  const seen = new Set();
  const anchors = raw.anchors.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'community,motif' || !community(item.community) || !valid(item.motif)) fail();
    const key = item.community + ':' + item.motif;
    if (seen.has(key)) fail();
    seen.add(key);
    return { community: item.community, motif: item.motif };
  });
  const pendingSeen = new Set();
  const pending = raw.pending.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'author,community,kind,motif,sourceKey' ||
        !community(item.community) || !phrase(item.motif) || !sourceKey(item.sourceKey, item.kind) || !author(item.author) ||
        !['exposure', 'participation'].includes(item.kind)) fail();
    const key = item.community + ':' + item.motif + ':' + item.sourceKey;
    if (pendingSeen.has(key)) fail();
    pendingSeen.add(key);
    return { community: item.community, motif: item.motif, sourceKey: item.sourceKey, author: item.author, kind: item.kind };
  });
  return { version: VERSION, anchors, pending };
}

function local(raw, target) {
  return (normalize(raw)?.anchors || []).filter(item => item.community === target).map(item => item.motif);
}

function proposed(raw, target) {
  const state = normalize(raw);
  return [...new Set([...(state?.anchors || []), ...(state?.pending || [])]
    .filter(item => item.community === target).map(item => item.motif))];
}

function extend(raw, events) {
  const frozen = normalize(raw);
  if (!frozen || !Array.isArray(events) || events.length > 96) fail();
  const anchors = new Map(frozen.anchors.map(item => [item.community + ':' + item.motif, item]));
  const pending = new Map(frozen.pending.map(item => [item.community + ':' + item.motif + ':' + item.sourceKey, item]));
  for (const event of events) {
    if (event.identityVersion !== 2 && event.identityVersion !== VERSION) continue;
    if (!community(event.community)) fail();
    const approved = event.identityVersion === 2 ? legacy.names(event.motifs) : names(event.motifs);
    for (const motif of approved) anchors.set(event.community + ':' + motif, { community: event.community, motif });
    if (event.identityVersion !== VERSION) continue;
    if (!['exposure', 'participation'].includes(event.kind)) fail();
    if (!sourceKey(event.sourceKey, event.kind) || !author(event.author)) fail();
    for (const motif of names(event.proposals)) {
      if (!phrase(motif)) fail();
      const item = { community: event.community, motif, sourceKey: event.sourceKey, author: event.author, kind: event.kind };
      const key = event.community + ':' + motif + ':' + event.sourceKey;
      const prior = pending.get(key);
      if (prior && (prior.author !== item.author || prior.kind !== item.kind)) fail();
      pending.set(key, item);
    }
  }
  const bounded = [...pending.values()].slice(-LIMITS.pending);
  const evidence = new Map();
  for (const item of bounded.filter(item => item.kind === 'exposure')) {
    const key = item.community + ':' + item.motif;
    if (!evidence.has(key)) evidence.set(key, []);
    evidence.get(key).push(item);
  }
  for (const [key, items] of evidence) if (new Set(items.map(item => item.sourceKey)).size >= 2 && new Set(items.map(item => item.author)).size >= 2) {
    anchors.set(key, { community: items[0].community, motif: items[0].motif });
  }
  return normalize({ version: VERSION, anchors: [...anchors.values()].slice(-LIMITS.anchors), pending: bounded });
}

function snapshot(state, at) {
  if (!state || !Array.isArray(state.events) || state.events.length > 96 || !Number.isSafeInteger(at) || at < 1) fail();
  return extend({ version: VERSION, anchors: [], pending: [] },
    state.events.filter(event => event.at <= at && at - event.at <= 7 * 24 * 60 * 60 * 1000));
}

function matches(event, subjectMotifSet) {
  if (event.identityVersion === 2) return legacy.names(event.motifs).some(value => subjectMotifSet.has(value));
  if (event.identityVersion !== VERSION) return false;
  return [...names(event.motifs), ...names(event.proposals)].some(value => subjectMotifSet.has(value));
}

module.exports = { VERSION, LIMITS, names, propose, extract, normalize, snapshot, local, proposed, extend, matches };
