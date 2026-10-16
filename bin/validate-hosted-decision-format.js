'use strict';

// Explicit bounded frozen validation. No scheduler, live stores, registration,
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

// Validation-only admission bound. Cancel the real HTTP acquire request, not
// an uncancelled Promise.race. A granted lease remains admitted work and drains
// normally; maintenance operators must still establish an empty shared arbiter.
function boundedAdmission(client, { deadline, maintenanceExists, now = Date.now,
  reserveMs = 330000, pollMs = 250 } = {}) {
  return { async acquire(options) {
    const available = deadline - now() - reserveMs;
    assert(available > 0 && !maintenanceExists(), 'Validation admission is unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), available);
    const watcher = setInterval(() => { if (maintenanceExists()) controller.abort(); }, pollMs);
    try {
      const lease = await client.acquire({ ...options, signal: controller.signal });
      if (controller.signal.aborted || maintenanceExists() || deadline - now() <= reserveMs) {
        await lease.release();
        throw new Error('Validation admission cancelled before inference');
      }
      return lease;
    } finally { clearTimeout(timer); clearInterval(watcher); }
  } };
}
const chosen = [
  ['t_833470e10c8efa585a15bc1c3c0e2ea4', 'marker-no-votes'],
  ['t_13d085fcb8842d1cf5715047cc7abe2d', 'syntax-two-votes'],
  ['t_3ad4b07b8d044593d7c3a596912d5f23', 'missing-three-votes'],
];
const finalPairId = 't_80a68191c5055cdd1ffe390c31955d19';

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

function prepareReasonRefinement(corpus) {
  const packet = prepare(corpus);
  return { ...packet, version: 2, maxCalls: 2, cases: packet.cases.slice(1).map(item => ({
    ...item, descriptor: format.validate({ ...item.descriptor, version: 2 }), order: ['schema'],
  })) };
}

function prepareFinalPair(corpus) {
  assert.equal(corpus.version, 1);
  const original = corpus.cases.find(item => item.id === finalPairId);
  assert(original && original.generations.length >= 2, 'Untested retained framing-failure case missing');
  assert(!chosen.some(([id]) => id === original.id));
  const request = original.generations[0].request;
  assert.equal(request.numPredict, 640);
  const measured = budget.measure(request.system, request.prompt, 640, 2);
  assert.deepEqual(request.decisionBudget, measured);
  assert(budget.fits(measured));
  const descriptor = format.validate({ version: 1,
    candidateIds: original.construction.candidateIds, voteIds: original.construction.voteIds });
  assert(descriptor.voteIds.length > 0, 'Final framing case must include votes');
  const item = { id: original.id, label: 'final-framing-pair', request, descriptor,
    candidates: original.candidates, voteCandidates: original.voteCandidates,
    historical: score(original.generations[0].result.text, original),
    historicalFinal: score(original.generations.at(-1).result.text, original),
    order: ['control', 'schema'], frozenHash: hash(request) };
  assert(!item.historical.primaryValid && !item.historicalFinal.primaryValid,
    'Final comparison requires retained initial and final primary failures');
  return { version: 3, createdAt: new Date().toISOString(), maxCalls: 2, cases: [item] };
}

function validatePacket(packet, continueUntouched = false) {
  assert([1, 2, 3].includes(packet.version), 'Unsupported private validation protocol');
  if (packet.version === 3) {
    assert(!continueUntouched, 'Final pair requires a fresh ledger; continuation is not allowed');
    assert.equal(packet.maxCalls, 2);
    assert.equal(packet.cases.length, 1);
    const item = packet.cases[0];
    assert.equal(item.id, finalPairId);
    assert.equal(item.label, 'final-framing-pair');
    assert.equal(item.descriptor.version, 1);
    format.validate(item.descriptor);
    assert(item.descriptor.voteIds.length > 0);
    assert.deepEqual(item.order, ['control', 'schema']);
    assert.equal(hash(item.request), item.frozenHash);
    assert.equal(item.request.numPredict, 640);
    assert.deepEqual(item.request.decisionBudget, budget.measure(item.request.system, item.request.prompt, 640, 2));
    assert(budget.fits(item.request.decisionBudget));
    assert.deepEqual(item.candidates.map(value => value.id), item.descriptor.candidateIds);
    assert.deepEqual(item.voteCandidates.map(value => value.id), item.descriptor.voteIds);
    return;
  }
  const refinement = packet.version === 2;
  assert.equal(packet.maxCalls, refinement ? 2 : 6);
  assert.equal(packet.cases.length, refinement ? 2 : 3);
  if (refinement) {
    assert(!continueUntouched, 'Reason refinement requires a fresh ledger; continuation is not allowed');
    assert.deepEqual(packet.cases.map(item => item.id), chosen.slice(1).map(([id]) => id));
    for (const [index, item] of packet.cases.entries()) {
      assert.equal(item.descriptor.version, 2);
      assert.equal(item.descriptor.voteIds.length, index + 2);
      assert.deepEqual(item.order, ['schema']);
    }
  }
  assert.equal(packet.cases.reduce((sum, item) => sum + item.order.length, 0), packet.maxCalls);
}

function freshOutput(output) {
  assert(!fs.existsSync(output), 'Fresh private run directory required; never retry a ledger');
  fs.mkdirSync(output);
}

function score(text, item) {
  const decision = actions.parseDecision(text, item.candidates, {
    voteCandidates: item.voteCandidates, decisionContractVersion: 2 });
  const parsed = contract.parseObject(text);
  let rawJSON = false;
  try { JSON.parse(String(text || '').trim()); rawJSON = true; } catch { /* no salvage for native attribution */ }
  const fullValid = decision.valid && decision.votes.every(vote => vote.decisionKind === 'explicit');
  const expected = item.descriptor ? item.descriptor.voteIds : item.construction.voteIds;
  const tupleExact = !!parsed && Array.isArray(parsed.votes) && parsed.votes.length === expected.length &&
    parsed.votes.every((vote, index) => vote && vote.id === expected[index]);
  const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  const reasonSchema = item.descriptor?.version === 2
    ? format.schema(item.descriptor).properties.votes.items[0]?.oneOf[0].properties.reason : null;
  const refinedReason = vote => vote.direction === 'nil' ||
    (reasonSchema && Array.from(vote.reason).length >= reasonSchema.minLength &&
      new RegExp(reasonSchema.pattern, 'u').exec(vote.reason)?.[0] === vote.reason &&
      decision.votes.find(value => value.id === vote.id)?.decisionKind === 'explicit');
  const nativeSchemaExact = rawJSON && !!parsed && exactKeys(parsed, ['choice', 'reason', 'votes']) &&
    typeof parsed.reason === 'string' && ['WAIT', ...item.candidates.map(c => c.id)].includes(parsed.choice) &&
    tupleExact && parsed.votes.every(vote => exactKeys(vote, ['id', 'direction', 'reason']) &&
      ['up', 'down', 'nil'].includes(vote.direction) && typeof vote.reason === 'string' &&
      (item.descriptor?.version !== 2 || refinedReason(vote)));
  const isolated = voting.record({}, decision.votes).considered;
  for (const vote of decision.votes.filter(vote => vote.decisionKind !== 'explicit')) {
    assert(!isolated.includes(voting.targetKey(vote)), 'Unresolved target cannot become considered');
  }
  return { fullValid, primaryValid: decision.valid, waited: decision.waited,
    validWait: decision.valid && decision.waited, tupleExact, nativeSchemaExact, rawJSON,
    strictObject: !!parsed, choice: decision.candidate?.id || (decision.valid ? 'WAIT' : null),
    explicit: decision.votes.filter(vote => vote.decisionKind === 'explicit').length,
    invalid: decision.votes.filter(vote => vote.decisionKind === 'invalid').length,
    missing: decision.votes.filter(vote => vote.decisionKind === 'missing').length,
    unresolved: decision.votes.filter(vote => vote.decisionKind !== 'explicit').length,
    votes: decision.votes.map(({ id, direction, decisionKind }) => ({ id, direction, decisionKind })) };
}

// Final-pair-only observation of the actual non-stream worker transport. Never
// change provider options, request bodies, response objects or legacy metadata.
// Only an allowlisted content-free projection of the cloned response survives.
async function observeFinalPair(callback, target = globalThis) {
  const original = target.fetch;
  let active = null;
  let calls = 0;
  let frozenBodyHash = null;
  const observer = {
    start(arm, descriptor) {
      assert(!active && ['control', 'schema'].includes(arm));
      active = { arm, descriptor, calls: 0, completion: null };
    },
    finish() {
      assert(active && active.calls === 1, 'Exactly one inference per final-pair arm is required');
      const completion = active.completion;
      active = null;
      assert(completion, 'Actual completion metadata missing');
      return completion;
    },
  };
  target.fetch = async function(url, options) {
    const location = new URL(url);
    const chat = location.pathname === '/api/chat';
    if (chat) {
      assert.equal(location.origin, 'http://127.0.0.1:11434', 'Unexpected inference destination');
      assert(active && calls < 2 && active.calls === 0, 'No additional inference or retry is authorized');
      const body = JSON.parse(options.body);
      assert.equal(body.stream, false, 'Final pair requires the production non-streaming transport');
      if (active.arm === 'control') assert(!Object.hasOwn(body, 'format'), 'Control must not request a native format');
      else assert.deepEqual(body.format, format.schema(active.descriptor));
      const { format: ignored, ...unchangedBody } = body;
      const bodyHash = hash(unchangedBody);
      if (frozenBodyHash === null) frozenBodyHash = bodyHash;
      else assert.equal(bodyHash, frozenBodyHash, 'Frozen chat request changed between arms');
      active.bodyHash = bodyHash;
      active.calls++; calls++;
    }
    const response = await original.call(target, url, options);
    if (chat) {
      const record = await response.clone().json();
      const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
      active.completion = { done: record.done === true,
        finishReason: ['stop', 'length'].includes(record.done_reason) ? record.done_reason : 'unknown',
        inputTokens: count(record.prompt_eval_count), outputTokens: count(record.eval_count),
        requestHashWithoutFormat: active.bodyHash };
    }
    return response;
  };
  try {
    const result = await callback(observer);
    assert.equal(calls, 2, 'Exactly two final-pair inference calls must complete');
    assert.equal(active, null);
    return result;
  } finally { target.fetch = original; }
}

function continuation(packet, files, first) {
  assert.equal(packet.version, 1, 'Reason refinement cannot resume or reuse a ledger');
  const label = packet.cases[0].label + '-control';
  assert.deepEqual(files, [label + '-admitted.json'], 'Only the single known lost-receipt attempt may be continued');
  assert.equal(first.label, label);
  assert.equal(first.calls, 1);
  assert.equal(first.frozenHash, packet.cases[0].frozenHash);
  assert(Number.isFinite(Date.parse(first.at)));
  return { label, at: Date.parse(first.at), calls: 1 };
}

function receiptKind(url) {
  const route = new URL(url).pathname;
  assert(/^\/api\/worker\/jobs\/frozen-[0-9]+\/(renew|complete|fail)$/.test(route));
  return route.endsWith('/renew') ? null : route.endsWith('/complete') ? 'complete' : 'fail';
}

async function run(packet, output, workerRoot, continueUntouched = false) {
  validatePacket(packet, continueUntouched);
  assert.equal(process.platform, 'win32');
  assert.equal(os.hostname().toUpperCase(), 'DELL');
  assert(path.isAbsolute(output));
  let previous = null;
  if (continueUntouched) {
    const files = fs.readdirSync(output);
    previous = continuation(packet, files, read(path.join(output, files[0])));
  } else {
    freshOutput(output);
  }
  process.env.OLLAMA_BASE = 'http://127.0.0.1:11434';
  process.env.SHARED_OLLAMA_ARBITER_URL = 'http://127.0.0.1:11435';
  process.env.FEDDIT_BOT_DATA_DIR = path.join(output, 'isolated-telemetry');
  const { createWorker } = require(path.join(workerRoot, 'worker'));
  const ollama = require(path.join(workerRoot, 'lib/providers/ollama'));
  const workerFormat = require(path.join(workerRoot, 'lib/hosted-decision-format'));
  const started = previous ? previous.at : Date.now();
  const admission = boundedAdmission(require(path.join(workerRoot, 'lib/shared-ollama-lease'))
    .createClient('http://127.0.0.1:11435'), { deadline: started + 30 * 60 * 1000,
    maintenanceExists: () => fs.existsSync('C:/dev/inference-maintenance/request.json') });
  const results = [];
  let reported;
  let calls = previous ? previous.calls : 0;
  const worker = createWorker({ runnerUrl: 'http://127.0.0.1:9', key: 'private-fixture-only',
    workerId: 'frozen-native-format-validation', maintenanceDir: '',
    generate: payload => ollama.generate({ ...payload, kind: 'frozen-native-format-validation', leaseClient: admission }),
    fetchImpl: async (url, options) => {
      const kind = receiptKind(url);
      const data = JSON.parse(options.body);
      if (kind) {
        reported = kind === 'complete'
          ? { ok: true, result: data.result } : { ok: false, error: data.error };
        fs.writeFileSync(path.join(output, 'receipt-' + calls + '-private.json'), JSON.stringify(reported), { flag: 'wx' });
      }
      return { ok: true, text: async () => '{}' };
    }, logger: { log() {}, warn() {}, error() {} } });
  const save = (name, value) => fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2), { flag: 'wx' });
  if (previous) {
    const lost = { label: previous.label, arm: 'control', usable: false,
      classification: 'private-completion-callback-failed', retried: false };
    results.push(lost); save(previous.label + '-unrecoverable', lost);
  }
  const execute = async observer => {
    for (const item of packet.cases) {
      assert.equal(hash(item.request), item.frozenHash);
      assert.deepEqual(workerFormat.schema(item.descriptor), format.schema(item.descriptor));
      for (const arm of item.order) {
        if (previous && item.label + '-' + arm === previous.label) continue;
        assert(calls < packet.maxCalls && Date.now() - started < 30 * 60 * 1000, 'Bounded experiment window exhausted');
        assert(!fs.existsSync('C:/dev/inference-maintenance/request.json'), 'Another maintenance owner must not be disturbed');
        calls++;
        reported = null;
        const label = item.label + '-' + arm;
        save(label + '-admitted', { label, calls, at: new Date().toISOString(), frozenHash: item.frozenHash });
        console.log(JSON.stringify({ state: 'waiting-for-normal-synthetic-lease', label, calls, input: item.request.decisionBudget.inputTokens }));
        const payload = { ...item.request, timeoutMs: 300000,
          ...(arm === 'schema' ? { hostedDecisionFormat: item.descriptor } : {}) };
        if (observer) observer.start(arm, item.descriptor);
        await worker.runJob({ id: 'frozen-' + calls, kind: 'scheduled-decision', payload,
          priority: 'background', allocationClass: 'synthetic' });
        assert(reported, 'Isolated completion receipt missing');
        save(label + '-private-result', reported);
        if (!reported.ok) {
          console.log(JSON.stringify({ label, state: 'failed-no-retry' }));
          throw new Error('Frozen worker request failed; private diagnostic retained, no retry');
        }
        const result = reported.result;
        const completion = observer ? observer.finish() : null;
        const summary = { label, id: item.id, arm, ms: result.ms, queueMs: result.queueMs,
          input: result.usage.inputTokens, frozenInput: item.request.decisionBudget.inputTokens,
          output: result.usage.outputTokens, finishReason: result.finishReason || 'legacy-not-recorded',
          ...(completion ? { completion } : {}), decision: score(result.text, item) };
        if (packet.version === 2) {
          const parsed = contract.parseObject(result.text);
          summary.reasonLengths = item.descriptor.voteIds.map(id => {
            const vote = Array.isArray(parsed?.votes) ? parsed.votes.find(value => value?.id === id) : null;
            const reason = String(vote?.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240);
            return { id, characters: reason.length, words: reason.split(/\s+/).filter(Boolean).length };
          });
        }
        results.push(summary); save(label + '-summary', summary);
        console.log(JSON.stringify(summary));
        assert.equal(summary.input, summary.frozenInput, 'Native token mismatch: stop without retry');
        if (completion) {
          assert.equal(completion.inputTokens, summary.input, 'Completion token mismatch: stop without retry');
          assert.equal(completion.outputTokens, summary.output, 'Completion output mismatch: stop without retry');
        }
        if (arm === 'schema' && packet.version !== 3) assert(summary.decision.nativeSchemaExact, 'Native schema was not enforced; stop without retry');
        if (packet.version === 2) assert(summary.decision.fullValid, 'Reason refinement did not satisfy the unchanged decision contract; stop without retry');
      }
    }
    save('summary', { calls, results, elapsedMs: Date.now() - started,
      publicationCalls: 0, liveStoresOpened: 0, automaticRetries: 0, maintenanceHolds: 0 });
  };
  try {
    if (packet.version === 3) await observeFinalPair(execute);
    else await execute(null);
  } finally { worker.stop(); worker.maintenance.close(); }
}

if (require.main === module) {
  (async () => {
    if (['--prepare', '--prepare-reason-refinement', '--prepare-final-pair'].includes(process.argv[2])) {
      const mode = { '--prepare': prepare, '--prepare-reason-refinement': prepareReasonRefinement,
        '--prepare-final-pair': prepareFinalPair }[process.argv[2]];
      const packet = mode(read(process.argv[3]));
      fs.writeFileSync(process.argv[4], JSON.stringify(packet), { flag: 'wx' });
      console.log(JSON.stringify(packet.cases.map(item => ({ id: item.id, label: item.label,
        input: item.request.decisionBudget.inputTokens, votes: item.voteCandidates.length, historical: item.historical }))));
    } else if (process.argv[2] === '--run') await run(read(process.argv[3]), process.argv[4], process.argv[5],
      process.argv[6] === '--continue-unattempted');
    else throw new Error('Explicit --prepare, --prepare-reason-refinement, --prepare-final-pair or --run required');
  })().catch(() => { console.error('Frozen native-format validation stopped; no retry. See private evidence.'); process.exitCode = 1; });
}
module.exports = { prepare, prepareReasonRefinement, prepareFinalPair, validatePacket, freshOutput, score,
  boundedAdmission, continuation, receiptKind, observeFinalPair };
