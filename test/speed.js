'use strict';

const assert = require('node:assert/strict');
const speed = require('../lib/speed');
const { createScheduler } = require('../lib/scheduler');

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

for (const multiplier of speed.MULTIPLIERS.slice(1)) {
  const state = speed.startState(multiplier, '30m', start);
  eq(speed.inspect(state, start).effectiveMultiplier, multiplier, multiplier + 'x is an active scheduler multiplier');
  eq(speed.scaleDelay(60_000, multiplier), 60_000 / multiplier, multiplier + 'x scales scheduler time');
}

eq(speed.startState(5, '3h', start).expiresAt, '2026-10-02T13:00:00.000Z', 'three-hour expiry is absolute and restart-safe');
eq(speed.startState(5, 'untilOff', start).expiresAt, null, 'until-off has no expiry');
eq(speed.inspect(speed.startState(5, '30m', start), start + 30 * 60 * 1000).effectiveMultiplier, 1,
  'timed Speed cleanly becomes 1x at expiry');
eq(speed.rescaleFutureDeadline(start + 60_000, start, 1, 5), start + 12_000,
  'starting 5x shortens the remaining scheduler delay');
eq(speed.rescaleFutureDeadline(start + 12_000, start, 5, 1), start + 60_000,
  'stopping 5x restores the equivalent normal-cadence delay');
eq(speed.rescaleFutureDeadline(start - 1, start, 5, 1), null,
  'overdue work is marked for a fresh deadline rather than catch-up');
assert.throws(() => speed.startState(3, '30m', start), /Choose a Speed multiplier/);
checks++;

function makeProfile(id = 'speed-bot') {
  return {
    id,
    fedditUsername: id,
    token: 'secret',
    provider: 'ollama',
    enabled: true,
    dryRun: false,
    botOrigin: 'user',
    canReply: false,
    canStartDiscussions: true,
    canShareLinks: false,
    postsPerHour: 1,
    articlePostsPerHour: 0,
    commentsPerHour: 0,
    probation: { onProbation: false, checkedAt: start },
    sched: defaults(),
    simulationState: { sched: defaults() },
  };
}

function defaults() {
  return {
    nextPostAt: null,
    nextArticleAt: null,
    nextCommentAt: null,
    backoffUntil: 0,
    sentPosts: [],
    sentComments: [],
  };
}

function harness(initialSpeed, profiles = [makeProfile()]) {
  let nowMs = start;
  const settings = { paused: false, dryRun: true, monthlyCapUsd: 5, pricing: {}, speed: initialSpeed };
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const store = {
    DEFAULT_MODEL: 'test-model',
    schedDefaults: defaults,
    getSettings: () => settings,
    updateSettings(patch) { Object.assign(settings, patch); return settings; },
    listProfiles: () => [...byId.values()],
    getProfile: (id) => byId.get(id) || null,
    updateSched(id, patch, options = {}) {
      const profile = byId.get(id);
      const target = options.simulation ? profile.simulationState.sched : profile.sched;
      Object.assign(target, patch);
      return target;
    },
    runnerSpend: () => ({ monthUsd: 0, todayUsd: 0 }),
    referenceName: (profile) => profile.fedditUsername,
  };
  const scheduler = createScheduler({
    store,
    providers: { ollamaBusy: () => false },
    feddit: {},
    now: () => nowMs,
    random: () => 0.5,
  });
  return {
    settings,
    profiles,
    scheduler,
    advance(milliseconds) { nowMs += milliseconds; },
    now: () => nowMs,
  };
}

(async () => {
  for (const multiplier of speed.MULTIPLIERS.slice(1)) {
    const h = harness(speed.startState(multiplier, 'untilOff', start));
    await h.scheduler.runTick();
    eq(h.profiles[0].sched.nextPostAt - start, 30 * 60 * 1000 / multiplier,
      multiplier + 'x is applied to a real scheduler deadline');
    eq(h.profiles[0].postsPerHour, 1, multiplier + 'x never mutates stored bot cadence');
  }

  const changed = harness(speed.inactiveState());
  changed.profiles[0].sched.nextPostAt = start + 60 * 60 * 1000;
  changed.profiles[0].simulationState.sched.nextPostAt = start + 30 * 60 * 1000;
  const five = speed.startState(5, 'untilOff', start);
  changed.settings.speed = five;
  changed.scheduler.applySpeedChange(speed.inactiveState(), five);
  eq(changed.profiles[0].sched.nextPostAt, start + 12 * 60 * 1000, 'live deadline rescales when Speed starts');
  eq(changed.profiles[0].simulationState.sched.nextPostAt, start + 6 * 60 * 1000,
    'rehearsal deadline follows the same workspace Speed');
  changed.settings.speed = speed.inactiveState();
  changed.scheduler.applySpeedChange(five, speed.inactiveState());
  eq(changed.profiles[0].sched.nextPostAt, start + 60 * 60 * 1000, 'stopping returns the live deadline to normal cadence');
  eq(changed.profiles[0].postsPerHour, 1, 'start and stop leave the cadence source of truth unchanged');

  const expiredState = speed.startState(10, '30m', start);
  const expired = harness(expiredState);
  expired.profiles[0].sched.nextPostAt = start + 5 * 60 * 1000;
  expired.advance(31 * 60 * 1000);
  const expiryResult = await expired.scheduler.runTick();
  eq(expired.settings.speed.multiplier, 1, 'expired Speed is durably cleared');
  ok(expired.profiles[0].sched.nextPostAt > expired.now(), 'expired overdue work receives a fresh normal deadline');
  eq(expiryResult.acted, 0, 'expiry does not repay an overdue accelerated opportunity');

  const persistent = speed.startState(25, 'untilOff', start);
  const restarted = harness(persistent);
  restarted.profiles[0].sched.nextPostAt = start - 1;
  const restartResult = await restarted.scheduler.runTick();
  eq(restarted.settings.speed.multiplier, 25, 'until-off Speed survives scheduler restart');
  ok(restarted.profiles[0].sched.nextPostAt > restarted.now(), 'restart rebases an overdue Speed deadline');
  eq(restartResult.acted, 0, 'restart does not create catch-up work');

  const pausedProfile = makeProfile('paused-bot');
  pausedProfile.enabled = false;
  const paused = harness(speed.startState(100, 'untilOff', start), [pausedProfile]);
  await paused.scheduler.runTick();
  eq(pausedProfile.sched.nextPostAt, null, '100x does not schedule a disabled bot');

  console.log('speed: ' + checks + ' checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
