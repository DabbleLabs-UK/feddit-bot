'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMaintenanceGate } = require('../lib/worker-maintenance');
const { createWorker } = require('../worker');

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-maintenance-'));
  const requestPath = path.join(directory, 'request.json');
  return {
    directory,
    hold: () => fs.writeFileSync(requestPath, JSON.stringify({ version: 1, id: 'test-window' })),
    release: () => fs.unlinkSync(requestPath),
    malformed: () => fs.writeFileSync(requestPath, '{broken'),
    status: () => JSON.parse(fs.readFileSync(path.join(directory, 'feddit-status.json'), 'utf8')),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
const logger = { log() {}, warn() {}, error() {} };
function response(body) { return { ok: true, status: 200, text: async () => JSON.stringify(body) }; }

async function checkDrain(phase, fail = false) {
  const f = fixture();
  const entered = deferred();
  const resume = deferred();
  const calls = [];
  let generated = 0;
  const worker = createWorker({
    runnerUrl: 'https://example.invalid/', key: 'private-test-key', maintenanceDir: f.directory, logger,
    fetchImpl: async (url) => {
      const route = url.pathname.split('/').pop();
      calls.push(route);
      if (route === phase) { entered.resolve(); await resume.promise; }
      if (route === 'claim') return response({ job: { id: 'private-job', payload: { prompt: 'private-prompt' } } });
      return response({ ok: true });
    },
    generate: async () => {
      generated++;
      if (phase === 'inference') { entered.resolve(); await resume.promise; }
      if (fail) throw new Error('cancelled generation');
      return { text: 'private-output' };
    },
  });
  try {
    const pending = worker.pollOnce();
    await entered.promise;
    f.hold();
    worker.maintenance.refresh();
    eq(f.status().state, 'draining', phase + ' remains active while draining');
    eq(f.status().active, 1, phase + ' active unit includes acknowledgement');
    eq(await worker.pollOnce(), false, phase + ' hold prevents concurrent admission');
    eq(calls.filter((route) => route === 'claim').length, 1, 'no second claim');
    resume.resolve();
    await pending;
    eq(generated, 1, 'already admitted job completes its natural path');
    eq(calls.at(-1), fail ? 'fail' : 'complete', 'normal result delivery preserved');
    eq(f.status().state, 'held', 'held only after delivery settles');
    eq(f.status().active, 0, 'no active unit after drain');
    eq(/private-|prompt|output|key/.test(JSON.stringify(f.status())), false, 'status is content-free');
    f.release();
    eq(worker.maintenance.refresh().state, 'running', 'explicit removal releases hold');
  } finally { worker.maintenance.close(); f.cleanup(); }
}

async function run() {
  const off = createMaintenanceGate({ fsImpl: new Proxy({}, { get() { throw new Error('unexpected I/O'); } }) });
  eq(off.begin(), true, 'default-off admits without file I/O');
  off.end(); off.refresh(); off.close();

  const f = fixture();
  let gate;
  try {
    f.hold();
    gate = createMaintenanceGate({ directory: f.directory, logger });
    eq(gate.begin(), false, 'hold before startup prevents first claim');
    eq(f.status().state, 'held', 'startup acknowledges held');
    eq(f.status().requestId, 'test-window', 'acknowledgement identifies exact request');
    gate.close();
    gate = createMaintenanceGate({ directory: f.directory, logger });
    eq(gate.begin(), false, 'restart retains hold without expiry');
    f.malformed();
    eq(gate.begin(), false, 'malformed request fails closed');
    eq(f.status().state, 'error', 'malformed request never claims quiescence');
    f.release();
    eq(gate.begin(), true, 'release restores normal admission');
    gate.end();
    eq(f.status().active, 0, 'normal completion clears activity');
  } finally { gate.close(); f.cleanup(); }

  const bad = fixture();
  const errors = [];
  let denyWrite = false;
  let denyRead = false;
  const files = Object.create(fs);
  files.writeFileSync = (...args) => { if (denyWrite) throw new Error('private-secret'); return fs.writeFileSync(...args); };
  files.readFileSync = (...args) => { if (denyRead) throw new Error('private-secret'); return fs.readFileSync(...args); };
  gate = createMaintenanceGate({ directory: bad.directory, fsImpl: files, logger: { error: (message) => errors.push(message) } });
  try {
    eq(gate.begin(), true, 'admitted work starts normally');
    denyWrite = true;
    eq(gate.refresh().state, 'error', 'status write error cannot acknowledge held');
    assert.doesNotThrow(() => gate.end()); checks++;
    eq(gate.begin(), false, 'status write error blocks subsequent work');
    denyWrite = false;
    denyRead = true;
    eq(gate.begin(), false, 'request read error blocks subsequent work');
    eq(bad.status().state, 'error', 'read errors publish error rather than held');
    eq(JSON.stringify(errors).includes('private-secret'), false, 'filesystem errors do not leak secrets');
    denyRead = false;
    eq(gate.begin(), true, 'recovered status permits normal work');
    gate.end();
  } finally { gate.close(); bad.cleanup(); }

  await checkDrain('claim');
  await checkDrain('inference');
  await checkDrain('complete');
  await checkDrain('fail', true);

  const rejected = fixture();
  const failedClaim = createWorker({
    runnerUrl: 'https://example.invalid/', key: 'secret', maintenanceDir: rejected.directory, logger,
    fetchImpl: async () => { rejected.hold(); throw new Error('connection failed'); },
  });
  try {
    await assert.rejects(failedClaim.pollOnce(), /connection failed/); checks++;
    eq(rejected.status().state, 'held', 'failed claim clears admission normally');
    eq(rejected.status().active, 0, 'failed claim leaves no active unit');
  } finally { failedClaim.maintenance.close(); rejected.cleanup(); }

  const stopped = fixture();
  let worker;
  try {
    stopped.hold();
    let claims = 0;
    worker = createWorker({
      runnerUrl: 'https://example.invalid/', key: 'secret', maintenanceDir: stopped.directory, logger,
      fetchImpl: async () => { claims++; return response({}); },
      sleep: async () => worker.stop(),
    });
    await worker.run();
    eq(claims, 0, 'held loop never claims or sends fake heartbeat');
    eq(stopped.status().state, 'held', 'held loop can stop without admitting work');
  } finally { worker.maintenance.close(); stopped.cleanup(); }
  console.log('worker-maintenance: ' + checks + ' checks passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
