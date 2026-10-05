'use strict';

const assert = require('node:assert/strict');
const { buildActivityForecast } = require('../lib/activity-forecast');
const scheduler = require('../lib/scheduler');
const activity = require('../lib/population-activity');
const speed = require('../lib/speed');

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-8, message + ': ' + actual + ' vs ' + expected);
  checks++;
}

const now = Date.parse('2026-10-05T10:00:00.000Z');
const hour = 60 * 60 * 1000;
const groups = [{ id: 'readers', name: 'Readers' }, { id: 'writers', name: 'Writers' }];
function profile(id, patch = {}) {
  return {
    id, fedditUsername: id, token: 'test-secret', enabled: true, dryRun: false,
    botOrigin: 'user', groupId: 'readers',
    canStartDiscussions: true, canShareLinks: true, canReply: true, canVote: true,
    postsPerHour: 1, articlePostsPerHour: 2, commentsPerHour: 3, votesPerHour: 4,
    sched: {
      nextPostAt: now + 10_000, nextArticleAt: now + 20_000,
      nextCommentAt: now + 30_000, nextVoteAt: now + 40_000,
    },
    simulationState: { sched: { nextPostAt: now + 50_000 } },
    ...patch,
  };
}
function forecast(profiles, options = {}) {
  return buildActivityForecast({ profiles, groups, nowMs: now, ...options });
}

const live = profile('live');
const rehearsal = profile('rehearsal', { dryRun: true, groupId: 'writers' });
const zero = profile('zero', {
  postsPerHour: 0, articlePostsPerHour: 0, commentsPerHour: 0, votesPerHour: 0,
});
const inputs = [live, rehearsal, zero,
  profile('disabled', { enabled: false }),
  profile('archived', { populationArchivedAt: new Date(now).toISOString() }),
  profile('missing-token', { token: '' }),
];
const before = structuredClone(inputs);
const standard = forecast(inputs);
eq(standard.botCount, 2, 'default forecast counts only eligible live bots');
eq(standard.groupCount, 1, 'default forecast counts represented named groups');
eq(standard.projections['1h'].botCount, 1, 'projection bot count excludes active zero-cadence bots');
eq(standard.projections['1h'].byType, { text: 1, article: 2, reply: 3, vote: 4 },
  'independent activity rates produce separate expected opportunity totals');
eq(standard.projections['24h'].total, 240, 'daily totals use ordinary cadence');
eq(standard.projections['7d'].total, 1680, 'weekly totals use ordinary cadence');
eq(standard.upcoming.map((item) => item.at), [now + 10_000, now + 20_000, now + 30_000, now + 40_000],
  'upcoming contains actual saved live deadlines only');
eq(standard.activeNoCadence.map((item) => item.profileId), ['zero'],
  'enabled zero-cadence bots are exposed even with stale saved timers');
eq(standard.hourlyBuckets.length, 24, 'hourly chart has 24 rolling buckets');
eq(standard.dailyBuckets.length, 7, 'daily chart has seven rolling buckets');
eq(standard.hourlyBuckets[0].startAt, now, 'buckets start at the supplied clock');
near(standard.hourlyBuckets.reduce((sum, bucket) => sum + bucket.total, 0), 240, 'hourly buckets reconcile with daily projection');
near(standard.dailyBuckets.reduce((sum, bucket) => sum + bucket.total, 0), 1680, 'daily buckets reconcile with weekly projection');
eq(inputs, before, 'forecast does not mutate profiles, live schedules or rehearsal state');
ok(!JSON.stringify(standard).includes('test-secret'), 'forecast never returns tokens');

const rehearsed = forecast(inputs, { filters: { mode: 'rehearsal' } });
eq(rehearsed.upcoming.map((item) => item.at), [now + 50_000], 'rehearsal reads only its saved rehearsal schedule');
eq(forecast(inputs, { filters: { mode: 'all' } }).botCount, 3, 'all combines the bots actual modes without duplicating clocks');
const filtered = forecast(inputs, { filters: { groupId: 'readers', type: 'article', zeroCadence: 'exclude' } });
eq(filtered.projections['1h'].byType, { text: 0, article: 2, reply: 0, vote: 0 }, 'type filter consistently restricts projections');
eq(filtered.upcoming.map((item) => item.type), ['article'], 'type filter consistently restricts upcoming');
eq(filtered.botCount, 1, 'exclude-zero filter removes no-cadence bots');
const zeroOnly = forecast(inputs, { filters: { zeroCadence: 'only' } });
eq(zeroOnly.botCount, 1, 'zero-only filter selects active bots without automatic cadence');
eq(zeroOnly.projections['7d'].total, 0, 'manual-only bots receive no invented forecast');
eq(zeroOnly.upcoming, [], 'manual-only bots stale deadlines are ignored');
const incomplete = { ...zero, id: 'incomplete', token: '', groupId: 'writers' };
const withIncomplete = forecast([live, incomplete]);
eq(withIncomplete.activeNoCadence.map((item) => item.profileId), ['incomplete'],
  'enabled live zero-cadence bots remain visible when registration is incomplete');
eq(withIncomplete.botCount, 2, 'top-level count retains matched no-cadence bots');
eq(withIncomplete.upcoming.map((item) => item.profileId), ['live', 'live', 'live', 'live'],
  'incomplete zero-cadence profiles never receive upcoming actions');
for (const horizon of ['1h', '24h', '7d']) {
  eq(withIncomplete.projections[horizon].botCount, 1, horizon + ' counts only positive contributing bots');
  eq(withIncomplete.projections[horizon].groupCount, 1, horizon + ' counts only positive contributing groups');
  eq(withIncomplete.projections[horizon].groups.find((group) => group.id === 'writers').botCount, 0,
    horizon + ' group contribution excludes zero-cadence members');
  eq(forecast([incomplete]).projections[horizon].total, 0, horizon + ' incomplete bots never project work');
}
eq(forecast([{ ...incomplete, dryRun: true }], { filters: { mode: 'all' } }).activeNoCadence, [],
  'credential-free no-cadence visibility is restricted to enabled live profiles');
const ungrouped = forecast([profile('unknown-group', { groupId: 'deleted-group' })], { filters: { groupId: '' } });
eq(ungrouped.botCount, 1, 'missing group membership safely appears as Ungrouped');
eq(ungrouped.groupCount, 0, 'Ungrouped is not counted as a saved group');
eq(ungrouped.groups[0].name, 'Ungrouped', 'Ungrouped contribution is explicit');
eq(forecast([profile('dto', { token: undefined, hasToken: true })]).botCount, 1,
  'caller can provide safe credential-presence DTOs');
eq(forecast([profile('timers-missing', { sched: {} })]).upcoming, [], 'missing timers are never synthesized');
const paused = forecast([live], { settings: { paused: true } });
eq(paused.paused, true, 'global runner pause is explicitly reported');
ok(paused.assumptions[0].includes('no automatic work will run while paused'), 'pause does not silently promise active execution');
const overdue = forecast([profile('overdue', { sched: { nextPostAt: now - hour, backoffUntil: now + hour } })]);
eq(overdue.upcoming[0].at, now - hour, 'overdue saved deadlines remain exact rather than moved to now');
eq(overdue.upcoming[0].overdue, true, 'overdue deadlines are labelled');
eq(overdue.upcoming[0].backoffUntil, now + hour, 'backoff is reported alongside saved deadlines');
eq(forecast([profile('bad-timers', { sched: { nextPostAt: 'bad', nextArticleAt: Infinity, nextCommentAt: 0 } })]).upcoming,
  [], 'invalid timers are excluded');

const onePerHour = profile('one', { canShareLinks: false, canReply: false, canVote: false });
const timed = forecast([onePerHour], { speedState: speed.startState(10, '30m', now) });
near(timed.projections['1h'].total, 5.5, 'finite Speed is integrated across its mid-hour expiry');
near(timed.projections['24h'].total, 28.5, 'finite Speed returns to ordinary cadence for the remainder of the day');
near(timed.projections['7d'].total, 172.5, 'finite Speed is not multiplied across the whole week');
eq(timed.upcoming[0].at, now + 10_000, 'Speed never invents or rewrites exact saved deadlines');
near(forecast([onePerHour], { speedState: speed.startState(5, 'untilOff', now) }).projections['7d'].total,
  840, 'until-off speed is explicitly assumed to persist');
near(forecast([onePerHour], { speedState: speed.startState(5, '30m', now - hour) }).projections['7d'].total,
  168, 'already-expired Speed has no projection effect');
near(forecast([onePerHour, { ...onePerHour, id: 'unowned' }], {
  speedState: (p) => p.id === 'one' ? speed.startState(10, '30m', now) : speed.inactiveState(),
}).projections['1h'].total, 6.5, 'Speed callbacks preserve separate owner and workspace scopes');
const hosted = profile('hosted', {
  hostedActivatedAt: new Date(now - 71.5 * hour).toISOString(),
  canShareLinks: false, canReply: false, canVote: false,
});
near(forecast([hosted], { placement: 'hosted' }).projections['1h'].total,
  0.1875, 'hosted new-bot boost ends at its exact mid-hour boundary');
near(forecast([hosted], { placement: 'hosted', ownerActivityAt: new Date(now).toISOString() }).projections['24h'].total,
  6, 'owner activity extends the hosted boost using the central allocation policy');
const probation = forecast([profile('probation', {
  postsPerHour: 100, articlePostsPerHour: 100, commentsPerHour: 100,
  probation: { onProbation: true },
})]);
eq(probation.projections['1h'].byType, { text: 2, article: 2, reply: 5, vote: 4 }, 'forecast reuses probation-aware opportunity cadence ceilings');

const ecology = activity.initialState({}, { nowMs: now, quantile: 0.98, random: () => 0.5 });
const synthetic = profile('synthetic', {
  botOrigin: 'system', populationActivity: ecology,
  postsPerHour: 0, articlePostsPerHour: 0, commentsPerHour: 0, votesPerHour: 0,
  canShareLinks: false, canReply: false, canVote: false,
});
eq(scheduler.populationRate(synthetic, 'post'), 1, 'shared scheduler helper derives system ecology despite zero stored rates');
eq(scheduler.nextAction(synthetic).next, { kind: 'post', at: now + 10_000 },
  'the next-action display does not label ecological text activity Idle');
const ecological = forecast([synthetic]);
ok(ecological.projections['24h'].total > 0 && ecological.projections['24h'].total < 24,
  'bounded exponential minimum spacing lowers expected frequency from the raw ecology target');
eq(ecological.activeNoCadence.length, 0, 'ecology with old zero stored rates is not falsely marked manual-only');
eq(ecological.upcoming.length, 1, 'ecology exposes persisted eligible deadlines');
const systemCustom = { ...synthetic, populationCadenceMode: 'custom' };
eq(forecast([systemCustom]).projections['7d'].total, 0, 'custom system zero cadence remains an intentional zero');
eq(scheduler.nextAction(systemCustom).next, null, 'custom system zero cadence does not acquire an exact next action');
const systemNews = profile('system-news', {
  botOrigin: 'system', populationActivity: ecology,
  canStartDiscussions: false, canReply: false, canVote: false, articlePostsPerHour: 0,
});
eq(scheduler.nextAction(systemNews).next, { kind: 'link', at: now + 20_000 },
  'ecological articles use the article clock despite stale zero stored article rates');
const systemReply = profile('system-reply', {
  botOrigin: 'system', populationActivity: ecology,
  canStartDiscussions: false, canShareLinks: false, canVote: false, commentsPerHour: 0,
});
eq(scheduler.nextAction(systemReply).next, { kind: 'comment', at: now + 30_000 },
  'ecological replies use the reply clock despite stale zero stored reply rates');
const rehearsalSystem = { ...synthetic, dryRun: true };
ok(forecast([rehearsalSystem], { filters: { mode: 'rehearsal' } }).projections['24h'].total > ecological.projections['24h'].total,
  'ecological rehearsal uses its existing compressed time scale');
const groupsResult = forecast([live, profile('other', { groupId: 'writers' })]);
near(groupsResult.projections['24h'].groups.reduce((sum, group) => sum + group.total, 0),
  groupsResult.projections['24h'].total, 'group contributions reconcile with the overall projection');

const originalRandom = Math.random;
Math.random = () => { throw new Error('Forecast must not consume scheduler randomness.'); };
try {
  eq(forecast([synthetic]), ecological, 'forecast is deterministic and does not draw from scheduler randomness');
} finally {
  Math.random = originalRandom;
}

console.log('activity forecast: ' + checks + ' checks passed');
