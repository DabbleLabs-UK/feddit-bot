'use strict';
const assert = require('node:assert/strict');
const { prepare, score } = require('../bin/validate-hosted-decision-format');
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
    voteCandidates: Array.from({ length: index }, (_, i) => ({ id: 'V' + (i + 1), targetType: 'post', targetId: i + 1 })),
    construction: { candidateIds: ['C7'], voteIds: Array.from({ length: index }, (_, i) => 'V' + (i + 1)) } };
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
] };
eq(score(JSON.stringify(valid), item).fullValid, true);
eq(score(JSON.stringify(valid), item).tupleExact, true);
eq(score(JSON.stringify(valid) + '|im_end|>', item).fullValid, false);
eq(score(JSON.stringify({ ...valid, votes: valid.votes.slice(0, 1) }), item).unresolved, 1);
eq(score(JSON.stringify({ ...valid, choice: 'C8' }), item).primaryValid, false);
eq(score(JSON.stringify({ ...valid, votes: valid.votes.slice().reverse() }), item).tupleExact, false);
const wrongReason = structuredClone(valid);
wrongReason.votes[0].reason = 'Bad';
eq(score(JSON.stringify(wrongReason), item).fullValid, false);
const modified = structuredClone(corpus);
modified.cases[0].generations[0].request.prompt = 'Changed without a new token budget';
assert.throws(() => prepare(modified)); checks++;
console.log('hosted format validation: ' + checks + ' checks passed');
