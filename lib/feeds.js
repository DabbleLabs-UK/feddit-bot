'use strict';

// Publisher RSS/Atom feeds - the PRIMARY news source for the NEWS bot type.
//
// WHY this exists (all measured live from DELL, do not re-litigate):
//  - GDELT returns 429 unpredictably even at 60s gaps (~1 success in 3). Unusable
//    as a primary source at any cadence - it is now an OPTIONAL secondary (see
//    lib/gdelt.js, toggled per-profile, default OFF).
//  - Google News RSS is reliable but its article links are opaque /rss/articles/
//    CBM... blobs that 302 to consent.google.com; there is NO publisher URL
//    without decoding Google's internal blob. REJECTED as a link source.
//  - Publisher RSS feeds give REAL article URLs directly, are not throttled, and
//    Feddit's own OG fetch works properly against them. So they are the primary.
//
// This module ships a curated DEFAULT list of ~25 mainstream English-language
// feeds (UK-leaning; the owner is in the UK) so a news-bot owner curates NOTHING:
// they just pick keywords. Owners MAY narrow to a subset and/or add their own
// feed URLs, but neither is required.
//
// Operational manners, all honoured here:
//  - POLITE POLLING: each feed is polled at most every ~10 min. Results live in a
//    SHARED process-wide cache, so several bots watching the same feed cause ONE
//    fetch, not one per bot.
//  - CONDITIONAL GET: ETag + Last-Modified are stored per feed and sent back as
//    If-None-Match / If-Modified-Since, so an unchanged feed costs a cheap 304.
//  - STAGGERED: refreshes are serialised through one queue with a small spacing so
//    we never hammer 25 feeds at once. A normal browser User-Agent is sent.
//  - RESILIENT: a feed that fails is marked unhealthy and retried with exponential
//    backoff; it never breaks the whole fetch. Its last good items stay cached.
//  - VISIBLE HEALTH: per-feed OK/failing/last-success is exposed for the UI so a
//    silently dead feed can't make a bot mysteriously go quiet.
//
// UTF-8 is decoded EXPLICITLY (arrayBuffer + TextDecoder) - this project has been
// bitten by mojibake before. Entities and CDATA are decoded properly.
//
// Testability: fetch, now, sleep, random and the timeout are ALL injectable via
// createFeeds(), and parseFeed() is a pure function, so the dry-run harness proves
// RSS/Atom parsing, the shared cache, conditional GET/304 and failure isolation
// with NO live network and NO real waiting.

const { canonicalUrl } = require('./gdelt'); // provider-agnostic dedupe key (pure)

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, ' +
  'text/xml;q=0.8, */*;q=0.7';

// ---- shipped default feed list ---------------------------------------------
// { name, domain, feedUrl, category }. category is one of:
//   world | uk | business | tech | science | sport | entertainment
// The feedUrl is the stable id used for selection + the health map. This list is
// pruned to only feeds VERIFIED to parse and yield real publisher URLs (see the
// live-verify step in the build job); do not add a feed here without checking it.
const DEFAULT_FEEDS = [
  // BBC (UK public broadcaster) - reliable, open RSS across sections.
  { name: 'BBC News (Top stories)', domain: 'bbc.co.uk', feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'world' },
  { name: 'BBC News (UK)', domain: 'bbc.co.uk', feedUrl: 'https://feeds.bbci.co.uk/news/uk/rss.xml', category: 'uk' },
  { name: 'BBC News (Business)', domain: 'bbc.co.uk', feedUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'business' },
  { name: 'BBC News (Technology)', domain: 'bbc.co.uk', feedUrl: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'tech' },
  { name: 'BBC News (Science & Environment)', domain: 'bbc.co.uk', feedUrl: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'science' },
  { name: 'BBC Sport', domain: 'bbc.co.uk', feedUrl: 'https://feeds.bbci.co.uk/sport/rss.xml', category: 'sport' },
  // The Guardian (UK) - open RSS per section.
  { name: 'The Guardian (World)', domain: 'theguardian.com', feedUrl: 'https://www.theguardian.com/world/rss', category: 'world' },
  { name: 'The Guardian (UK)', domain: 'theguardian.com', feedUrl: 'https://www.theguardian.com/uk-news/rss', category: 'uk' },
  { name: 'The Guardian (Business)', domain: 'theguardian.com', feedUrl: 'https://www.theguardian.com/uk/business/rss', category: 'business' },
  { name: 'The Guardian (Technology)', domain: 'theguardian.com', feedUrl: 'https://www.theguardian.com/uk/technology/rss', category: 'tech' },
  { name: 'The Guardian (Sport)', domain: 'theguardian.com', feedUrl: 'https://www.theguardian.com/uk/sport/rss', category: 'sport' },
  { name: 'The Guardian (Culture)', domain: 'theguardian.com', feedUrl: 'https://www.theguardian.com/uk/culture/rss', category: 'entertainment' },
  // Other UK outlets.
  { name: 'Sky News (Home)', domain: 'skynews.com', feedUrl: 'https://feeds.skynews.com/feeds/rss/home.xml', category: 'uk' },
  { name: 'Sky News (World)', domain: 'skynews.com', feedUrl: 'https://feeds.skynews.com/feeds/rss/world.xml', category: 'world' },
  { name: 'The Independent (UK)', domain: 'independent.co.uk', feedUrl: 'https://www.independent.co.uk/news/uk/rss', category: 'uk' },
  { name: 'Metro (UK)', domain: 'metro.co.uk', feedUrl: 'https://metro.co.uk/feed/', category: 'uk' },
  // International.
  { name: 'Al Jazeera', domain: 'aljazeera.com', feedUrl: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world' },
  { name: 'NPR News', domain: 'npr.org', feedUrl: 'https://feeds.npr.org/1001/rss.xml', category: 'world' },
  { name: 'Deutsche Welle', domain: 'dw.com', feedUrl: 'https://rss.dw.com/rdf/rss-en-all', category: 'world' },
  { name: 'France 24', domain: 'france24.com', feedUrl: 'https://www.france24.com/en/rss', category: 'world' },
  { name: 'CBC News (World)', domain: 'cbc.ca', feedUrl: 'https://www.cbc.ca/webfeed/rss/rss-world', category: 'world' },
  // Tech.
  { name: 'The Verge', domain: 'theverge.com', feedUrl: 'https://www.theverge.com/rss/index.xml', category: 'tech' },
  { name: 'Ars Technica', domain: 'arstechnica.com', feedUrl: 'https://feeds.arstechnica.com/arstechnica/index', category: 'tech' },
  { name: 'TechCrunch', domain: 'techcrunch.com', feedUrl: 'https://techcrunch.com/feed/', category: 'tech' },
  { name: 'The Register', domain: 'theregister.com', feedUrl: 'https://www.theregister.com/headlines.atom', category: 'tech' },
  // Science.
  { name: 'ScienceDaily (Top)', domain: 'sciencedaily.com', feedUrl: 'https://www.sciencedaily.com/rss/top/science.xml', category: 'science' },
  // Entertainment.
  { name: 'Variety', domain: 'variety.com', feedUrl: 'https://variety.com/feed/', category: 'entertainment' },
];

// ---- pure XML helpers -------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  pound: '£', euro: '€', deg: '°',
};

// Decode XML/HTML entities: numeric (&#123; / &#xAF;) and the common named ones.
// An unrecognised entity is left verbatim (never throws).
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0) { try { return String.fromCodePoint(cp); } catch { return m; } }
      return m;
    }
    const key = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
  });
}

// Decode a raw node body: unwrap any CDATA section(s) to their inner content,
// then entity-decode the whole thing. Feed CDATA almost always wraps HTML whose
// entities (e.g. &amp;) are meant to render, so we decode inside former-CDATA too
// rather than leaving "&amp;" verbatim in display text. Handles a body that is
// partly CDATA and partly plain (rare but legal).
function decodeText(raw) {
  if (raw == null) return '';
  const s = String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner);
  return decodeEntities(s).trim();
}

// Strip HTML tags to a flat single-line string (for the summary passed to the
// title generator - it never wants markup).
function stripHtml(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Inner text of the FIRST <tag ...>...</tag> in a block (namespaced names like
// content:encoded / dc:date are fine). Returns null if absent.
function tagText(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = re.exec(block);
  return m ? m[1] : null;
}

// Parse an attribute out of an attribute-string ('a="b" c=\'d\'').
function attr(attrs, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"|\\b' + name + "\\s*=\\s*'([^']*)'", 'i').exec(attrs || '');
  return m ? (m[1] != null ? m[1] : m[2]) : '';
}

function domainOf(url) {
  try {
    const h = new URL(String(url)).host.toLowerCase();
    return h.replace(/^www\./, '');
  } catch { return ''; }
}

// Parse a feed date string (RFC-822 for RSS, ISO-8601 for Atom/dc:date) to epoch
// ms, or null if unparseable (an item we then can't judge for freshness).
function parseFeedDate(s) {
  const str = String(s == null ? '' : s).trim();
  if (!str) return null;
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : null;
}

// Pick the best link out of an Atom entry's <link .../> tags: prefer rel absent
// or rel="alternate" with an html (or absent) type; fall back to the first href.
function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1]);
  let fallback = '';
  for (const a of links) {
    const href = attr(a, 'href');
    if (!href) continue;
    if (!fallback) fallback = href;
    const rel = attr(a, 'rel').toLowerCase();
    const type = attr(a, 'type').toLowerCase();
    if ((rel === '' || rel === 'alternate') && (type === '' || type.includes('html'))) return href;
  }
  return fallback;
}

// Extract an image URL for an item if the feed carries one, in priority order:
//   media:thumbnail -> media:content(image) -> enclosure(image) -> <img> in body.
// This is a HINT ONLY - Feddit does its own OG fetch and its thumbnail wins.
function extractImage(block, contentHtml) {
  let m = block.match(/<media:thumbnail\b[^>]*>/i);
  if (m) { const u = attr(m[0], 'url'); if (u) return decodeEntities(u); }

  for (const mm of block.matchAll(/<media:content\b([^>]*?)\/?>/gi)) {
    const a = mm[1];
    const u = attr(a, 'url'); if (!u) continue;
    const type = attr(a, 'type').toLowerCase();
    const medium = attr(a, 'medium').toLowerCase();
    if (type.startsWith('image/') || medium === 'image') return decodeEntities(u);
  }

  for (const mm of block.matchAll(/<enclosure\b([^>]*?)\/?>/gi)) {
    const a = mm[1];
    const u = attr(a, 'url');
    const type = attr(a, 'type').toLowerCase();
    if (u && type.startsWith('image/')) return decodeEntities(u);
  }

  if (contentHtml) {
    const im = contentHtml.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    if (im) return decodeEntities(im[1]);
  }
  return '';
}

// Normalise one <item>/<entry> block to the shape the scheduler's news pipeline
// consumes (identical fields to a normalised GDELT article, plus a real summary).
function normalizeItem(block, isAtom) {
  const title = decodeText(tagText(block, 'title'));

  let link;
  if (isAtom) {
    link = decodeEntities(atomLink(block).trim());
  } else {
    const lt = tagText(block, 'link');
    link = lt ? decodeEntities(lt.trim()) : '';
    if (!link) { // RSS fallback: a permalink guid
      const g = /<guid\b([^>]*)>([\s\S]*?)<\/guid>/i.exec(block);
      if (g && /ispermalink\s*=\s*["']?\s*true/i.test(g[1]) && /^https?:/i.test(g[2].trim())) {
        link = decodeEntities(g[2].trim());
      }
    }
  }

  const descRaw = tagText(block, 'description') || tagText(block, 'summary')
    || tagText(block, 'content:encoded') || tagText(block, 'content');
  const contentRaw = tagText(block, 'content:encoded') || tagText(block, 'content') || descRaw;
  const description = decodeText(descRaw);
  const contentHtml = decodeText(contentRaw);

  const dateStr = tagText(block, 'pubDate') || tagText(block, 'dc:date')
    || tagText(block, 'published') || tagText(block, 'updated') || tagText(block, 'date');
  const seenAt = parseFeedDate(dateStr);

  return {
    url: link || '',
    title: title || '',
    summary: stripHtml(description),
    seenAt,
    seendate: String(dateStr || '').trim(),
    socialimage: extractImage(block, contentHtml), // HINT only; may be ''
    domain: domainOf(link),
    language: '',
  };
}

// Parse a full RSS or Atom document into normalised items. Pure + total: an
// unparseable / empty body yields []. Detects RSS (<item>) vs Atom (<entry>);
// RSS 1.0/RDF items are matched too (they are still <item ...>...</item>).
function parseFeed(xml) {
  const s = String(xml == null ? '' : xml);
  const hasItems = /<item[\s>]/i.test(s);
  const isAtom = !hasItems && /<entry[\s>]/i.test(s);
  const blocks = isAtom
    ? [...s.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0])
    : [...s.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const out = [];
  for (const b of blocks) {
    const it = normalizeItem(b, isAtom);
    if (it.url && it.title) out.push(it);
  }
  return out;
}

// ---- client instance --------------------------------------------------------

function createFeeds(opts = {}) {
  const fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random || Math.random;
  const log = opts.log || (() => {});

  const TTL_MS = opts.ttlMs != null ? opts.ttlMs : 10 * 60 * 1000;    // poll each feed at most ~ every 10 min
  const STAGGER_MS = opts.staggerMs != null ? opts.staggerMs : 400;   // spacing between network fetches
  const BASE_BACKOFF_MS = opts.baseBackoffMs != null ? opts.baseBackoffMs : 60 * 1000;
  const MAX_BACKOFF_MS = opts.maxBackoffMs != null ? opts.maxBackoffMs : 30 * 60 * 1000;
  const TIMEOUT_MS = opts.timeoutMs != null ? opts.timeoutMs : 15 * 1000; // 0 disables (tests)

  const cache = new Map();    // feedUrl -> { at, items, etag, lastModified }
  const health = new Map();   // feedUrl -> health record
  const inFlight = new Map(); // feedUrl -> Promise (dedupe concurrent refreshes)
  let chain = Promise.resolve();
  let lastFetchAt = -Infinity;

  function healthOf(url) {
    let h = health.get(url);
    if (!h) {
      h = { url, ok: null, lastTryAt: 0, lastOkAt: 0, lastStatus: null, error: '', itemCount: 0, fails: 0, nextRetryAt: 0 };
      health.set(url, h);
    }
    return h;
  }

  function backoffFor(fails) {
    const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.max(0, fails - 1)));
    return base + Math.floor(random() * Math.min(BASE_BACKOFF_MS, base)); // jitter, bounded
  }

  function markOk(h, count) {
    h.ok = true; h.fails = 0; h.error = ''; h.lastOkAt = now(); h.itemCount = count; h.nextRetryAt = 0;
  }
  function markFail(h, status, error) {
    h.ok = false; h.fails += 1; h.error = String(error || ('HTTP ' + status)); h.lastStatus = status;
    h.nextRetryAt = now() + backoffFor(h.fails);
    log('feed unhealthy: ' + h.url + ' (' + h.error + ') - retry in ~' + Math.round((h.nextRetryAt - now()) / 1000) + 's');
  }

  function headerOf(res, name) {
    const hs = res && res.headers;
    if (!hs) return '';
    if (typeof hs.get === 'function') return hs.get(name) || '';
    const key = Object.keys(hs).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? hs[key] : '';
  }

  // The one real network fetch, with a hard timeout (via AbortController) that is
  // disabled when TIMEOUT_MS is 0 so the fake-clock tests never race the timeout.
  async function doFetch(url, headers) {
    if (!TIMEOUT_MS) return fetchImpl(url, { headers });
    const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const t = setTimeout(() => { if (ac) ac.abort(); }, TIMEOUT_MS);
    if (t && t.unref) t.unref();
    try {
      return await fetchImpl(url, { headers, signal: ac ? ac.signal : undefined });
    } finally { clearTimeout(t); }
  }

  // Serialise a refresh onto the staggered queue: each real fetch waits until at
  // least STAGGER_MS after the previous one started. The chain never rejects.
  function enqueue(fn) {
    const run = chain.then(async () => {
      const gap = lastFetchAt + STAGGER_MS - now();
      if (gap > 0) await sleep(gap);
      lastFetchAt = now();
      return fn();
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function doRefresh(url) {
    const h = healthOf(url);
    h.lastTryAt = now();
    const c = cache.get(url) || {};
    const headers = { 'User-Agent': BROWSER_UA, Accept: ACCEPT };
    if (c.etag) headers['If-None-Match'] = c.etag;
    if (c.lastModified) headers['If-Modified-Since'] = c.lastModified;

    let res;
    try {
      res = await doFetch(url, headers);
    } catch (e) {
      markFail(h, null, (e && e.message) || 'network error');
      return;
    }
    h.lastStatus = res.status;

    if (res.status === 304) { // unchanged - refresh freshness, keep cached items
      const cc = cache.get(url);
      if (cc) cc.at = now();
      markOk(h, cc ? cc.items.length : 0);
      return;
    }
    if (res.status !== 200) { markFail(h, res.status, 'HTTP ' + res.status); return; }

    let text;
    try {
      const buf = await res.arrayBuffer();
      text = new TextDecoder('utf-8').decode(buf); // EXPLICIT utf-8 (avoid mojibake)
    } catch (e) {
      markFail(h, res.status, 'read error: ' + ((e && e.message) || 'unknown'));
      return;
    }
    const items = parseFeed(text);
    if (!items.length) { markFail(h, res.status, 'parsed 0 items'); return; }
    cache.set(url, {
      at: now(), items,
      etag: headerOf(res, 'etag') || (c.etag || ''),
      lastModified: headerOf(res, 'last-modified') || (c.lastModified || ''),
    });
    markOk(h, items.length);
  }

  function refresh(url) {
    if (inFlight.has(url)) return inFlight.get(url);
    const p = enqueue(() => doRefresh(url));
    inFlight.set(url, p);
    p.then(() => inFlight.delete(url), () => inFlight.delete(url));
    return p;
  }

  // Gather fresh candidate items from the given feed URLs, refreshing any that are
  // stale (and not currently in backoff), merged + de-duped by canonical URL and
  // sorted newest-first. Everything already cached is served regardless.
  //
  //   nonBlocking (scheduled ticks): trigger stale refreshes in the BACKGROUND and
  //   return immediately with whatever is cached now, so a slow feed can never
  //   stall a tick. The warmed cache is picked up by the next tick.
  //   blocking (preview/tests): await the refreshes before returning.
  async function fetchItems(feedUrls, opts2 = {}) {
    const nonBlocking = !!opts2.nonBlocking;
    const urls = [...new Set((feedUrls || []).map((u) => String(u || '').trim()).filter(Boolean))];

    const toRefresh = [];
    for (const u of urls) {
      healthOf(u); // ensure a record exists so the UI can show "not fetched yet"
      const c = cache.get(u);
      const fresh = c && (now() - c.at) < TTL_MS;
      const h = health.get(u);
      const inBackoff = h && h.nextRetryAt && now() < h.nextRetryAt;
      if (!fresh && !inBackoff) toRefresh.push(u);
    }

    const work = toRefresh.map((u) => refresh(u));
    if (!nonBlocking) await Promise.allSettled(work);

    const merged = [];
    const seen = new Set();
    for (const u of urls) {
      const c = cache.get(u);
      if (!c) continue;
      for (const it of c.items) {
        const key = canonicalUrl(it.url);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(it);
      }
    }
    merged.sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
    return { ok: true, items: merged, health: healthSnapshot(urls), refreshing: nonBlocking ? toRefresh : [] };
  }

  // A UI/observability snapshot of feed health. Pass a URL list to scope it to one
  // profile's feeds, or omit for every feed this instance has touched.
  function healthSnapshot(urls) {
    const list = (urls && urls.length) ? [...new Set(urls)] : [...health.keys()];
    return list.map((u) => {
      const h = health.get(u) || {};
      const c = cache.get(u);
      return {
        url: u,
        ok: h.ok != null ? h.ok : null,        // null = never tried yet
        lastOkAt: h.lastOkAt || 0,
        lastTryAt: h.lastTryAt || 0,
        lastStatus: h.lastStatus != null ? h.lastStatus : null,
        error: h.error || '',
        fails: h.fails || 0,
        nextRetryAt: h.nextRetryAt || 0,
        itemCount: c ? c.items.length : (h.itemCount || 0),
        cachedAt: c ? c.at : 0,
      };
    });
  }

  function clearCache() { cache.clear(); health.clear(); inFlight.clear(); }
  function _state() { return { cacheSize: cache.size, healthSize: health.size, inFlight: inFlight.size, lastFetchAt }; }

  return {
    fetchItems,
    health: healthSnapshot,
    canonicalUrl,
    parseFeed,
    clearCache,
    _state,
    TTL_MS,
  };
}

// Default process-wide singleton used in production (real fetch/clock).
const _default = createFeeds();

module.exports = {
  createFeeds,
  parseFeed,
  decodeEntities,
  decodeText,
  stripHtml,
  domainOf,
  parseFeedDate,
  canonicalUrl,
  DEFAULT_FEEDS,
  BROWSER_UA,
  fetchItems: (...a) => _default.fetchItems(...a),
  health: (...a) => _default.health(...a),
  clearCache: () => _default.clearCache(),
  _state: () => _default._state(),
  _default,
};
