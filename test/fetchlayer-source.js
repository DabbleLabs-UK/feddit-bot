'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createFetchLayerSource,
  createFetchLayerTransport,
} = require('../lib/culture-importer/fetchlayer-source');

const fixtureDirectory = path.join(__dirname, 'fixtures', 'culture-importer');
const communityFixture = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'fetchlayer-community-posts.json'), 'utf8'));
const thread1Fixture = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'fetchlayer-thread-post1.json'), 'utf8'));
const thread2Fixture = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'fetchlayer-thread-post2.json'), 'utf8'));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-fetchlayer-source-'));
let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

async function rejectedCode(action, code, message) {
  await assert.rejects(action, (error) => {
    eq(error.code, code, message);
    return true;
  });
}

async function run() {
  const calls = [];
  const transport = {
    async postJson(url, body) {
      calls.push({ url, body: structuredClone(body) });
      if (url.includes('community-posts')) {
        const listing = structuredClone(communityFixture);
        listing.items[0].commentCount = 100;
        return listing;
      }
      return structuredClone(body.url.includes('/post1/') ? thread1Fixture : thread2Fixture);
    },
  };
  const source = createFetchLayerSource({
    apiKey: 'fixture-key',
    transport,
    cacheDirectory: path.join(temporaryRoot, 'complete-cache'),
    now: () => Date.parse('2026-10-02T10:00:00.000Z'),
  });
  const progress = [];
  const first = await source.fetchCorpus({
    subreddit: 'ExampleSub',
    maxPosts: 100,
    maxComments: 4,
    since: '2023-11-14T21:00:00.000Z',
    until: '2023-11-15T00:00:00.000Z',
  }, { onProgress: (event) => progress.push(event) });
  eq(calls[0].body.pages, 4, 'subreddit pagination requests enough 25-item FetchLayer pages');
  eq(calls[0].body.sort, 'new', 'subreddit sample uses the recent-post feed');
  eq(calls[1].body.pages, 1, 'comment-page request is bounded to the remaining sample');
  eq(first.corpus.posts.length, 2, 'FetchLayer posts normalize into the existing corpus');
  eq(first.corpus.posts[0].body, 'Tell us the strangest answer you can defend, with enough detail for the full thread reader.', 'thread enrichment replaces a listing preview with the full post body');
  eq(first.corpus.comments.length, 4, 'nested FetchLayer comments flatten into the existing corpus');
  eq(first.corpus.comments[0].threadSourceId, 't3_post1', 'comment retains its thread identity');
  eq(first.corpus.comments[1].parentSourceId, 't1_comment1', 'comment retains its parent identity');
  eq(first.corpus.comments[1].parentAuthor, 'DryWit', 'sampled parent author is reconstructed');
  eq(first.corpus.comments[2].depth, 2, 'nested comment depth is preserved');
  eq(first.corpus.comments[0].author, 'DryWit', 'public contributor identity is preserved in the private corpus');
  eq(first.corpus.posts[1].outboundUrl, 'https://example.test/diagram', 'link post destination is preserved');
  eq(first.corpus.provenance.provider, 'FetchLayer', 'provider provenance is explicit');
  ok(progress.some((event) => event.kind === 'post') && progress.some((event) => event.kind === 'comment'), 'post and comment progress is reported');

  const cached = await source.fetchCorpus({
    subreddit: 'ExampleSub', maxPosts: 100, maxComments: 4,
    since: '2023-11-14T21:00:00.000Z', until: '2023-11-15T00:00:00.000Z',
  });
  eq(cached.cache.hit, true, 'matching FetchLayer source input uses the six-hour cache');
  eq(calls.length, 3, 'cache hit makes no additional upstream calls');

  const paginationCalls = [];
  const paginationSource = createFetchLayerSource({
    apiKey: 'fixture-key',
    cacheDirectory: path.join(temporaryRoot, 'pagination-cache'),
    transport: {
      async postJson(url, body) {
        paginationCalls.push({ url, body: structuredClone(body) });
        if (url.includes('community-posts')) {
          const listing = structuredClone(communityFixture);
          listing.items[0].commentCount = 100;
          return listing;
        }
        return structuredClone(body.url.includes('/post1/') ? thread1Fixture : thread2Fixture);
      },
    },
  });
  await paginationSource.fetchCorpus({ subreddit: 'ExampleSub', maxPosts: 2, maxComments: 60 });
  eq(paginationCalls[1].body.pages, 3, 'comment retrieval requests multiple provider pages for a larger target');
  eq(paginationCalls[1].body.depth, 8, 'comment relationships use a bounded nested-tree depth');

  const filteredListing = structuredClone(communityFixture);
  filteredListing.items[1].createdAt = '2022-01-01T00:00:00.000Z';
  const filteredThread = structuredClone(thread1Fixture);
  filteredThread.comments[0].children[0].children[0].createdAt = '2022-01-01T00:00:00.000Z';
  const filtered = createFetchLayerSource({
    apiKey: 'fixture-key',
    cacheDirectory: path.join(temporaryRoot, 'filtered-cache'),
    transport: {
      async postJson(url) {
        if (url.includes('community-posts')) return structuredClone(filteredListing);
        return structuredClone(filteredThread);
      },
    },
  });
  const filteredResult = await filtered.fetchCorpus({
    subreddit: 'ExampleSub', maxPosts: 2, maxComments: 3, since: '2023-01-01T00:00:00.000Z',
  });
  eq(filteredResult.corpus.posts.map((post) => post.sourceId), ['t3_post1'], 'recent-window filtering excludes older posts');
  eq(filteredResult.corpus.comments.length, 2, 'recent-window filtering also excludes older nested comments');

  const partial = createFetchLayerSource({
    apiKey: 'fixture-key',
    cacheDirectory: path.join(temporaryRoot, 'partial-cache'),
    transport: {
      async postJson(url, body) {
        if (url.includes('community-posts')) return structuredClone(communityFixture);
        if (body.url.includes('/post1/')) {
          const error = new Error('this public thread could not be read');
          error.code = 'FETCHLAYER_SOURCE_BLOCKED';
          error.retryable = true;
          throw error;
        }
        return structuredClone(thread2Fixture);
      },
    },
  });
  const partialResult = await partial.fetchCorpus({ subreddit: 'ExampleSub', maxPosts: 2, maxComments: 4 });
  eq(partialResult.corpus.comments.length, 1, 'available thread data survives another thread failure');
  eq(partialResult.corpus.provenance.partialFailures[0].code, 'FETCHLAYER_SOURCE_BLOCKED', 'partial failure keeps bounded diagnostics');
  ok(partialResult.corpus.warnings.some((warning) => warning.includes('could not read 1')), 'partial source result has a user-visible warning');
  eq(partialResult.corpus.provenance.complete, false, 'partial source result is marked incomplete');

  const haltedListing = structuredClone(communityFixture);
  haltedListing.items.push({
    ...structuredClone(haltedListing.items[1]),
    id: 'post3',
    fullname: 't3_post3',
    title: 'A third discussion that must not be requested after rate limiting',
    permalink: 'https://www.reddit.com/r/ExampleSub/comments/post3/third_discussion/',
    url: 'https://www.reddit.com/r/ExampleSub/comments/post3/third_discussion/',
    createdAt: '2023-11-14T21:30:00.000Z',
    commentCount: 1,
  });
  const haltedThreadCalls = [];
  const halted = createFetchLayerSource({
    apiKey: 'fixture-key',
    cacheDirectory: path.join(temporaryRoot, 'halted-cache'),
    transport: {
      async postJson(url, body) {
        if (url.includes('community-posts')) return structuredClone(haltedListing);
        haltedThreadCalls.push(body.url);
        if (body.url.includes('/post2/')) {
          const error = new Error('provider rate limit');
          error.code = 'FETCHLAYER_RATE_LIMITED';
          error.status = 429;
          error.retryable = true;
          throw error;
        }
        return structuredClone(thread1Fixture);
      },
    },
  });
  const haltedResult = await halted.fetchCorpus({ subreddit: 'ExampleSub', maxPosts: 3, maxComments: 10 });
  eq(haltedResult.corpus.comments.length, 3, 'comments fetched before a provider-wide failure remain reviewable');
  eq(haltedThreadCalls.length, 2, 'provider-wide failure stops further per-thread upstream calls');
  eq(haltedResult.corpus.provenance.threadSamplingStoppedBy, 'FETCHLAYER_RATE_LIMITED', 'provider-wide sampling stop is explicit in provenance');
  ok(haltedResult.corpus.warnings.some((warning) => warning.includes('Further thread sampling stopped')), 'provider-wide sampling stop is visible to the operator');

  const malformedCommunity = createFetchLayerSource({
    apiKey: 'fixture-key',
    cacheDirectory: path.join(temporaryRoot, 'malformed-cache'),
    transport: { async postJson() { return { blocked: false }; } },
  });
  await rejectedCode(
    () => malformedCommunity.fetchCorpus({ subreddit: 'ExampleSub', maxPosts: 2, maxComments: 0 }),
    'FETCHLAYER_BAD_RESPONSE',
    'malformed subreddit response has a stable provider-specific code',
  );

  let missingKeyCalls = 0;
  const missingKey = createFetchLayerSource({
    apiKey: '',
    cacheDirectory: path.join(temporaryRoot, 'missing-key-cache'),
    transport: { async postJson() { missingKeyCalls++; return {}; } },
  });
  await rejectedCode(
    () => missingKey.fetchCorpus({ subreddit: 'ExampleSub', maxPosts: 2, maxComments: 0 }),
    'FETCHLAYER_NOT_CONFIGURED',
    'missing FetchLayer key explains the configuration dependency',
  );
  eq(missingKeyCalls, 0, 'missing key fails before any source request');

  const statuses = [
    [403, 'FETCHLAYER_FORBIDDEN'],
    [429, 'FETCHLAYER_RATE_LIMITED'],
    [503, 'FETCHLAYER_UNAVAILABLE'],
  ];
  for (const [status, code] of statuses) {
    let attempts = 0;
    const statusTransport = createFetchLayerTransport({
      maxRetries: 1,
      retryDelayMs: 0,
      async fetchImpl() { attempts++; return response(status, { error: 'raw provider body must not leak' }); },
    });
    await rejectedCode(
      () => statusTransport.postJson('https://api.fetchlayer.dev/reddit/community-posts', {}, {}),
      code,
      'HTTP ' + status + ' receives a stable FetchLayer error',
    );
    eq(attempts, status === 403 ? 1 : 2, 'only retryable HTTP ' + status + ' failures are retried once');
  }

  const malformedTransport = createFetchLayerTransport({
    maxRetries: 0,
    async fetchImpl() { return response(200, 'not-json'); },
  });
  await rejectedCode(
    () => malformedTransport.postJson('https://api.fetchlayer.dev/reddit/community-posts', {}, {}),
    'FETCHLAYER_BAD_JSON',
    'malformed provider JSON receives a stable error',
  );

  const cancelled = new AbortController();
  cancelled.abort();
  const cancellationTransport = createFetchLayerTransport({
    async fetchImpl(_url, options) {
      if (options.signal.aborted) throw new Error('aborted');
      return response(200, {});
    },
  });
  await assert.rejects(
    () => cancellationTransport.postJson('https://api.fetchlayer.dev/reddit/community-posts', {}, { signal: cancelled.signal }),
    (error) => error.name === 'AbortError',
    'caller cancellation remains an AbortError',
  );
  checks++;

  console.log('fetchlayer culture source: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
