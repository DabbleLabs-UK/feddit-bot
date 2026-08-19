'use strict';

// Shared GDELT DOC 2.0 client for the NEWS bot type.
//
// GDELT is the ONE source news profiles draw from. It is probed live and has
// three hard-won operational facts baked in here - honour all three:
//
//  1. RATE LIMIT IS ONE REQUEST PER ~5s, GLOBAL. Two back-to-back requests 429
//     immediately. So EVERY request from EVERY profile goes through a SINGLE
//     process-wide queue with a minimum spacing of MIN_SPACING_MS (8s, not 5 -
//     we leave headroom). A per-query result cache (CACHE_TTL_MS, ~15 min) means
//     several profiles with overlapping keywords do not each hit the API. No
//     caller may bypass the queue - the only entry point is fetchArticles().
//
//  2. A 429 RESPONSE BODY IS PLAIN TEXT, NOT JSON, and there is NO Retry-After
//     header. We NEVER JSON.parse blindly: a non-JSON body (a plain-text 429 OR
//     an HTML error page) is treated as rate limiting and triggers an escalating
//     fixed back-off (BACKOFF_STEPS). While backed off, the queue short-circuits
//     without issuing a request.
//
//  3. socialimage IS OFTEN EMPTY. We never require it here; the caller offers an
//     optional 'only post articles with an image' toggle. Feddit does its own OG
//     fetch later, so GDELT's image is an optional hint only.
//
// Responses are UTF-8 and titles carry accented/symbol characters, so we decode
// the body EXPLICITLY as UTF-8 (arrayBuffer + TextDecoder) rather than trusting
// a default - a latin1 read mangles e.g. "Globee(R)". We also send a normal
// browser User-Agent (a default runtime UA can be blocked at the edge).
//
// Testability: fetch, now and sleep are all injectable via createGdelt(), so the
// dry-run harness can drive the queue with a fake clock and a stub fetch and
// prove the 8s spacing + plain-text-429 back-off with NO live network call.

const API_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- pure helpers (no instance state) --------------------------------------

// Parse GDELT's seendate ("20260819T091500Z") into epoch ms, or null if it
// isn't the expected shape (an article we then can't judge for freshness).
function parseSeenDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  return Number.isFinite(ms) ? ms : null;
}

// Canonicalise an article URL for PERMANENT dedupe: lowercase the host, strip
// utm_*/fbclid/gclid tracking params and any #fragment, and drop a trailing
// slash. Everything else (scheme, path case, remaining query) is preserved.
// Reposting a story is the one unforgivable news-bot failure, so this key has to
// collapse the trivial variants of the same link onto one string.
function canonicalUrl(raw) {
  const input = String(raw || '').trim();
  let u;
  try { u = new URL(input); }
  catch { return input.toLowerCase(); } // not a URL we can parse: best-effort key
  u.hash = '';
  const host = u.host.toLowerCase();
  for (const k of [...u.searchParams.keys()]) {
    const kl = k.toLowerCase();
    if (kl.startsWith('utm_') || kl === 'fbclid' || kl === 'gclid') u.searchParams.delete(k);
  }
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1); // drop trailing slash (keep root)
  const qs = u.searchParams.toString();
  return u.protocol + '//' + host + path + (qs ? '?' + qs : '');
}

// Body looks like JSON if it starts with { or [ after trimming leading BOM/space.
function looksJson(text) {
  const t = String(text || '').replace(/^﻿/, '').trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

// Normalise one GDELT article record to the shape the scheduler consumes.
function normalizeArticle(a) {
  return {
    url: (a && a.url) || '',
    urlMobile: (a && a.url_mobile) || '',
    title: (a && a.title) || '',
    seendate: (a && a.seendate) || '',
    seenAt: parseSeenDate(a && a.seendate),
    socialimage: (a && a.socialimage) || '',   // OFTEN empty - never required
    domain: String((a && a.domain) || '').toLowerCase(),
    language: (a && a.language) || '',
  };
}

// Build the DOC 2.0 ArtList URL. Spaces -> %20, colon kept literal (matches the
// probed request shape); we force English via "sourcelang:eng".
function buildUrl(query, maxRecords, timespanHours) {
  const raw = String(query || '').trim() + ' sourcelang:eng';
  const q = encodeURIComponent(raw).replace(/%3A/gi, ':');
  return API_BASE + '?query=' + q +
    '&mode=ArtList&format=json&maxrecords=' + maxRecords +
    '&timespan=' + timespanHours + 'h';
}

// ---- client instance --------------------------------------------------------

function createGdelt(opts = {}) {
  const fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log || (() => {});

  const MIN_SPACING_MS = opts.minSpacingMs != null ? opts.minSpacingMs : 8000;   // 5s limit + headroom
  const CACHE_TTL_MS = opts.cacheTtlMs != null ? opts.cacheTtlMs : 15 * 60 * 1000; // ~15 min
  // Escalating fixed back-off after a 429 / non-JSON body. Milliseconds.
  const BACKOFF_STEPS = opts.backoffSteps || [15_000, 30_000, 60_000, 120_000, 300_000];

  // Process-wide (per-instance) serialisation + spacing state.
  let lastRequestAt = -Infinity;   // when the last REAL request was issued
  let chain = Promise.resolve();   // serialises all requests into one queue
  let backoffUntil = 0;            // suppress requests until this time (rate limit)
  let backoffLevel = 0;            // index into BACKOFF_STEPS, escalates per failure
  const cache = new Map();         // queryKey -> { at, articles }

  function cacheKey(query, maxRecords, timespanHours) {
    return String(query || '').trim().toLowerCase() + '|' + maxRecords + '|' + timespanHours;
  }

  function bumpBackoff() {
    const step = BACKOFF_STEPS[Math.min(backoffLevel, BACKOFF_STEPS.length - 1)];
    backoffLevel++;
    backoffUntil = now() + step;
    return step;
  }

  // Serialise a unit of work onto the single queue. The chain never rejects
  // (errors are isolated) so one failed request can't wedge the queue.
  function enqueue(fn) {
    const run = chain.then(() => fn());
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function doFetch(url) {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(buf); // EXPLICIT utf-8, avoids mojibake
    return { status: res.status, text };
  }

  // The ONLY way to hit GDELT. Returns one of:
  //   { ok:true, articles:[...], cached?:true }
  //   { ok:false, rateLimited:true, backoff?:true, retryInSec, status? }
  //   { ok:false, error }                        (network / transport)
  async function fetchArticles(query, { maxRecords = 25, timespanHours = 24 } = {}) {
    const key = cacheKey(query, maxRecords, timespanHours);
    const hit = cache.get(key);
    if (hit && (now() - hit.at) < CACHE_TTL_MS) {
      return { ok: true, cached: true, articles: hit.articles };
    }

    return enqueue(async () => {
      // Re-check the cache inside the queue: a request ahead of us may have just
      // populated it for the same query.
      const hit2 = cache.get(key);
      if (hit2 && (now() - hit2.at) < CACHE_TTL_MS) {
        return { ok: true, cached: true, articles: hit2.articles };
      }

      // Suppressed by an active back-off: do NOT issue a request (no hammering).
      if (backoffUntil && now() < backoffUntil) {
        return { ok: false, rateLimited: true, backoff: true, retryInSec: Math.ceil((backoffUntil - now()) / 1000) };
      }

      // Global spacing: at least MIN_SPACING_MS since the last real request.
      const wait = Math.max(0, lastRequestAt + MIN_SPACING_MS - now());
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();

      let status, text;
      try {
        ({ status, text } = await doFetch(buildUrl(query, maxRecords, timespanHours)));
      } catch (e) {
        const step = bumpBackoff(); // transport failure: back off too, don't spin
        log('GDELT fetch error: ' + e.message + ' (back off ' + Math.round(step / 1000) + 's)');
        return { ok: false, error: e.message, retryInSec: Math.ceil(step / 1000) };
      }

      // A 429, OR any non-JSON body (plain-text limit notice / HTML error page),
      // is rate limiting. Never JSON.parse it blindly.
      if (status === 429 || !looksJson(text)) {
        const step = bumpBackoff();
        log('GDELT rate limited (status ' + status + ', ' +
          (status === 429 ? 'plain-text body' : 'non-JSON body') + '); back off ' + Math.round(step / 1000) + 's');
        return { ok: false, rateLimited: true, status, retryInSec: Math.ceil(step / 1000) };
      }

      let data;
      try { data = JSON.parse(text); }
      catch {
        const step = bumpBackoff(); // looked like JSON but wasn't - treat as rate limiting
        return { ok: false, rateLimited: true, status, retryInSec: Math.ceil(step / 1000) };
      }

      // Success: reset the escalating back-off and cache the result.
      backoffLevel = 0;
      backoffUntil = 0;
      const articles = (Array.isArray(data.articles) ? data.articles : [])
        .map(normalizeArticle)
        .filter((a) => a.url && a.title);
      cache.set(key, { at: now(), articles });
      return { ok: true, articles };
    });
  }

  function clearCache() { cache.clear(); }

  // Exposed for tests/observability; not needed by callers.
  function _state() { return { backoffUntil, backoffLevel, lastRequestAt, cacheSize: cache.size }; }

  return {
    fetchArticles,
    canonicalUrl,
    parseSeenDate,
    clearCache,
    _state,
    MIN_SPACING_MS,
    CACHE_TTL_MS,
  };
}

// Default process-wide singleton used in production (real fetch/clock).
const _default = createGdelt();

module.exports = {
  createGdelt,
  canonicalUrl,
  parseSeenDate,
  buildUrl,
  BROWSER_UA,
  API_BASE,
  fetchArticles: (...a) => _default.fetchArticles(...a),
  clearCache: () => _default.clearCache(),
  _state: () => _default._state(),
  _default,
};
