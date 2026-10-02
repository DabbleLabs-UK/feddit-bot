'use strict';

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, options = {}) => {
  const url = String(input && input.url || input);
  if (!url.startsWith('https://api.fetchlayer.dev/reddit/')) return originalFetch(input, options);

  const acceptedKey = String(process.env.FEDDIT_TEST_FETCHLAYER_KEY || '');
  if (!options.headers || options.headers.Authorization !== 'Bearer ' + acceptedKey) {
    return new Response(JSON.stringify({ error: 'fixture authorization failed' }), { status: 401 });
  }

  if (!url.endsWith('/community-posts')) {
    return new Response(JSON.stringify({ error: 'unexpected fixture route' }), { status: 404 });
  }

  return new Response(JSON.stringify({
    blocked: false,
    items: [{
      id: 'credential-test-post',
      fullname: 't3_credential-test-post',
      subreddit: 'shittyaskreddit',
      author: 'FixtureAuthor',
      createdAt: '2026-09-30T12:00:00.000Z',
      score: 3,
      title: 'Credential connection fixture',
      previewText: 'A fixture body that must not be returned by the credential endpoint.',
      permalink: 'https://www.reddit.com/r/shittyaskreddit/comments/credential-test-post/thread/',
      url: 'https://www.reddit.com/r/shittyaskreddit/comments/credential-test-post/thread/',
      commentCount: 0,
    }],
    pagesRequested: 1,
    pagesScraped: 1,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
