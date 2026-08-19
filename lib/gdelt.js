'use strict';

// Shared GDELT DOC 2.0 client for the NEWS bot type.
//
// GDELT is the ONE source news profiles draw from. It runs live from DELL and
// has four hard-won operational facts baked in here - honour all four:
//
//  1. THE RATE LIMIT IS UNPREDICTABLE, NOT A CLEAN "one request per 5s". GDELT's
//     own 429 body claims a 5s window, but it was probed directly from DELL with
//     15s gaps between single requests and still returned 429, 200, 429 - i.e. it
//     throttles erratically even at 3x its stated spacing, AND a 429 does NOT
//     mean the next request will also fail. So: EVERY request from EVERY profile
//     goes through a SINGLE process-wide queue with a generous minimum spacing of
//     MIN_SPACING_MS (20s), and a throttle is RETRIED inside the queue rather
//     than surfaced as an immediate failure - see fact 2. A per-query result
//     cache (CACHE_TTL_MS, ~15 min) means several profiles with overlapping
//     keywords do not each hit the API, and once a query has succeeded once the
//     scheduler mostly does not touch the API at all. The only entry point is
//     fetchArticles() - no caller may bypass the queue.
//
//  2. A THROTTLE IS RETRIED IN-QUEUE, NOT FAILED. A 429 body is plain text (NOT
//     JSON) and there is no Retry-After header, so we never JSON.parse blindly: a
//     non-JSON body (plain-text 429 OR an HTML error page) counts as throttling.
//     On a throttle we wait and retry automatically, up to MAX_RETRIES (~5)
//     attempts with jittered ~20s spacing, bounded by RETRY_BUDGET_MS (~90s).
//     Given the measured pattern the 2nd or 3rd attempt usually succeeds. If
//     every retry is exhausted we fall back to a STALE cache entry (past its TTL)
//     when one exists - a slightly old headline beats no headline - and mark it
//     stale so the UI/log can say so. Only if there is nothing stale either do we
//     return a rate-limited failure. Scheduled ticks pass { nonBlocking:true } so
//     a long retry chain can never stall unrelated work: if the queue is busy, in
//     cooldown, or inside the spacing floor they defer to a later tick instead of
//     waiting. The UI Preview passes onProgress so it can report "retrying (2 of
//     5)..." live.
//
//  3. socialimage IS OFTEN EMPTY. We never require it here; the caller offers an
//     optional 'only post articles with an image' toggle. Feddit does its own OG
//     fetch later, so GDELT's image is an optional hint only.
//
//  4. Responses are UTF-8 and titles carry accented/symbol characters, so we
//     decode the body EXPLICITLY as UTF-8 (arrayBuffer + TextDecoder) rather than
//     trusting a default - a latin1 read mangles e.g. "Globee(R)". We also send a
//     normal browser User-Agent (a default runtime UA can be blocked at the edge).
//
// Testability: fetch, now, sleep and random are ALL injectable via createGdelt(),
// so the dry-run harness drives the queue with a fake clock and a stub fetch and
// proves the 20s spacing, the in-queue retry (429/200/429), the bounded budget
// and the stale-cache fallback with NO live network call and NO real waiting.

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
  const random = opts.random || Math.random;   // injectable so tests kill the jitter
  const log = opts.log || (() => {});

  const MIN_SPACING_MS = opts.minSpacingMs != null ? opts.minSpacingMs : 20_000; // erratic limit + headroom
  const CACHE_TTL_MS = opts.cacheTtlMs != null ? opts.cacheTtlMs : 15 * 60 * 1000; // ~15 min
  // In-queue retry on a throttle: up to MAX_RETRIES attempts, jittered ~20s
  // spacing, bounded by RETRY_BUDGET_MS. All injectable so tests run with a fake
  // clock and no real waiting.
  const MAX_RETRIES = opts.maxRetries != null ? opts.maxRetries : 5;
  const RETRY_BUDGET_MS = opts.retryBudgetMs != null ? opts.retryBudgetMs : 90_000;
  const RETRY_JITTER_MS = opts.retryJitterMs != null ? opts.retryJitterMs : 5_000;
  // After a retry chain gives up, scheduled (non-blocking) callers defer for this
  // long so a throttle storm can't make them probe every spacing window.
  const COOLDOWN_MS = opts.cooldownMs != null ? opts.cooldownMs : 60_000;

  // Process-wide (per-instance) serialisation + spacing state.
  let lastRequestAt = -Infinity;   // when the last REAL request was issued
  let chain = Promise.resolve();   // serialises all requests into one queue
  let queueDepth = 0;              // enqueued units not yet settled (busy if > 0)
  let backoffUntil = 0;            // scheduled callers defer until this time (cooldown)
  const cache = new Map();         // queryKey -> { at, articles }

  function cacheKey(query, maxRecords, timespanHours) {
    return String(query || '').trim().toLowerCase() + '|' + maxRecords + '|' + timespanHours;
  }

  // Serialise a unit of work onto the single queue. The chain never rejects
  // (errors are isolated) so one failed request can't wedge the queue. queueDepth
  // tracks whether a unit is in flight so non-blocking callers can bail out.
  function enqueue(fn) {
    queueDepth++;
    const run = chain.then(() => fn());
    chain = run.then(() => {}, () => {});
    run.then(() => { queueDepth--; }, () => { queueDepth--; });
    return run;
  }

  function isBusy() { return queueDepth > 0; }

  async function doFetch(url) {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(buf); // EXPLICIT utf-8, avoids mojibake
    return { status: res.status, text };
  }

  // One real attempt: honours the spacing floor (plus any jitter), issues the
  // request, and classifies the result. Returns { throttled, status?, articles?,
  // error? }. A transport error, a 429, a non-JSON body or a JSON-parse failure
  // all count as throttling (never JSON.parse blindly).
  async function attempt(query, maxRecords, timespanHours, jitter) {
    const wait = Math.max(0, lastRequestAt + MIN_SPACING_MS + jitter - now());
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();

    let status, text;
    try {
      ({ status, text } = await doFetch(buildUrl(query, maxRecords, timespanHours)));
    } catch (e) {
      return { throttled: true, transport: true, error: e.message };
    }
    if (status === 429 || !looksJson(text)) return { throttled: true, status };
    let data;
    try { data = JSON.parse(text); }
    catch { return { throttled: true, status }; } // looked like JSON but wasn't
    const articles = (Array.isArray(data.articles) ? data.articles : [])
      .map(normalizeArticle)
      .filter((a) => a.url && a.title);
    return { throttled: false, status, articles };
  }

  // The ONLY way to hit GDELT. opts2:
  //   maxRecords, timespanHours          - the query shape
  //   nonBlocking                        - scheduled callers: defer instead of
  //                                        waiting behind the queue / cooldown /
  //                                        spacing floor, and do at most ONE try
  //   maxRetries, retryBudgetMs          - per-call overrides of the retry policy
  //   onProgress({attempt,maxAttempts})  - called before each retry wait (UI)
  //   allowStale (default true)          - serve a past-TTL cache entry on give-up
  // Returns one of:
  //   { ok:true, articles:[...], cached?:true }
  //   { ok:true, stale:true, staleAgeMs, articles:[...] }   (retries exhausted)
  //   { ok:false, deferred:true, reason, retryInSec? }      (nonBlocking bail-out)
  //   { ok:false, rateLimited:true, status?, retryInSec }   (gave up, nothing stale)
  async function fetchArticles(query, opts2 = {}) {
    const maxRecords = opts2.maxRecords != null ? opts2.maxRecords : 25;
    const timespanHours = opts2.timespanHours != null ? opts2.timespanHours : 24;
    const nonBlocking = !!opts2.nonBlocking;
    const allowStale = opts2.allowStale !== false;
    const onProgress = typeof opts2.onProgress === 'function' ? opts2.onProgress : null;
    const maxAttempts = nonBlocking ? 1 : (opts2.maxRetries != null ? opts2.maxRetries : MAX_RETRIES);
    const budgetMs = opts2.retryBudgetMs != null ? opts2.retryBudgetMs : RETRY_BUDGET_MS;

    const key = cacheKey(query, maxRecords, timespanHours);

    // Fresh cache hit: no queue needed at all (the cache is doing most of the work).
    const hit = cache.get(key);
    if (hit && (now() - hit.at) < CACHE_TTL_MS) {
      return { ok: true, cached: true, articles: hit.articles };
    }

    // Scheduled (non-blocking) callers must NEVER wait behind an in-flight retry
    // chain, an active cooldown, or the spacing floor - that is what would stall a
    // conversational profile's tick. They defer to a later tick instead.
    if (nonBlocking) {
      if (queueDepth > 0) return { ok: false, deferred: true, reason: 'busy' };
      if (backoffUntil && now() < backoffUntil) {
        return { ok: false, deferred: true, reason: 'cooldown', retryInSec: Math.ceil((backoffUntil - now()) / 1000) };
      }
      if (now() < lastRequestAt + MIN_SPACING_MS) {
        return { ok: false, deferred: true, reason: 'spacing', retryInSec: Math.ceil((lastRequestAt + MIN_SPACING_MS - now()) / 1000) };
      }
    }

    return enqueue(async () => {
      // Re-check the cache inside the queue: a request ahead of us may have just
      // populated it for the same query.
      const hit2 = cache.get(key);
      if (hit2 && (now() - hit2.at) < CACHE_TTL_MS) {
        return { ok: true, cached: true, articles: hit2.articles };
      }

      const started = now();
      let lastStatus;
      for (let n = 1; n <= maxAttempts; n++) {
        const jitter = n > 1 ? Math.floor(random() * RETRY_JITTER_MS) : 0;
        const r = await attempt(query, maxRecords, timespanHours, jitter);
        if (!r.throttled) {
          backoffUntil = 0; // a success clears any cooldown
          cache.set(key, { at: now(), articles: r.articles });
          return { ok: true, articles: r.articles };
        }
        lastStatus = r.status;
        log('GDELT throttled (status ' + (r.status != null ? r.status : 'net') + ')' +
          (r.error ? ': ' + r.error : '') + ' - attempt ' + n + '/' + maxAttempts);
        // Stop if we are out of attempts, or the next ~20s wait would not fit the
        // budget. Both keep the total bounded so we give up cleanly.
        const budgetLeft = budgetMs - (now() - started);
        if (n >= maxAttempts || budgetLeft <= MIN_SPACING_MS) break;
        if (onProgress) onProgress({ attempt: n + 1, maxAttempts, status: r.status });
      }

      // Every attempt exhausted. Cool the scheduled path down, then fall back to a
      // STALE cache entry if we have one (a slightly old headline beats none).
      backoffUntil = now() + COOLDOWN_MS;
      if (allowStale) {
        const stale = cache.get(key);
        if (stale) return { ok: true, stale: true, staleAgeMs: now() - stale.at, articles: stale.articles };
      }
      return { ok: false, rateLimited: true, status: lastStatus, retryInSec: Math.ceil(COOLDOWN_MS / 1000) };
    });
  }

  function clearCache() { cache.clear(); }

  // Exposed for tests/observability; not needed by callers.
  function _state() { return { backoffUntil, queueDepth, lastRequestAt, cacheSize: cache.size }; }

  return {
    fetchArticles,
    isBusy,
    canonicalUrl,
    parseSeenDate,
    clearCache,
    _state,
    MIN_SPACING_MS,
    CACHE_TTL_MS,
    MAX_RETRIES,
    RETRY_BUDGET_MS,
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
