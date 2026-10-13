'use strict';

// Fault injection only: no production files, provider imports or HTTP requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const evaluation = require('../scripts/concise-branch-evaluation');
const paused = require('../scripts/concise-paused-comparison');
const diagnostics = require('../scripts/evaluation-guard-diagnostics');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-guard-integration-'));
const now = () => 1800000000000;
const idle = async () => ({ busy: false, nextAt: Infinity });
const options = { signal: new AbortController().signal };
let checks = 0;
let sequence = 0;
const fixture = () => {
  const directory = path.join(root, String(sequence++));
  fs.mkdirSync(directory);
  return directory;
};
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

async function rejected(promise, phase, code, transportClass) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.guardDiagnostic.phase, phase);
    assert.equal(error.guardDiagnostic.safetyCode, code);
    if (transportClass) assert.equal(error.guardDiagnostic.transportClass, transportClass);
    assert.equal(JSON.stringify(error).includes('PRIVATE'), false);
    checks++;
    return true;
  });
}

function api(faultEndpoint, response) {
  return paused.createApi(async (url, request) => {
    assert.equal(request.method, 'GET');
    const endpoint = new URL(url).pathname;
    if (endpoint === faultEndpoint) return response();
    return { ok: true, json: async () => endpoint === '/api/settings'
      ? { settings: { paused: true } } : endpoint === '/api/runtime-state' ? { busy: false }
        : endpoint === '/api/runtime' ? { placement: 'desktop', ownerSessionRequired: false } : { active: null } };
  });
}

function leaseFixture() {
  const directory = fixture();
  const files = paused.paths(directory);
  const lease = { version: 1, nonce: crypto.randomUUID(), pid: process.pid, startedAt: now(),
    deadlineAt: now() + paused.MAX_PAUSE_MS,
    inferenceDeadlineAt: now() + paused.MAX_PAUSE_MS - paused.RESTORE_RESERVE_MS,
    originalPaused: false, restorePaused: false,
    owner: { pid: process.pid, createdTicks: '638000000000000000', commandHash: 'a'.repeat(64) } };
  json(files.lease, lease);
  json(files.watchdog, { nonce: lease.nonce, status: 'armed', pid: process.pid });
  return { directory, files, lease, api: { state: async () => ({ paused: true, busy: false }) },
    now, alive: () => true };
}

async function run() {
  for (const [endpoint, prefix] of [['/api/settings', 'settings'], ['/api/runtime-state', 'runtime'],
    ['/api/local-model-activity', 'activity'], ['/api/runtime', 'identity']]) {
    const invoke = (value) => endpoint === '/api/runtime' ? value.identity() : value.state();
    await rejected(invoke(api(endpoint, () => { throw Object.assign(new Error('PRIVATE token'),
      { name: 'TimeoutError' }); })), prefix + '-fetch', 'PAUSE_API_UNAVAILABLE', 'timeout');
    await rejected(invoke(api(endpoint, () => { throw Object.assign(new Error('PRIVATE socket'),
      { cause: { code: 'ECONNRESET' } }); })), prefix + '-fetch', 'PAUSE_API_UNAVAILABLE', 'reset');
    let responseRead = false;
    await rejected(invoke(api(endpoint, () => ({ ok: false, status: 503,
      json: async () => { responseRead = true; return { secret: 'PRIVATE body' }; } }))),
    prefix + '-http', 'PAUSE_API_UNAVAILABLE');
    assert.equal(responseRead, false, 'HTTP error bodies are not read or retained');
    await rejected(invoke(api(endpoint, () => ({ ok: true,
      json: async () => { throw new SyntaxError('PRIVATE body'); } }))),
    prefix + '-json', 'PAUSE_API_UNAVAILABLE', 'malformed-json');
    await rejected(invoke(api(endpoint, () => ({ ok: true, json: async () => ({ unexpected: 'PRIVATE' }) }))),
      prefix + '-schema', endpoint === '/api/settings' ? 'PAUSE_SETTINGS_UNKNOWN'
        : endpoint === '/api/runtime' ? 'PAUSE_DESKTOP_REQUIRED' : 'PAUSE_STATUS_UNKNOWN');
  }

  for (const [mutate, phase, code, className] of [
    [(env) => fs.unlinkSync(env.files.lease), 'lease-read', 'EVAL_STATUS_UNAVAILABLE', 'missing'],
    [(env) => fs.writeFileSync(env.files.lease, '{'), 'lease-read', 'EVAL_STATUS_UNAVAILABLE', 'malformed-json'],
    [(env) => json(env.files.lease, { ...env.lease, deadlineAt: 1 }), 'lease-validate', 'PAUSE_INVALID_LEASE'],
    [(env) => json(env.files.lease, { ...env.lease, nonce: crypto.randomUUID() }), 'lease-validate', 'PAUSE_OWNERSHIP_CHANGED'],
    [(env) => json(env.files.released, { nonce: env.lease.nonce }), 'released-read', 'PAUSE_ABORTED'],
    [(env) => json(env.files.abort, { nonce: crypto.randomUUID() }), 'abort-read', 'PAUSE_OWNERSHIP_CHANGED'],
    [(env) => json(env.files.abort, { nonce: env.lease.nonce }), 'abort-read', 'PAUSE_ABORTED'],
    [(env) => fs.unlinkSync(env.files.watchdog), 'watchdog-read', 'PAUSE_WATCHDOG_UNAVAILABLE'],
    [(env) => fs.writeFileSync(env.files.watchdog, '{'), 'watchdog-read', 'EVAL_STATUS_UNAVAILABLE', 'malformed-json'],
    [(env) => json(env.files.watchdog, { nonce: crypto.randomUUID() }), 'watchdog-read', 'PAUSE_OWNERSHIP_CHANGED'],
    [(env) => { env.alive = () => false; }, 'watchdog-liveness', 'PAUSE_WATCHDOG_UNAVAILABLE'],
    [(env) => { env.alive = () => { throw Object.assign(new Error('PRIVATE process'), { code: 'EPERM' }); }; },
      'watchdog-liveness', 'EVAL_STATUS_UNAVAILABLE', 'permission'],
    [(env) => { env.now = () => env.lease.inferenceDeadlineAt; }, 'experiment-deadline', 'PAUSE_DEADLINE'],
    [(env) => { env.api.state = async () => ({ paused: false, busy: false }); }, 'pause-check', 'PAUSE_RESUMED_EXTERNALLY'],
    [(env) => { env.api.state = async () => { json(env.files.abort, { nonce: env.lease.nonce });
      return { paused: true, busy: false }; }; }, 'abort-read', 'PAUSE_ABORTED'],
  ]) {
    const env = leaseFixture();
    mutate(env);
    await rejected(paused.createPausedStatus(env)(), phase, code, className);
  }

  await rejected(evaluation.guardedTransport(async () => { throw new Error('must not start'); }, {}, options,
    async () => ({ busy: false }), { now }), 'status-schema', 'EVAL_STATUS_UNAVAILABLE');
  for (const [readProfiles, phase, code] of [
    [() => { throw Object.assign(new Error('PRIVATE path'), { code: 'ENOENT' }); }, 'schedule-read', 'EVAL_SCHEDULE_UNKNOWN'],
    [() => ({}), 'schedule-schema', 'EVAL_SCHEDULE_UNKNOWN'],
  ]) {
    await rejected(evaluation.createStatusReader({ readProfiles,
      fetch: async (url) => ({ ok: true, json: async () => url.endsWith('runtime-state')
        ? { busy: false } : { active: null } }) })(), phase, code);
  }

  // Prove transport completion cannot overtake a failing asynchronous poll.
  let finishTransport;
  let finishPoll;
  let pollStarted;
  const pollReady = new Promise((resolve) => { pollStarted = resolve; });
  let statusCalls = 0;
  let settled = false;
  const race = evaluation.guardedTransport(() => new Promise((resolve) => { finishTransport = resolve; }), {}, options,
    async () => {
      if (++statusCalls === 1) return idle();
      pollStarted();
      return new Promise((resolve, reject) => { finishPoll = reject; });
    }, { now, pollMs: 1 }).finally(() => { settled = true; });
  await pollReady;
  finishTransport({ result: 'PRIVATE output' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'result waits for safety poll');
  finishPoll(diagnostics.failure('PAUSE_OWNERSHIP_CHANGED', { phase: 'lease-validate', now }));
  await rejected(race, 'lease-validate', 'PAUSE_OWNERSHIP_CHANGED');

  // Provider rejection also must not erase a pending guard failure.
  let rejectTransport;
  let rejectPoll;
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  let failureChecks = 0;
  const failedRace = evaluation.guardedTransport(() => new Promise((resolve, reject) => { rejectTransport = reject; }),
    {}, options, async () => {
      if (++failureChecks === 1) return idle();
      ready();
      return new Promise((resolve, reject) => { rejectPoll = reject; });
    }, { now, pollMs: 1 });
  await readyPromise;
  rejectTransport(Object.assign(new Error('PRIVATE provider rejection'), { code: 'OLLAMA_STREAM_ERROR' }));
  await new Promise((resolve) => setImmediate(resolve));
  rejectPoll(diagnostics.failure('PAUSE_WATCHDOG_UNAVAILABLE', { phase: 'watchdog-liveness', now }));
  await rejected(failedRace, 'watchdog-liveness', 'PAUSE_WATCHDOG_UNAVAILABLE');

  const postOwner = leaseFixture();
  postOwner.api.state = async () => {
    json(postOwner.files.watchdog, { nonce: postOwner.lease.nonce, status: 'released' });
    return { paused: true, busy: false };
  };
  await assert.rejects(paused.createPausedStatus(postOwner)(), (error) => {
    assert.equal(error.guardDiagnostic.phase, 'watchdog-read');
    assert.equal(error.guardDiagnostic.ownershipStage, 'post');
    checks++;
    return true;
  });

  // A fast transport must also pass a final ownership/status check.
  let fastChecks = 0;
  await rejected(evaluation.guardedTransport(async () => ({ content: 'PRIVATE result' }), {}, options,
    async () => ++fastChecks === 1 ? idle() : { busy: true, nextAt: Infinity }, { now }),
  'transport-final', 'EVAL_YIELD');

  // The diagnostic is durable before abort; a new recorder preserves the first failure.
  const directory = fixture();
  const recordDiagnostic = diagnostics.createRecorder({ directory, now });
  let aborted = false;
  let count = 0;
  await rejected(evaluation.guardedTransport((_body, request) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => {
      const record = JSON.parse(fs.readFileSync(path.join(directory, diagnostics.FILE_NAME), 'utf8'));
      assert.equal(record.phase, 'activity-fetch');
      assert.equal(record.guardStage, 'transport-poll');
      assert.equal(record.pollIndex, 1);
      aborted = true;
      reject(new Error('PRIVATE aborted'));
    }, { once: true });
  }), {}, options, async () => {
    if (++count === 1) return idle();
    throw diagnostics.attach(Object.assign(new Error('PRIVATE credential'), { name: 'TimeoutError' }),
      { phase: 'activity-fetch', endpoint: '/api/local-model-activity', elapsedMs: 1500,
        timeoutMs: 1500, fallbackCode: 'PAUSE_API_UNAVAILABLE', now });
  }, { now, pollMs: 1, recordDiagnostic }), 'activity-fetch', 'PAUSE_API_UNAVAILABLE', 'timeout');
  assert.equal(aborted, true);
  const file = path.join(directory, diagnostics.FILE_NAME);
  const before = fs.readFileSync(file, 'utf8');
  diagnostics.createRecorder({ directory, now })(diagnostics.failure('EVAL_YIELD', { phase: 'transport-final', now }).guardDiagnostic);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(before.includes('PRIVATE'), false);

  let unavailableChecks = 0;
  await rejected(evaluation.guardedTransport((_body, request) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }), {}, options, async () => ++unavailableChecks === 1 ? idle() : { busy: true, nextAt: Infinity },
  { now, pollMs: 1, recordDiagnostic: () => { throw diagnostics.failure('GUARD_DIAGNOSTIC_WRITE_FAILED',
    { phase: 'guard-diagnostic-write', now }); } }), 'guard-diagnostic-write', 'GUARD_DIAGNOSTIC_WRITE_FAILED');

  assert.equal(require.cache[require.resolve('../lib/providers/ollama')], undefined);
  console.log('evaluation-guard-integration: ' + checks + ' fault/race checks passed; zero inference/HTTP calls');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
