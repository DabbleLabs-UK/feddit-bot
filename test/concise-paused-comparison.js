'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const evaluation = require('../scripts/concise-branch-evaluation');
const paused = require('../scripts/concise-paused-comparison');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-paused-comparison-test-'));
let fixtureIndex = 0;

function fixture() {
  const directory = path.join(temporary, String(fixtureIndex++));
  fs.mkdirSync(directory);
  const data = { protocolId: crypto.randomUUID(), preparedAt: new Date().toISOString(),
    maxCalls: 10, model: evaluation.MODEL, cases: paused.CATEGORIES.map((id, index) => {
      const item = { id, kind: index === 0 ? 'post' : 'comment', bot: 'frozen-' + index,
        model: evaluation.MODEL, temperature: 0.8, numPredict: 200,
        system: 'PRIVATE SYSTEM ' + index, control: 'PRIVATE CONTROL ' + index,
        treatment: 'PRIVATE TREATMENT ' + index };
      item.hashes = Object.fromEntries(['system', 'control', 'treatment']
        .map((key) => [key, evaluation.sha(item[key])]));
      return item;
    }) };
  fs.writeFileSync(path.join(directory, 'cases.json'), JSON.stringify(data));
  return directory;
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const ledger = (directory) => read(path.join(directory, 'results.json'));
const owner = () => ({ pid: process.pid, createdTicks: '638000000000000000', commandHash: 'a'.repeat(64) });

function environment(options = {}) {
  let at = 1800000000000;
  const data = { paused: Boolean(options.originalPaused), monthlyCapUsd: 17,
    pricing: { model: { input: 4, output: 9 } }, dryRun: false };
  const requests = [];
  const logs = [];
  let busy = false;
  let active = null;
  let restorationFailures = options.restorationFailures || 0;
  const api = paused.createApi(async (url, request) => {
    at += options.apiDelayMs || 0;
    assert.equal(new URL(url).origin, paused.BASE);
    assert.equal(request.redirect, 'error', 'desktop API redirects cannot reach a hosted server');
    assert.ok(request.signal);
    const endpoint = new URL(url).pathname;
    requests.push({ endpoint, method: request.method, ...(request.body ? { body: JSON.parse(request.body) } : {}) });
    if (endpoint === '/api/settings' && request.method === 'PUT') {
      const body = JSON.parse(request.body);
      assert.deepEqual(Object.keys(body), ['paused'], 'pause is the only settings mutation');
      if (!body.paused && restorationFailures-- > 0) throw new Error('PRIVATE NETWORK DETAIL');
      data.paused = body.paused;
      if (options.losePauseResponse && body.paused) throw new Error('lost acknowledgement');
    }
    const payload = endpoint === '/api/runtime' ? {
      placement: options.hosted ? 'hosted' : 'desktop', ownerSessionRequired: Boolean(options.hosted),
    } : endpoint === '/api/settings' ? { settings: { ...data } }
      : endpoint === '/api/runtime-state' ? { busy } : { active };
    return { ok: true, json: async () => payload };
  });
  return { api, requests, logs, data, now: () => at, wait: async (ms) => { at += ms; },
    capture: async () => owner(),
    advance: (ms) => { at += ms; }, setBusy: (value) => { busy = value; },
    setActive: (value) => { active = value; },
    arm: async ({ files, lease }) => {
      assert.equal(requests.some((item) => item.method === 'PUT'), false, 'watchdog is armed before pause');
      assert.equal(read(files.lease).nonce, lease.nonce);
      paused.atomic(files.watchdog, { nonce: lease.nonce, status: 'armed', pid: process.pid });
      return { waitForExit: async () => {} };
    },
    snapshot: () => ({ 'profiles.json': 'HASH ONLY', 'secrets.json': 'HASH ONLY' }),
    log: (value) => logs.push(value) };
}

function provider(onGenerate) {
  let calls = 0;
  const instance = { OLLAMA_BASE: 'http://127.0.0.1:11434', SHARED_OLLAMA_ARBITER_URL: '',
    isBusy: () => false,
    _test: { ollamaChatStream: async () => ({ message: { content: 'PRIVATE GENERATED RESPONSE' } }) },
    generate: async (options) => {
      calls++;
      assert.equal(options.model, evaluation.MODEL);
      assert.equal(options.leaseClient, null);
      const response = await options.chatTransport({}, { signal: new AbortController().signal });
      if (onGenerate) await onGenerate(calls, options);
      return { provider: 'ollama', model: evaluation.MODEL, text: response.message.content, ms: 2,
        usage: { inputTokens: 10, outputTokens: 4 } };
    }, calls: () => calls };
  return instance;
}

function options(directory, env, instance = provider(), extra = {}) {
  return { directory, ...env, loadProvider: () => instance, ...extra };
}

function leaseFixture(env, originalPaused = false) {
  const directory = fixture();
  const files = paused.paths(directory);
  const lease = { version: 1, nonce: crypto.randomUUID(), pid: process.pid, startedAt: env.now(),
    deadlineAt: env.now() + paused.MAX_PAUSE_MS,
    inferenceDeadlineAt: env.now() + paused.MAX_PAUSE_MS - paused.RESTORE_RESERVE_MS,
    originalPaused, resumeOnExit: originalPaused, restorePaused: false, owner: owner() };
  paused.atomic(files.lease, lease, true);
  paused.atomic(files.heartbeat, { nonce: lease.nonce, at: env.now() });
  paused.atomic(files.watchdog, { nonce: lease.nonce, status: 'armed', pid: process.pid });
  return { directory, files, lease };
}

async function run() {
  assert.equal(paused.MAX_PAUSE_MS, 1200000);
  assert.equal(paused.DRAIN_MS, 300000);
  assert.equal(paused.HEARTBEAT_MS, 2000);
  assert.equal(paused.POLL_MS, evaluation.POLL_MS);
  assert.equal(paused.RESTORE_GRACE_MS, 1700);
  assert.equal(paused.RESTORE_RESERVE_MS, 60000);
  assert.equal(paused.ARM_MARGIN_MS, 90000);
  assert.deepEqual(paused.parseArgs(['run', '--directory', temporary, '--resume-on-exit']),
    { command: 'run', directory: temporary, resumeOnExit: true });
  for (const args of [[], ['run'], ['run', '--directory', 'relative'],
    ['run', '--directory', temporary, '--url', 'https://hosted.example']]) {
    assert.throws(() => paused.parseArgs(args), { code: 'PAUSE_EXPLICIT_COMMAND_REQUIRED' });
  }

  const directory = fixture();
  const env = environment();
  const instance = provider();
  let loads = 0;
  assert.deepEqual(await paused.run(options(directory, env, instance, {
    loadProvider: () => { loads++; return instance; },
  })), { status: 'completed', attempts: 10 });
  assert.equal(loads, 1, 'the isolated provider is reused across sequential arms');
  assert.equal(instance.calls(), 10);
  assert.deepEqual(ledger(directory).calls.map((item) => item.arm), evaluation.order().map((item) => item.arm));
  assert.deepEqual(env.requests.filter((item) => item.method === 'PUT').map((item) => item.body),
    [{ paused: true }, { paused: false }]);
  assert.deepEqual(env.data, { paused: false, monthlyCapUsd: 17,
    pricing: { model: { input: 4, output: 9 } }, dryRun: false });
  assert.equal(env.logs.at(-1).statePreserved, true);
  assert.ok(env.logs.at(-1).resumedAt >= env.logs.at(-1).pausedAt);
  assert.equal(JSON.stringify(env.logs).includes('PRIVATE'), false);
  const oldLedger = fs.readFileSync(path.join(directory, 'results.json'), 'utf8');
  const requestsBefore = env.requests.length;
  await assert.rejects(paused.run(options(directory, env)), { code: 'PAUSE_FRESH_DIRECTORY_REQUIRED' });
  assert.equal(env.requests.length, requestsBefore, 'used directories fail before any API request');
  assert.equal(fs.readFileSync(path.join(directory, 'results.json'), 'utf8'), oldLedger);

  const existing = fixture();
  fs.writeFileSync(path.join(existing, 'results.json'), 'historical failed ledger - preserve exact bytes');
  assert.throws(() => paused.freshDirectory(existing), { code: 'PAUSE_FRESH_DIRECTORY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(existing, 'results.json'), 'utf8'), 'historical failed ledger - preserve exact bytes');
  const metadata = fixture();
  const badCases = read(path.join(metadata, 'cases.json'));
  badCases.maxCalls = 11;
  fs.writeFileSync(path.join(metadata, 'cases.json'), JSON.stringify(badCases));
  assert.throws(() => paused.freshDirectory(metadata), { code: 'PAUSE_CASE_METADATA_INVALID' });

  const refusedPause = environment({ originalPaused: true });
  await assert.rejects(paused.run(options(fixture(), refusedPause)),
    { code: 'PAUSE_EXISTING_PAUSE_REQUIRES_RESUME_ON_EXIT' });
  assert.equal(refusedPause.requests.some((item) => item.method === 'PUT'), false);
  const adopted = environment({ originalPaused: true });
  await paused.run(options(fixture(), adopted, provider(), { resumeOnExit: true }));
  assert.deepEqual(adopted.requests.filter((item) => item.method === 'PUT').map((item) => item.body), [{ paused: false }]);
  assert.equal(adopted.logs.at(-1).originalPaused, true);
  const startupFailure = environment({ originalPaused: true });
  await assert.rejects(paused.run(options(fixture(), startupFailure, provider(), { resumeOnExit: true,
    arm: async () => { throw Object.assign(new Error('watchdog unavailable'), { code: 'PAUSE_WATCHDOG_UNAVAILABLE' }); },
  })), { code: 'PAUSE_WATCHDOG_UNAVAILABLE' });
  assert.equal(startupFailure.data.paused, false, 'an authorized adopted pause is restored even if arming fails');

  const hosted = environment({ hosted: true });
  await assert.rejects(paused.run(options(fixture(), hosted)), { code: 'PAUSE_DESKTOP_REQUIRED' });
  assert.equal(hosted.requests.some((item) => item.method === 'PUT'), false);

  const failing = fixture();
  const failureEnv = environment();
  const failedProvider = provider((count) => {
    if (count === 4) throw Object.assign(new Error('PRIVATE DETAIL'), { code: 'OLLAMA_TIMEOUT' });
  });
  await assert.rejects(paused.run(options(failing, failureEnv, failedProvider)), { code: 'OLLAMA_TIMEOUT' });
  assert.equal(failedProvider.calls(), 4);
  assert.equal(ledger(failing).calls[3].status, 'failed-no-retry');
  assert.equal(failureEnv.data.paused, false);
  assert.equal(failureEnv.logs.at(-1).attempts, 4);
  await assert.rejects(paused.run(options(failing, failureEnv, failedProvider)), { code: 'PAUSE_FRESH_DIRECTORY_REQUIRED' });

  const empty = fixture();
  const emptyEnv = environment();
  const emptyProvider = provider();
  emptyProvider._test.ollamaChatStream = async () => ({ message: { content: '' } });
  await assert.rejects(paused.run(options(empty, emptyEnv, emptyProvider)), { code: 'EVAL_INVALID_RESULT' });
  assert.equal(emptyProvider.calls(), 1);
  assert.equal(ledger(empty).calls[0].status, 'failed-no-retry');
  assert.equal(emptyEnv.data.paused, false);

  const busyDirectory = fixture();
  const busy = environment();
  busy.setBusy(true);
  const busyProvider = provider();
  const busyStarted = busy.now();
  await assert.rejects(paused.run(options(busyDirectory, busy, busyProvider)), { code: 'PAUSE_DRAIN_TIMEOUT' });
  assert.equal(busyProvider.calls(), 0);
  assert.ok(busy.now() - busyStarted >= paused.DRAIN_MS);
  assert.equal(fs.existsSync(path.join(busyDirectory, 'results.json')), false);
  assert.equal(busy.data.paused, false);

  const incoming = environment();
  const incomingProvider = provider(() => incoming.setBusy(true));
  await assert.rejects(paused.run(options(fixture(), incoming, incomingProvider)), { code: 'PAUSE_NORMAL_WORK_BUSY' });
  assert.equal(incomingProvider.calls(), 1);
  assert.equal(incoming.data.paused, false);

  const deadline = environment();
  const deadlineProvider = provider(() => deadline.advance(18 * 60000));
  await assert.rejects(paused.run(options(fixture(), deadline, deadlineProvider)), { code: 'PAUSE_ENTRY_MARGIN' });
  assert.equal(deadlineProvider.calls(), 1);
  assert.equal(deadline.data.paused, false);

  const retry = environment({ restorationFailures: 2 });
  await paused.run(options(fixture(), retry));
  assert.equal(retry.logs.at(-1).restoreAttempts, 3);
  assert.equal(retry.data.paused, false);
  const lost = environment({ losePauseResponse: true });
  await assert.rejects(paused.run(options(fixture(), lost)));
  assert.equal(lost.data.paused, false, 'an ambiguous pause response still restores normal admission');
  const failedRestore = environment({ restorationFailures: 100 });
  const failedRestoreDirectory = fixture();
  await assert.rejects(paused.run(options(failedRestoreDirectory, failedRestore)), { code: 'PAUSE_RESTORE_FAILED' });
  assert.equal(read(paused.paths(failedRestoreDirectory).evidence).status, 'restore-failed');
  assert.equal(fs.existsSync(paused.paths(failedRestoreDirectory).released), false);

  let snapshotCalls = 0;
  const changed = environment();
  await assert.rejects(paused.run(options(fixture(), changed, provider(), {
    snapshot: () => ({ 'profiles.json': ++snapshotCalls === 1 ? 'before' : 'after' }),
  })), { code: 'PAUSE_STATE_CHANGED' });
  assert.equal(changed.data.paused, false);
  assert.equal(changed.logs.at(-1).statePreserved, false);

  const snapshotDirectory = path.join(temporary, 'snapshot');
  fs.mkdirSync(snapshotDirectory);
  fs.writeFileSync(path.join(snapshotDirectory, 'profiles.json'), JSON.stringify({
    settings: { paused: true, monthlyCapUsd: 17 }, profiles: [{ persona: 'PRIVATE PERSONA' }],
  }));
  fs.writeFileSync(path.join(snapshotDirectory, 'secrets.json'), 'PRIVATE SECRET');
  const snapshotBefore = paused.stateSnapshot(snapshotDirectory);
  fs.writeFileSync(path.join(snapshotDirectory, 'profiles.json'), JSON.stringify({
    settings: { paused: false, monthlyCapUsd: 17 }, profiles: [{ persona: 'PRIVATE PERSONA' }],
  }));
  assert.deepEqual(paused.stateSnapshot(snapshotDirectory), snapshotBefore, 'only pause differs');
  assert.equal(snapshotBefore['secrets.json'], evaluation.sha('PRIVATE SECRET'));
  assert.equal(JSON.stringify(snapshotBefore).includes('PRIVATE'), false);

  for (const condition of ['parent', 'heartbeat', 'deadline']) {
    const watchEnv = environment({ originalPaused: true });
    const { files, lease } = leaseFixture(watchEnv, true);
    if (condition === 'heartbeat') watchEnv.advance(paused.STALE_MS + 1);
    if (condition === 'deadline') {
      watchEnv.advance(lease.inferenceDeadlineAt - watchEnv.now());
      paused.atomic(files.heartbeat, { nonce: lease.nonce, at: watchEnv.now() });
    }
    await paused.watchdog({ file: files.lease, nonce: lease.nonce, ...watchEnv,
      alive: () => condition !== 'parent', stopOwner: async (value) => {
        assert.equal(value.nonce, lease.nonce);
        assert.equal(watchEnv.requests.some((item) => item.method === 'PUT'), false,
          'owned request termination is verified before scheduler resume');
      } });
    assert.equal(watchEnv.data.paused, false);
    assert.equal(read(files.watchdog).status, 'released');
    assert.equal(read(files.abort).code, condition === 'parent' ? 'PAUSE_PARENT_EXITED'
      : condition === 'heartbeat' ? 'PAUSE_HEARTBEAT_STALE' : 'PAUSE_DEADLINE');
    assert.ok(read(files.released).resumedAt >= read(files.abort).at + paused.RESTORE_GRACE_MS);
    const writes = watchEnv.requests.filter((item) => item.method === 'PUT').length;
    watchEnv.data.paused = true;
    await paused.restore({ files, lease, actor: 'main', ...watchEnv });
    await paused.watchdog({ file: files.lease, nonce: lease.nonce, ...watchEnv, alive: () => false });
    assert.equal(watchEnv.data.paused, true, 'a released watchdog cannot undo a later user pause');
    assert.equal(watchEnv.requests.filter((item) => item.method === 'PUT').length, writes);
  }

  const identityEnv = environment({ originalPaused: true });
  const identity = leaseFixture(identityEnv, true);
  let stopped = 0;
  const terminate = async (expected) => { assert.deepEqual(expected, owner()); stopped++; return { state: 'dead' }; };
  await paused.stopOwnedController(identity.lease, { inspect: async () => owner(), terminate });
  assert.equal(stopped, 1);
  await paused.stopOwnedController(identity.lease, { inspect: async () => ({ state: 'dead' }), terminate });
  assert.equal(stopped, 1, 'already exited controllers require no termination');
  for (const actual of [{ ...owner(), createdTicks: '639000000000000000' },
    { ...owner(), commandHash: 'b'.repeat(64) }, { ...owner(), pid: process.pid + 1 }, null]) {
    await assert.rejects(paused.stopOwnedController(identity.lease, { inspect: async () => actual, terminate }),
      { code: 'PAUSE_OWNER_IDENTITY_UNVERIFIED' });
  }
  assert.equal(stopped, 1, 'mismatched identities are never terminated');
  identityEnv.advance(paused.STALE_MS + 1);
  await assert.rejects(paused.watchdog({ file: identity.files.lease, nonce: identity.lease.nonce, ...identityEnv,
    alive: () => true, stopOwner: (value) => paused.stopOwnedController(value, {
      inspect: async () => ({ ...owner(), createdTicks: '639000000000000000' }), terminate,
    }) }), { code: 'PAUSE_OWNER_IDENTITY_UNVERIFIED' });
  assert.equal(identityEnv.data.paused, true, 'an unverified active request prevents blind resume');
  assert.equal(identityEnv.requests.some((item) => item.method === 'PUT'), false);

  const slowRecovery = environment({ originalPaused: true, apiDelayMs: paused.REQUEST_MS });
  const slow = leaseFixture(slowRecovery, true);
  slowRecovery.advance(slow.lease.inferenceDeadlineAt - slowRecovery.now());
  paused.atomic(slow.files.heartbeat, { nonce: slow.lease.nonce, at: slowRecovery.now() });
  await paused.watchdog({ file: slow.files.lease, nonce: slow.lease.nonce, ...slowRecovery,
    alive: () => true, stopOwner: async () => slowRecovery.advance(10000) });
  assert.equal(slowRecovery.data.paused, false);
  assert.ok(slowRecovery.now() <= slow.lease.deadlineAt,
    'two worst-case identity checks and slow API restoration fit inside the absolute pause ceiling');
  const boundEnv = environment({ originalPaused: true, apiDelayMs: paused.REQUEST_MS, restorationFailures: 100 });
  const bound = leaseFixture(boundEnv, true);
  boundEnv.advance(bound.lease.deadlineAt - boundEnv.now() - 7000);
  await assert.rejects(paused.restore({ ...bound, ...boundEnv, actor: 'main' }), { code: 'PAUSE_RESTORE_FAILED' });
  assert.ok(boundEnv.now() <= bound.lease.deadlineAt, 'restoration retries cannot exceed the absolute ceiling');

  const guardEnv = environment({ originalPaused: true });
  const guarded = leaseFixture(guardEnv, true);
  const status = paused.createPausedStatus({ ...guarded, ...guardEnv });
  assert.deepEqual(await status(), { busy: false, nextAt: Infinity });
  await assert.rejects(paused.createPausedStatus({ ...guarded, ...guardEnv, alive: () => false })(),
    { code: 'PAUSE_WATCHDOG_UNAVAILABLE' });
  guardEnv.setActive({ kind: 'manual' });
  assert.equal((await status()).busy, true);
  guardEnv.setActive(null);
  guardEnv.data.paused = false;
  await assert.rejects(status(), { code: 'PAUSE_RESUMED_EXTERNALLY' });
  guardEnv.data.paused = true;
  paused.markAbort(guarded.files, guarded.lease.nonce, 'PAUSE_INTERRUPTED', guardEnv.now);
  await assert.rejects(status(), { code: 'PAUSE_ABORTED' });
  assert.throws(() => paused.validateLease(guarded.files.lease, crypto.randomUUID()), { code: 'PAUSE_OWNERSHIP_CHANGED' });

  const timeoutEnv = environment({ originalPaused: true });
  const timeoutGuard = leaseFixture(timeoutEnv, true);
  let statusCalls = 0;
  const timeoutStatus = paused.createPausedStatus({ ...timeoutGuard, ...timeoutEnv });
  await assert.rejects(evaluation.guardedTransport((_body, request) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), {}, {}, async () => {
    if (++statusCalls > 1) timeoutEnv.advance(timeoutGuard.lease.inferenceDeadlineAt - timeoutEnv.now());
    return timeoutStatus();
  }, { now: timeoutEnv.now, pollMs: 1 }), { code: 'EVAL_STATUS_UNAVAILABLE' });

  console.log('concise paused comparison: all checks passed (mock API and provider only)');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
