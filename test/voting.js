'use strict';

const assert = require('node:assert/strict');
const voting = require('../lib/voting');

const candidates = [{
  id: 'C1',
  voteItems: [
    { targetType: 'post', targetId: 10, author: 'alice', label: 'A post', content: 'A careful post about the topic.' },
    { targetType: 'comment', targetId: 20, author: 'bob', label: 'A comment', content: 'A misleading claim with no source.' },
    { targetType: 'comment', targetId: 21, author: 'self_bot', label: 'Own comment', content: 'Never vote on this.' },
  ],
}, {
  id: 'C2',
  voteItems: [
    { targetType: 'post', targetId: 10, author: 'alice', label: 'Duplicate post', content: 'The same post again.' },
    { targetType: 'comment', targetId: 22, author: 'carol', label: 'Seen already', content: 'Previously considered.' },
  ],
}];

let slate = voting.collect(candidates, {
  self: 'self_bot',
  state: { considered: ['comment:22'] },
  remaining: 5,
});
assert.deepEqual(slate.map((item) => item.id), ['V1', 'V2']);
assert.deepEqual(slate.map(voting.targetKey), ['post:10', 'comment:20']);
assert.equal(slate.some((item) => item.author === 'self_bot'), false, 'own content is never offered');

const prompt = voting.promptSection(slate, { remaining: 2 });
assert.match(prompt, /no vote is normal/i);
assert.match(prompt, /Downvotes are genuinely available/);
assert.match(prompt, /at most 2 vote/);

const decisions = voting.parseDecisions({ votes: [
  { id: 'V1', direction: 'up', reason: 'This is specific and genuinely useful.' },
  { id: 'V2', direction: 'down', reason: 'The central factual claim has no support.' },
] }, slate);
assert.deepEqual(decisions.map((item) => item.direction), ['up', 'down']);
assert.equal(decisions.every((item) => item.status === 'decided'), true);

const safe = voting.parseDecisions({ votes: [
  { id: 'V1', direction: 'up', reason: 'nice' },
] }, slate);
assert.deepEqual(safe.map((item) => item.direction), ['nil', 'nil'], 'bad and missing decisions safely become nil');

const recorded = voting.record({ considered: ['comment:22'] }, decisions);
assert.deepEqual(recorded.considered, ['comment:22', 'post:10', 'comment:20']);
assert.equal(voting.collect(candidates, { self: 'self_bot', state: recorded }).length, 0,
  'considered content is not repeatedly presented');

const many = [{ id: 'C1', voteItems: Array.from({ length: 20 }, (_, i) => ({
  targetType: 'post', targetId: i + 1, author: 'other', label: 'post ' + i, content: 'visible content ' + i,
})) }];
assert.equal(voting.collect(many).length, voting.MAX_VOTE_CANDIDATES, 'the vote slate is hard bounded');
assert.equal(voting.collect(many, { remaining: 2 }).length, 2, 'authoritative allowance further bounds the slate');

console.log('voting: all checks passed');
