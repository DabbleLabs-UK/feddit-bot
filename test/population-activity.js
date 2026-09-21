'use strict';

const assert = require('node:assert/strict');
const activity = require('../lib/population-activity');

let checks = 0;
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function seeded(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const now = Date.parse('2026-09-20T00:00:00.000Z');
const seeds = Array.from({ length: 100 }, (_, index) => ({
  username: 'system_' + index,
  sociability: 'selective',
  initiative: 'balanced',
  persistence: 'steady',
}));
const assigned = activity.assignCohort(seeds, { nowMs: now, offset: 0, random: seeded(3) });
const bands = activity.cohortSummary(assigned, { nowMs: now }).bands;

eq(new Set(assigned.map((state) => state.currentDailyOpportunities)).size, 4,
  'a representative cohort receives heterogeneous activity tendencies');
eq(bands, { rare: 52, occasional: 28, regular: 15, active: 5 },
  'the initial distribution is meaningfully heavy-tailed');
ok(bands.rare > bands.occasional && bands.occasional > bands.regular && bands.regular > bands.active,
  'successively more active bands contain fewer bots');

const small = activity.assignCohort(seeds.slice(0, 2), { nowMs: now, offset: 0.2, random: seeded(5) });
eq(small.length, 2, 'small cohorts are assigned without forcing every activity band');
ok(new Set(small.map((state) => state.band)).size >= 1,
  'small cohort assignment remains valid even when not every band appears');

function simulateOpportunities(initial, days, seed) {
  const random = seeded(seed);
  let state = initial;
  let at = now;
  let count = 0;
  const end = now + days * activity.DAY_MS;
  while (at < end) {
    at += activity.nextDelayMs(state, { nowMs: at, random });
    if (at >= end) break;
    state = activity.recordOpportunity(state, { nowMs: at, random });
    count++;
  }
  return { count, state, at };
}

const quiet = activity.initialState({}, { nowMs: now, quantile: 0.2, random: seeded(7) });
const active = activity.initialState({}, { nowMs: now, quantile: 0.98, random: seeded(7) });
const quietRun = simulateOpportunities(quiet, 60, 11);
const activeRun = simulateOpportunities(active, 60, 11);
ok(quietRun.count < activeRun.count / 3,
  'quiet bots receive materially fewer opportunities than active bots over representative time');
ok(activeRun.count <= 60 * activity.MAX_OPPORTUNITIES_PER_DAY,
  'the rolling opportunity ceiling prevents one bot from monopolising synthetic activity');

const saturated = {
  ...active,
  recentOpportunities: Array.from({ length: activity.MAX_OPPORTUNITIES_PER_DAY }, (_, index) =>
    now - (activity.MAX_OPPORTUNITIES_PER_DAY - index) * 60 * 60 * 1000),
};
ok(activity.nextDelayMs(saturated, { nowMs: now, random: () => 0 }) >= 18 * 60 * 60 * 1000,
  'a saturated active bot is held until its rolling daily window has room');

const normalWait = activity.nextDelayMs(quiet, { nowMs: now, random: () => 0.000001 });
ok(normalWait >= 45 * 60 * 1000,
  'an opportunity followed by WAIT cannot create an immediate replacement opportunity');

const rehearsalWait = activity.nextDelayMs(quiet, {
  nowMs: now,
  random: () => 0.5,
  rehearsal: true,
});
const liveWait = activity.nextDelayMs(quiet, { nowMs: now, random: () => 0.5 });
ok(rehearsalWait < liveWait,
  'rehearsal compresses time while preserving the same relative ecology');

const fullCadence = activity.nextDelayMs(active, { nowMs: now, random: () => 0.5 });
const postCadence = activity.nextDelayMs(active, {
  nowMs: now,
  random: () => 0.5,
  opportunityShare: 1 / 3,
});
const commentCadence = activity.nextDelayMs(active, {
  nowMs: now,
  random: () => 0.5,
  opportunityShare: 2 / 3,
});
ok(Math.abs((1 / postCadence) + (1 / commentCadence) - (1 / fullCadence)) < 1e-12,
  'post and comment clocks combine to one configured ecology rate');
ok(postCadence > commentCadence && commentCadence > fullCadence,
  'the one-third post and two-thirds comment shares preserve their intended ordering');

let driftingQuiet = quiet;
let driftingActive = active;
const driftRandom = seeded(19);
for (let day = 1; day <= 90; day++) {
  const at = now + day * activity.DAY_MS;
  driftingQuiet = activity.advanceState(driftingQuiet, { nowMs: at, random: driftRandom });
  driftingActive = activity.advanceState(driftingActive, { nowMs: at, random: driftRandom });
}
ok(driftingQuiet.currentDailyOpportunities >= activity.MIN_DAILY &&
  driftingActive.currentDailyOpportunities <= activity.MAX_DAILY,
  'slow drift remains inside absolute bounds');
ok(driftingActive.currentDailyOpportunities > driftingQuiet.currentDailyOpportunities * 2,
  'drift remains anchored to individual baselines instead of converging the population');
ok(Math.abs(driftingQuiet.currentDailyOpportunities - quiet.currentDailyOpportunities) < 0.7,
  'a quiet bot drifts gradually rather than being re-rolled into a new class');

const social = {
  relationships: {
    other: {
      recentEvents: [
        { threadKey: 't3_1', direction: 'incoming', at: now - 60 * 60 * 1000 },
        { threadKey: 't3_1', direction: 'outgoing', at: now - 30 * 60 * 1000 },
      ],
    },
  },
};
eq(activity.recentThreadMomentum(social, now), 1.25,
  'a genuine active exchange provides only a modest temporary timing effect');
eq(activity.recentThreadMomentum({ relationships: {} }, now), 1,
  'no conversation momentum leaves opportunity timing unchanged');

const liveBefore = structuredClone(quiet);
let rehearsal = activity.rehearsalFromLive(quiet, { nowMs: now, random: seeded(23) });
rehearsal = activity.recordOpportunity(rehearsal, { nowMs: now + activity.DAY_MS, random: seeded(29) });
eq(quiet, liveBefore, 'rehearsal activity updates do not mutate live activity state');
eq(rehearsal.recentOpportunities.length, 1, 'rehearsal keeps its own opportunity history');
eq(activity.rehearsalFromLive(quiet, { nowMs: now + 2 * activity.DAY_MS, random: seeded(31) }).recentOpportunities.length,
  0, 'rehearsal reset starts fresh without changing live history');

console.log('population activity ecology: ' + checks + ' checks passed');
