'use strict';

// Bot-local lexical evidence, not a semantic topic classifier or an eligibility
// rule. Every retained item is a receipt for public evidence, never its prose.
const social = require('./social-relationships');

const VERSION = 1;
const LIMITS = Object.freeze({ events: 96, featuresPerEvent: 3, hintChars: 160, hintsPerMenu: 2, textChars: 1200 });
const HOUR = 60 * 60 * 1000;
const RETENTION = 7 * 24 * HOUR;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function failure(message, code = 'THEME_INTEREST_BOOKKEEPING_PENDING') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function version(value, fallback = 0) {
  const selected = value === undefined || value === null ? fallback : value;
  if (selected !== 0 && selected !== VERSION) throw failure('Unsupported theme-interest contract.', 'UNSUPPORTED_THEME_INTEREST');
  return selected;
}

function features(value) {
  const text = String(value || '').slice(0, LIMITS.textChars)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*$/g, ' ')
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/@[a-z0-9_-]+/gi, ' ');
  // The existing public-topic extractor supplies the shared stopword policy.
  // Adjacency of surviving terms is deliberately only a lexical proxy.
  const allowed = new Set(social.topicsFromText(text, 48).filter((term) => term.length <= 48));
  const terms = (text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []).filter((term) => allowed.has(term));
  const pairs = new Map();
  for (let i = 1; i < terms.length; i++) {
    if (terms[i - 1] === terms[i]) continue;
    const pair = [terms[i - 1], terms[i]].sort(compare);
    const key = pair.join('|');
    const prior = pairs.get(key);
    if (prior) prior.count++;
    else pairs.set(key, { pair, count: 1, first: i });
  }
  return [...pairs.values()].sort((a, b) => b.count - a.count || a.first - b.first || compare(a.pair.join('|'), b.pair.join('|')))
    .slice(0, LIMITS.featuresPerEvent).map((entry) => entry.pair);
}

function object(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
}

function validString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function publicKey(value, rootOnly = false) {
  return typeof value === 'string' && value.length <= 19 &&
    (rootOnly ? /^t3_[1-9]\d{0,15}$/ : /^t[13]_[1-9]\d{0,15}$/).test(value) &&
    Number.isSafeInteger(Number(value.slice(3)));
}

function receiptKeys(raw) {
  const rehearsal = typeof raw.sourceKey === 'string' && /^r3_[a-f0-9]{64}$/.test(raw.sourceKey);
  // A private rehearsal publication has no public ID. It can represent only
  // this bot's own use, never an independent encounter or a public thread.
  if (rehearsal) return raw.kind === 'participation' && raw.threadKey === raw.sourceKey;
  return publicKey(raw.sourceKey) && publicKey(raw.threadKey, true);
}

function event(raw) {
  if (!object(raw, ['id', 'at', 'kind', 'sourceKey', 'threadKey', 'community', 'author', 'features']) ||
      !validString(raw.id, 180) || !Number.isSafeInteger(raw.at) || raw.at < 1 ||
      !['exposure', 'participation'].includes(raw.kind) ||
      !receiptKeys(raw) ||
      typeof raw.community !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.community) ||
      typeof raw.author !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(raw.author) ||
      !Array.isArray(raw.features) || raw.features.length > LIMITS.featuresPerEvent) {
    throw failure('Invalid theme-interest receipt.');
  }
  const pairs = raw.features.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((term) => typeof term !== 'string' || !/^[a-z][a-z0-9_-]{2,47}$/.test(term)) || pair[0] === pair[1]) {
      throw failure('Invalid theme-interest lexical feature.');
    }
    return pair.slice().sort(compare);
  });
  if (new Set(pairs.map((pair) => pair.join('|'))).size !== pairs.length) throw failure('Duplicate theme-interest lexical feature.');
  return { id: raw.id, at: raw.at, kind: raw.kind, sourceKey: raw.sourceKey, threadKey: raw.threadKey,
    community: raw.community, author: raw.author.toLowerCase(), features: pairs };
}

function normalize(raw) {
  if (raw === undefined || raw === null) return { version: VERSION, events: [], floorAt: 0 };
  if (!object(raw, ['version', 'events', 'floorAt']) || raw.version !== VERSION ||
      !Array.isArray(raw.events) || raw.events.length > LIMITS.events ||
      !Number.isSafeInteger(raw.floorAt) || raw.floorAt < 0) throw failure('Invalid theme-interest state.');
  const events = raw.events.map(event).sort((a, b) => a.at - b.at || compare(a.id, b.id));
  if (new Set(events.map((item) => item.id)).size !== events.length || events.some((item) => item.at < raw.floorAt)) {
    throw failure('Inconsistent theme-interest state.');
  }
  return { version: VERSION, events, floorAt: raw.floorAt };
}

function record(raw, inputs) {
  const current = normalize(raw);
  if (!Array.isArray(inputs) || inputs.length > 32) throw failure('Invalid theme-interest receipt batch.');
  const merged = new Map(current.events.map((item) => [item.id, item]));
  for (const input of inputs) {
    const next = event(input);
    const prior = merged.get(next.id);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(next)) throw failure('Conflicting theme-interest receipt.');
      continue;
    }
    // A monotonic timestamp fence prevents evicted receipts from being replayed
    // into fresh evidence. Equal-time late receipts may be conservatively lost.
    if (next.at <= current.floorAt) continue;
    merged.set(next.id, next);
  }
  const events = [...merged.values()].sort((a, b) => a.at - b.at || compare(a.id, b.id));
  const latestAt = events.length ? events[events.length - 1].at : 0;
  const expired = events.filter((item) => latestAt - item.at > RETENTION);
  const retained = events.filter((item) => latestAt - item.at <= RETENTION);
  const evicted = expired.concat(retained.slice(0, Math.max(0, retained.length - LIMITS.events)));
  return { version: VERSION, events: retained.slice(-LIMITS.events),
    floorAt: Math.max(current.floorAt, ...evicted.map((item) => item.at)) };
}

function describe(raw, subject, options) {
  const current = normalize(raw);
  if (!options || !Number.isSafeInteger(options.at) || options.at < 1) throw failure('Theme-interest evaluation requires a frozen time.');
  const at = options.at;
  const keys = new Set(features(subject && subject.text).map((pair) => pair.join('|')));
  const matching = current.events.filter((item) => item.community === (subject && subject.community) &&
    item.at <= at && at - item.at <= RETENTION && item.features.some((pair) => keys.has(pair.join('|'))));
  const exposures = matching.filter((item) => item.kind === 'exposure');
  const uses = matching.filter((item) => item.kind === 'participation');
  const independent = new Map();
  const authors = new Set();
  for (const item of exposures) {
    const weight = Math.pow(0.5, (at - item.at) / (12 * HOUR));
    independent.set(item.sourceKey, Math.max(independent.get(item.sourceKey) || 0, weight));
    authors.add(item.author);
  }
  const familiarity = 1 - Math.exp(-[...independent.values()].reduce((sum, weight) => sum + weight, 0) / 3);
  const exposureWeight = exposures.reduce((sum, item) => sum + Math.pow(0.5, (at - item.at) / (24 * HOUR)), 0);
  const useWeight = uses.reduce((sum, item) => sum + Math.pow(0.5, (at - item.at) / (24 * HOUR)), 0);
  const satiation = 1 - Math.exp(-(0.04 * exposureWeight + 0.3 * useWeight));
  const interest = Math.max(-1, Math.min(1, 0.7 * familiarity - 0.9 * satiation));
  const known = matching.length > 0;
  let summary = '';
  if (known) {
    summary = 'Lexical familiarity: ' + (familiarity >= 0.5 ? 'established' : 'limited') +
      '; recent own use: ' + (useWeight >= 2 ? 'repeated' : useWeight > 0 ? 'some' : 'none') +
      '; satiation: ' + (satiation >= 0.5 ? 'elevated' : 'low') + '. Evidence only; WAIT remains valid.';
    // Even generic labels must not accidentally suggest a matching subject.
    const terms = features(subject.text).flat();
    if (terms.some((term) => summary.toLowerCase().split(/[^a-z0-9_-]+/).includes(term))) summary = '';
  }
  return { known, independentSources: independent.size, independentAuthors: authors.size,
    exposures: exposures.length, uses: uses.length, familiarity, satiation, interest, summary: summary.slice(0, LIMITS.hintChars) };
}

module.exports = { VERSION, LIMITS, version, features, normalize, record, describe };
