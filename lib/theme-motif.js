'use strict';

// A local lexical name, not a semantic theme or a shared vocabulary. Never
// learn aliases from unoffered candidates or turn arbitrary phrases into names.
const VERSION = 2;
const LIMITS = Object.freeze({ names: 3, chars: 1200, anchors: 288 });
// Pinned public-domain ordinary-English exclusion data; not learned themes.
// Read once, locally. No runtime dictionary service or classification call.
const ordinary = new Set(require('node:fs').readFileSync(require('node:path').join(__dirname, 'theme-common-words.txt'), 'utf8')
  .split(/\s+/).map(word => word.toLowerCase()).filter(word => /^[a-z]{8,32}$/.test(word)));
const COMMON = new Set(('important attention warning password passwords username usernames ' +
  'confidential information instructions instruction conversation conversations discussion discussions ' +
  'community communities everyone everybody something anything everything nothing ' +
  'absolutely definitely actually literally seriously obviously apparently ' +
  'reminder remember question questions response responses comments comment ' +
  'copyright disclaimer subscribe subscription notification notifications ' +
  'moderation moderator moderators administration announcement announcements ' +
  'breaking exclusive official emergency security verification authentication ' +
  'background foreground paragraph paragraphs familiarity established satiation ' +
  'evidence repeated optional interest lexical').split(' '));
const name = value => typeof value === 'string' && /^[a-z]{8,32}$/.test(value) && !COMMON.has(value) && !ordinary.has(value);

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
    .replace(/https?:\/\/\S+/gi, ' ').replace(/@[a-z0-9_-]+/gi, ' ');
}

function names(raw, limit = LIMITS.names) {
  if (!Array.isArray(raw) || raw.length > limit || raw.some(value => !name(value)) || new Set(raw).size !== raw.length) fail();
  return raw.slice();
}

function extract(value, known = []) {
  names(known, LIMITS.anchors);
  const text = clean(value);
  const words = [...text.matchAll(/[A-Za-z]+/g)].filter(word =>
    !/[A-Za-z0-9]/.test(text[word.index - 1] || '') && !/[A-Za-z0-9]/.test(text[word.index + word[0].length] || ''));
  const introduced = new Map();
  // All-uppercase prose/emphasis is not a naming signal. Require repeated,
  // isolated uppercase names in otherwise mixed/lowercase prose.
  const lowerWords = words.filter(item => /[a-z]/.test(item[0])).length;
  if (lowerWords >= 4 && lowerWords > words.length / 2) for (const word of words) {
    const canonical = word[0].toLowerCase();
    if (word[0] === word[0].toUpperCase() && name(canonical)) introduced.set(canonical, (introduced.get(canonical) || 0) + 1);
  }
  const allowed = new Set([...known, ...[...introduced].filter(([, count]) => count >= 2).map(([key]) => key)]);
  const result = new Set();
  for (let i = 0; i < words.length; i++) {
    const current = words[i][0].toLowerCase();
    if (allowed.has(current)) result.add(current);
    if (i + 1 < words.length && current.length >= 3 && words[i + 1][0].length >= 3) {
      const gap = text.slice(words[i].index + words[i][0].length, words[i + 1].index);
      const joined = current + words[i + 1][0].toLowerCase();
      // No arbitrary punctuation, clause joins, stemming, fuzzy edits or
      // independently invented split-word identities.
      if (/^(?:[ \t]{1,3}|[ \t]?[-_][ \t]?)$/.test(gap) && allowed.has(joined)) result.add(joined);
    }
  }
  return [...result].slice(0, LIMITS.names);
}

function normalize(raw) {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION ||
      Object.keys(raw).some(key => !['version', 'anchors'].includes(key)) ||
      !Array.isArray(raw.anchors) || raw.anchors.length > LIMITS.anchors) fail();
  const seen = new Set();
  const anchors = raw.anchors.map(item => {
    if (!item || Object.keys(item).sort().join(',') !== 'community,motif' || typeof item.community !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.community) || !name(item.motif)) fail();
    const key = item.community + ':' + item.motif;
    if (seen.has(key)) fail();
    seen.add(key);
    return { community: item.community, motif: item.motif };
  });
  return { version: VERSION, anchors };
}

function snapshot(state, at) {
  const anchors = new Map();
  for (const event of state.events) if (event.at <= at && at - event.at <= 7 * 24 * 60 * 60 * 1000 && event.identityVersion === VERSION) {
    for (const motif of names(event.motifs)) anchors.set(event.community + ':' + motif, { community: event.community, motif });
  }
  return normalize({ version: VERSION, anchors: [...anchors.values()] });
}

function local(raw, community) {
  return (normalize(raw)?.anchors || []).filter(item => item.community === community).map(item => item.motif);
}

function extend(raw, events) {
  const frozen = normalize(raw);
  if (!frozen) fail();
  const anchors = new Map(frozen.anchors.map(item => [item.community + ':' + item.motif, item]));
  for (const event of events) if (event.identityVersion === VERSION) for (const value of names(event.motifs)) {
    anchors.set(event.community + ':' + value, { community: event.community, motif: value });
  }
  return normalize({ version: VERSION, anchors: [...anchors.values()].slice(-LIMITS.anchors) });
}

module.exports = { VERSION, LIMITS, names, extract, normalize, snapshot, local, extend };
