'use strict';

const assert = require('node:assert/strict');
const observability = require('../lib/rehearsal-observability');

let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }

function profile(id, band, expected, events) {
  return {
    id,
    fedditUsername: id,
    simulationState: {
      populationActivity: { band, currentDailyOpportunities: expected },
      telemetry: { version: 1, events, lastConflictCount: 0 },
    },
  };
}

function event(id, profileId, index, patch = {}) {
  return {
    id,
    runId: 'run-1',
    at: 1_000 + index,
    virtualAt: 1_000 + index * 65_000,
    profileId,
    botName: profileId,
    outcome: 'action',
    action: 'comment',
    consideredTypes: { ordinary_post: 2, direct_reply: 1 },
    selectedType: index % 2 ? 'ordinary_post' : 'direct_reply',
    targetAccount: 'peer-' + ((index + 1) % 4),
    threadKey: 't3_' + index,
    chainLength: index % 2,
    topics: ['topic-' + (index % 3)],
    memoryInfluenced: index % 3 === 0,
    preoccupations: index % 4 === 0 ? ['topic-' + (index % 3)] : [],
    memoryConflictCount: 0,
    conflictDelta: 0,
    reason: 'A bounded public candidate fit the bot.',
    ...patch,
  };
}

function run() {
  let state = observability.defaults();
  for (let i = 0; i < 300; i++) state = observability.record(state, event('bounded-' + i, 'a', i));
  eq(state.events.length, observability.MAX_EVENTS, 'telemetry retains only the bounded event limit');
  eq(state.events[0].id, 'bounded-60', 'the bounded store discards the oldest event first');

  const healthyProfiles = [
    profile('a', 'regular', 2, [event('a1', 'a', 0), event('a2', 'a', 3), event('a3', 'a', 6), event('a4', 'a', 9, { outcome: 'wait', action: 'wait' })]),
    profile('b', 'regular', 2, [event('b1', 'b', 1), event('b2', 'b', 4), event('b3', 'b', 7), event('b4', 'b', 10, { outcome: 'wait', action: 'wait' })]),
    profile('c', 'occasional', 1, [event('c1', 'c', 2), event('c2', 'c', 5), event('c3', 'c', 8), event('c4', 'c', 11, { outcome: 'wait', action: 'wait' })]),
  ];
  const healthy = observability.summarize(healthyProfiles, { runId: 'run-1' });
  eq(healthy.opportunities, 12, 'summary counts opportunities across the whole cohort');
  eq(healthy.actions, 9, 'summary separates visible actions from WAIT outcomes');
  eq(healthy.waits, 3, 'summary reports WAIT outcomes');
  eq(healthy.accounts.length, 3, 'summary includes each cohort account');
  ok(healthy.candidateTypes.considered.some((item) => item.name === 'ordinary_post'), 'candidate types considered are visible');
  ok(healthy.topics.length >= 3, 'topic distribution is visible');
  ok(healthy.memory.influencedChoices > 0, 'memory influence is counted without storing model reasoning');
  eq(healthy.warnings.length, 0, 'a varied fixture does not produce false-positive warnings');

  const badEvents = Array.from({ length: 10 }, (_, i) => event('bad-' + i, 'dominant', i, {
    virtualAt: 60_000 + i,
    selectedType: 'ordinary_post',
    targetAccount: 'same-peer',
    threadKey: 't3_same',
    chainLength: 3,
    topics: ['only-topic'],
    memoryConflictCount: i + 1,
    conflictDelta: 1,
  }));
  const bad = observability.summarize([
    profile('dominant', 'active', 5, badEvents),
    profile('quiet-a', 'regular', 2, []),
    profile('quiet-b', 'occasional', 1, []),
    profile('quiet-c', 'rare', 0.5, []),
  ], { runId: 'run-1' });
  const warningCodes = new Set(bad.warnings.map((item) => item.code));
  for (const code of ['account-domination', 'repeated-pair', 'reply-loop', 'poor-participant-diversity',
    'poor-topic-diversity', 'candidate-type-domination', 'synchronized-activity', 'memory-conflicts']) {
    ok(warningCodes.has(code), 'pathological fixture triggers ' + code);
  }
  eq(bad.repeatedPairs[0].count, 10, 'repeated conversation pairs are counted');
  eq(bad.chains.longest, 3, 'reply-chain depth is visible');
  eq(bad.memory.contradictionDetections, 10, 'bounded memory conflict deltas are counted');
  ok(bad.notableEvents.length <= 40, 'operator event evidence is bounded');

  const waiting = observability.summarize([
    profile('waiting', 'regular', 2, Array.from({ length: 8 }, (_, i) => event('wait-' + i, 'waiting', i, {
      outcome: 'wait', action: 'wait', selectedType: '', targetAccount: '', topics: [],
    }))),
  ], { runId: 'run-1' });
  ok(waiting.warnings.some((item) => item.code === 'excessive-wait'), 'a mostly-WAIT fixture triggers the WAIT warning');

  const normalized = observability.record(observability.defaults(), {
    id: 'private-shape', runId: 'run-1', at: 1, virtualAt: 1, profileId: 'a',
    outcome: 'action', prompt: 'must not persist', reasoning: 'must not persist', reason: 'short public reason',
  });
  ok(!('prompt' in normalized.events[0]) && !('reasoning' in normalized.events[0]), 'unknown prompt and reasoning fields are never persisted');

  console.log('rehearsal observability: ' + checks + ' checks passed');
}

run();
