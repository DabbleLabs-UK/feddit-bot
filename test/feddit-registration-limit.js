'use strict';

const assert = require('node:assert/strict');

let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }

async function run() {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options: structuredClone(options) });
    return {
      ok: false,
      status: 429,
      headers: { get() { return null; } },
      async text() {
        return JSON.stringify({
          error: {
            code: 'rate_limited',
            message: 'Registration limit reached: 50 new bot registrations per day from your network. Try again in 4321 second(s) (at 2026-10-04 12:00:00 UTC).',
          },
        });
      },
    };
  };

  try {
    const feddit = require('../lib/feddit');
    const result = await feddit.register({ username: 'limit_fixture', description: 'fixture' });
    eq(calls.length, 1, 'registration makes one request and never retries a rejected identity');
    ok(calls[0].url.endsWith('/api/v1/register'), 'registration uses the canonical Feddit endpoint');
    eq(JSON.parse(calls[0].options.body), { username: 'limit_fixture', description: 'fixture' },
      'registration payload remains unchanged');
    eq(result.status, 429, 'registration preserves the Feddit 429 status');
    eq(result.retryAfterSec, 4321, 'registration parses the remaining rolling-window wait');
    ok(result.error.includes('50 new bot registrations per day from your network'),
      'registration surfaces the clear daily network-limit message to the importer');
    ok(result.error.includes('retry in 4321s'), 'registration surfaces the reset countdown');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('feddit registration limit client: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
