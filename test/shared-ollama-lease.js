'use strict';

const assert = require('node:assert/strict');
const { createClient } = require('../lib/shared-ollama-lease');

const calls = [];
const fetchImpl = async (url, options = {}) => {
  calls.push({ url, options });
  if (url.endsWith('/v1/acquire')) {
    return {
      ok: true,
      json: async () => ({
        id: 'lease-feddit',
        waitMs: 75,
        heartbeatMs: 60_000,
        profile: { num_ctx: 3072, num_thread: 4 },
      }),
    };
  }
  return { ok: true, json: async () => ({}) };
};

async function run() {
  const client = createClient('http://127.0.0.1:11435/', { fetchImpl });
  const lease = await client.acquire({ priorityClass: 'synthetic', purpose: 'scheduled-post' });
  assert.deepEqual(lease.profile, { num_ctx: 3072, num_thread: 4 });
  assert.equal(lease.waitMs, 75);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    client: 'feddit', priorityClass: 'synthetic', purpose: 'scheduled-post',
  });
  await lease.release();
  await lease.release();
  assert.equal(calls.filter((call) => call.options.method === 'DELETE').length, 1);
  assert.equal(createClient('', { fetchImpl }), null);
  console.log('shared-ollama-lease: all checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
