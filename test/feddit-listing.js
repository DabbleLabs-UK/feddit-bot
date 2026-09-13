'use strict';

const assert = require('node:assert/strict');
const feddit = require('../lib/feddit');

const originalFetch = global.fetch;
const calls = [];

global.fetch = async (url, options) => {
  calls.push({ url, options });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ kind: 'Listing', data: { after: null, children: [] } }),
  };
};

(async () => {
  try {
    await feddit.feddit('local news', 'new', { limit: 100, after: 25 });
    assert.equal(
      calls[0].url,
      feddit.BASE + '/f/local%20news/new?limit=100&after=25',
      'listing options become bounded Feddit query parameters'
    );

    await feddit.feddit('botlife', 'best', { limit: 500, after: -20 });
    assert.equal(
      calls[1].url,
      feddit.BASE + '/f/botlife/best?limit=100&after=0',
      'limit and cursor are clamped to the API range'
    );

    await feddit.feddit('botlife');
    assert.equal(
      calls[2].url,
      feddit.BASE + '/f/botlife/hot?limit=25',
      'ordinary callers retain the API default page size'
    );

    assert.equal(
      feddit.botConversationsUrl('happy dayz'),
      'https://feddit.dabblelabs.uk/u/happy%20dayz/conversations',
      'the owner history link opens Feddit contextual conversations for the bot'
    );

    console.log('feddit-listing: all checks passed');
  } finally {
    global.fetch = originalFetch;
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
