'use strict';

const assert = require('node:assert/strict');
const social = require('../lib/social-relationships');
const candidates = require('../lib/action-candidates');

let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }

const base = 1_800_000_000_000;
const target = {
  author: 'Alice',
  postId: 42,
  candidateType: 'ordinary_comment',
  createdUtc: Math.floor((base + 5_000) / 1000),
  context: 'POST TITLE: Community gardens\nAlice: The tomatoes and compost are thriving.',
};

let aliceView = social.describe(social.defaults(), target, base + 6_000);
eq(aliceView.known, false, 'an unfamiliar account starts without invented familiarity or affinity');
eq(aliceView.salienceDelta, 0, 'an unfamiliar account receives no social salience bonus');

let stateA = social.defaults();
let stateB = social.defaults();
function add(state, id, direction, at, text) {
  return social.recordEvent(state, {
    id,
    account: 'Alice',
    direction,
    kind: direction === 'incoming' ? 'direct-reply' : 'reply',
    threadKey: 't3_42',
    at,
    text,
  }, at).state;
}

stateA = add(stateA, 'in-1', 'incoming', base, 'The community garden tomatoes need compost.');
stateA = add(stateA, 'out-1', 'outgoing', base + 60_000, 'I have also been thinking about garden compost.');
stateA = add(stateA, 'in-2', 'incoming', base + 120_000, 'Alice asks another question about tomatoes and compost.');
stateA = add(stateA, 'out-2', 'outgoing', base + 180_000, 'The tomatoes sound worth discussing again.');

aliceView = social.describe(stateA, target, base + 240_000);
ok(aliceView.known && aliceView.interactionCount === 4,
  'repeated meaningful interactions build bounded familiarity evidence');
eq(aliceView.momentum, 'active', 'a recent two-way exchange has active conversational momentum');
ok(aliceView.sharedTopics.includes('tomatoes') || aliceView.sharedTopics.includes('compost'),
  'recurring topics are grounded in words repeated across actual exchanges');
ok(aliceView.salienceDelta > 0, 'repeated interactions can increase future candidate salience');
eq(social.describe(stateB, target, base + 240_000).known, false,
  'relationship state is asymmetric because another bot retains its own empty view');

const duplicate = social.recordEvent(stateA, {
  id: 'out-2', account: 'Alice', direction: 'outgoing', threadKey: 't3_42', at: base + 180_000,
}, base + 240_000);
eq(duplicate.counted, false, 'a repeated durable event identifier is not counted twice');
eq(duplicate.relationship.interactionCount, 4, 'duplicate recovery leaves interaction totals unchanged');

const cooled = social.describe(stateA, target, base + 4 * 24 * 60 * 60 * 1000);
eq(cooled.momentum, 'none', 'conversational momentum decays rather than remaining permanently active');

stateA = add(stateA, 'in-3', 'incoming', base + 240_000, 'More tomatoes and compost.');
stateA = add(stateA, 'out-3', 'outgoing', base + 300_000, 'Another garden reply.');
const satiated = social.describe(stateA, target, base + 360_000);
eq(satiated.satiation, 'high', 'many recent turns produce a strong bounded satiation signal');
ok(satiated.summary.includes('strong reason to stop or choose something else'),
  'satiation explicitly lets a repeated exchange fade without a fixed required turn count');

const socialMenu = candidates.bound({
  attention: [{
    key: 'active', action: 'comment', candidateType: 'ordinary_comment', context: target.context,
    social: aliceView,
  }],
  ordinary: [{
    key: 'unrelated', action: 'comment', candidateType: 'ordinary_post', context: 'A new and unrelated astronomy topic.',
    social: social.describe(stateA, { author: 'Bob', postId: 88, context: 'astronomy' }, base + 360_000),
  }],
});
const activePrompt = candidates.prompt(socialMenu, base + 360_000);
ok(activePrompt.includes('BOUNDED SOCIAL CONTEXT') && activePrompt.includes('not proof of friendship'),
  'the model sees concise grounded social context with an explicit non-friendship guard');
ok(activePrompt.includes('WAIT remains valid'),
  'WAIT remains explicitly possible during an active conversation');
const otherWins = candidates.parseDecision('{"choice":"C2","reason":"The new astronomy topic is more interesting."}', socialMenu);
eq(otherWins.candidate.id, 'C2', 'another candidate can beat an ongoing conversation');
const waits = candidates.publicDecision(
  candidates.parseDecision('{"choice":"WAIT","reason":"The exchange feels repetitive."}', socialMenu),
  socialMenu,
);
eq(waits.outcome, 'wait', 'active social context never removes WAIT');

let bounded = social.defaults();
for (let i = 0; i < 125; i++) {
  bounded = social.recordEvent(bounded, {
    id: 'event-' + i,
    account: 'account-' + i,
    direction: 'incoming',
    threadKey: 't3_' + i,
    at: base + i,
    text: 'A unique public interaction.',
  }, base + 125).state;
}
eq(Object.keys(bounded.relationships).length, social.LIMITS.relationships,
  'the per-bot relationship map has a hard size bound');
ok(bounded.seenEventIds.length <= social.LIMITS.seenEventIds,
  'the exactly-once event ledger is also bounded');

console.log('social relationships: ' + checks + ' checks passed');
