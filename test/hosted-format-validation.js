'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare, prepareReasonRefinement, validatePacket, freshOutput, score, boundedAdmission, continuation, receiptKind } = require('../bin/validate-hosted-decision-format');
const budget = require('../lib/hosted-decision-budget');
let checks = 0;
function eq(actual, expected) { assert.deepEqual(actual, expected); checks++; }
const ids = ['t_833470e10c8efa585a15bc1c3c0e2ea4', 't_13d085fcb8842d1cf5715047cc7abe2d',
  't_3ad4b07b8d044593d7c3a596912d5f23'];
const corpus = { version: 1, cases: ids.map((id, index) => {
  const request = { model: require('../lib/hosted-tokenizer').MODEL, system: 'Fixture persona.',
    prompt: 'A complete frozen request.', temperature: 0.8, numPredict: 640 };
  request.decisionBudget = budget.measure(request.system, request.prompt, 640, 2);
  return { id, generations: [{ request, result: { text: 'An unreadable decision.' } }],
    candidates: [{ id: 'C7', candidateType: 'ordinary_comment' }],
    voteCandidates: Array.from({ length: index ? index + 1 : 0 }, (_, i) => ({ id: 'V' + (i + 1), targetType: 'post', targetId: i + 1 })),
    construction: { candidateIds: ['C7'], voteIds: Array.from({ length: index ? index + 1 : 0 }, (_, i) => 'V' + (i + 1)) } };
}) };
const packet = prepare(corpus);
eq(packet.maxCalls, 6);
eq(packet.cases.length, 3);
eq(packet.cases.map(c => c.order), [['control', 'schema'], ['schema', 'control'], ['control', 'schema']]);
for (let i = 0; i < 3; i++) {
  eq(packet.cases[i].request, corpus.cases[i].generations[0].request);
  eq(packet.cases[i].descriptor.voteIds, corpus.cases[i].construction.voteIds);
  eq(packet.cases[i].historical.fullValid, false);
}
const item = packet.cases[2];
const valid = { choice: 'C7', reason: 'This fits the actual branch.', votes: [
  { id: 'V1', direction: 'up', reason: 'This is a specific useful explanation.' },
  { id: 'V2', direction: 'nil', reason: '' },
  { id: 'V3', direction: 'nil', reason: '' },
] };
eq(score(JSON.stringify(valid), item).fullValid, true);
eq(score(JSON.stringify(valid), item).tupleExact, true);
eq(score(JSON.stringify(valid), item).nativeSchemaExact, true);
eq(score('```json\n' + JSON.stringify(valid) + '\n```', item).nativeSchemaExact, false);
eq(score(JSON.stringify({ ...valid, extra: true }), item).nativeSchemaExact, false);
eq(score(JSON.stringify({ ...valid, reason: 1 }), item).nativeSchemaExact, false);
eq(score(JSON.stringify({ ...valid, votes: valid.votes.map(v => ({ ...v, extra: true })) }), item).nativeSchemaExact, false);
eq(score(JSON.stringify(valid) + '|im_end|>', item).fullValid, false);
eq(score(JSON.stringify({ ...valid, votes: valid.votes.slice(0, 1) }), item).unresolved, 2);
eq(score(JSON.stringify({ ...valid, choice: 'C8' }), item).primaryValid, false);
eq(score(JSON.stringify({ ...valid, votes: valid.votes.slice().reverse() }), item).tupleExact, false);
const wrongReason = structuredClone(valid);
wrongReason.votes[0].reason = 'Bad';
eq(score(JSON.stringify(wrongReason), item).fullValid, false);
const modified = structuredClone(corpus);
modified.cases[0].generations[0].request.prompt = 'Changed without a new token budget';
assert.throws(() => prepare(modified)); checks++;
const firstLabel = packet.cases[0].label + '-control';
eq(receiptKind(new URL('http://127.0.0.1:9/api/worker/jobs/frozen-1/complete')), 'complete');
eq(receiptKind('http://127.0.0.1:9/api/worker/jobs/frozen-1/fail'), 'fail');
eq(receiptKind(new URL('http://127.0.0.1:9/api/worker/jobs/frozen-1/renew')), null);
const marker = { label: firstLabel, calls: 1, at: new Date().toISOString(), frozenHash: packet.cases[0].frozenHash };
eq(continuation(packet, [firstLabel + '-admitted.json'], marker).calls, 1);
for (const files of [[], [firstLabel + '-admitted.json', 'another-attempt.json']]) {
  assert.throws(() => continuation(packet, files, marker)); checks++;
}
assert.throws(() => continuation(packet, [firstLabel + '-admitted.json'], { ...marker, frozenHash: 'changed' })); checks++;

const refinement = prepareReasonRefinement(corpus);
eq(refinement.version, 2);
eq(refinement.maxCalls, 2);
eq(refinement.cases.map(value => value.id), ids.slice(1));
eq(refinement.cases.map(value => value.order), [['schema'], ['schema']]);
eq(refinement.cases.map(value => value.descriptor.version), [2, 2]);
for (let i = 0; i < refinement.cases.length; i++) {
  eq(refinement.cases[i].request, packet.cases[i + 1].request);
  eq(refinement.cases[i].frozenHash, packet.cases[i + 1].frozenHash);
  eq(refinement.cases[i].candidates, packet.cases[i + 1].candidates);
  eq(refinement.cases[i].voteCandidates, packet.cases[i + 1].voteCandidates);
}
validatePacket(packet); checks++;
validatePacket(refinement); checks++;
for (const malformed of [
  { ...refinement, maxCalls: 3 },
  { ...refinement, cases: [...refinement.cases, refinement.cases[0]] },
  { ...refinement, cases: refinement.cases.map(value => ({ ...value, order: ['schema', 'control'] })) },
  { ...refinement, cases: refinement.cases.slice().reverse() },
  { ...refinement, cases: refinement.cases.map(value => ({ ...value, descriptor: { ...value.descriptor, version: 1 } })) },
]) {
  assert.throws(() => validatePacket(malformed)); checks++;
}
assert.throws(() => validatePacket(refinement, true)); checks++;
assert.throws(() => continuation(refinement, [firstLabel + '-admitted.json'], marker)); checks++;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-format-fixture-'));
try {
  const output = path.join(directory, 'fresh-ledger');
  freshOutput(output); checks++;
  assert.throws(() => freshOutput(output), /never retry a ledger/); checks++;
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
const refinedItem = refinement.cases[1];
eq(score(JSON.stringify(valid), refinedItem).nativeSchemaExact, true);
eq(score(JSON.stringify(valid), refinedItem).fullValid, true);
for (const reason of ['Seventeen letters', 'a b c', 'A                    B']) {
  const invalid = structuredClone(valid);
  invalid.votes[0].reason = reason;
  eq(score(JSON.stringify(invalid), refinedItem).nativeSchemaExact, false);
  eq(score(JSON.stringify(invalid), refinedItem).fullValid, false);
  eq(score(JSON.stringify(invalid), refinedItem).unresolved, 1);
}
const normalized = structuredClone(valid);
normalized.votes[0].reason = '  A\tuseful\nexplanation here.  ';
eq(score(JSON.stringify(normalized), refinedItem).nativeSchemaExact, false);
eq(score(JSON.stringify(normalized), refinedItem).fullValid, true);
normalized.votes[0].reason = 'A useful explanation here.\n';
eq(score(JSON.stringify(normalized), refinedItem).nativeSchemaExact, false);
eq(score(JSON.stringify(valid), refinedItem).votes[1].direction, 'nil');
// Content-free shape of the first real v2 check: compliant V1 reason but V2
// absent, despite a native tuple schema. Never attribute this as schema success.
const missingRefined = { ...valid, votes: valid.votes.slice(0, 1) };
const missingScore = score(JSON.stringify(missingRefined), refinement.cases[0]);
eq(missingScore.nativeSchemaExact, false);
eq(missingScore.fullValid, false);
eq(missingScore.explicit, 1);
eq(missingScore.unresolved, 1);
eq(missingScore.votes[1], { id: 'V2', direction: null, decisionKind: 'missing' });
// Version 1 attribution remains structural; the unchanged semantic validator
// still rejects the same short non-nil reason independently.
eq(score(JSON.stringify(wrongReason), item).nativeSchemaExact, true);

(async () => {
  const options = { deadline: Date.now() + 1000, reserveMs: 0, maintenanceExists: () => false, pollMs: 1 };
  let released = 0;
  const lease = { release: async () => { released++; } };
  const client = { acquire: async ({ signal }) => { eq(signal.aborted, false); return lease; } };
  const admitted = await boundedAdmission(client, options).acquire({});
  eq(admitted, lease);
  eq(released, 0);
  let held = false;
  await assert.rejects(() => boundedAdmission({ acquire: async () => { held = true; return lease; } },
    { ...options, maintenanceExists: () => held }).acquire({})); checks++;
  eq(released, 1);
  const waiting = { acquire: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) };
  await assert.rejects(() => boundedAdmission(waiting, { ...options, deadline: Date.now() + 15 }).acquire({})); checks++;
  held = false;
  const pending = boundedAdmission(waiting, { ...options, maintenanceExists: () => held }).acquire({});
  setTimeout(() => { held = true; }, 5);
  await assert.rejects(() => pending); checks++;
  console.log('hosted format validation: ' + checks + ' checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
