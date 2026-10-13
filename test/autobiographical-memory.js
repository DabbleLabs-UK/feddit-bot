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

const previousAnswer = '"The silver teapot hums beneath the photographic moon; this was my distinctive previous answer." '.repeat(6).trim();
const incomingAnswer = '"An earlier public answer described a darkroom conversation in elaborate prose."';
const privateMarker = 'PRIVATE-METADATA-MUST-NOT-REACH-WRITING';
const writingState = {
  ...memory.defaults(),
  prompt: privateMarker,
  credentials: { token: privateMarker },
  episodes: [
    {
      id: 'unselected-event', at: start - 2 * hour, kind: 'reply', direction: 'outgoing',
      account: 'carol', community: 'botlife', importance: 1, topics: ['darkroom'],
      summary: 'A less relevant public answer.',
    },
    {
      id: 'incoming-event', at: start - hour, kind: 'reply', direction: 'incoming',
      account: 'bob', community: 'photography', importance: 1, topics: ['darkroom', 'printing'],
      summary: incomingAnswer, prompt: privateMarker,
    },
    {
      id: 'outgoing-event', at: start, kind: 'reply', direction: 'outgoing',
      account: '@Alice', threadKey: 't3_1', community: 'photography', importance: 2,
      topics: ['darkroom', 'printing'], summary: previousAnswer,
      credentials: { token: privateMarker }, extra: privateMarker,
    },
  ],
  claims: [
    {
      key: 'unselected-claim', slot: 'interest', value: 'photography', topics: ['darkroom'],
      evidenceCount: 1, confidence: 0.15, firstAt: start, lastAt: start,
    },
    {
      key: 'residence-claim', slot: 'residence', value: 'London', topics: ['london'],
      polarity: 'positive', evidenceCount: 1, confidence: 0.35, firstAt: start, lastAt: start,
      evidenceIds: ['residence-evidence'], credentials: privateMarker,
    },
    {
      key: 'preference-claim', slot: 'preference', value: 'darkroom printing', topics: ['darkroom', 'printing'],
      polarity: 'negative', evidenceCount: 2, confidence: 0.71, firstAt: start - hour, lastAt: start,
      evidenceIds: ['preference-evidence-1', 'preference-evidence-2'], prompt: privateMarker,
    },
  ],
  preoccupations: {
    london: { weight: 1, lastAt: start, evidenceCount: 2 },
    printing: { weight: 1.5, lastAt: start, evidenceCount: 3 },
    darkroom: { weight: 2, lastAt: start, evidenceCount: 4, credentials: privateMarker },
  },
};
const writingStateBefore = structuredClone(writingState);
const writingCandidate = { target: { author: 'alice', postId: 1, context: 'darkroom printing London' } };
const defaultDescription = memory.describe(writingState, writingCandidate, { nowMs: start });
assert.deepEqual(defaultDescription, {
  relevant: true,
  salienceDelta: 2,
  topics: ['darkroom', 'printing', 'london'],
  episodeIds: ['outgoing-event', 'incoming-event'],
  claimKeys: ['preference-claim', 'residence-claim'],
  preoccupations: ['darkroom', 'printing'],
  summary: 'Remembered 2 relevant past events. Retrieved established public self-claim "preference = darkroom printing"; tentative public self-claim "residence = London". Current preoccupation with darkroom, printing increased salience.',
  prompt: 'Past event: ' + previousAnswer + ' Past event: ' + incomingAnswer +
    ' Autobiographical established claim: preference = darkroom printing (confidence 71%; public self-claim, not owner-authored canon).' +
    ' Autobiographical tentative claim: residence = London (confidence 35%; public self-claim, not owner-authored canon).' +
    ' Current preoccupation: darkroom, printing.',
}, 'the default description retains the exact legacy shape, ranking, salience and prose');
for (const includeWritingContext of [false, undefined, 1, 'true']) {
  assert.deepEqual(memory.describe(writingState, writingCandidate, { nowMs: start, includeWritingContext }), defaultDescription,
    'writing context requires an explicit boolean opt-in');
}
const { writingContext, ...descriptionWithWriting } = memory.describe(writingState, writingCandidate, {
  nowMs: start, includeWritingContext: true,
});
assert.deepEqual(descriptionWithWriting, defaultDescription, 'opt-in leaves every existing description field unchanged');
assert.deepEqual(writingContext, {
  version: 1,
  claims: [
    { slot: 'preference', value: 'darkroom printing', polarity: 'negative', status: 'established' },
    { slot: 'residence', value: 'London', polarity: 'positive', status: 'tentative' },
  ],
  episodes: [
    { kind: 'reply', direction: 'outgoing', account: 'alice', community: 'photography', topics: ['darkroom', 'printing'] },
    { kind: 'reply', direction: 'incoming', account: 'bob', community: 'photography', topics: ['darkroom', 'printing'] },
  ],
  preoccupations: ['darkroom', 'printing'],
}, 'writing context projects only the same selected claims, event metadata and preoccupations');
const serializedWriting = JSON.stringify(writingContext);
assert.ok(defaultDescription.prompt.includes(previousAnswer), 'the quoted prior answer remains in the legacy prompt');
for (const forbidden of ['silver teapot', 'earlier public answer', privateMarker, 'outgoing-event', 'preference-evidence', 'confidence', 'summary', 'prompt', 'lastAt']) {
  assert.equal(serializedWriting.includes(forbidden), false, 'writing context excludes ' + forbidden);
}
assert.deepEqual(memory.describe(writingState, { context: 'football tournaments' }, {
  nowMs: start, includeWritingContext: true,
}).writingContext, { version: 1, claims: [], episodes: [], preoccupations: [] },
'an irrelevant candidate does not fabricate writing cues');
assert.deepEqual(writingState, writingStateBefore, 'describing memory does not mutate stored state');
writingContext.episodes[0].topics.push('mutated-output');
writingContext.claims[0].value = 'mutated-output';
assert.deepEqual(writingState, writingStateBefore, 'the transient projection has no mutable aliases into stored state');

const familiarWritingState = structuredClone(writingState);
familiarWritingState.episodes[1].account = 'alice';
familiarWritingState.episodes[1].threadKey = 't3_1';
familiarWritingState.episodes[1].topics = ['kettle', 'cucumbers'];
familiarWritingState.episodes[2].topics = ['kettle'];
familiarWritingState.episodes[2].summary = 'My earlier answer compared everything to a copper kettle.';
for (const target of [
  { author: 'alice', postId: 99, context: 'cucumbers' },
  { author: 'dave', postId: 1, context: 'cucumbers' },
  { author: 'alice', postId: 1, context: 'cucumbers' },
]) {
  const familiarDefault = memory.describe(familiarWritingState, { target }, { nowMs: start });
  const { writingContext: familiarContext, ...familiarDescription } = memory.describe(familiarWritingState, { target }, {
    nowMs: start, includeWritingContext: true,
  });
  assert.deepEqual(familiarDescription, familiarDefault, 'filtering writing topics does not change legacy retrieval');
  assert.deepEqual(familiarDescription.episodeIds, ['incoming-event', 'outgoing-event'],
    'same-account or same-thread history still ranks even without topic overlap');
  assert.match(familiarDescription.prompt, /copper kettle/, 'the legacy prompt retains the unrelated earlier prose');
  assert.deepEqual(familiarContext.episodes.map((episode) => episode.topics), [['cucumbers'], []],
    'writing episode topics retain only matches to this candidate, including empty matches');
  assert.equal(JSON.stringify(familiarContext).includes('kettle'), false, 'unmatched motifs cannot leak through episode metadata');
}

const boundedWritingState = structuredClone(writingState);
boundedWritingState.episodes[2].kind = 'r'.repeat(100);
boundedWritingState.episodes[2].account = '@' + 'a'.repeat(150);
boundedWritingState.episodes[2].community = 'c'.repeat(120);
boundedWritingState.episodes[2].topics = ['darkroom', 'printing', 'T'.repeat(200), 'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
boundedWritingState.claims[2].slot = 'S'.repeat(180);
boundedWritingState.claims[2].value = 'V'.repeat(300);
const boundedWritingCandidate = {
  target: { ...writingCandidate.target, context: 'darkroom printing ' + 'T'.repeat(200) + ' alpha bravo charlie delta echo foxtrot' },
};
const boundedWriting = memory.describe(boundedWritingState, boundedWritingCandidate, {
  nowMs: start, includeWritingContext: true,
}).writingContext;
assert.equal(boundedWriting.claims[0].slot, 's'.repeat(160), 'claim slots retain their existing normalized bound');
assert.equal(boundedWriting.claims[0].value, 'V'.repeat(240), 'canonical claim values retain their existing normalized bound');
assert.equal(boundedWriting.episodes[0].kind.length, 80);
assert.ok(boundedWriting.episodes[0].account.length <= 128);
assert.equal(boundedWriting.episodes[0].community.length, 100);
assert.equal(boundedWriting.episodes[0].topics.length, 8);
assert.equal(boundedWriting.episodes[0].topics[2], 't'.repeat(160), 'episode topics retain their existing normalized bound');
boundedWritingState.preoccupations['T'.repeat(200)] = { weight: 2, lastAt: start };
assert.deepEqual(memory.describe(boundedWritingState, { context: 'T'.repeat(200) }, {
  nowMs: start, includeWritingContext: true,
}).writingContext.preoccupations, ['t'.repeat(160)], 'preoccupation topics retain their existing normalized bound');

console.log('autobiographical-memory: all checks passed');
