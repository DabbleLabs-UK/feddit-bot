'use strict';

// No real network or model calls. Exercise the unchanged deployed worker with
// the reviewed budget verifier before the runner begins sending v2 metadata.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const budget = require('../lib/hosted-decision-budget');
const tokenizer = require('../lib/hosted-tokenizer');
const { createWorker } = require('../worker');

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function rejects(run, message) {
  assert.throws(run, (error) => error.code === 'HOSTED_DECISION_BUDGET', message);
  checks++;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const profile = { num_ctx: 3072, num_thread: 4 };
const logger = { log() {}, warn() {}, error() {} };

async function run() {
  eq(budget.VERSION, 2, 'compatible worker recognizes construction v2');
  eq([budget.CONTEXT_TOKENS, budget.SAFETY_TOKENS], [3072, 64], 'execution limits unchanged');
  for (const version of [1, 2]) {
    const request = { model: tokenizer.MODEL, system: 'Complete persona.',
      prompt: 'Complete frozen candidate. Choose WAIT or the offered ID.', numPredict: 640 };
    request.budget = budget.measure(request.system, request.prompt, request.numPredict, version);
    eq(request.budget.version, version, 'frozen construction version retained');
    eq(request.budget.inputTokens, tokenizer.countRequest(request.system, request.prompt), 'exact tokenizer count retained');
    eq(request.budget.outputTokens, 640, 'full output reserve retained');
    eq(request.budget.requestHash, crypto.createHash('sha256')
      .update(JSON.stringify([request.system, request.prompt, 640])).digest('hex'), 'hash covers exact request');
    eq(budget.verifyRequest(request, profile), request.budget, 'v' + version + ' exact request accepted');
    rejects(() => budget.verifyRequest({ ...request, prompt: request.prompt + ' changed' }, profile), 'changed prompt rejected');
    rejects(() => budget.verifyRequest({ ...request, numPredict: 639 }, profile), 'changed output reserve rejected');
    for (const field of ['inputTokens', 'contextTokens', 'safetyTokens']) {
      rejects(() => budget.verifyRequest({ ...request, budget: { ...request.budget, [field]: 1 } }, profile), 'changed ' + field + ' rejected');
    }
    rejects(() => budget.verifyRequest(request, { num_ctx: 2048 }), 'smaller actual context rejected');

    const reports = [];
    let inferenceCalls = 0;
    let forwarded;
    const worker = createWorker({
      runnerUrl: 'https://fixture.invalid/', key: 'fixture-only', allowedModels: tokenizer.MODEL, logger,
      fetchImpl: async (url, options) => {
        reports.push({ path: url.pathname, body: JSON.parse(options.body) });
        return { ok: true, text: async () => '{}' };
      },
      generate: async (payload) => {
        forwarded = payload;
        budget.verifyRequest({ ...payload, budget: payload.decisionBudget }, profile);
        inferenceCalls++;
        return { provider: 'ollama', model: payload.model, text: '{"choice":"WAIT","votes":[]}', ms: 1 };
      },
    });
    const job = { id: 'v' + version, kind: 'scheduled-decision', allocationClass: 'synthetic',
      payload: { ...request, budget: undefined, decisionBudget: request.budget } };
    eq(await worker.runJob(job), true, 'unchanged worker completes v' + version + ' job');
    eq(forwarded.decisionBudget, request.budget, 'worker forwards frozen metadata unchanged');
    eq(forwarded.hostedDecision, true, 'worker retains guarded decision path');
    eq(forwarded.legacyTimeouts, true, 'worker retains deployed timeout policy');
    eq(forwarded.priorityClass, 'synthetic', 'synthetic allocation priority unchanged');
    eq(inferenceCalls, 1, 'one fake inference accepted');
    eq(reports.map((item) => item.path), ['/api/worker/jobs/v' + version + '/complete'], 'one completion, no failed delivery');
    eq(reports[0].body.result.text, '{"choice":"WAIT","votes":[]}', 'explicit WAIT delivered intact');

    reports.length = 0;
    eq(await worker.runJob({ ...job, id: 'tampered', payload: { ...job.payload, prompt: 'changed' } }), false, 'worker reports mismatch safely');
    eq(inferenceCalls, 1, 'mismatch reaches zero additional fake inference');
    eq(reports[0].path, '/api/worker/jobs/tampered/fail', 'mismatch reported as failure');
    eq(reports[0].body.retryable, false, 'deterministic mismatch not retried');

    const oversized = { ...job.payload, prompt: 'Unbounded context '.repeat(4000) };
    oversized.decisionBudget = budget.measure(oversized.system, oversized.prompt, 640, version);
    reports.length = 0;
    eq(await worker.runJob({ ...job, id: 'impossible', payload: oversized }), false, 'genuinely impossible request fails explicitly');
    eq(inferenceCalls, 1, 'impossible request reaches zero additional fake inference');
    eq(reports[0].body.retryable, false, 'impossible request not retried');
  }

  const entered = deferred();
  const finish = deferred();
  const delivered = [];
  const request = { model: tokenizer.MODEL, system: 'Persona', prompt: 'Frozen admitted decision', numPredict: 640 };
  request.decisionBudget = budget.measure(request.system, request.prompt, 640, 1);
  const worker = createWorker({
    runnerUrl: 'https://fixture.invalid/', key: 'fixture-only', allowedModels: tokenizer.MODEL, logger,
    fetchImpl: async (url, options) => {
      delivered.push({ path: url.pathname, body: JSON.parse(options.body) });
      return { ok: true, text: async () => '{}' };
    },
    generate: async (payload) => {
      budget.verifyRequest({ ...payload, budget: payload.decisionBudget }, profile);
      entered.resolve();
      await finish.promise;
      return { text: 'existing admitted result' };
    },
  });
  const pending = worker.runJob({ id: 'already-active-v1', kind: 'scheduled-decision', payload: request });
  await entered.promise;
  worker.stop();
  eq(delivered.length, 0, 'stopping admission does not prematurely complete active work');
  finish.resolve();
  eq(await pending, true, 'already active legacy work finishes normally');
  eq(delivered.length, 1, 'active result delivered exactly once');
  eq(delivered[0].path, '/api/worker/jobs/already-active-v1/complete', 'active result retains original job identity');
  eq(delivered[0].body.result.text, 'existing admitted result', 'active result not discarded or replaced');
  console.log('hosted-budget-worker-v2: ' + checks + ' checks passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
