'use strict';

// Explicit six-call frozen validation. No scheduler, live stores, registration,
// publication routes or provider fallback. Reuse the actual non-stream worker.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const budget = require('../lib/hosted-decision-budget');
const format = require('../lib/hosted-decision-format');
const actions = require('../lib/action-candidates');
const contract = require('../lib/decision-contract');
const voting = require('../lib/voting');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const chosen = [
  ['t_833470e10c8efa585a15bc1c3c0e2ea4', 'marker-no-votes'],
  ['t_13d085fcb8842d1cf5715047cc7abe2d', 'syntax-two-votes'],
  ['t_3ad4b07b8d044593d7c3a596912d5f23', 'missing-three-votes'],
];

function prepare(corpus) {
  assert.equal(corpus.version, 1);
  const cases = chosen.map(([id, label], index) => {
    const original = corpus.cases.find(item => item.id === id);
    assert(original, 'Frozen representative case missing');
    const request = original.generations[0].request;
    assert.equal(request.numPredict, 640);
    const measured = budget.measure(request.system, request.prompt, 640, 2);
    assert.deepEqual(request.decisionBudget, measured);
    assert(budget.fits(measured));
    const descriptor = format.validate({ version: 1,
      candidateIds: original.construction.candidateIds, voteIds: original.construction.voteIds });
    return { id, label, request, descriptor, candidates: original.candidates,
      voteCandidates: original.voteCandidates, historical: score(original.generations[0].result.text, original),
      order: index % 2 ? ['schema', 'control'] : ['control', 'schema'], frozenHash: hash(request) };
  });
  return { version: 1, createdAt: new Date().toISOString(), maxCalls: 6, cases };
}

function score(text, item) {
  const decision = actions.parseDecision(text, item.candidates, {
    voteCandidates: item.voteCandidates, decisionContractVersion: 2 });
  const parsed = contract.parseObject(text);
  const fullValid = decision.valid && decision.votes.every(vote => vote.decisionKind === 'explicit');
  const expected = item.descriptor ? item.descriptor.voteIds : item.construction.voteIds;
  const tupleExact = !!parsed && Array.isArray(parsed.votes) && parsed.votes.length === expected.length &&
    parsed.votes.every((vote, index) => vote && vote.id === expected[index]);
  const isolated = voting.record({}, decision.votes).considered;
  for (const vote of decision.votes.filter(vote => vote.decisionKind !== 'explicit')) {
    assert(!isolated.includes(voting.targetKey(vote)), 'Unresolved target cannot become considered');
  }
  return { fullValid, primaryValid: decision.valid, waited: decision.waited, tupleExact,
    strictObject: !!parsed, choice: decision.candidate?.id || (decision.valid ? 'WAIT' : null),
    explicit: decision.votes.filter(vote => vote.decisionKind === 'explicit').length,
    unresolved: decision.votes.filter(vote => vote.decisionKind !== 'explicit').length,
    votes: decision.votes.map(({ id, direction, decisionKind }) => ({ id, direction, decisionKind })) };
}

async function run(packet, output, workerRoot) {
  assert.equal(process.platform, 'win32');
  assert.equal(os.hostname().toUpperCase(), 'DELL');
  assert.equal(packet.version, 1);
  assert.equal(packet.maxCalls, 6);
  assert.equal(packet.cases.length, 3);
  assert(path.isAbsolute(output) && !fs.existsSync(output), 'Fresh private run directory required; never retry a ledger');
  fs.mkdirSync(output);
  process.env.OLLAMA_BASE = 'http://127.0.0.1:11434';
  process.env.SHARED_OLLAMA_ARBITER_URL = 'http://127.0.0.1:11435';
  process.env.FEDDIT_BOT_DATA_DIR = path.join(output, 'isolated-telemetry');
  const { createWorker } = require(path.join(workerRoot, 'worker'));
  const ollama = require(path.join(workerRoot, 'lib/providers/ollama'));
  const workerFormat = require(path.join(workerRoot, 'lib/hosted-decision-format'));
  const started = Date.now();
  const results = [];
  let reported;
  let calls = 0;
  const worker = createWorker({ runnerUrl: 'http://127.0.0.1:9', key: 'private-fixture-only',
    workerId: 'frozen-native-format-validation', maintenanceDir: '',
    generate: payload => ollama.generate({ ...payload, kind: 'frozen-native-format-validation' }),
    fetchImpl: async (url, options) => {
      assert(/^\/api\/worker\/jobs\/frozen-[0-9]+\/(renew|complete|fail)$/.test(new URL(url).pathname));
      const data = JSON.parse(options.body);
      if (!url.endsWith('/renew')) reported = url.endsWith('/complete')
        ? { ok: true, result: data.result } : { ok: false, error: data.error };
      return { ok: true, text: async () => '{}' };
    }, logger: { log() {}, warn() {}, error() {} } });
  const save = (name, value) => fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2), { flag: 'wx' });
  try {
    for (const item of packet.cases) {
      assert.equal(hash(item.request), item.frozenHash);
      assert.deepEqual(workerFormat.schema(item.descriptor), format.schema(item.descriptor));
      for (const arm of item.order) {
        assert(calls < 6 && Date.now() - started < 30 * 60 * 1000, 'Bounded experiment window exhausted');
        assert(!fs.existsSync('C:/dev/inference-maintenance/request.json'), 'Another maintenance owner must not be disturbed');
        calls++;
        reported = null;
        const label = item.label + '-' + arm;
        save(label + '-admitted', { label, calls, at: new Date().toISOString(), frozenHash: item.frozenHash });
        console.log(JSON.stringify({ state: 'waiting-for-normal-synthetic-lease', label, calls, input: item.request.decisionBudget.inputTokens }));
        const payload = { ...item.request, timeoutMs: 300000,
          ...(arm === 'schema' ? { hostedDecisionFormat: item.descriptor } : {}) };
        await worker.runJob({ id: 'frozen-' + calls, kind: 'scheduled-decision', payload,
          priority: 'background', allocationClass: 'synthetic' });
        assert(reported, 'Isolated completion receipt missing');
        save(label + '-private-result', reported);
        if (!reported.ok) {
          console.log(JSON.stringify({ label, state: 'failed-no-retry' }));
          throw new Error('Frozen worker request failed; private diagnostic retained, no retry');
        }
        const result = reported.result;
        const summary = { label, id: item.id, arm, ms: result.ms, queueMs: result.queueMs,
          input: result.usage.inputTokens, frozenInput: item.request.decisionBudget.inputTokens,
          output: result.usage.outputTokens, finishReason: result.finishReason || 'legacy-not-recorded',
          decision: score(result.text, item) };
        results.push(summary); save(label + '-summary', summary);
        console.log(JSON.stringify(summary));
        assert.equal(summary.input, summary.frozenInput, 'Native token mismatch: stop without retry');
        if (arm === 'schema') assert(summary.decision.tupleExact, 'Native tuple schema was not enforced; stop without retry');
      }
    }
    save('summary', { calls, results, elapsedMs: Date.now() - started,
      publicationCalls: 0, liveStoresOpened: 0, automaticRetries: 0, maintenanceHolds: 0 });
  } finally { worker.stop(); worker.maintenance.close(); }
}

if (require.main === module) {
  (async () => {
    if (process.argv[2] === '--prepare') {
      const packet = prepare(read(process.argv[3]));
      fs.writeFileSync(process.argv[4], JSON.stringify(packet), { flag: 'wx' });
      console.log(JSON.stringify(packet.cases.map(item => ({ id: item.id, label: item.label,
        input: item.request.decisionBudget.inputTokens, votes: item.voteCandidates.length, historical: item.historical }))));
    } else if (process.argv[2] === '--run') await run(read(process.argv[3]), process.argv[4], process.argv[5]);
    else throw new Error('Explicit --prepare or --run required');
  })().catch(() => { console.error('Frozen native-format validation stopped; no retry. See private evidence.'); process.exitCode = 1; });
}
module.exports = { prepare, score };
