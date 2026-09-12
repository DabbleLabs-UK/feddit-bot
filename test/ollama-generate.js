'use strict';

const assert = require('node:assert/strict');
const ollama = require('../lib/providers/ollama');

function fakeResponse(value) {
  return {
    ok: true,
    text: async () => JSON.stringify(value),
  };
}

async function run() {
  const originalFetch = global.fetch;
  const requests = [];
  const replies = [
    {
      message: { content: 'A visible reply.' },
      prompt_eval_count: 14,
      eval_count: 5,
      done_reason: 'stop',
    },
    {
      message: { content: '', thinking: 'hidden reasoning' },
      prompt_eval_count: 14,
      eval_count: 200,
      done_reason: 'length',
    },
    {
      message: { content: '' },
      prompt_eval_count: 14,
      eval_count: 200,
      done_reason: 'length',
    },
  ];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return fakeResponse(replies.shift());
  };

  try {
    const result = await ollama.generate({
      system: 'Stay in character.',
      prompt: 'Reply to this post.',
      model: 'direct-model',
      numPredict: 200,
    });
    assert.equal(result.text, 'A visible reply.');
    assert.equal(result.usage.inputTokens, 14);
    assert.equal(result.usage.outputTokens, 5);
    const sent = JSON.parse(requests[0].options.body);
    assert.equal(sent.keep_alive, -1);
    assert.equal(sent.options.num_predict, 200);
    assert.equal(Object.hasOwn(sent, 'think'), false, 'do not expose thinking-only traces as visible content');

    await assert.rejects(
      ollama.generate({ model: 'thinking-model', numPredict: 200 }),
      (error) => error.code === 'THINKING_EXHAUSTED' && /used its reply allowance thinking/i.test(error.message),
    );
    assert.equal(ollama.isBusy(), false, 'single-flight gate is released after a thinking exhaustion');

    await assert.rejects(
      ollama.generate({ model: 'empty-model', numPredict: 200 }),
      (error) => error.code === 'EMPTY_RESPONSE' && /reached its reply limit/i.test(error.message),
    );
    assert.equal(ollama.isBusy(), false, 'single-flight gate is released after an empty response');

    assert.ok(ollama.DEFAULT_GENERATION_TIMEOUT_MS >= 10 * 60 * 1000,
      'the local generation default allows slow CPU models more than two minutes');
    global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    await assert.rejects(
      ollama.generate({ model: 'slow-model', numPredict: 200, timeoutMs: 5 }),
      (error) => error.code === 'OLLAMA_TIMEOUT' && /did not finish within 5ms/i.test(error.message),
    );
    assert.equal(ollama.isBusy(), false, 'single-flight gate is released after a timeout');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('ollama-generate: all checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
