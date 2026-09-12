'use strict';

const assert = require('node:assert/strict');
const ollama = require('../lib/providers/ollama');
const {
  cleanRunnerUrl,
  parseAllowedModels,
  cleanPayload,
  createWorker,
} = require('../worker');
const { authorised, bearerToken } = require('../lib/worker-auth');

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
    text: async () => JSON.stringify(body),
  };
}

async function run() {
  eq(bearerToken('Bearer abc123'), 'abc123', 'bearer token parsed');
  ok(authorised('Bearer correct', 'correct'), 'matching worker key accepted');
  ok(!authorised('Bearer wrong', 'correct'), 'wrong worker key refused');
  ok(!authorised('Bearer anything', ''), 'missing server key fails closed');
  eq(cleanRunnerUrl('https://feddit.example/bots'), 'https://feddit.example/bots/', 'runner URL keeps reverse-proxy path');
  assert.throws(() => cleanRunnerUrl('http://feddit.example/bots'), /HTTPS/, 'remote clear-text runner URL refused');
  checks++;

  const models = parseAllowedModels('', ollama.DEFAULT_MODEL);
  const clean = cleanPayload({ prompt: 'hello', temperature: 99, numPredict: 99999 }, models);
  eq(clean.temperature, 2, 'temperature capped');
  eq(clean.numPredict, 4096, 'output token request capped');
  eq(clean.model, ollama.DEFAULT_MODEL, 'default resident model selected');
  assert.throws(
    () => cleanPayload({ prompt: 'hello', model: 'unapproved' }, models),
    /does not allow model/,
    'unapproved model refused',
  );
  checks++;

  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: url.toString(), options, body });
    if (url.pathname.endsWith('/api/worker/claim')) {
      return response(200, {
        job: {
          id: 'j_test',
          payload: { prompt: 'Say hi.', model: ollama.DEFAULT_MODEL },
        },
      });
    }
    if (url.pathname.endsWith('/complete')) return response(200, { ok: true });
    throw new Error('Unexpected worker request: ' + url);
  };
  const logs = [];
  const worker = createWorker({
    runnerUrl: 'https://feddit.example/bots',
    key: 'worker-secret',
    workerId: 'dell-test',
    fetchImpl,
    generate: async (payload) => ({
      provider: 'ollama',
      model: payload.model,
      text: 'Hi.',
      ms: 3,
      usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0 },
    }),
    logger: {
      log: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });
  eq(await worker.pollOnce(), true, 'claimed work processed');
  eq(calls.length, 2, 'worker claimed then completed one job');
  ok(calls[0].url.includes('/bots/api/worker/claim'), 'reverse-proxy base path preserved');
  eq(calls[0].options.headers.Authorization, 'Bearer worker-secret', 'worker authenticates every request');
  eq(calls[1].body.result.text, 'Hi.', 'generated result returned to public runner');
  eq(calls[1].body.workerId, 'dell-test', 'completion identifies lease holder');
  ok(logs.some((message) => message.includes('Completed')), 'completion logged without secret');
  ok(logs.every((message) => !message.includes('worker-secret')), 'worker key never logged');

  console.log('worker: ' + checks + ' checks passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

