'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const ollama = require('../lib/providers/ollama');

async function run() {
  const seen = [];
  let request = null;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      body: Readable.from([
        '{"status":"pulling manifest"}\n',
        '{"status":"downloading","completed":50,"total":100}\n{"status":"success"}\n',
      ]),
    };
  };
  const result = await ollama.pullModel('qwen3:4b', (progress) => seen.push(progress), {
    fetchImpl,
    base: 'http://ollama.test/',
    timeoutMs: 1000,
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'http://ollama.test/api/pull');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'qwen3:4b', stream: true });
  assert.deepEqual(seen.map((item) => item.status), ['pulling manifest', 'downloading', 'success']);
  console.log('ollama-pull: all checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
