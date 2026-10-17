'use strict';

// Shortlist presentation is not consideration, publication or social state.
const VERSION = 1;
const ENTRY_CAP = 512;
const SHORTLIST_LIMIT = 3;

function version(raw, fallback = 0) {
  const selected = raw == null ? fallback : raw;
  if (selected !== 0 && selected !== VERSION) {
    const error = new Error('Unsupported ordinary-candidate contract version. No shortlist state was changed.');
    error.code = 'UNSUPPORTED_ORDINARY_CANDIDATES';
    throw error;
  }
  return selected;
}

function defaults() {
  return { version: VERSION, entries: [] };
}

function key(raw) {
  return typeof raw === 'string' && raw.length <= 64 && /^t[13]_[0-9]+$/.test(raw) ? raw : '';
}

function normalize(raw) {
  if (raw && raw.version != null) version(raw.version);
  const entries = new Map();
  for (const entry of (raw && Array.isArray(raw.entries) ? raw.entries : [])) {
    if (!entry || !key(entry.key) || !Number.isFinite(entry.at) || entry.at <= 0) continue;
    entries.set(entry.key, Math.max(entries.get(entry.key) || 0, entry.at));
  }
  return {
    version: VERSION,
    entries: [...entries].map(([identity, at]) => ({ key: identity, at }))
      .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(-ENTRY_CAP),
  };
}

function select(sources, state, limit = SHORTLIST_LIMIT) {
  const maximum = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, SHORTLIST_LIMIT) : SHORTLIST_LIMIT;
  const timestamps = new Map(normalize(state).entries.map((entry) => [entry.key, entry.at]));
  const ranked = (name) => (sources && Array.isArray(sources[name]) ? sources[name] : [])
    .filter((candidate) => candidate && key(candidate.key))
    .map((candidate, order) => ({ candidate, order, at: timestamps.get(candidate.key) || 0 }))
    .sort((a, b) => a.at - b.at || a.order - b.order).map((entry) => entry.candidate);
  const roots = ranked('roots');
  const own = ranked('own');
  const nearby = ranked('nearby');
  const selected = [];
  const seen = new Set();
  const take = (pool) => {
    while (pool.length) {
      const candidate = pool.shift();
      if (seen.has(candidate.key)) continue;
      seen.add(candidate.key);
      selected.push(candidate);
      return true;
    }
    return false;
  };
  while (selected.length < maximum && (roots.length || own.length)) {
    take(roots);
    if (selected.length < maximum) take(own);
  }
  while (selected.length < maximum && take(nearby)) { /* Fill only otherwise unused slots. */ }
  return selected;
}

function receipt(selected, at) {
  if (!Number.isFinite(at) || at <= 0) throw new Error('A positive ordinary-candidate timestamp is required.');
  const keys = [];
  for (const candidate of (Array.isArray(selected) ? selected : [])) {
    const identity = key(candidate && candidate.key);
    if (identity && !keys.includes(identity)) keys.push(identity);
    if (keys.length === SHORTLIST_LIMIT) break;
  }
  return { version: VERSION, at, keys };
}

function record(state, rawReceipt) {
  if (!rawReceipt || version(rawReceipt.version) !== VERSION || !Number.isFinite(rawReceipt.at) || rawReceipt.at <= 0 ||
      !Array.isArray(rawReceipt.keys) || rawReceipt.keys.length > SHORTLIST_LIMIT ||
      rawReceipt.keys.some((identity) => !key(identity)) || new Set(rawReceipt.keys).size !== rawReceipt.keys.length) {
    throw new Error('A valid ordinary-candidate shortlist receipt is required.');
  }
  const current = normalize(state);
  return normalize({ version: VERSION, entries: current.entries.concat(
    rawReceipt.keys.map((identity) => ({ key: identity, at: rawReceipt.at })),
  ) });
}

module.exports = { VERSION, ENTRY_CAP, SHORTLIST_LIMIT, version, defaults, normalize, select, receipt, record };
