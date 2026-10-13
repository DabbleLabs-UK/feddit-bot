'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const evaluation = require('../scripts/concise-branch-evaluation');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-concise-evaluation-test-'));
const now = 1800000000000;
const idle = async () => ({ busy: false, nextAt: now + 600000 });
const logs = [];
let directoryIndex = 0;

function cases() {
  return { cases: Array.from({ length: 5 }, (_, index) => {
    const item = { id: 'case-' + index, kind: index === 0 ? 'post' : 'comment', bot: 'frozen-bot-' + index,
      model: evaluation.MODEL, temperature: index === 0 ? 0 : 0.8, numPredict: 250 + index,
      system: 'PRIVATE SYSTEM ' + index, control: 'PRIVATE CONTROL ' + index, treatment: 'PRIVATE TREATMENT ' + index };
    item.hashes = Object.fromEntries(['system', 'control', 'treatment'].map((key) => [key, evaluation.sha(item[key])]));
    return item;
  }) };
}

function fixture(value = cases()) {
  const directory = path.join(temporary, String(directoryIndex++));
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'cases.json'), JSON.stringify(value));
  return directory;
}

function ledger(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'results.json'), 'utf8'));
}

function mockProvider(directory, onGenerate) {
  return {
    OLLAMA_BASE: 'http://127.0.0.1:11434', SHARED_OLLAMA_ARBITER_URL: '', isBusy: () => false,
    _test: { ollamaChatStream: async () => ({ message: { content: 'A natural short thought.' } }) },
    generate: async (options) => {
      assert.equal(ledger(directory).calls.at(-1).status, 'started', 'durable intent precedes any provider call');
      assert.equal(options.model, evaluation.MODEL);
      assert.equal(options.timeoutMs, 600000);
      assert.equal(options.leaseClient, null);
      assert.equal(options.kind, 'isolated-concise-branch-evaluation');
      if (onGenerate) return onGenerate(options);
      const response = await options.chatTransport({}, { signal: new AbortController().signal, timeoutMs: options.timeoutMs });
      return { provider: 'ollama', model: evaluation.MODEL, text: response.message.content,
        ms: 10, usage: { inputTokens: 20, outputTokens: 5 } };
    },
  };
}

function runOptions(directory, extra = {}) {
  return { directory, status: idle, now: () => now,
    loadProvider: () => mockProvider(directory), log: (value) => logs.push(value), ...extra };
}

function schedule(nextAt) {
  return { settings: { paused: false }, profiles: [{ enabled: true, dryRun: false,
    postsPerHour: 1, articlePostsPerHour: 0, commentsPerHour: 0, votesPerHour: 0,
    sched: { nextPostAt: nextAt, nextArticleAt: null, nextCommentAt: null, nextVoteAt: null } }] };
}

async function untilAborted(_body, options) {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(new Error('aborted'));
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

async function run() {
  assert.equal(evaluation.POLL_MS, 200);
  assert.equal(evaluation.MAX_CALLS, 10);
  assert.equal(evaluation.CEILING_MS, 600000);
  assert.deepEqual(evaluation.order().map((item) => item.arm), [
    'control', 'treatment', 'treatment', 'control', 'control', 'treatment', 'treatment', 'control', 'control', 'treatment',
  ]);
  assert.equal(evaluation.nextNaturalAt(schedule(now + 10000)), now + 10000);
  assert.equal(evaluation.nextNaturalAt({ settings: { paused: true }, profiles: [] }), Infinity);
  const rehearsal = schedule(now + 10000);
  rehearsal.profiles[0].dryRun = true;
  rehearsal.profiles[0].simulationState = { sched: { ...rehearsal.profiles[0].sched, nextPostAt: now + 5000 } };
  assert.equal(evaluation.nextNaturalAt(rehearsal), now + 5000);
  for (const invalid of [{}, { settings: { paused: false } }, schedule(null), schedule('123')]) {
    assert.throws(() => evaluation.nextNaturalAt(invalid), { code: 'EVAL_SCHEDULE_UNKNOWN' });
  }

  const statusCalls = [];
  const status = evaluation.createStatusReader({
    fetch: async (url, options) => {
      statusCalls.push(url);
      assert.equal(options.method, 'GET');
      assert.ok(options.signal);
      return { ok: true, json: async () => url.endsWith('runtime-state') ? { busy: false } : { active: null } };
    },
    readProfiles: () => schedule(now + 600000),
  });
  assert.deepEqual(await status(), { busy: false, nextAt: now + 600000 });
  assert.deepEqual(statusCalls.sort(), [
    'http://127.0.0.1:8770/api/local-model-activity', 'http://127.0.0.1:8770/api/runtime-state',
  ]);
  for (const response of [{ ok: false }, { ok: true, json: async () => ({ busy: false }) }]) {
    await assert.rejects(evaluation.createStatusReader({ fetch: async () => response,
      readProfiles: () => schedule(now + 600000) })(), { code: 'EVAL_STATUS_UNAVAILABLE' });
  }

  for (const state of [{ busy: true, nextAt: Infinity }, { busy: false, nextAt: now + 300000 },
    { busy: false, nextAt: now - 1 }, { busy: false }]) {
    const directory = fixture();
    let providerLoads = 0;
    const result = await evaluation.runOne(runOptions(directory, { status: async () => state,
      loadProvider: () => { providerLoads++; throw new Error('must not load'); } }));
    assert.equal(result.status, 'deferred');
    assert.equal(providerLoads, 0);
    assert.equal(fs.existsSync(path.join(directory, 'results.json')), false, 'deferral does not reserve a ledger call');
    assert.equal(fs.existsSync(path.join(directory, 'run.lock')), false);
  }
  const unavailableDirectory = fixture();
  assert.equal((await evaluation.runOne(runOptions(unavailableDirectory, {
    status: async () => { throw new Error('PRIVATE runtime detail'); },
  }))).status, 'deferred');
  assert.equal(fs.existsSync(path.join(unavailableDirectory, 'results.json')), false);

  const options = { signal: new AbortController().signal, timeoutMs: 600000 };
  let transported = false;
  await assert.rejects(evaluation.guardedTransport(async () => { transported = true; }, {}, options,
    async () => ({ busy: true, nextAt: Infinity }), { now: () => now }), { code: 'EVAL_YIELD' });
  assert.equal(transported, false);
  for (const [nextStatus, code] of [
    [async () => ({ busy: true, nextAt: Infinity }), 'EVAL_YIELD'],
    [async () => ({ busy: false, nextAt: now + 3000 }), 'EVAL_DEADLINE_DUE'],
    [async () => { throw new Error('unavailable'); }, 'EVAL_STATUS_UNAVAILABLE'],
  ]) {
    let checks = 0;
    await assert.rejects(evaluation.guardedTransport(untilAborted, {}, options,
      () => ++checks === 1 ? idle() : nextStatus(), { now: () => now, pollMs: 1 }), { code });
    assert.ok(checks >= 2, 'a later poll cancels only the experimental transport');
  }
  await assert.rejects(evaluation.guardedTransport(untilAborted, {}, options, idle,
    { now: () => now, pollMs: 1, ceilingMs: 5 }), { code: 'EVAL_CEILING' });

  const directory = fixture();
  const generationOptions = [];
  const provider = mockProvider(directory, async (request) => {
    generationOptions.push(request);
    await request.chatTransport({}, options);
    return { provider: 'ollama', model: evaluation.MODEL, text: 'PRIVATE GENERATED RESPONSE',
      ms: 5, usage: { inputTokens: 10, outputTokens: 3 } };
  });
  const first = await evaluation.runOne(runOptions(directory, { loadProvider: () => provider }));
  assert.equal(first.status, 'completed-one');
  assert.equal(generationOptions.length, 1, 'one invocation can generate only one arm');
  assert.equal(ledger(directory).calls.length, 1);
  assert.equal(generationOptions[0].temperature, 0, 'configured zero temperature is not replaced');
  assert.equal(generationOptions[0].numPredict, 250);
  assert.equal(generationOptions[0].system, cases().cases[0].system);
  assert.equal(generationOptions[0].prompt, cases().cases[0].control);
  for (let index = 1; index < 10; index++) {
    await evaluation.runOne(runOptions(directory, { loadProvider: () => provider }));
  }
  assert.equal(generationOptions.length, 10);
  assert.equal(ledger(directory).calls.length, 10);
  const completed = await evaluation.runOne(runOptions(directory, {
    status: async () => { throw new Error('must not inspect after cap'); },
    loadProvider: () => { throw new Error('must not generate after cap'); },
  }));
  assert.equal(completed.status, 'complete');
  assert.equal(generationOptions.length, 10);
  assert.equal(ledger(directory).calls[2].arm, 'treatment');
  assert.equal(JSON.stringify(logs).includes('PRIVATE'), false, 'stdout summaries contain neither prompts nor generated text');
  const overCap = ledger(directory);
  overCap.calls.push({ ...overCap.calls[0] });
  evaluation.saveLedger(directory, overCap);
  await assert.rejects(evaluation.runOne(runOptions(directory)), { code: 'EVAL_LEDGER_MISMATCH' });

  const yieldingDirectory = fixture();
  let yieldChecks = 0;
  const yielding = mockProvider(yieldingDirectory);
  yielding._test.ollamaChatStream = untilAborted;
  await assert.rejects(evaluation.runOne(runOptions(yieldingDirectory, {
    loadProvider: () => yielding,
    status: async () => ({ busy: ++yieldChecks > 2, nextAt: now + 600000 }),
  })), { code: 'EVAL_YIELD' });
  assert.equal(ledger(yieldingDirectory).calls[0].status, 'failed-no-retry');
  assert.equal(ledger(yieldingDirectory).calls[0].code, 'EVAL_YIELD');
  await assert.rejects(evaluation.runOne(runOptions(yieldingDirectory)), { code: 'EVAL_PRIOR_CALL_NO_RETRY' });

  const failedDirectory = fixture();
  let attempts = 0;
  const failing = mockProvider(failedDirectory, async () => {
    attempts++;
    throw Object.assign(new Error('PRIVATE provider detail'), { code: 'OLLAMA_TIMEOUT' });
  });
  await assert.rejects(evaluation.runOne(runOptions(failedDirectory, { loadProvider: () => failing })), { code: 'OLLAMA_TIMEOUT' });
  assert.equal(ledger(failedDirectory).calls[0].status, 'failed-no-retry');
  await assert.rejects(evaluation.runOne(runOptions(failedDirectory, { loadProvider: () => failing })),
    { code: 'EVAL_PRIOR_CALL_NO_RETRY' });
  assert.equal(attempts, 1);
  const failedLedger = ledger(failedDirectory);
  failedLedger.calls[0].status = 'started';
  evaluation.saveLedger(failedDirectory, failedLedger);
  await assert.rejects(evaluation.runOne(runOptions(failedDirectory)), { code: 'EVAL_PRIOR_CALL_NO_RETRY' });

  const hashDirectory = fixture();
  await evaluation.runOne(runOptions(hashDirectory));
  const originalLedger = fs.readFileSync(path.join(hashDirectory, 'results.json'), 'utf8');
  const modified = cases();
  modified.cases[0].control += ' changed';
  fs.writeFileSync(path.join(hashDirectory, 'cases.json'), JSON.stringify(modified));
  await assert.rejects(evaluation.runOne(runOptions(hashDirectory)), { code: 'EVAL_CASE_HASH_MISMATCH' });
  modified.cases[0].hashes.control = evaluation.sha(modified.cases[0].control);
  fs.writeFileSync(path.join(hashDirectory, 'cases.json'), JSON.stringify(modified));
  await assert.rejects(evaluation.runOne(runOptions(hashDirectory)), { code: 'EVAL_LEDGER_MISMATCH' });
  assert.equal(fs.readFileSync(path.join(hashDirectory, 'results.json'), 'utf8'), originalLedger);

  const lockedDirectory = fixture();
  const release = evaluation.exclusiveRunLock(lockedDirectory);
  await assert.rejects(evaluation.runOne(runOptions(lockedDirectory)), { code: 'EVAL_LOCKED' });
  assert.ok(fs.existsSync(path.join(lockedDirectory, 'run.lock')), 'another run never removes the existing lock');
  release();
  assert.equal(fs.existsSync(path.join(lockedDirectory, 'run.lock')), false);

  const wrongModel = cases();
  wrongModel.cases[0].model = 'paid-provider';
  await assert.rejects(evaluation.runOne(runOptions(fixture(wrongModel))), { code: 'EVAL_INVALID_CASES' });
  const unsafeDirectory = fixture();
  const unsafe = mockProvider(unsafeDirectory);
  unsafe.OLLAMA_BASE = 'https://remote-provider.invalid';
  await assert.rejects(evaluation.runOne(runOptions(unsafeDirectory, { loadProvider: () => unsafe })),
    { code: 'EVAL_PROVIDER_UNSAFE' });
  assert.equal(fs.existsSync(path.join(unsafeDirectory, 'results.json')), false);
  const wrongCount = cases();
  wrongCount.cases.pop();
  await assert.rejects(evaluation.runOne(runOptions(fixture(wrongCount))), { code: 'EVAL_INVALID_CASES' });
  assert.equal(require.cache[require.resolve('../lib/providers/ollama')], undefined,
    'pure tests never import the real provider or touch its telemetry');
  assert.equal(JSON.stringify(logs).includes('PRIVATE'), false);
  console.log('concise-branch-evaluation: passed (mock inference only)');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
