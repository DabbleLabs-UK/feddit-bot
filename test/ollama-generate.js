'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-ollama-test-'));
process.env.FEDDIT_BOT_DATA_DIR = dataDir;
const ollama = require('../lib/providers/ollama');

async function withServer(handler, action) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await action('http://127.0.0.1:' + address.port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonLine(value) {
  return JSON.stringify(value) + '\n';
}

async function run() {
  const requests = [];
  const replies = [
    {
      message: { content: 'A visible reply.' },
      prompt_eval_count: 14,
      eval_count: 5,
      done_reason: 'stop',
      done: true,
    },
    {
      message: { content: '', thinking: 'hidden reasoning' },
      prompt_eval_count: 14,
      eval_count: 200,
      done_reason: 'length',
      done: true,
    },
    {
      message: { content: '' },
      prompt_eval_count: 14,
      eval_count: 200,
      done_reason: 'length',
      done: true,
    },
  ];
  const scriptedTransport = async (body, options) => {
    requests.push({ body, options });
    return replies.shift();
  };

  let leaseReleases = 0;
  const result = await ollama.generate({
    system: 'Stay in character.',
    prompt: 'Reply to this post.',
    model: 'direct-model',
    numPredict: 200,
    priorityClass: 'interactive',
    chatTransport: scriptedTransport,
    leaseClient: {
      acquire: async (detail) => {
        assert.equal(detail.priorityClass, 'interactive');
        return {
          waitMs: 42,
          profile: { num_ctx: 3072, num_thread: 4 },
          release: async () => { leaseReleases++; },
        };
      },
    },
  });
  assert.equal(result.text, 'A visible reply.');
  assert.equal(result.usage.inputTokens, 14);
  assert.equal(result.usage.outputTokens, 5);
  assert.equal(result.queueMs, 42);
  const sent = requests[0].body;
  assert.equal(sent.keep_alive, -1);
  assert.equal(sent.stream, true);
  assert.equal(sent.options.num_predict, 200);
  assert.equal(sent.options.num_ctx, 3072);
  assert.equal(sent.options.num_thread, 4);
  assert.equal(leaseReleases, 1, 'the shared lease is released after generation');
  assert.equal(Object.hasOwn(sent, 'think'), false, 'do not expose thinking-only traces as visible content');

  await assert.rejects(
    ollama.generate({ model: 'thinking-model', numPredict: 200, chatTransport: scriptedTransport }),
    (error) => error.code === 'THINKING_EXHAUSTED' && /used its reply allowance thinking/i.test(error.message),
  );
  assert.equal(ollama.isBusy(), false, 'single-flight gate is released after a thinking exhaustion');

  await assert.rejects(
    ollama.generate({ model: 'empty-model', numPredict: 200, chatTransport: scriptedTransport }),
    (error) => error.code === 'EMPTY_RESPONSE' && /reached its reply limit/i.test(error.message),
  );
  assert.equal(ollama.isBusy(), false, 'single-flight gate is released after an empty response');

  assert.ok(ollama.DEFAULT_GENERATION_TIMEOUT_MS >= 10 * 60 * 1000,
    'the local generation default allows slow CPU models more than two minutes');
  assert.ok(ollama.DEFAULT_STREAM_IDLE_TIMEOUT_MS >= 5 * 60 * 1000,
    'the stream watchdog is tolerant of a heavily loaded local machine');

  await withServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(jsonLine({ message: { content: 'long success' }, done: true, eval_count: 2 }));
    }, 70);
  }, async (base) => {
    const value = await ollama._test.ollamaChatStream({ model: 'slow-start', messages: [] }, {
      base, timeoutMs: 250, idleTimeoutMs: 40,
    });
    assert.equal(value.message.content, 'long success',
      'a response that starts beyond a simulated old header boundary still succeeds');
  });

  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(jsonLine({ message: { thinking: 'progress' }, done: false }));
  }, async (base) => {
    await assert.rejects(
      ollama._test.ollamaChatStream({ model: 'stalled', messages: [] }, {
        base, timeoutMs: 250, idleTimeoutMs: 30,
      }),
      (error) => error.code === 'OLLAMA_STALLED' && error.failureClass === 'stalled-stream' && error.streamStarted,
    );
  });

  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(jsonLine({ message: { content: 'partial' }, done: false }));
    setImmediate(() => res.socket.destroy());
  }, async (base) => {
    await assert.rejects(
      ollama._test.ollamaChatStream({ model: 'reset', messages: [] }, { base, timeoutMs: 250, idleTimeoutMs: 100 }),
      (error) => error.code === 'OLLAMA_CONNECTION_RESET' && error.failureClass === 'connection-reset',
      'a model process restart or socket reset is classified without claiming which one happened',
    );
  });

  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end(jsonLine({ message: { content: 'partial' }, done: false }));
  }, async (base) => {
    await assert.rejects(
      ollama._test.ollamaChatStream({ model: 'incomplete', messages: [] }, { base, timeoutMs: 250, idleTimeoutMs: 100 }),
      (error) => error.code === 'OLLAMA_INCOMPLETE_STREAM' && error.failureClass === 'incomplete-response',
    );
  });

  await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end('{not-json}\n');
  }, async (base) => {
    await assert.rejects(
      ollama._test.ollamaChatStream({ model: 'malformed', messages: [] }, { base, timeoutMs: 250, idleTimeoutMs: 100 }),
      (error) => error.code === 'OLLAMA_MALFORMED_RESPONSE' && error.failureClass === 'malformed-response',
    );
  });

  await withServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'model runner unavailable' }));
  }, async (base) => {
    await assert.rejects(
      ollama._test.ollamaChatStream({ model: 'unavailable', messages: [] }, { base, timeoutMs: 250, idleTimeoutMs: 100 }),
      (error) => error.code === 'OLLAMA_HTTP_ERROR' && error.failureClass === 'ollama-unavailable' && error.httpStatus === 503,
    );
  });

  let unavailableBase;
  await withServer((_req, res) => res.end(), async (base) => { unavailableBase = base; });
  await assert.rejects(
    ollama._test.ollamaChatStream({ model: 'offline', messages: [] }, {
      base: unavailableBase, timeoutMs: 250, idleTimeoutMs: 100,
    }),
    (error) => error.code === 'OLLAMA_UNREACHABLE' && error.failureClass === 'ollama-unavailable',
  );

  await withServer(() => {}, async (base) => {
    await assert.rejects(
      ollama._test.ollamaChatStream({ model: 'slow-model', messages: [] }, {
        base, timeoutMs: 30, idleTimeoutMs: 100,
      }),
      (error) => error.code === 'OLLAMA_TIMEOUT' && error.failureClass === 'total-timeout' &&
        /did not finish within 30ms/i.test(error.message),
    );
  });
  assert.equal(ollama.isBusy(), false, 'transport failures do not retain the single-flight gate');

  let releaseVisibleGeneration;
  const heldTransport = async () => new Promise((resolve) => {
    releaseVisibleGeneration = () => resolve({
      message: { content: 'Tracked reply.' },
      prompt_eval_count: 12,
      eval_count: 3,
      done_reason: 'stop',
      done: true,
    });
  });
  const tracked = ollama.generate({
    model: 'tracked-model',
    profileId: 'profile-1',
    botName: 'happy_dayz',
    kind: 'scheduled-generation',
    activityAction: 'writing a comment',
    activityTrigger: 'scheduled simulation',
    activityTarget: 'f/localnews t3_123',
    chatTransport: heldTransport,
  });
  await Promise.resolve();
  const active = ollama.generationActivity().active;
  assert.equal(active.botName, 'happy_dayz');
  assert.equal(active.action, 'writing a comment');
  assert.equal(active.trigger, 'scheduled simulation');
  assert.equal(active.target, 'f/localnews t3_123');
  assert.equal(active.status, 'running');
  assert.equal(Object.hasOwn(active, 'prompt'), false, 'activity status never exposes the prompt');
  releaseVisibleGeneration();
  await tracked;
  const finished = ollama.generationActivity();
  assert.equal(finished.active, null);
  assert.equal(finished.recent[0].status, 'completed');
  assert.equal(finished.recent[0].botName, 'happy_dayz');
  assert.equal(finished.recent[0].published, false);
  assert.equal(finished.recent[0].schedulingContinues, true);
  assert.ok(finished.recent[0].durationMs >= 0);

  await assert.rejects(
    ollama.generate({
      model: 'tracked-model',
      profileId: 'profile-1',
      botName: 'happy_dayz',
      prompt: 'PRIVATE PROMPT MUST NOT PERSIST',
      chatTransport: async () => {
        const error = new Error('upstream echoed PRIVATE PROMPT MUST NOT PERSIST');
        error.code = 'OLLAMA_TRANSPORT_ERROR';
        error.failureClass = 'transport-error';
        throw error;
      },
    }),
    (error) => error.code === 'OLLAMA_TRANSPORT_ERROR',
  );

  const telemetry = fs.readFileSync(ollama._test.telemetryFile, 'utf8');
  assert.doesNotMatch(telemetry, /Stay in character|Reply to this post|Tracked reply|visible reply|PRIVATE PROMPT/i,
    'bounded telemetry contains no prompt, generated content, or free-form upstream error text');
  const records = JSON.parse(telemetry).events;
  assert.ok(records.length <= 50, 'local generation telemetry is bounded');
  assert.equal(records[0].published, false);
  assert.equal(records[0].schedulingContinues, true);

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('ollama-generate: all checks passed');
}

run().catch((error) => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
