'use strict';

// Run the actual provider against fake native HTTP and a virtual clock. No
// model calls, sockets, private data or wall-clock timeout waits are involved.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MINUTE = 60_000;
const SOURCE = fs.readFileSync(path.join(__dirname, '../lib/providers/ollama.js'), 'utf8');

function fixture(persisted = [], transportOptions = {}) {
  let now = 1_800_000_000_000;
  let nextTimer = 0;
  const timers = new Map();
  const requests = [];
  const records = persisted.map((value) => ({ ...value }));
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const setTimeoutFake = (fn, delay) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + Number(delay), fn });
    return id;
  };
  const transport = {
    request(target, options, receive) {
      if (transportOptions.synchronousError) throw transportOptions.synchronousError;
      const req = new EventEmitter();
      req.target = target;
      req.options = options;
      req.destroyed = false;
      req.end = (body) => { req.body = JSON.parse(body); };
      req.destroy = (error) => {
        req.destroyed = true;
        req.destroyError = error;
        if (error) req.emit('error', error);
      };
      req.respond = (statusCode = 200) => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.setEncoding = () => {};
        receive(res);
        req.response = res;
        return res;
      };
      requests.push(req);
      return req;
    },
  };
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, Buffer, URL, AbortController, Date: ClockDate,
    process: { env: {} },
    setTimeout: setTimeoutFake,
    clearTimeout: (id) => timers.delete(id),
    require(name) {
      if (name === 'node:http' || name === 'node:https') return transport;
      if (name === '../shared-ollama-lease') return { createClient: () => null };
      if (name === '../local-generation-telemetry') return {
        createLocalGenerationTelemetry: () => ({
          read: () => records.map((item) => ({ ...item })),
          record: (item) => records.unshift({ ...item }),
          file: 'in-memory-test-only',
        }),
      };
      throw new Error('Unexpected provider dependency: ' + name);
    },
  });
  vm.runInContext(SOURCE, context, { filename: 'lib/providers/ollama.js' });
  const provider = module.exports;
  function advance(ms) {
    const end = now + ms;
    let count = 0;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      if (++count > 1000) throw new Error('Runaway fake timer');
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  }
  function start(options = {}, generate = false) {
    const promise = generate
      ? provider.generate({ model: 'fixture-local-model', leaseClient: null,
        profileId: 'bot-selected', botName: 'fixture_bot', kind: 'scheduled-decision',
        system: 'PRIVATE_SYSTEM_SENTINEL', prompt: 'PRIVATE_PROMPT_SENTINEL', ...options })
      : provider._test.ollamaChatStream({ model: 'fixture-local-model', messages: [] }, options);
    // Attach rejection handling immediately; fake clock failures are synchronous.
    const settled = promise.then((value) => ({ value }), (error) => ({ error }));
    const request = requests[requests.length - 1];
    return { settled, request, respond: () => request.respond() };
  }
  return { provider, advance, start, timers, requests, records, now: () => now };
}

const line = (res, value) => res.emit('data', JSON.stringify(value) + '\n');
function complete(res, content = 'A normal answer.') {
  line(res, { message: { content }, done: true, eval_count: 7, prompt_eval_count: 23 });
  res.emit('end');
}
async function success(turn) {
  const result = await turn.settled;
  assert.equal(result.error, undefined, result.error && result.error.message);
  return result.value;
}
async function failure(turn, code, classification) {
  const result = await turn.settled;
  assert.ok(result.error, 'request must fail');
  assert.equal(result.error.code, code);
  if (classification) assert.equal(result.error.failureClass, classification);
  return result.error;
}
function clean(f, expectedRequests = 1) {
  assert.equal(f.timers.size, 0, 'every provider timer is cleared');
  f.advance(60 * MINUTE);
  assert.equal(f.requests.length, expectedRequests, 'no automatic retry after settlement');
  assert.equal(f.timers.size, 0);
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('local defaults are exactly 20 / 5 / 30 minutes', () => {
  const { provider } = fixture();
  assert.equal(provider.DEFAULT_FIRST_OUTPUT_TIMEOUT_MS, 20 * MINUTE);
  assert.equal(provider.DEFAULT_STREAM_IDLE_TIMEOUT_MS, 5 * MINUTE);
  assert.equal(provider.DEFAULT_GENERATION_TIMEOUT_MS, 30 * MINUTE);
});

test('first generated output at 19 minutes succeeds, even without early headers', async () => {
  const f = fixture();
  const turn = f.start();
  f.advance(19 * MINUTE);
  assert.equal(turn.request.destroyed, false);
  complete(turn.respond());
  assert.equal((await success(turn)).message.content, 'A normal answer.');
  clean(f);
});

test('silent connection is cancelled at the first-output deadline', async () => {
  const f = fixture();
  const turn = f.start();
  f.advance(20 * MINUTE - 1);
  assert.equal(turn.request.destroyed, false);
  f.advance(1);
  await failure(turn, 'OLLAMA_FIRST_OUTPUT_TIMEOUT', 'waiting-for-first-output-timeout');
  assert.equal(turn.request.destroyed, true);
  clean(f);
});

test('headers, framing, empty and metadata records never satisfy first-output', async () => {
  const f = fixture();
  const turn = f.start();
  const res = turn.respond();
  for (let i = 0; i < 4; i++) {
    f.advance(4 * MINUTE);
    res.emit('data', '\n  \n');
    line(res, {});
    line(res, { model: 'fixture-local-model', created_at: 'metadata', message: { content: '', thinking: '' } });
  }
  f.advance(4 * MINUTE);
  await failure(turn, 'OLLAMA_FIRST_OUTPUT_TIMEOUT', 'waiting-for-first-output-timeout');
  clean(f);
});

test('genuine generation crosses 15 minutes and completes before 30', async () => {
  const f = fixture();
  const turn = f.start();
  const res = turn.respond();
  for (let i = 0; i < 7; i++) {
    f.advance(4 * MINUTE);
    line(res, { message: { content: 'token ' }, done: false });
    assert.equal(turn.request.destroyed, false);
  }
  complete(res, 'finished');
  assert.match((await success(turn)).message.content, /finished$/);
  clean(f);
});

test('continuous generation cannot escape the 30-minute emergency ceiling', async () => {
  const f = fixture();
  const turn = f.start();
  const res = turn.respond();
  for (let i = 0; i < 7; i++) {
    f.advance(4 * MINUTE);
    line(res, { message: { thinking: 'more' }, done: false });
  }
  f.advance(2 * MINUTE);
  await failure(turn, 'OLLAMA_TIMEOUT', 'emergency-hard-timeout');
  assert.equal(turn.request.destroyed, true);
  clean(f);
});

test('five minutes without generated progress cancels a started stream', async () => {
  const f = fixture();
  const turn = f.start();
  line(turn.respond(), { message: { content: 'partial' } });
  f.advance(5 * MINUTE - 1);
  assert.equal(turn.request.destroyed, false);
  f.advance(1);
  await failure(turn, 'OLLAMA_STALLED', 'no-generation-progress-timeout');
  clean(f);
});

test('partial raw bytes cannot reset the generated-progress timer', async () => {
  const f = fixture();
  const turn = f.start();
  const res = turn.respond();
  line(res, { message: { content: 'partial' } });
  f.advance(4 * MINUTE);
  res.emit('data', '{"message":');
  f.advance(MINUTE);
  await failure(turn, 'OLLAMA_STALLED', 'no-generation-progress-timeout');
  clean(f);
});

test('empty, non-string and metadata-only records cannot extend progress', async () => {
  const f = fixture();
  const turn = f.start();
  const res = turn.respond();
  line(res, { message: { content: 'partial' } });
  f.advance(4 * MINUTE);
  for (const record of [{}, { message: { content: '', thinking: '' } },
    { message: { content: 123, thinking: {} } }, { eval_count: 42 },
    { response: '', thinking: '' }, { model: 'fixture-local-model', done: false }]) line(res, record);
  res.emit('data', '\n');
  f.advance(MINUTE);
  await failure(turn, 'OLLAMA_STALLED', 'no-generation-progress-timeout');
  clean(f);
});

for (const [name, record] of [
  ['message.content', { message: { content: 'next' } }],
  ['message.thinking', { message: { thinking: 'next' } }],
  ['response', { response: 'next' }],
  ['thinking', { thinking: 'next' }],
  ['whitespace token', { message: { content: ' ' } }],
]) test(name + ' resets meaningful-progress deadline', async () => {
  const f = fixture();
  const turn = f.start();
  const res = turn.respond();
  line(res, { message: { content: 'first' } });
  f.advance(4 * MINUTE);
  line(res, record);
  f.advance(4 * MINUTE);
  assert.equal(turn.request.destroyed, false);
  complete(res);
  await success(turn);
  clean(f);
});

test('short successful request preserves output and final token usage', async () => {
  const f = fixture();
  const turn = f.start();
  const res = turn.respond();
  f.advance(20);
  line(res, { message: { content: 'Hello ' } });
  f.advance(20);
  complete(res, 'world');
  const value = await success(turn);
  assert.equal(value.message.content, 'Hello world');
  assert.equal(value.eval_count, 7);
  assert.equal(value.prompt_eval_count, 23);
  clean(f);
});

test('malformed response destroys request and clears every timer', async () => {
  const f = fixture();
  const turn = f.start();
  turn.respond().emit('data', '{invalid}\n');
  await failure(turn, 'OLLAMA_MALFORMED_RESPONSE');
  assert.equal(turn.request.destroyed, true);
  clean(f);
});

test('socket interruption clears timers and never retries partial output', async () => {
  const f = fixture();
  const turn = f.start();
  const res = turn.respond();
  line(res, { message: { content: 'partial' } });
  res.emit('aborted');
  await failure(turn, 'OLLAMA_CONNECTION_RESET');
  clean(f);
});

test('explicit abort destroys request, removes listener and clears timers', async () => {
  const f = fixture();
  const ctrl = new AbortController();
  let removed = 0;
  const originalRemove = ctrl.signal.removeEventListener.bind(ctrl.signal);
  ctrl.signal.removeEventListener = (...args) => { removed++; return originalRemove(...args); };
  const turn = f.start({ signal: ctrl.signal });
  line(turn.respond(), { message: { content: 'partial' } });
  ctrl.abort();
  const { error } = await turn.settled;
  assert.ok(error);
  assert.equal(turn.request.destroyed, true);
  assert.equal(removed, 1);
  clean(f);
});

test('pre-aborted request is never sent and owns no surviving timers', async () => {
  const f = fixture();
  const ctrl = new AbortController();
  ctrl.abort();
  const turn = f.start({ signal: ctrl.signal });
  assert.ok((await turn.settled).error);
  assert.equal(turn.request.body, undefined);
  clean(f);
});

test('legacy hosted path retains 15-minute absolute cancellation', async () => {
  const f = fixture();
  const turn = f.start({ legacyTimeouts: true });
  const res = turn.respond();
  for (let i = 0; i < 3; i++) {
    f.advance(4 * MINUTE);
    line(res, { message: { content: 'progress' } });
  }
  f.advance(3 * MINUTE);
  await failure(turn, 'OLLAMA_TIMEOUT', 'total-timeout');
  clean(f);
});

test('failed generation clears Working/single-flight state; recovery is idle', async () => {
  const f = fixture();
  const turn = f.start({}, true);
  assert.equal(f.provider.isBusy(), true);
  assert.equal(f.provider.generationActivity().active.profileId, 'bot-selected');
  await assert.rejects(f.provider.generate({ leaseClient: null }), (error) => error.code === 'BUSY');
  line(turn.respond(), { message: { content: 'PRIVATE_OUTPUT_SENTINEL' } });
  f.advance(5 * MINUTE);
  await failure(turn, 'OLLAMA_STALLED', 'no-generation-progress-timeout');
  assert.equal(f.provider.isBusy(), false);
  assert.equal(f.provider.generationActivity().active, null);
  assert.equal(f.records[0].outcome, 'failed-before-publication');
  assert.equal(f.records[0].published, false);
  assert.doesNotMatch(JSON.stringify(f.records), /PRIVATE_(SYSTEM|PROMPT|OUTPUT)_SENTINEL/);
  clean(f);
  const restarted = fixture(f.records);
  assert.equal(restarted.provider.isBusy(), false);
  assert.equal(restarted.provider.generationActivity().active, null);
  assert.equal(restarted.requests.length, 0, 'restart never repeats prior generation');
  assert.equal(restarted.provider.generationActivity().recent[0].failureCode, 'OLLAMA_STALLED');
});

test('successful generation clears Working and allows a later explicit request', async () => {
  const f = fixture();
  const turn = f.start({}, true);
  complete(turn.respond());
  await success(turn);
  assert.equal(f.provider.generationActivity().active, null);
  assert.equal(f.provider.isBusy(), false);
  clean(f);
  const next = f.start({}, true);
  complete(next.respond());
  await success(next);
  assert.equal(f.records.length, 2);
  clean(f, 2);
});

test('telemetry records content-free timing and honest final token totals', async () => {
  const f = fixture();
  const started = f.now();
  const turn = f.start({}, true);
  const res = turn.respond();
  f.advance(16 * MINUTE);
  line(res, { message: { thinking: 'PRIVATE_THINKING_SENTINEL' } });
  let active = f.provider.generationActivity().active;
  assert.equal(active.requestStartedAt, started);
  assert.equal(active.firstOutputAt, started + 16 * MINUTE);
  assert.equal(active.lastProgressAt, started + 16 * MINUTE);
  assert.equal(active.progressRecords, 1);
  assert.equal(active.outputTokens, null, 'fragments must not be represented as exact tokens');
  f.advance(MINUTE);
  line(res, { message: { content: 'PRIVATE_OUTPUT_SENTINEL' } });
  active = f.provider.generationActivity().active;
  assert.equal(active.firstOutputAt, started + 16 * MINUTE);
  assert.equal(active.lastProgressAt, started + 17 * MINUTE);
  assert.equal(active.progressRecords, 2);
  assert.equal(active.outputCharacters, 'PRIVATE_OUTPUT_SENTINEL'.length);
  assert.equal(active.thinkingCharacters, 'PRIVATE_THINKING_SENTINEL'.length);
  line(res, { done: true, eval_count: 41, prompt_eval_count: 6930 });
  res.emit('end');
  await success(turn);
  const saved = f.records[0];
  assert.equal(saved.completedAt, started + 17 * MINUTE);
  assert.equal(saved.endedAt, saved.completedAt);
  assert.equal(saved.inputTokens, 6930);
  assert.equal(saved.outputTokens, 41);
  assert.equal(saved.progressRecords, 2, 'terminal metadata is not generated progress');
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_(SYSTEM|PROMPT|OUTPUT|THINKING)_SENTINEL/);
  clean(f);
});

test('cancelled generation clears authoritative Working state and releases lease', async () => {
  const f = fixture();
  let loseLease;
  let released = 0;
  const promise = f.provider.generate({
    profileId: 'bot-selected', botName: 'fixture_bot', model: 'fixture-local-model',
    leaseClient: { acquire: async ({ onLost }) => {
      loseLease = onLost;
      return { profile: { num_thread: 4 }, waitMs: 0, release: async () => { released++; } };
    } },
  });
  const settled = promise.then((value) => ({ value }), (error) => ({ error }));
  for (let i = 0; i < 10 && !f.requests.length; i++) await Promise.resolve();
  assert.equal(f.provider.generationActivity().active.profileId, 'bot-selected');
  const request = f.requests[0];
  line(request.respond(), { message: { content: 'partial' } });
  f.advance(100);
  loseLease();
  const { error } = await settled;
  assert.equal(error.code, 'OLLAMA_LEASE_LOST');
  assert.equal(request.destroyed, true);
  assert.equal(released, 1);
  assert.equal(f.provider.isBusy(), false);
  assert.equal(f.provider.generationActivity().active, null);
  assert.equal(f.records[0].published, false);
  assert.equal(f.records[0].cancelledAt, f.now());
  clean(f);
});

test('thinking-only semantic failure retains completed transport diagnostics', async () => {
  const f = fixture();
  const started = f.now();
  const turn = f.start({}, true);
  const res = turn.respond();
  f.advance(100);
  line(res, { message: { thinking: 'PRIVATE_THINKING_SENTINEL' } });
  f.advance(200);
  line(res, { message: { thinking: 'PRIVATE_MORE_THINKING' }, done: true, done_reason: 'length', eval_count: 200 });
  res.emit('end');
  await failure(turn, 'THINKING_EXHAUSTED');
  const saved = f.records[0];
  assert.equal(saved.httpStatus, 200);
  assert.equal(saved.streamStarted, true);
  assert.equal(saved.responseStarted, true);
  assert.ok(saved.bytesReceived > 0);
  assert.equal(saved.phase, 'streaming');
  assert.equal(saved.firstOutputAt, started + 100);
  assert.equal(saved.lastProgressAt, started + 300);
  assert.equal(saved.progressRecords, 2);
  assert.equal(saved.outputTokens, 200);
  assert.equal(saved.outcome, 'failed-before-publication');
  assert.equal(f.provider.generationActivity().active, null);
  assert.equal(f.provider.isBusy(), false);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_/);
  clean(f);
});

test('synchronous native request failure with signal clears all timers', async () => {
  const cause = Object.assign(new Error('Synthetic invalid request'), { code: 'ERR_INVALID_PROTOCOL' });
  const f = fixture([], { synchronousError: cause });
  const ctrl = new AbortController();
  const turn = f.start({ signal: ctrl.signal });
  const error = await failure(turn, 'OLLAMA_TRANSPORT_ERROR', 'transport-error');
  assert.equal(error.transportCode, 'ERR_INVALID_PROTOCOL');
  ctrl.abort();
  clean(f, 0);
});

(async () => {
  let passed = 0;
  for (const item of tests) {
    let guard;
    try {
      await Promise.race([item.run(), new Promise((_, reject) => {
        guard = setTimeout(() => reject(new Error('Unsettled mocked request: ' + item.name)), 2000);
      })]);
      passed++;
      console.log('PASS ' + item.name);
    } catch (error) { console.error('FAIL ' + item.name); throw error; }
    finally { clearTimeout(guard); }
  }
  console.log('ollama-progress-timeouts: ' + passed + '/' + tests.length + ' deterministic checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
