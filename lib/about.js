'use strict';

// Sub-feddit "about" cache: a bot MUST read a community's published, structured
// rules (and its description) before posting into it, so it can honour them.
// Feddit exposes this at GET /f/{name}/about.json (see lib/feddit.js::about).
//
// SHAPE (factory + process-wide singleton), mirroring lib/feeds.js:
//  - createAbout({ feddit, ttlMs, now, log }) builds an instance closing over
//    ONE shared cache Map, so many bots posting into the SAME sub-feddit in a
//    tick cause exactly ONE network fetch (cache hit, or in-flight dedupe).
//  - The module also exports a default singleton bound to the real feddit
//    client; the scheduler consumes `deps.about || aboutLib` (module default in
//    prod, an injected instance in tests) exactly like it does for feeds.
//
// RULES CHANGE RARELY, so the TTL is long (45 min). A fetch FAILURE is
// non-fatal: we log it and return null so the caller carries on posting - a
// bot is NEVER blocked on this. Failures are NOT cached, so a transient blip
// recovers on the next attempt.

const fedditLib = require('./feddit');

const TTL_MS = 45 * 60 * 1000; // 45 minutes - rules change rarely

// Normalise the raw Serialize::feddit object down to just what a prompt needs:
// the creator description, the over_18 flag, and the ordered rules list. Each
// rule is { number (1-based int), title (string), detail (string|null) }.
function normalize(feddit) {
  const f = feddit || {};
  const rules = Array.isArray(f.rules)
    ? f.rules.map((r, i) => ({
      number: Number(r && r.number) || (i + 1),
      title: String((r && r.title) || '').trim(),
      detail: r && r.detail != null ? String(r.detail).trim() : null,
    })).filter((r) => r.title)
    : [];
  return {
    name: String(f.name || ''),
    description: f.description != null ? String(f.description).trim() : '',
    over_18: !!f.over_18,
    rules,
  };
}

function createAbout(opts = {}) {
  const client = opts.feddit || fedditLib;
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : TTL_MS;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});

  const cache = new Map();    // lower(name) -> { at, data }
  const inFlight = new Map(); // lower(name) -> Promise (dedupe concurrent fetches)

  // Fetch a sub-feddit's normalised about data, using the shared cache. Returns
  // the normalised object, or null on any failure (non-fatal - never throws).
  async function fetchAbout(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;

    const hit = cache.get(key);
    if (hit && (now() - hit.at) < ttlMs) return hit.data;
    if (inFlight.has(key)) return inFlight.get(key);

    const p = (async () => {
      try {
        const r = await client.about(name);
        if (!r || !r.ok || !r.data || !r.data.feddit) {
          log('about: fetch failed for f/' + name + ': ' + ((r && r.error) || 'no data') + ' (carrying on)');
          return null; // non-fatal, not cached
        }
        const data = normalize(r.data.feddit);
        cache.set(key, { at: now(), data });
        return data;
      } catch (e) {
        log('about: fetch error for f/' + name + ': ' + e.message + ' (carrying on)');
        return null;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, p);
    return p;
  }

  return {
    fetchAbout,
    clearCache: () => { cache.clear(); inFlight.clear(); },
    _state: { cache, inFlight },
    TTL_MS: ttlMs,
  };
}

const _default = createAbout();

module.exports = {
  createAbout,
  normalize,
  TTL_MS,
  fetchAbout: (...a) => _default.fetchAbout(...a),
  clearCache: () => _default.clearCache(),
  _default,
};
