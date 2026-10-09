'use strict';
const assert = require('node:assert/strict');
const { score, remainingAfterTimeout, TIMEOUT_MESSAGE } = require('../bin/validate-hosted-decision-budget');
const item = { construction: { candidateIds: ['C1'], voteIds: ['V1'], deferredVoteIds: ['V2'] },
  record: { slate: { candidates: [{ id: 'C1' }, { id: 'C2' }], voteCandidates: [
    { id: 'V1', targetType: 'post', targetId: 1 }, { id: 'V2', targetType: 'post', targetId: 2 }] } } };
const before = JSON.stringify(item);
let checks = 0;
for (const text of ['not JSON', '{"choice":"WAIT"}',
  '{"choice":"C1","votes":[{"id":"V1","direction":"up","reason":""}]}',
  '{"choice":"C1","votes":[{"id":"V1","direction":"nil"},{"id":"V1","direction":"up","reason":"A genuinely relevant contribution"}]}']) {
  const result = score(text, item);
  assert.equal(result.unresolved, 1); assert.equal(result.isolatedConsideredCount, 0);
  assert.equal(result.votes.length, 1); checks += 3;
}
const nil = score('{"choice":"WAIT","votes":[{"id":"V1","direction":"nil"},{"id":"V2","direction":"nil"}]}', item);
assert.equal(nil.valid, true); assert.equal(nil.isolatedConsideredCount, 1);
assert.equal(nil.votes.length, 1); assert.equal(nil.deferredNeverConsidered, true); checks += 4;
const invalidChoice = score('{"choice":"C2","votes":[]}', item);
assert.equal(invalidChoice.valid, false); assert.equal(invalidChoice.technicalFailure, true); checks += 2;
assert.equal(JSON.stringify(item), before); checks++;
const packet = { cases: [{ label: 'first', construction: { budget: { requestHash: 'frozen-hash' } } }, { label: 'second' }, { label: 'third' }, { label: 'blocked' }] };
const prior = { status: 'failed', attempts: 1, lastError: TIMEOUT_MESSAGE, profileId: 'frozen-first', payload: { decisionBudget: { requestHash: 'frozen-hash' } } };
assert.deepEqual(remainingAfterTimeout(packet, [prior]).map((entry) => entry.label), ['second', 'third', 'blocked']); checks++;
for (const change of [{ status: 'claimed' }, { attempts: 2 }, { lastError: 'ambiguous transport' }, { profileId: 'other' }, { payload: { decisionBudget: { requestHash: 'changed' } } }]) {
  assert.throws(() => remainingAfterTimeout(packet, [{ ...prior, ...change }])); checks++;
}
assert.throws(() => remainingAfterTimeout(packet, [prior, prior])); checks++;
console.log('Frozen budget validation: ' + checks + ' checks passed');
