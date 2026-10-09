'use strict';

// Explicit frozen validation only. Never import a scheduler, bot store or live
// runner credentials. All queue/results/telemetry belong to a new private folder.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const budget = require('../lib/hosted-decision-budget');
const tokenizer = require('../lib/hosted-tokenizer');
const actions = require('../lib/action-candidates');
const voting = require('../lib/voting');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function prepare(records) {
  const cases = records.map((record) => {
    const request = record.generations[0].request;
    return { record, request, construction: budget.construct({ model: request.model,
      system: request.system, ...record.slate, decisionAt: record.createdAt, decisionContractVersion: 2 }) };
  });
  const causal = cases.find((item) => item.record.id === 't_2c79a50593f9302295577ec701aa7cb0');
  const fitting = cases.filter((item) => !item.construction.failure);
  const baseline = fitting.filter((item) => item.construction.deferredCandidateIds.length === 0 && item.construction.deferredVoteIds.length === 0)
    .sort((a,b) => a.construction.originalInputTokens - b.construction.originalInputTokens)[0];
  const pressure = fitting.filter((item) => item !== causal && item !== baseline)
    .sort((a,b) => b.construction.originalInputTokens - a.construction.originalInputTokens)[0];
  const blocked = cases.find((item) => item.construction.failure);
  assert(causal && baseline && pressure && blocked, 'Required representative frozen cases are missing');
  return { version: 1, cases: [[baseline, 'already-fitting', false], [causal, 'causal-overflow', false],
    [pressure, 'largest-overflow-repair', true], [blocked, 'minimum-does-not-fit', false]].map(([item, label, repair]) => ({
      ...item, label, repair, frozenHash: hash(JSON.stringify(item.record)) })) };
}

function score(text, item) {
  const construction = item.construction;
  const candidates = item.record.slate.candidates.filter((candidate) => construction.candidateIds.includes(candidate.id));
  const voteCandidates = item.record.slate.voteCandidates.filter((candidate) => construction.voteIds.includes(candidate.id));
  const decision = actions.parseDecision(text, candidates, { voteCandidates, decisionContractVersion: 2 });
  // Isolated pure projection only; NEVER save this to a live considered store.
  const considered = voting.record({ considered: [] }, decision.votes).considered;
  const unresolved = decision.votes.filter((vote) => vote.status === 'unresolved');
  for (const vote of unresolved) assert(!considered.includes(voting.targetKey(vote)));
  for (const vote of item.record.slate.voteCandidates.filter((vote) => construction.deferredVoteIds.includes(vote.id))) {
    assert(!considered.includes(voting.targetKey(vote)));
    assert(!decision.votes.some((entry) => entry.id === vote.id));
  }
  return { valid: decision.valid, waited: decision.waited, technicalFailure: !!decision.technicalFailure,
    choice: decision.candidate?.id || null, votes: decision.votes.map(({ id, direction, status, decisionKind }) => ({ id, direction, status, decisionKind })),
    unresolved: unresolved.length, isolatedConsideredCount: considered.length, deferredNeverConsidered: true };
}

async function run(packet, output) {
  assert.equal(process.platform, 'win32');
  assert.equal(os.hostname().toUpperCase(), 'DELL');
  assert.equal(packet.version, 1);
  assert.equal(packet.cases.length, 4);
  assert.equal(packet.cases.filter((item) => !item.construction.failure).length, 3);
  assert(path.isAbsolute(output));
  assert(!fs.existsSync(output), 'Refuse to resume/retry an existing validation directory');
  assert(!fs.existsSync('C:/dev/inference-maintenance/request.json'), 'Another maintenance operation owns admission');
  fs.mkdirSync(output);
  process.env.FEDDIT_BOT_DATA_DIR = path.join(output, 'telemetry');
  process.env.OLLAMA_BASE = 'http://127.0.0.1:11434';
  process.env.SHARED_OLLAMA_ARBITER_URL = 'http://127.0.0.1:11435';
  const { createQueue } = require('../lib/job-queue');
  const { createDellProvider } = require('../lib/providers/dell');
  const { createWorker } = require('../worker');
  const queue = createQueue({ file: path.join(output, 'private-jobs.json') });
  const provider = createDellProvider(queue);
  const key = crypto.randomBytes(24).toString('hex');
  const save = (name, data) => fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(data, null, 2), { flag: 'wx' });
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, 'Bearer ' + key);
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let result;
      if (request.url === '/api/worker/claim') result = { job: queue.claim(body.workerId, body) };
      else {
        const match = request.url.match(/^\/api\/worker\/jobs\/([^/]+)\/(renew|complete|fail)$/);
        assert(match, 'No non-worker routes exist in this isolated queue');
        const id = decodeURIComponent(match[1]);
        result = match[2] === 'renew' ? queue.renew(id, body.workerId) : match[2] === 'complete'
          ? queue.complete(id, body.workerId, body.result) : queue.fail(id, body.workerId, body.error, false);
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result || {}));
    } catch { response.writeHead(400); response.end('{"error":"Validation queue boundary rejected request"}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const worker = createWorker({ runnerUrl: 'http://127.0.0.1:' + server.address().port, key,
    workerId: 'frozen-budget-validation', allowedModels: tokenizer.MODEL,
    logger: { log() {}, warn() {}, error() {} } });
  const results = [];
  try {
    for (const item of packet.cases) {
      assert.equal(hash(JSON.stringify(item.record)), item.frozenHash);
      const built = budget.construct({ model: item.request.model, system: item.request.system,
        ...item.record.slate, decisionAt: item.record.createdAt, decisionContractVersion: 2 });
      assert.deepEqual(built, item.construction, 'Transferred construction must match exact branch implementation');
      if (built.failure) {
        const result = { label: item.label, inferenceSent: false, explicitFailure: true,
          minimumInput: built.minimumInputTokens, minimumRepair: built.minimumRepairTokens, context: built.contextTokens,
          output: built.outputTokens, safety: built.safetyTokens, unresolvedUnconsideredVotes: item.record.slate.voteCandidates.length };
        results.push(result); save(item.label, result); console.log(JSON.stringify(result)); continue;
      }
      assert(!fs.existsSync('C:/dev/inference-maintenance/request.json'), 'Maintenance began; stop before next request');
      const measured = item.repair ? built.repairBudget : built.budget;
      const prompt = item.repair ? built.repair : built.prompt;
      const job = provider.enqueue({ ...item.request, profileId: 'frozen-' + item.label, ownerKey: 'private-validation',
        kind: item.repair ? 'scheduled-decision-retry' : 'scheduled-decision', prompt, decisionBudget: measured,
        numPredict: built.numPredict, timeoutMs: 300000, priority: 'background', allocationClass: 'synthetic' });
      console.log(JSON.stringify({ label: item.label, state: 'waiting-for-normal-shared-lease', budget: measured,
        offered: [built.candidateIds.length, built.voteIds.length], deferred: [built.deferredCandidateIds.length, built.deferredVoteIds.length] }));
      await worker.pollOnce();
      const completed = queue.get(job.id);
      if (completed.status !== 'completed') {
        save(item.label + '-failure', { status: completed.status, error: completed.lastError });
        throw new Error('Frozen worker request failed; no retry: ' + item.label);
      }
      const generated = await provider.wait(job.id, 1000);
      const result = { label: item.label, originalInput: built.originalInputTokens, budget: measured,
        nativeInput: generated.usage.inputTokens, nativeOutput: generated.usage.outputTokens,
        exactNativeInputMatch: generated.usage.inputTokens === measured.inputTokens,
        ms: generated.ms, queueMs: generated.queueMs, offered: [built.candidateIds.length, built.voteIds.length],
        deferred: [built.deferredCandidateIds.length, built.deferredVoteIds.length], decision: score(generated.text, item) };
      save(item.label, result); results.push(result); console.log(JSON.stringify(result));
      assert(result.exactNativeInputMatch, 'Native token count mismatch; stop without retry');
    }
    save('summary', { results, publicationRoutes: 0, liveStoresOpened: 0, automaticRetries: 0 });
    return results;
  } finally { worker.stop(); await new Promise((resolve) => server.close(resolve)); }
}

if (require.main === module) {
  (async () => {
    if (process.argv[2] === '--prepare') {
      const packet = prepare(read(process.argv[3]).records);
      fs.writeFileSync(process.argv[4], JSON.stringify(packet), { flag: 'wx' });
      console.log(JSON.stringify(packet.cases.map((item) => ({ label: item.label, original: item.construction.originalInputTokens,
        input: (item.repair ? item.construction.repairBudget : item.construction.budget)?.inputTokens, failure: !!item.construction.failure }))));
    } else if (process.argv[2] === '--run') await run(read(process.argv[3]), process.argv[4]);
    else throw new Error('Explicit --prepare or --run required');
  })().catch((error) => { console.error('Frozen validation stopped: ' + error.message); process.exitCode = 1; });
}
module.exports = { prepare, score };
