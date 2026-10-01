'use strict';

const { cacheKey, createFileCorpusCache } = require('./cache');

const SOURCE_SCHEMA_VERSION = 1;
const DEFAULT_BASE_URL = 'https://api.fetchlayer.dev/reddit/';
const MAX_POSTS = 1000;
const MAX_COMMENTS = 5000;
const COMMUNITY_PAGE_SIZE = 25;
const MAX_THREAD_REQUESTS = 24;
const MAX_COMMENT_PAGES_PER_THREAD = 5;
const DEFAULT_COMMENT_DEPTH = 8;

class SourceAdapterError extends Error {
  constructor(message, code = 'SOURCE_FAILED', options = {}) {
    super(String(message || 'The source adapter failed.'));
    this.name = 'SourceAdapterError';
    this.code = code;
    this.status = Number(options.status) || null;
    this.endpoint = options.endpoint ? String(options.endpoint) : '';
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

function text(value, max = 20_000) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function sourceId(kind, data) {
  const fullname = text(data && data.fullname, 80);
  if (fullname) return fullname;
  const id = text(data && data.id, 80);
  return id ? kind + '_' + id.replace(new RegExp('^' + kind + '_'), '') : '';
}

function canonicalUrl(value) {
  const clean = text(value, 2000);
  if (!clean) return '';
  try { return new URL(clean, 'https://www.reddit.com').toString(); } catch { return ''; }
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function withinWindow(createdAt, input) {
  const at = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(at)) return true;
  if (input.sinceMs != null && at < input.sinceMs) return false;
  if (input.untilMs != null && at > input.untilMs) return false;
  return true;
}

function normalizePost(data, subreddit) {
  const id = sourceId('t3', data);
  const permalink = canonicalUrl(data && (data.permalink || data.requestedUrl));
  const contentUrl = canonicalUrl(data && data.url);
  const isRedditContent = !contentUrl || /(^|\.)reddit\.com$/i.test(new URL(contentUrl).hostname);
  return {
    type: 'post',
    sourceId: id,
    id: id.replace(/^t3_/, ''),
    subreddit: text(data && (data.subreddit || subreddit), 80),
    author: text(data && data.author, 100) || '[deleted]',
    createdAt: isoTimestamp(data && data.createdAt),
    score: Number.isFinite(Number(data && data.score)) ? Number(data.score) : null,
    title: text(data && data.title, 600),
    body: text(data && (data.bodyText || data.previewText), 20_000),
    url: permalink,
    outboundUrl: isRedditContent ? '' : contentUrl,
    commentCount: Math.max(0, Number(data && data.commentCount) || 0),
    nsfw: data && data.nsfw === true,
    locked: data && data.locked === true,
  };
}

function normalizeComment(data, post, parentSourceId, depth) {
  const id = sourceId('t1', data);
  return {
    type: 'comment',
    sourceId: id,
    id: id.replace(/^t1_/, ''),
    threadSourceId: post.sourceId,
    parentSourceId: text(data && data.parentFullname, 80) || parentSourceId || post.sourceId,
    subreddit: post.subreddit,
    author: text(data && data.author, 100) || '[deleted]',
    createdAt: isoTimestamp(data && data.createdAt),
    score: Number.isFinite(Number(data && data.score)) ? Number(data.score) : null,
    body: text(data && data.bodyText, 20_000),
    url: canonicalUrl(data && data.permalink),
    postTitle: post.title,
    postAuthor: post.author,
    depth: Number.isFinite(Number(data && data.depth)) ? Math.max(0, Number(data.depth)) : depth,
  };
}

function flattenComments(nodes, post, input, limit) {
  const output = [];
  const seen = new Set();
  function visit(list, parentSourceId = post.sourceId, depth = 0) {
    for (const node of Array.isArray(list) ? list : []) {
      if (output.length >= limit) return;
      const normalized = normalizeComment(node, post, parentSourceId, depth);
      if (normalized.sourceId && !seen.has(normalized.sourceId)) {
        seen.add(normalized.sourceId);
        if (withinWindow(normalized.createdAt, input)) output.push(normalized);
      }
      visit(node && node.children, normalized.sourceId || parentSourceId, depth + 1);
    }
  }
  visit(nodes);
  return output;
}

function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => signal && signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      const error = new Error('Import cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function statusError(status, endpoint) {
  if (status === 401) {
    return new SourceAdapterError('FetchLayer rejected the configured API key.', 'FETCHLAYER_AUTH_FAILED', { status, endpoint });
  }
  if (status === 403) {
    return new SourceAdapterError('FetchLayer refused this source request. Check that the configured key can use the Reddit source.', 'FETCHLAYER_FORBIDDEN', { status, endpoint });
  }
  if (status === 429) {
    return new SourceAdapterError('FetchLayer is rate limited. Try the import again later or use the cached sample.', 'FETCHLAYER_RATE_LIMITED', { status, endpoint, retryable: true });
  }
  if (status >= 500) {
    return new SourceAdapterError('FetchLayer is temporarily unavailable (HTTP ' + status + ').', 'FETCHLAYER_UNAVAILABLE', { status, endpoint, retryable: true });
  }
  return new SourceAdapterError('FetchLayer could not complete the source request (HTTP ' + status + ').', 'FETCHLAYER_HTTP', { status, endpoint });
}

function createFetchLayerTransport(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || 60_000);
  const maxRetries = Math.max(0, Math.min(3, Number(options.maxRetries == null ? 2 : options.maxRetries)));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs == null ? 500 : options.retryDelayMs));
  return {
    async postJson(url, body, request = {}) {
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const onAbort = () => controller.abort(request.signal && request.signal.reason);
        if (request.signal) {
          if (request.signal.aborted) onAbort();
          else request.signal.addEventListener('abort', onAbort, { once: true });
        }
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(url, {
            method: 'POST',
            headers: request.headers || {},
            body: JSON.stringify(body || {}),
            signal: controller.signal,
          });
          const raw = await response.text();
          if (!response.ok) throw statusError(response.status, url);
          try { return JSON.parse(raw); }
          catch (cause) {
            throw new SourceAdapterError('FetchLayer returned an unreadable response.', 'FETCHLAYER_BAD_JSON', { endpoint: url, cause });
          }
        } catch (error) {
          if (request.signal && request.signal.aborted) {
            const cancelled = new Error('Import cancelled.');
            cancelled.name = 'AbortError';
            throw cancelled;
          }
          let failure = error;
          if (controller.signal.aborted && !(error instanceof SourceAdapterError)) {
            failure = new SourceAdapterError('FetchLayer did not respond before the source timeout.', 'FETCHLAYER_TIMEOUT', { endpoint: url, retryable: true, cause: error });
          } else if (!(error instanceof SourceAdapterError)) {
            failure = new SourceAdapterError('FetchLayer could not be reached.', 'FETCHLAYER_NETWORK', { endpoint: url, retryable: true, cause: error });
          }
          if (!failure.retryable || attempt >= maxRetries) throw failure;
          await sleep(retryDelayMs * (attempt + 1), request.signal);
        } finally {
          clearTimeout(timer);
          if (request.signal) request.signal.removeEventListener('abort', onAbort);
        }
      }
    },
  };
}

function validateResponse(value, expected, endpoint) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SourceAdapterError('FetchLayer returned an incomplete ' + expected + ' response.', 'FETCHLAYER_BAD_RESPONSE', { endpoint });
  }
  if (value.blocked === true) {
    throw new SourceAdapterError('FetchLayer could not read the requested public Reddit content.', 'FETCHLAYER_SOURCE_BLOCKED', { endpoint, retryable: true });
  }
  return value;
}

function safePartialFailure(error, postSourceId) {
  return {
    postSourceId,
    code: text(error && error.code || 'FETCHLAYER_THREAD_FAILED', 100),
    status: Number(error && error.status) || null,
    message: text(error && error.message || 'FetchLayer could not read this thread.', 300),
    retryable: error && error.retryable === true,
  };
}

function createFetchLayerSource(options = {}) {
  const id = 'fetchlayer-reddit';
  const baseUrl = new URL(options.baseUrl || DEFAULT_BASE_URL);
  const transport = options.transport || createFetchLayerTransport(options);
  const cache = options.cache || createFileCorpusCache({ directory: options.cacheDirectory, now: options.now, ttlMs: options.cacheTtlMs });
  const apiKey = String(options.apiKey || process.env.FETCHLAYER_API_KEY || '').trim();
  const now = options.now || Date.now;
  const maxThreadRequests = Math.max(1, Math.min(MAX_THREAD_REQUESTS, Number(options.maxThreadRequests) || MAX_THREAD_REQUESTS));
  const maxCommentPages = Math.max(1, Math.min(MAX_COMMENT_PAGES_PER_THREAD, Number(options.maxCommentPages) || MAX_COMMENT_PAGES_PER_THREAD));
  const commentDepth = Math.max(1, Math.min(20, Number(options.commentDepth) || DEFAULT_COMMENT_DEPTH));

  function endpoint(route) {
    return new URL(route.replace(/^\//, ''), baseUrl).toString();
  }

  function headers() {
    if (!apiKey) {
      throw new SourceAdapterError('FetchLayer is not configured for this runner. Set FETCHLAYER_API_KEY, then restart Feddit Bots.', 'FETCHLAYER_NOT_CONFIGURED');
    }
    return { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async function fetchPosts(input, runtime) {
    const route = endpoint('community-posts');
    const pages = Math.max(1, Math.ceil(input.maxPosts / COMMUNITY_PAGE_SIZE));
    const response = validateResponse(await transport.postJson(route, {
      subreddit: input.subreddit,
      sort: 'new',
      limit: input.maxPosts,
      pages,
    }, { headers: headers(), signal: runtime.signal }), 'subreddit listing', route);
    if (!Array.isArray(response.items)) {
      throw new SourceAdapterError('FetchLayer returned a subreddit listing without posts.', 'FETCHLAYER_BAD_RESPONSE', { endpoint: route });
    }
    const seen = new Set();
    const posts = [];
    for (const raw of response.items) {
      const post = normalizePost(raw, input.subreddit);
      if (!post.sourceId || seen.has(post.sourceId) || !withinWindow(post.createdAt, input)) continue;
      seen.add(post.sourceId);
      posts.push(post);
      if (posts.length >= input.maxPosts) break;
    }
    if (input.maxPosts && !posts.length) {
      throw new SourceAdapterError('FetchLayer returned no posts in the requested subreddit and time window.', 'FETCHLAYER_NO_DATA', { endpoint: route });
    }
    runtime.onProgress({
      phase: 'fetch', state: 'running', source: id, kind: 'post', current: posts.length,
      total: input.maxPosts, pages: Number(response.pagesScraped) || 0,
      message: 'Fetched ' + posts.length + ' recent posts through FetchLayer.',
    });
    return {
      items: posts,
      pagesRequested: Number(response.pagesRequested) || pages,
      pagesScraped: Number(response.pagesScraped) || 0,
      incompleteReason: text(response.incompleteReason, 120),
    };
  }

  function candidateThreads(posts) {
    return posts.filter((post) => post.url && post.commentCount > 0)
      .sort((a, b) => b.commentCount - a.commentCount || String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, maxThreadRequests);
  }

  async function fetchComments(input, posts, runtime) {
    if (!input.maxComments) return { items: [], attempts: 0, pagesScraped: 0, failures: [], incomplete: false };
    const route = endpoint('post');
    const output = [];
    const seen = new Set();
    const failures = [];
    let attempts = 0;
    let pagesScraped = 0;
    let remainingPlaceholders = 0;
    for (const post of candidateThreads(posts)) {
      if (output.length >= input.maxComments) break;
      if (runtime.signal && runtime.signal.aborted) {
        const cancelled = new Error('Import cancelled.');
        cancelled.name = 'AbortError';
        throw cancelled;
      }
      const remaining = input.maxComments - output.length;
      const pages = Math.min(maxCommentPages, Math.max(1, Math.ceil(Math.min(remaining, post.commentCount) / COMMUNITY_PAGE_SIZE)));
      attempts++;
      try {
        const response = validateResponse(await transport.postJson(route, {
          url: post.url,
          pages,
          depth: commentDepth,
          commentLimit: remaining,
        }, { headers: headers(), signal: runtime.signal }), 'thread', route);
        if (!Array.isArray(response.comments)) {
          throw new SourceAdapterError('FetchLayer returned a thread without a comment tree.', 'FETCHLAYER_BAD_RESPONSE', { endpoint: route });
        }
        pagesScraped += Number(response.commentPagesScraped) || 0;
        remainingPlaceholders += Math.max(0, Number(response.remainingMoreCommentsCount) || 0);
        for (const comment of flattenComments(response.comments, post, input, remaining)) {
          if (!comment.sourceId || seen.has(comment.sourceId)) continue;
          seen.add(comment.sourceId);
          output.push(comment);
          if (output.length >= input.maxComments) break;
        }
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        if (['FETCHLAYER_AUTH_FAILED', 'FETCHLAYER_FORBIDDEN'].includes(error && error.code)) throw error;
        failures.push(safePartialFailure(error, post.sourceId));
      }
      runtime.onProgress({
        phase: 'fetch', state: 'running', source: id, kind: 'comment', current: output.length,
        total: input.maxComments, pages: pagesScraped,
        message: 'Fetched ' + output.length + ' comments from ' + attempts + ' sampled threads through FetchLayer.',
      });
    }
    return {
      items: output.slice(0, input.maxComments),
      attempts,
      pagesScraped,
      failures,
      incomplete: output.length < input.maxComments,
      remainingPlaceholders,
    };
  }

  function buildCorpus(input, postsResult, commentsResult) {
    const postsById = new Map(postsResult.items.map((post) => [post.sourceId, post]));
    const commentsById = new Map(commentsResult.items.map((comment) => [comment.sourceId, comment]));
    for (const comment of commentsResult.items) {
      const parent = commentsById.get(comment.parentSourceId);
      const post = postsById.get(comment.threadSourceId);
      comment.parentAuthor = parent ? parent.author : (comment.parentSourceId === comment.threadSourceId && post ? post.author : '');
    }
    const threadHints = commentsResult.items.reduce((hints, comment) => {
      if (hints.has(comment.threadSourceId)) return hints;
      const post = postsById.get(comment.threadSourceId);
      hints.set(comment.threadSourceId, {
        sourceId: comment.threadSourceId,
        title: post ? post.title : comment.postTitle,
        author: post ? post.author : comment.postAuthor,
        url: post ? post.url : '',
      });
      return hints;
    }, new Map());
    const warnings = [];
    if (postsResult.incompleteReason) warnings.push('FetchLayer returned a partial subreddit listing: ' + postsResult.incompleteReason + '.');
    if (commentsResult.failures.length) warnings.push('FetchLayer could not read ' + commentsResult.failures.length + ' sampled thread(s); the available source sample was retained.');
    if (input.maxComments && commentsResult.incomplete) warnings.push('The bounded FetchLayer thread sample returned ' + commentsResult.items.length + ' of ' + input.maxComments + ' requested comments.');
    return {
      schemaVersion: SOURCE_SCHEMA_VERSION,
      source: id,
      subreddit: input.subreddit,
      fetchedAt: new Date(Number(now())).toISOString(),
      window: {
        since: input.sinceMs == null ? null : new Date(input.sinceMs).toISOString(),
        until: input.untilMs == null ? null : new Date(input.untilMs).toISOString(),
      },
      posts: postsResult.items,
      comments: commentsResult.items,
      threadHints: Array.from(threadHints.values()),
      warnings,
      provenance: {
        adapter: id,
        provider: 'FetchLayer',
        baseHost: baseUrl.hostname,
        postPagesRequested: postsResult.pagesRequested,
        postPagesScraped: postsResult.pagesScraped,
        commentThreadRequests: commentsResult.attempts,
        commentPagesScraped: commentsResult.pagesScraped,
        remainingCommentPlaceholders: commentsResult.remainingPlaceholders,
        partialFailures: commentsResult.failures,
        complete: !postsResult.incompleteReason && !commentsResult.failures.length && !commentsResult.incomplete,
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
        onProgress({ phase: 'fetch', state: 'cached', current: 1, total: 1, message: 'Using the cached FetchLayer corpus.' });
        return { corpus: cached.value, cache: { ...cached, value: undefined } };
      }
    }
    onProgress({ phase: 'fetch', state: 'started', current: 0, total: input.maxPosts + input.maxComments, message: 'Fetching the public subreddit sample through FetchLayer.' });
    const progressRuntime = { signal: runtime.signal, onProgress };
    const posts = await fetchPosts(input, progressRuntime);
    const comments = await fetchComments(input, posts.items, progressRuntime);
    const corpus = buildCorpus(input, posts, comments);
    const stored = cache.set(key, corpus);
    onProgress({
      phase: 'fetch', state: corpus.warnings.length ? 'partial' : 'completed',
      current: corpus.posts.length + corpus.comments.length,
      total: input.maxPosts + input.maxComments,
      message: corpus.warnings.length ? 'FetchLayer source sample cached with a completeness warning.' : 'FetchLayer source sample cached.',
    });
    return { corpus, cache: stored };
  }

  return { id, baseUrl: baseUrl.toString(), cache, fetchCorpus };
}

module.exports = {
  SOURCE_SCHEMA_VERSION,
  DEFAULT_BASE_URL,
  MAX_POSTS,
  MAX_COMMENTS,
  COMMUNITY_PAGE_SIZE,
  MAX_THREAD_REQUESTS,
  MAX_COMMENT_PAGES_PER_THREAD,
  SourceAdapterError,
  cleanSubreddit,
  normalizeInput,
  normalizePost,
  normalizeComment,
  flattenComments,
  createFetchLayerTransport,
  createFetchLayerSource,
};
