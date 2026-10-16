'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorker } = require('../worker');
const { createDeliveryStore, validate, MAX_BYTES } = require('../lib/worker-delivery-store');
const { classify } = require('../lib/worker-operational-log');

let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-worker-delivery-'));
const workers = [];
const job = { id: 'j_' + 'a'.repeat(32), status: 'claimed', leaseProtocolVersion: 2,
  leaseToken: 'l_' + 'b'.repeat(32), payload: { prompt: 'private prompt' } };
const result = { text: 'private result', model: 'private model', usage: { inputTokens: 4, outputTokens: 2 } };
function response(status = 200, value = { ok: true }) {
  return { ok: status >= 200 && status < 300, status, text: async () => typeof value === 'string' ? value : JSON.stringify(value) };
}
function make(name, overrides = {}) {
  const worker = createWorker({
    runnerUrl: 'https://example.invalid/bots/', key: 'private credential', workerId: name,
    stateDir: path.join(directory, name), logger: { log() {}, warn() {}, error() {} },
    generate: async () => result, ...overrides,
  });
  workers.push(worker);
  return worker;
}
function saved(worker) { return JSON.parse(fs.readFileSync(worker.deliveryFile, 'utf8')); }

async function run() {
  try {
    let generated = 0;
    const claims = [];
    const sent = [];
    const lostClaim = make('lost-claim', {
      generate: async () => { generated++; return result; },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        sent.push({ route: url.pathname, body });
        if (url.pathname.endsWith('/claim')) {
          claims.push(body.claimRequestId);
          if (claims.length === 1) throw new Error('private raw connection diagnostic');
          return response(200, { job });
        }
        return response();
      },
    });
    await assert.rejects(lostClaim.pollOnce(), /connection/); checks++;
    eq(saved(lostClaim).claimRequestId, claims[0], 'ambiguous claim is durable before another poll');
    eq(await lostClaim.pollOnce(), true);
    eq(claims.length, 2);
    eq(claims[0], claims[1], 'same claim ID recovers lost ACK');
    ok(/^c_[a-f0-9]{32}$/.test(claims[0]), 'claim ID is cryptographically random and protocol-shaped');
    eq(generated, 1);
    eq(sent.at(-1).body.leaseToken, job.leaseToken);
    eq(saved(lostClaim), { version: 1, claimRequestId: null, pending: null });

    const claimRestart = make('claim-restart', {
      fetchImpl: async () => { throw new Error('unacknowledged server claim'); },
    });
    await assert.rejects(claimRestart.pollOnce()); checks++;
    const requestIdBeforeRestart = saved(claimRestart).claimRequestId;
    let requestIdAfterRestart;
    const claimRestarted = make('claim-restart', {
      fetchImpl: async (_url, options) => {
        requestIdAfterRestart = JSON.parse(options.body).claimRequestId;
        return response(200, { job: null });
      },
    });
    eq(await claimRestarted.pollOnce(), false);
    eq(requestIdAfterRestart, requestIdBeforeRestart, 'restart preserves ambiguous claim request identity');
    eq(saved(claimRestarted).claimRequestId, null, 'authoritative empty claim clears identity');

    generated = 0;
    const deliveries = [];
    let failCalls = 0;
    const lostComplete = make('lost-complete', {
      generate: async () => { generated++; return result; },
      fetchImpl: async (url, options) => {
        if (url.pathname.endsWith('/claim')) return response(200, { job });
        if (url.pathname.endsWith('/fail')) { failCalls++; return response(); }
        if (url.pathname.endsWith('/complete')) {
          deliveries.push(JSON.parse(options.body));
          if (deliveries.length === 1) throw new Error('ACK lost after server committed result');
          return response();
        }
        return response();
      },
    });
    await lostComplete.pollOnce();
    eq(saved(lostComplete).pending.operation, 'complete', 'completion persisted before delivery failure');
    eq(saved(lostComplete).pending.body.result, result);
    eq(failCalls, 0, 'failed complete never becomes fail');
    await assert.rejects(lostComplete.runJob(job), /unresolved delivery/); checks++;
    await lostComplete.pollOnce();
    eq(generated, 1, 'completion ACK retry performs no inference');
    eq(failCalls, 0);
    eq(deliveries[0], deliveries[1], 'same fenced result delivered idempotently');
    eq(saved(lostComplete).pending, null);

    generated = 0;
    let restartClaims = 0;
    const first = make('restart', {
      fetchImpl: async (url) => url.pathname.endsWith('/claim') ? response(200, { job }) : response(503, 'private HTML failure'),
      generate: async () => { generated++; return result; },
    });
    await first.pollOnce();
    eq(saved(first).pending.blocked, null, 'transient HTTP failure remains retryable delivery only');
    const gateDir = path.join(directory, 'restart-gate');
    fs.mkdirSync(gateDir);
    fs.writeFileSync(path.join(gateDir, 'request.json'), JSON.stringify({ version: 1, id: 'held-restart' }));
    let duringRecovery;
    const restarted = make('restart', {
      maintenanceDir: gateDir,
      generate: async () => { throw new Error('model must not run during recovery'); },
      fetchImpl: async (url, options) => {
        if (url.pathname.endsWith('/claim')) restartClaims++;
        eq(url.pathname.endsWith('/complete'), true, 'restart sends only existing terminal delivery');
        eq(JSON.parse(options.body).leaseToken, job.leaseToken);
        duringRecovery = JSON.parse(fs.readFileSync(path.join(gateDir, 'feddit-status.json'), 'utf8'));
        return response();
      },
    });
    const startupStatus = JSON.parse(fs.readFileSync(path.join(gateDir, 'feddit-status.json'), 'utf8'));
    eq(startupStatus.state, 'draining', 'first startup heartbeat cannot falsely claim quiescence with a receipt');
    eq(startupStatus.active, 1);
    eq(await restarted.pollOnce(), true);
    eq(generated, 1, 'restart never regenerates persisted result');
    eq(restartClaims, 0);
    eq(duringRecovery.state, 'draining');
    eq(duringRecovery.active, 1);
    const held = JSON.parse(fs.readFileSync(path.join(gateDir, 'feddit-status.json'), 'utf8'));
    eq(held.state, 'held');
    eq(held.active, 0);
    eq(await restarted.pollOnce(), false, 'hold still prevents new admission after recovery');

    let finishInference;
    const inference = new Promise((resolve) => { finishInference = resolve; });
    const renewed = [];
    let renewObserved;
    const renewal = new Promise((resolve) => { renewObserved = resolve; });
    const renewingWorker = make('renewal', {
      renewMs: 5,
      generate: async () => inference,
      fetchImpl: async (url, options) => {
        if (url.pathname.endsWith('/claim')) return response(200, { job });
        if (url.pathname.endsWith('/renew')) { renewed.push(JSON.parse(options.body)); renewObserved(); }
        return response();
      },
    });
    const running = renewingWorker.pollOnce();
    let renewalDeadline;
    try {
      await Promise.race([renewal, new Promise((_resolve, reject) => {
        renewalDeadline = setTimeout(() => reject(new Error('renewal did not run')), 1000);
      })]);
    } finally { clearTimeout(renewalDeadline); }
    eq(renewed[0].leaseToken, job.leaseToken, 'renewal carries original claim fence');
    eq(renewed[0].busy, true);
    finishInference(result);
    await running;
    const renewedCount = renewed.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    eq(renewed.length, renewedCount, 'renew timer clears after confirmed terminal delivery');

    for (const status of [401, 403, 409, 410, 200]) {
      let calls = 0;
      const blockedGate = path.join(directory, 'blocked-gate-' + status);
      fs.mkdirSync(blockedGate);
      const records = [];
      const conflict = make('conflict-' + status, {
        maintenanceDir: blockedGate, renewMs: 5,
        logger: { log() {}, warn() {}, error: (message) => records.push(message) },
        fetchImpl: async (url) => {
          calls++;
          return url.pathname.endsWith('/claim') ? response(200, { job })
            : response(status, status === 200 ? 'private broken JSON' : { error: 'private response secret' });
        },
      });
      await conflict.pollOnce();
      const evidence = fs.readFileSync(conflict.deliveryFile, 'utf8');
      const blockedReason = status === 200 ? 'protocol' : status < 409 ? 'auth' : 'conflict';
      eq(saved(conflict).pending.blocked, blockedReason);
      const blockedStatus = JSON.parse(fs.readFileSync(path.join(blockedGate, 'feddit-status.json'), 'utf8'));
      eq(blockedStatus.state, 'error', 'authoritative supervisor cannot mistake quarantine for available worker');
      eq(blockedStatus.active, 1, 'uncertain terminal delivery never acknowledges safe quiescence');
      eq(blockedStatus.deliveryBlocked, 'WORKER_DELIVERY_' + blockedReason.toUpperCase());
      ok(records.some((entry) => entry.event === 'delivery_quarantined'), 'quarantine has a content-free operational event');
      eq(await conflict.pollOnce(), false);
      await new Promise((resolve) => setTimeout(resolve, 15));
      eq(calls, 2, 'quarantine never resubmits or claims');
      eq(fs.readFileSync(conflict.deliveryFile, 'utf8'), evidence, 'quarantine preserves original evidence');
      eq(evidence.includes('private response secret'), false);
      const conflictRestart = make('conflict-' + status, {
        maintenanceDir: blockedGate,
        fetchImpl: async () => { throw new Error('quarantined restart cannot send requests'); },
      });
      const restartStatus = JSON.parse(fs.readFileSync(path.join(blockedGate, 'feddit-status.json'), 'utf8'));
      eq(restartStatus.state, 'error', 'quarantine persists in first restart heartbeat');
      eq(restartStatus.active, 1);
      eq(await conflictRestart.pollOnce(), false);
    }

    const storageGate = path.join(directory, 'storage-gate');
    fs.mkdirSync(storageGate);
    const faultFiles = Object.create(fs);
    let writes = 0;
    faultFiles.renameSync = (...args) => {
      if (++writes === 3) throw Object.assign(new Error('private disk error'), { code: 'ENOSPC' });
      return fs.renameSync(...args);
    };
    let storageRequests = 0;
    let storageGenerations = 0;
    const storageFailure = make('storage-failure', {
      maintenanceDir: storageGate, deliveryFsImpl: faultFiles,
      fetchImpl: async () => { storageRequests++; return response(200, { job }); },
      generate: async () => { storageGenerations++; return result; },
    });
    await assert.rejects(storageFailure.pollOnce(), /delivery state is unavailable/); checks++;
    eq(storageGenerations, 1);
    eq(storageRequests, 1, 'failed receipt persistence sends neither complete nor fail');
    eq(await storageFailure.pollOnce(), false, 'storage quarantine blocks subsequent claims/inference');
    const storageStatus = JSON.parse(fs.readFileSync(path.join(storageGate, 'feddit-status.json'), 'utf8'));
    eq(storageStatus.state, 'error');
    eq(storageStatus.active, 1);
    eq(storageStatus.deliveryBlocked, 'WORKER_DELIVERY_STORAGE');
    ok(fs.readdirSync(path.dirname(storageFailure.deliveryFile)).some((name) => name.endsWith('.tmp')),
      'failed rename retains private recovery evidence, never silently discards result');

    let failBody;
    const failed = make('failed-inference', {
      generate: async () => { throw new Error('private provider body and credentials'); },
      fetchImpl: async (url, options) => {
        if (url.pathname.endsWith('/claim')) return response(200, { job });
        failBody = JSON.parse(options.body);
        return response();
      },
    });
    await failed.pollOnce();
    eq(failBody.error, 'Worker inference failed (INFERENCE_FAILED).');
    eq(failBody.leaseToken, job.leaseToken);
    eq(failBody.retryable, true, 'existing genuine inference-failure retry policy retained');

    let legacyBody;
    const legacy = make('legacy', {
      fetchImpl: async (url, options) => {
        if (url.pathname.endsWith('/claim')) return response(200, { job: { id: 'j_legacy', status: 'claimed', payload: { prompt: 'private' } } });
        legacyBody = JSON.parse(options.body);
        return response();
      },
    });
    await legacy.pollOnce();
    eq(Object.hasOwn(legacyBody, 'leaseToken'), false, 'legacy job omits fence rather than inventing one');

    for (const malformedJob of [
      { ...job, status: 'completed' }, { ...job, status: undefined }, { ...job, leaseProtocolVersion: 99 },
      { ...job, leaseProtocolVersion: 1 }, { ...job, leaseProtocolVersion: undefined },
      { ...job, leaseToken: undefined }, { ...job, leaseToken: 'bad' }, { ...job, payload: [] },
    ]) {
      let invalidGenerations = 0;
      const invalid = make('invalid-' + checks, {
        fetchImpl: async () => response(200, { job: malformedJob }),
        generate: async () => { invalidGenerations++; return result; },
      });
      await assert.rejects(invalid.pollOnce(), /protocol/); checks++;
      eq(invalidGenerations, 0, 'invalid claimed status/fence/version never reaches inference');
      ok(saved(invalid).claimRequestId, 'ambiguous invalid claim preserves identity');
    }

    for (const [label, fetchImpl, expectedPhase, expectedReason] of [
      ['headers', async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private timeout')))), 'headers', 'timeout'],
      ['body', async (_url, options) => ({ ok: true, status: 200, text: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private body timeout')))) }), 'body', 'timeout'],
      ['invalid-json', async () => response(200, 'private non-json'), 'body', 'protocol'],
      ['invalid-contract', async () => response(200, {}), 'body', 'protocol'],
      ['http5xx', async () => response(502, '<private failure>'), 'body', 'http5xx'],
    ]) {
      const logs = [];
      const requestWorker = make('request-' + label, { fetchImpl, requestTimeoutMs: 10, logger: { log() {}, warn: (message) => logs.push(message), error() {} } });
      await assert.rejects(requestWorker.pollOnce(), /request failed/); checks++;
      const diagnostic = classify(logs.find((entry) => typeof entry === 'object'));
      eq(diagnostic.operation, 'claim');
      eq(diagnostic.phase, expectedPhase);
      eq(diagnostic.reason, expectedReason);
      ok(Number.isFinite(diagnostic.elapsedMs));
      eq(JSON.stringify(logs).includes('private'), false, 'request diagnostics never contain response body/credential');
      ok(saved(requestWorker).claimRequestId, 'non-authoritative response retains claim identity');
    }

    const store = createDeliveryStore({ directory: path.join(directory, 'store'), runnerUrl: 'https://example.invalid/', workerId: 'test' });
    eq(store.read(), { version: 1, claimRequestId: null, pending: null });
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(store.file, '{private broken state');
    assert.throws(() => store.read(), /unavailable or invalid/); checks++;
    const base = { version: 1, claimRequestId: null, pending: { jobId: job.id, leaseToken: job.leaseToken, operation: 'complete', body: { result }, blocked: null } };
    eq(validate(base), base);
    for (const malformed of [
      { ...base, version: 2 }, { ...base, credential: 'secret' }, { ...base, claimRequestId: 'bad' },
      { ...base, pending: { ...base.pending, leaseToken: 'bad' } },
      { ...base, pending: { ...base.pending, body: { result: { ...result, prompt: 'secret' } } } },
      { ...base, pending: { ...base.pending, body: { result: { ...result, usage: { secret: 'bad' } } } } },
      { ...base, pending: { ...base.pending, body: { result: { text: 'a'.repeat(MAX_BYTES) } } } },
    ]) { assert.throws(() => validate(malformed), /unavailable or invalid/); checks++; }
    store.write(base);
    eq(store.read(), base, 'bounded terminal result survives atomic restart read');
    eq(fs.readdirSync(path.dirname(store.file)), [path.basename(store.file)], 'successful atomic write leaves one receipt');
    const unit = fs.readFileSync(path.join(__dirname, '../deploy/dell/feddit-worker.service'), 'utf8');
    ok(unit.includes('Environment=FEDDIT_WORKER_STATE_DIR=C:/dev/feddit-worker-state'), 'service pins delivery state outside immutable releases');
    ok(unit.split('\n').find((line) => line.startsWith('Environment=WSLENV=')).trim().split(':').includes('FEDDIT_WORKER_STATE_DIR'),
      'WSL explicitly forwards stable worker state path');
    console.log('worker-delivery: ' + checks + ' checks passed');
  } finally {
    for (const worker of workers) { worker.stop(); worker.maintenance.close(); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
