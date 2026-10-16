'use strict';

// Exercise the real queue and worker together. No HTTP server/model/publication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQueue } = require('../lib/job-queue');
const { createWorker } = require('../worker');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-claim-delivery-'));
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
const logger = { log() {}, warn() {}, error() {} };
const workers = [];

async function run() {
  try {
    const queue = createQueue({ file: path.join(directory, 'jobs.json') });
    const first = queue.enqueue({ ownerKey: 'fixture', profileId: 'first', payload: { prompt: 'fixture' } });
    const second = queue.enqueue({ ownerKey: 'fixture', profileId: 'second', payload: { prompt: 'fixture' } });
    let claimLost = false, resultLost = false, generated = 0, claims = 0, completions = 0;
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      let value;
      if (url.pathname.endsWith('/claim')) {
        claims++;
        value = { job: queue.claim(body.workerId, body) };
        if (!claimLost) { claimLost = true; throw new Error('fixture: response lost after durable claim'); }
      } else if (url.pathname.endsWith('/complete')) {
        completions++;
        const id = url.pathname.split('/').at(-2);
        const job = queue.complete(id, body.workerId, body.result, body.leaseToken);
        value = { ok: true, job: { id: job.id, status: job.status } };
        if (!resultLost) { resultLost = true; throw new Error('fixture: ACK lost after durable completion'); }
      } else {
        throw new Error('Unexpected request: ' + url.pathname);
      }
      return { status: 200, ok: true, text: async () => JSON.stringify(value) };
    };
    function worker() {
      const instance = createWorker({ runnerUrl: 'https://example.invalid/', workerId: 'fixture-worker',
        key: 'fixture-key', stateDir: path.join(directory, 'delivery'), logger, fetchImpl,
        generate: async () => { generated++; return { text: 'fixture output', ms: 1 }; } });
      workers.push(instance);
      return instance;
    }

    const beforeRestart = worker();
    await assert.rejects(beforeRestart.pollOnce()); checks++;
    eq(queue.get(first.id).status, 'claimed');
    eq(queue.get(first.id).attempts, 1);
    eq(queue.get(second.id).status, 'queued');
    eq(generated, 0, 'unreceived claim cannot start inference');
    beforeRestart.stop(); beforeRestart.maintenance.close();
    queue.resetForTests();

    const afterClaimRestart = worker();
    await afterClaimRestart.pollOnce();
    eq(claims, 2, 'restart repeats the same durable claim request');
    eq(generated, 1);
    eq(queue.get(first.id).attempts, 1, 'lost claim ACK never increments allocation/attempt');
    eq(queue.get(first.id).status, 'completed', 'queue result survives lost upload ACK');
    eq(queue.get(second.id).status, 'queued');
    const receipt = JSON.parse(fs.readFileSync(afterClaimRestart.deliveryFile, 'utf8'));
    eq(receipt.pending.operation, 'complete');
    eq(receipt.pending.body.result.text, 'fixture output');
    afterClaimRestart.stop(); afterClaimRestart.maintenance.close();
    queue.resetForTests();

    const afterResultRestart = worker();
    await afterResultRestart.pollOnce();
    eq(completions, 2, 'restart redelivers only the identical terminal receipt');
    eq(generated, 1, 'no duplicate inference after ambiguous completion');
    eq(claims, 2, 'pending terminal delivery does not admit another claim');
    eq(queue.get(first.id).attempts, 1);
    eq(queue.get(second.id).status, 'queued');
    eq(JSON.parse(fs.readFileSync(afterResultRestart.deliveryFile, 'utf8')).pending, null);
    console.log('claim-delivery integration: ' + checks + ' checks passed (offline)');
  } finally {
    for (const worker of workers) { worker.stop(); worker.maintenance.close(); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
