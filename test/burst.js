'use strict';

const assert = require('node:assert/strict');
const burst = require('../lib/burst');
// Historical durable-plan compatibility. Current version-2 vote correctness
// and boundedness are exercised in decision-contract.js and durable-scheduler.
const legacyPlan = (text, candidates, votes) => burst.parsePlan(text, candidates, votes,
  { decisionContractVersion: 1 });

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

const start = Date.parse('2026-10-02T10:00:00.000Z');

eq(burst.startState('chatgpt-plan', '30m', start).expiresAt, '2026-10-02T10:30:00.000Z',
  '30-minute Burst stores an absolute expiry');
eq(burst.startState('claude-plan', '3h', start).expiresAt, '2026-10-02T13:00:00.000Z',
  'three-hour Burst stores an absolute expiry');
eq(burst.startState('chatgpt-plan', 'untilOff', start).expiresAt, null,
  'until-stopped Burst survives restart without an expiry');
assert.throws(() => burst.startState('deepseek', '30m', start), /connected ChatGPT plan or Claude subscription/);
checks++;

const candidates = [
  { id: 'C1', action: 'comment', candidateType: 'reply_to_own_post' },
  { id: 'C2', action: 'comment', candidateType: 'ordinary_post' },
  { id: 'C3', action: 'post', candidateType: 'new_discussion' },
  { id: 'C4', action: 'post', candidateType: 'new_discussion' },
];
const parsed = burst.parsePlan(JSON.stringify({
  reason: 'Several small actions fit this moment.',
  actions: [
    { candidate: 'C1', text: 'First reply.', reason: 'Direct reply.' },
    { candidate: 'C2', text: 'Second reply.', reason: 'Relevant thread.' },
    { candidate: 'C3', title: 'A new topic', body: 'Opening thought.', reason: 'Worth discussing.' },
    { candidate: 'C4', title: 'Too many', body: 'Must be omitted.', reason: 'Over cap.' },
  ],
}), candidates, []);
eq(parsed.actions.map((action) => action.candidateId), ['C1', 'C2', 'C3'],
  'one inference can return an ordered bundle capped at three actions');

const voteCandidates = Array.from({ length: 8 }, (_, index) => ({
  id: 'V' + (index + 1),
  targetType: index % 2 ? 'comment' : 'post',
  targetId: index + 1,
  label: 'Vote candidate ' + (index + 1),
  content: 'Visible vote candidate ' + (index + 1),
}));
let votePlan = legacyPlan(JSON.stringify({
  actions: [{ candidate: 'C1', text: 'One reply.' }],
  votes: Array.from({ length: 20 }, (_, index) => ({
    id: 'V1', direction: 'up', reason: 'First reason remains aligned ' + index + '.',
  })),
}), candidates, voteCandidates);
eq(votePlan.votes.length, 1, 'twenty copies of one offered vote ID produce one processed vote');
eq(votePlan.votes[0].reason, 'First reason remains aligned 0.',
  'the first duplicate vote decision and reason are retained');

votePlan = legacyPlan(JSON.stringify({
  actions: [{ candidate: 'C1', text: 'One reply.' }],
  votes: [
    { id: 'V2', direction: 'down', reason: 'First V2 reason is retained.' },
    { id: 'V1', direction: 'up', reason: 'The V1 reason stays aligned.' },
    { id: 'V2', direction: 'up', reason: 'Later V2 reason is ignored.' },
    { id: 'V3', direction: 'down', reason: 'The V3 reason stays aligned.' },
    { id: 'V1', direction: 'down', reason: 'Later V1 reason is ignored.' },
  ],
}), candidates, voteCandidates);
eq(votePlan.votes.map((vote) => vote.id), ['V2', 'V1', 'V3'],
  'mixed duplicates preserve only the first occurrence of each offered ID in order');
eq(votePlan.votes.map((vote) => vote.reason), [
  'First V2 reason is retained.',
  'The V1 reason stays aligned.',
  'The V3 reason stays aligned.',
], 'retained vote reasons stay aligned with their first decisions');

votePlan = legacyPlan(JSON.stringify({
  actions: [{ candidate: 'C1', text: 'One reply.' }],
  votes: [
    { id: 'V999', direction: 'up', reason: 'Unknown candidates cannot be voted on.' },
    { id: 'V1', direction: 'down', reason: 'Known candidates remain available.' },
  ],
}), candidates, voteCandidates);
eq(votePlan.votes.map((vote) => vote.id), ['V1'], 'unknown vote IDs are ignored safely');

const normalVotes = voteCandidates.slice(0, 3).map((vote, index) => ({
  id: vote.id,
  direction: index === 1 ? 'down' : 'up',
  reason: 'Normal unique reason ' + (index + 1) + ' remains unchanged.',
}));
votePlan = legacyPlan(JSON.stringify({
  actions: [{ candidate: 'C1', text: 'One reply.' }],
  votes: normalVotes,
}), candidates, voteCandidates);
eq(votePlan.votes.map((vote) => ({ id: vote.id, direction: vote.direction, reason: vote.reason })), normalVotes,
  'a normal unique vote list remains unchanged');

votePlan = legacyPlan(JSON.stringify({
  actions: [{ candidate: 'C1', text: 'One reply.' }],
  votes: [
    ...voteCandidates.map((vote) => ({
      id: vote.id, direction: 'up', reason: 'A valid bounded vote reason for ' + vote.id + '.',
    })),
    ...voteCandidates.map((vote) => ({
      id: vote.id, direction: 'down', reason: 'A duplicate reason that must be ignored for ' + vote.id + '.',
    })),
  ],
}), candidates, voteCandidates);
eq(votePlan.votes.length, voteCandidates.length,
  'the maximum valid unique vote result cannot exceed the offered H14 slate');
eq(burst.parsePlan('{"wait":true,"reason":"Nothing fits.","actions":[]}', candidates, []).wait, true,
  'WAIT remains a valid zero-action session');
eq(burst.parsePlan('not json', candidates, []).actions, [],
  'unreadable provider output safely becomes a zero-action session');

const salient = burst.selectInspection([
  { profileId: 'quiet', candidates: [{ candidateType: 'new_discussion' }] },
  { profileId: 'direct', candidates: [{ candidateType: 'reply_to_own_comment' }] },
], {}, start);
eq(salient.profileId, 'direct', 'direct social attention outranks a generic posting opportunity');
const cooled = burst.selectInspection([
  { profileId: 'direct', candidates: [{ candidateType: 'reply_to_own_comment' }] },
  { profileId: 'other', candidates: [{ candidateType: 'ordinary_post' }] },
], { direct: start - 1_000 }, start);
eq(cooled.profileId, 'other', 'bounded cooldown prevents one salient bot monopolising Burst');
const system = burst.selectInspection([
  { profileId: 'synthetic', candidates: [{ candidateType: 'reply_to_own_comment' }], priorityAdjustment: -100 },
  { profileId: 'user', candidates: [{ candidateType: 'ordinary_post' }] },
], {}, start);
eq(system.profileId, 'user', 'background population yields to user-created bots');
eq(burst.selectInspection([
  { profileId: 'empty', candidates: [], eligible: true },
], {}, start), null, 'a bot without a real candidate is not selected for a pointless inference');

function controllerHarness(options = {}) {
  let nowMs = start;
  let status = options.providerState || 'ready';
  let sequence = 0;
  const settings = { burst: options.initial || burst.inactiveState(), speed: { multiplier: 5 } };
  const turns = new Map();
  const providerCalls = [];
  const store = {
    getSettings: () => settings,
    updateSettings(patch) { Object.assign(settings, patch); return settings; },
  };
  const scheduler = {
    inspectBurstCandidates: async () => options.inspections || [{
      profileId: 'bot-a', botName: 'bot-a', candidates: [{ candidateType: 'ordinary_post' }], eligible: true,
    }],
    startBurstSession(profileId, provider) {
      const id = 'turn-' + (++sequence);
      turns.set(id, { id, profileId, botName: profileId, status: 'generating', result: null });
      return { turnId: id, profileId, provider };
    },
    burstTurn: (id) => turns.get(id) || null,
  };
  const providers = {
    async status(provider) {
      providerCalls.push(provider);
      return { id: provider, state: status, detail: status === 'ready' ? 'Ready.' : 'Unavailable.' };
    },
  };
  const controller = burst.createController({ store, scheduler, providers, now: () => nowMs });
  return {
    controller, settings, turns, providerCalls,
    setProviderState(value) { status = value; },
    advance(value) { nowMs += value; },
    now: () => nowMs,
  };
}

(async () => {
  const h = controllerHarness();
  const active = await h.controller.start('chatgpt-plan', 'untilOff');
  eq(active.provider, 'chatgpt-plan', 'the explicitly selected subscription provider is persisted');
  ok(active.currentTurnId, 'starting Burst immediately accepts one durable bot session');
  ok(h.providerCalls.length >= 1 && h.providerCalls.every((provider) => provider === 'chatgpt-plan'),
    'start checks only the selected provider and has no fallback route');
  eq(h.settings.speed.multiplier, 5, 'Burst leaves independent workspace Speed state untouched');
  await assert.rejects(() => h.controller.start('claude-plan', '30m'),
    (error) => error.code === 'BURST_ALREADY_ACTIVE');
  checks++;

  h.setProviderState('busy');
  const monitored = await h.controller.tick();
  eq(monitored.running, true, 'provider busy during its own accepted session does not stop Burst');
  eq(h.providerCalls.length, 2, 'monitoring an accepted session does not recheck provider capacity');

  const stopped = h.controller.stop();
  eq(stopped.active, false, 'Stop immediately prevents new sessions');
  eq(stopped.stopping, true, 'an accepted durable session remains visible while stopping safely');
  const turn = h.turns.get(stopped.currentTurnId);
  turn.status = 'completed';
  turn.result = { reason: 'Session finished.', actions: [{ action: 'post' }] };
  await h.controller.tick();
  const drained = h.controller.publicState();
  eq(drained.currentTurnId, null, 'the stopped session is observed through its terminal result');
  eq(drained.recentSessions[0].actions, 1, 'recent-session observability records committed actions');

  const unavailable = controllerHarness({ providerState: 'auth-required' });
  await assert.rejects(() => unavailable.controller.start('claude-plan', '30m'),
    (error) => error.code === 'BURST_PROVIDER_UNAVAILABLE');
  checks++;
  eq(unavailable.settings.burst.active, false, 'unavailable subscription never silently starts or falls back');

  const forbiddenProvider = controllerHarness();
  await assert.rejects(() => forbiddenProvider.controller.start('deepseek', '30m'),
    (error) => error.code === 'INVALID_BURST_PROVIDER');
  checks++;
  eq(forbiddenProvider.providerCalls.length, 0,
    'a PAYG provider is rejected before any provider capability or generation path is touched');

  const persistentState = burst.startState('claude-plan', 'untilOff', start);
  persistentState.nextSessionAt = new Date(start + 60_000).toISOString();
  const restarted = controllerHarness({ initial: persistentState });
  restarted.advance(30_000);
  eq((await restarted.controller.tick()).skipped, 'gap', 'restart preserves the remaining gap without catch-up');
  restarted.advance(30_000);
  ok((await restarted.controller.tick()).started, 'until-stopped Burst resumes normally after its stored gap');

  const busyProvider = controllerHarness({
    initial: burst.startState('chatgpt-plan', 'untilOff', start),
    providerState: 'busy',
  });
  eq((await busyProvider.controller.tick()).skipped, 'provider-busy',
    'a healthy but occupied subscription provider defers rather than starting concurrent work');
  eq(busyProvider.controller.publicState().active, true,
    'temporary provider concurrency does not cancel the requested Burst duration');

  const expiring = controllerHarness({ initial: burst.startState('chatgpt-plan', '30m', start) });
  expiring.advance(30 * 60 * 1000 + 1);
  eq((await expiring.controller.tick()).skipped, 'expired', 'absolute expiry starts no catch-up session');
  eq(expiring.controller.publicState().active, false, 'expired Burst returns cleanly to inactive');

  console.log('burst: ' + checks + ' checks passed');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
