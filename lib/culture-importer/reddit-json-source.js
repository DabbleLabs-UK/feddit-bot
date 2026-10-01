'use strict';

const { cacheKey, createFileCorpusCache } = require('./cache');

const SOURCE_SCHEMA_VERSION = 1;
const DEFAULT_BASE_URL = 'https://www.reddit.com';
const DEFAULT_USER_AGENT = 'feddit-culture-importer/1.0 (private research; contact jody@dabblelabs.uk)';
const MAX_POSTS = 1000;
const MAX_COMMENTS = 5000;
const PAGE_SIZE = 100;

class SourceAdapterError extends Error {
  constructor(message, code = 'SOURCE_FAILED', options = {}) {
    super(String(message || 'The source adapter failed.'));
    this.name = 'SourceAdapterError';
    this.code = code;
    this.status = Number(options.status) || null;
    this.url = options.url ? String(options.url) : '';
    this.retryable = options.retryable === true;
    if (options.cause) this.cause = options.cause;
  }
}

function cleanSubreddit(value) {
  const clean = String(value || '').trim().replace(/^r\//i, '');
  if (!/^[A-Za-z0-9_]{2,21}$/.test(clean)) {
    throw new SourceAdapterError('The subreddit must be 2-21 letters, numbers or underscores.', 'BAD_INPUT');
  }
  return clean;
}

function boundedInteger(value, fallback, maximum) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(maximum, number));
}

function dateBoundary(value, label) {
  if (value == null || value === '') return null;
  const at = Date.parse(String(value));
  if (!Number.isFinite(at)) throw new SourceAdapterError(label + ' must be a valid date or ISO timestamp.', 'BAD_INPUT');
  return at;
}

function normalizeInput(input = {}) {
  const sinceMs = dateBoundary(input.since, 'since');
  const untilMs = dateBoundary(input.until, 'until');
  if (sinceMs != null && untilMs != null && sinceMs > untilMs) {
    throw new SourceAdapterError('since must be earlier than until.', 'BAD_INPUT');
  }
  return {
    subreddit: cleanSubreddit(input.subreddit),
    maxPosts: boundedInteger(input.maxPosts, 100, MAX_POSTS),
    maxComments: boundedInteger(input.maxComments, 1000, MAX_COMMENTS),
    sinceMs,
    untilMs,
  };
}

function isoFromUnix(seconds) {
  const ms = Number(seconds) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function text(value, max = 20_000) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function sourceId(kind, data) {
  const name = text(data && data.name, 80);
  if (name) return name;
  const id = text(data && data.id, 80);
  return id ? kind + '_' + id : '';
}

function canonicalUrl(permalink) {
  const value = text(permalink, 2000);
  if (!value) return '';
  try { return new URL(value, 'https://www.reddit.com').toString(); } catch { return ''; }
}

function normalizePost(data, subreddit) {
  const id = sourceId('t3', data);
  return {
    type: 'post',
    sourceId: id,
    id: id.replace(/^t3_/, ''),
    subreddit: text(data.subreddit || subreddit, 80),
    author: text(data.author, 100) || '[deleted]',
    createdAt: isoFromUnix(data.created_utc),
    score: Number.isFinite(Number(data.score)) ? Number(data.score) : null,
    title: text(data.title, 600),
    body: text(data.selftext, 20_000),
    url: canonicalUrl(data.permalink),
    outboundUrl: text(data.url_overridden_by_dest || (!data.is_self ? data.url : ''), 4000),
    commentCount: Math.max(0, Number(data.num_comments) || 0),
    nsfw: data.over_18 === true,
    locked: data.locked === true,
  };
}

function normalizeComment(data, subreddit) {
  const id = sourceId('t1', data);
  return {
    type: 'comment',
    sourceId: id,
    id: id.replace(/^t1_/, ''),
    threadSourceId: text(data.link_id, 80),
    parentSourceId: text(data.parent_id, 80),
    subreddit: text(data.subreddit || subreddit, 80),
    author: text(data.author, 100) || '[deleted]',
    createdAt: isoFromUnix(data.created_utc),
    score: Number.isFinite(Number(data.score)) ? Number(data.score) : null,
    body: text(data.body, 20_000),
    url: canonicalUrl(data.permalink),
    postTitle: text(data.link_title, 600),
    postAuthor: text(data.link_author, 100),
  };
}

function listingChildren(value) {
  const children = value && value.data && Array.isArray(value.data.children) ? value.data.children : [];
  return children.filter((item) => item && item.data).map((item) => ({ kind: item.kind, data: item.data }));
}

function withinWindow(createdAt, input) {
  const at = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(at)) return true;
  if (input.sinceMs != null && at < input.sinceMs) return false;
  if (input.untilMs != null && at > input.untilMs) return false;
  return true;
}

function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onComplete = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      const error = new Error('Import cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    timer = setTimeout(onComplete, ms);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function createFetchTransport(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || 30_000);
  return {
    async getJson(url, request = {}) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(request.signal && request.signal.reason);
      if (request.signal) {
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          headers: request.headers || {},
          signal: controller.signal,
        });
        const body = await response.text();
        if (!response.ok) {
          throw new SourceAdapterError('Reddit returned HTTP ' + response.status + '.', 'SOURCE_HTTP', {
            status: response.status,
            url,
            retryable: response.status === 429 || response.status >= 500,
          });
        }
        try { return JSON.parse(body); }
        catch (error) {
          throw new SourceAdapterError('Reddit returned malformed JSON.', 'SOURCE_BAD_JSON', { url, cause: error });
        }
      } catch (error) {
        if (error instanceof SourceAdapterError) throw error;
        if (controller.signal.aborted) {
          if (request.signal && request.signal.aborted) {
            const cancelled = new Error('Import cancelled.');
            cancelled.name = 'AbortError';
            throw cancelled;
          }
          throw new SourceAdapterError('The Reddit request timed out.', 'SOURCE_TIMEOUT', { url, retryable: true, cause: error });
        }
        throw new SourceAdapterError('The Reddit request failed: ' + error.message, 'SOURCE_NETWORK', {
          url, retryable: true, cause: error,
        });
      } finally {
        clearTimeout(timer);
        if (request.signal) request.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

function createRedditJsonSource(options = {}) {
  const id = 'reddit-json';
  const baseUrl = new URL(options.baseUrl || (options.accessToken ? 'https://oauth.reddit.com' : DEFAULT_BASE_URL));
  const transport = options.transport || createFetchTransport(options);
  const cache = options.cache || createFileCorpusCache({ directory: options.cacheDirectory, now: options.now, ttlMs: options.cacheTtlMs });
  const requestDelayMs = Math.max(0, Number(options.requestDelayMs == null ? 750 : options.requestDelayMs));
  const userAgent = String(options.userAgent || DEFAULT_USER_AGENT);
  const accessToken = String(options.accessToken || '');
  const now = options.now || Date.now;

  function headers() {
    return {
      'User-Agent': userAgent,
      'Accept': 'application/json',
      ...(accessToken ? { 'Authorization': 'Bearer ' + accessToken } : {}),
    };
  }

  async function fetchListing(kind, limit, input, runtime) {
    if (!limit) return { items: [], pages: 0 };
    const output = [];
    const seenSourceIds = new Set();
    let after = '';
    let pages = 0;
    let stopForWindow = false;
    while (output.length < limit && !stopForWindow) {
      if (runtime.signal && runtime.signal.aborted) {
        const cancelled = new Error('Import cancelled.');
        cancelled.name = 'AbortError';
        throw cancelled;
      }
      const route = kind === 'post' ? 'new.json' : 'comments.json';
      const url = new URL('/r/' + encodeURIComponent(input.subreddit) + '/' + route, baseUrl);
      url.searchParams.set('limit', String(Math.min(PAGE_SIZE, limit - output.length)));
      url.searchParams.set('raw_json', '1');
      if (after) url.searchParams.set('after', after);
      const response = await transport.getJson(url.toString(), { headers: headers(), signal: runtime.signal });
      pages++;
      const children = listingChildren(response);
      if (!children.length) break;
      for (const child of children) {
        const item = kind === 'post'
          ? normalizePost(child.data, input.subreddit)
          : normalizeComment(child.data, input.subreddit);
        if (!item.sourceId || seenSourceIds.has(item.sourceId)) continue;
        seenSourceIds.add(item.sourceId);
        if (input.sinceMs != null && item.createdAt && Date.parse(item.createdAt) < input.sinceMs) {
          stopForWindow = true;
          continue;
        }
        if (withinWindow(item.createdAt, input)) output.push(item);
        if (output.length >= limit) break;
      }
      runtime.onProgress({
        phase: 'fetch', state: 'running', source: id, kind,
        current: output.length, total: limit, pages,
        message: 'Fetched ' + output.length + ' recent ' + (kind === 'post' ? 'posts' : 'comments') + '.',
      });
      const next = text(response && response.data && response.data.after, 100);
      if (!next || next === after) break;
      after = next;
      if (output.length < limit) await sleep(requestDelayMs, runtime.signal);
    }
    return { items: output.slice(0, limit), pages };
  }

  function buildCorpus(input, postsResult, commentsResult) {
    const commentsById = new Map(commentsResult.items.map((item) => [item.sourceId, item]));
    const threadHints = new Map();
    for (const comment of commentsResult.items) {
      if (!threadHints.has(comment.threadSourceId)) {
        threadHints.set(comment.threadSourceId, {
          sourceId: comment.threadSourceId,
          title: comment.postTitle,
          author: comment.postAuthor,
          url: comment.url ? comment.url.replace(/\/comments\/([^/]+).*$/i, '/comments/$1/') : '',
        });
      }
      const parent = commentsById.get(comment.parentSourceId);
      comment.parentAuthor = parent ? parent.author : (comment.parentSourceId === comment.threadSourceId ? comment.postAuthor : '');
      comment.depth = 0;
      let cursor = parent;
      const seen = new Set([comment.sourceId]);
      while (cursor && !seen.has(cursor.sourceId) && comment.depth < 20) {
        seen.add(cursor.sourceId);
        comment.depth++;
        cursor = commentsById.get(cursor.parentSourceId);
      }
    }
    const fetchedAt = new Date(Number(now())).toISOString();
    return {
      schemaVersion: SOURCE_SCHEMA_VERSION,
      source: id,
      subreddit: input.subreddit,
      fetchedAt,
      window: {
        since: input.sinceMs == null ? null : new Date(input.sinceMs).toISOString(),
        until: input.untilMs == null ? null : new Date(input.untilMs).toISOString(),
      },
      posts: postsResult.items,
      comments: commentsResult.items,
      threadHints: Array.from(threadHints.values()),
      provenance: {
        adapter: id,
        baseHost: baseUrl.hostname,
        authenticated: Boolean(accessToken),
        postPages: postsResult.pages,
        commentPages: commentsResult.pages,
      },
    };
  }

  async function fetchCorpus(rawInput = {}, runtime = {}) {
    const input = normalizeInput(rawInput);
    const key = cacheKey(id, input);
    const onProgress = typeof runtime.onProgress === 'function' ? runtime.onProgress : () => {};
    if (runtime.signal && runtime.signal.aborted) {
      const cancelled = new Error('Import cancelled.');
      cancelled.name = 'AbortError';
      throw cancelled;
    }
    if (runtime.refresh !== true) {
      const cached = cache.get(key);
      if (cached.hit) {
        onProgress({ phase: 'fetch', state: 'cached', current: 1, total: 1, message: 'Using cached Reddit corpus.' });
        return { corpus: cached.value, cache: { ...cached, value: undefined } };
      }
    }
    onProgress({ phase: 'fetch', state: 'started', current: 0, total: input.maxPosts + input.maxComments, message: 'Fetching Reddit listings.' });
    const progressRuntime = { signal: runtime.signal, onProgress };
    const posts = await fetchListing('post', input.maxPosts, input, progressRuntime);
    if (posts.items.length && input.maxComments) await sleep(requestDelayMs, runtime.signal);
    const comments = await fetchListing('comment', input.maxComments, input, progressRuntime);
    const corpus = buildCorpus(input, posts, comments);
    const stored = cache.set(key, corpus);
    onProgress({ phase: 'fetch', state: 'completed', current: corpus.posts.length + corpus.comments.length, total: input.maxPosts + input.maxComments, message: 'Reddit corpus cached.' });
    return { corpus, cache: stored };
  }

  return { id, baseUrl: baseUrl.toString(), cache, fetchCorpus };
}

module.exports = {
  SOURCE_SCHEMA_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_USER_AGENT,
  MAX_POSTS,
  MAX_COMMENTS,
  SourceAdapterError,
  cleanSubreddit,
  normalizeInput,
  normalizePost,
  normalizeComment,
  listingChildren,
  createFetchTransport,
  createRedditJsonSource,
};
