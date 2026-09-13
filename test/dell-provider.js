'use strict';

const assert = require('node:assert/strict');
const { createDellProvider, hashRequest } = require('../lib/providers/dell');
const providers = require('../lib/providers');
const scheduler = require('../lib/scheduler');

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

async function run() {
  const request = {
    profileId: 'p_one',
    kind: 'preview',
    model: 'local-model',
    system: 'Be odd.',
    prompt: 'Say hello.',
    temperature: 0.7,
    numPredict: 50,
    activityAction: 'writing a preview reply',
  };
  eq(hashRequest(request), hashRequest({ ...request }), 'identical generation has a stable dedupe hash');
  ok(hashRequest(request) !== hashRequest({ ...request, prompt: 'Say goodbye.' }), 'prompt changes the dedupe hash');
  eq(scheduler.providerOf({ provider: 'dell' }), 'dell', 'scheduler preserves hosted placement');
  eq(scheduler.modelOf({ provider: 'dell', model: 'local-model' }, 'fallback'), 'local-model', 'hosted placement uses its worker model');

  let reads = 0;
  let enqueued = null;
  const queue = {
    enqueue: (job) => {
      enqueued = job;
      return { id: 'j_one', status: 'queued' };
    },
    get: () => {
      reads++;
      if (reads === 1) return { id: 'j_one', status: 'claimed' };
      return {
        id: 'j_one',
        status: 'completed',
        result: {
          provider: 'ollama',
          model: 'local-model',
          text: 'Hello.',
          usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0 },
          ms: 10,
        },
      };
    },
  };
  let current = 1000;
  const dell = createDellProvider(queue, {
    now: () => current,
    pollMs: 10,
    sleep: async (ms) => { current += ms; },
  });
  const result = await dell.generate({ ...request, priority: 'interactive' });
  eq(result.provider, 'dell', 'result identifies Feddit-hosted placement');
  eq(result.workerProvider, 'ollama', 'result retains the worker engine separately');
  eq(result.text, 'Hello.', 'worker text returned');
  eq(enqueued.priority, 'interactive', 'preview priority reaches the durable queue');
  eq(enqueued.profileId, 'p_one', 'profile ownership reaches the queue');
  eq(enqueued.activityAction, 'writing a preview reply', 'human-readable work activity reaches the queue');
  eq(enqueued.payload.prompt, 'Say hello.', 'worker payload contains the task prompt');
  ok(!Object.prototype.hasOwnProperty.call(enqueued.payload, 'apiKey'), 'worker payload excludes remote API keys');

  reads = 0;
  providers.configureDellQueue(queue, {
    now: () => current,
    pollMs: 10,
    sleep: async (ms) => { current += ms; },
  });
  const routed = await providers.generate({ ...request, provider: 'dell' });
  eq(routed.provider, 'dell', 'provider facade routes hosted generation to the queue');

  const failed = createDellProvider({
    enqueue: () => ({ id: 'j_bad' }),
    get: () => ({ id: 'j_bad', status: 'failed', lastError: 'model unavailable' }),
  });
  await assert.rejects(() => failed.generate(request), /model unavailable/, 'terminal worker error reaches the caller');
  checks++;

  console.log('dell provider: ' + checks + ' checks passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
