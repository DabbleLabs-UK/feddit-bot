'use strict';

const assert = require('node:assert/strict');
const memory = require('../lib/autobiographical-memory');

const hour = 60 * 60 * 1000;
const start = Date.UTC(2026, 8, 20, 12, 0, 0);

function record(state, id, text, options = {}) {
  return memory.recordEvent(state, {
    id,
    kind: options.kind || 'reply',
    direction: options.direction || 'outgoing',
    account: options.account || '',
    threadKey: options.threadKey || '',
    community: options.community || 'botlife',
    importance: options.importance == null ? 1 : options.importance,
    meaningful: options.meaningful,
    summary: options.summary || text,
    text,
  }, {
    nowMs: options.nowMs || start,
    ownerText: options.ownerText || '',
  });
}

let state = memory.defaults();
let result = record(state, 'event-1', 'I had a long conversation with Alice about restoring analogue cameras.', {
  account: 'alice', threadKey: 't3_1', importance: 2,
});
assert.equal(result.counted, true);
assert.equal(result.state.episodes.length, 1, 'a meaningful public event creates an episode');
state = result.state;

result = record(state, 'event-trivial', 'clicked refresh', { importance: 0, meaningful: false });
assert.equal(result.counted, false, 'trivial activity does not become autobiographical memory');
assert.equal(result.state.episodes.length, 1);

const relevant = memory.describe(state, {
  context: 'Alice has another question about an analogue camera repair.',
  target: { author: 'alice', postId: 1, context: 'analogue camera repair' },
}, { nowMs: start + hour });
assert.equal(relevant.relevant, true);
assert.ok(relevant.salienceDelta >= 1, 'a relevant episode can increase candidate salience');
assert.match(relevant.prompt, /Past event:/);

const irrelevant = memory.describe(state, { context: 'A football score from another country.' }, { nowMs: start + hour });
assert.equal(irrelevant.relevant, false, 'irrelevant episodes are not dumped into retrieval context');
assert.equal(irrelevant.prompt, '');

result = record(state, 'claim-owner-conflict', 'I live in Paris and walk by the river.', {
  ownerText: 'I live in London and care about local parks.',
});
assert.equal(result.claims.length, 0, 'a generated claim cannot override owner-authored background');
assert.equal(result.conflicts[0].strongerSource, 'owner');
assert.equal(result.state.conflicts.length, 1, 'the ignored conflict retains bounded provenance');

state = memory.defaults();
result = record(state, 'claim-1', 'I enjoy darkroom printing.', { nowMs: start });
state = result.state;
assert.equal(state.claims[0].status, 'tentative', 'one public self-claim remains tentative');
assert.ok(state.claims[0].confidence < 0.6, 'one self-claim is not immediately canonized');
result = record(state, 'claim-2', 'I enjoy darkroom printing.', { nowMs: start + hour });
state = result.state;
assert.equal(state.claims[0].status, 'established', 'repeated consistent self-claims can become established');
assert.equal(state.claims[0].evidenceCount, 2);

result = record(state, 'claim-distinct-interest', 'I enjoy skydiving.', { nowMs: start + 2 * hour });
assert.equal(result.claims.length, 1, 'distinct interests may coexist in autobiographical memory');
assert.equal(result.state.claims.length, 2);

state = memory.defaults();
state = record(state, 'residence-1', 'I live in London.', { nowMs: start }).state;
state = record(state, 'residence-2', 'I live in London.', { nowMs: start + hour }).state;
result = record(state, 'claim-conflict', 'I live in Paris.', { nowMs: start + 2 * hour });
assert.equal(result.claims.length, 0, 'a contradictory claim does not replace established memory');
assert.equal(result.conflicts[0].strongerSource, 'established-memory');
assert.equal(result.state.claims[0].value.toLowerCase(), 'london');

const duplicate = record(result.state, 'residence-2', 'I live in London.', { nowMs: start + 3 * hour });
assert.equal(duplicate.counted, false, 'stable event ids prevent double-counting on durable replay');
assert.equal(duplicate.state.claims[0].evidenceCount, 2);

state = memory.defaults();
const firstTopic = record(state, 'topic-1', 'We discussed gardening tomatoes and compost.', {
  direction: 'incoming', importance: 2, nowMs: start,
}).state;
const firstWeight = firstTopic.preoccupations.gardening.weight;
const secondTopic = record(firstTopic, 'topic-2', 'I replied about gardening tomatoes and compost.', {
  importance: 2, nowMs: start + hour,
}).state;
assert.ok(secondTopic.preoccupations.gardening.weight > firstWeight, 'repeated topics grow a current preoccupation');
const decayed = memory.normalize(secondTopic, start + 12 * 24 * hour);
assert.equal(decayed.preoccupations.gardening, undefined, 'old preoccupations decay out of the bounded state');

state = memory.defaults();
for (let index = 0; index < memory.LIMITS.episodes + 25; index++) {
  state = record(state, 'bounded-' + index, 'Meaningful public event number ' + index + ' about gardening.', {
    importance: 1, nowMs: start + index,
  }).state;
}
assert.equal(state.episodes.length, memory.LIMITS.episodes, 'episodic memory has a hard bound');
assert.ok(state.seenEventIds.length <= memory.LIMITS.seenEventIds, 'idempotency history has a hard bound');

console.log('autobiographical-memory: all checks passed');
