'use strict';

const assert = require('node:assert/strict');
const policy = require('../lib/hosted-policy');
const populationActivity = require('../lib/population-activity');

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

const startedAt = Date.parse('2026-09-13T12:00:00.000Z');
const boostEnd = startedAt + 72 * 60 * 60 * 1000;

const advertised = policy.runtimePolicy();
eq(advertised.managedCadence, true, 'hosted cadence is centrally managed');
eq(advertised.standardDailyTurns, 3, 'standard allocation is three turns a day');
eq(advertised.newBotDailyTurns, 6, 'new-bot allocation is six turns a day');
eq(advertised.newBotBoostHours, 72, 'new-bot boost lasts 72 hours');
eq(advertised.ownerActivityBoostHours, 72, 'owner activity keeps the boost alive for 72 hours');
eq(advertised.firstTurnDueMinutes, 2, 'first turn becomes due promptly');
eq(advertised.maxActiveJobsPerBot, 1, 'only one active job is allowed per bot');
eq(advertised.onboardingCompletedTurns, 5, 'compute onboarding is bounded by completed turns');
eq(advertised.onboardingMaxDays, 30, 'compute onboarding has a wall-clock long-stop');
eq(advertised.queueOrder, 'interactive-then-owner-and-profile-fair-share', 'fair queue order is public');

eq(policy.allocationFor({}, startedAt).phase, 'not-started', 'draft has not started its boost clock');
eq(policy.allocationFor({}, startedAt).dailyTurns, 6, 'draft previews the new-bot allocation');
eq(policy.processingFor({}, startedAt).origin, 'user', 'missing origin safely defaults to user-created');
eq(policy.processingFor({}, startedAt).phase, 'onboarding', 'a user-created draft previews onboarding priority');
eq(policy.processingFor({}, startedAt).turnsRemaining, 5, 'all onboarding turns initially remain');

const firstStart = policy.applyHostedPolicy({
  enabled: true,
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: false,
  hostedDailyTurns: 999,
  botOrigin: 'system',
  hostedOnboardingTurnsCompleted: 999,
  postsPerHour: 999,
  commentsPerHour: 999,
}, {}, startedAt);
eq(firstStart.hostedActivatedAt, '2026-09-13T12:00:00.000Z', 'first activation is recorded by the server');
eq(firstStart.hostedDailyTurns, 6, 'owner-supplied allowance is ignored');
eq(firstStart.postsPerHour * 24, 2, 'mixed bot reserves one third of opportunities for posts');
eq(firstStart.commentsPerHour * 24, 4, 'mixed bot reserves two thirds for replies');
eq(firstStart.sched.nextPostAt, startedAt + 2 * 60 * 1000, 'first post becomes due in two minutes');
eq(firstStart.sched.nextCommentAt, startedAt + 2 * 60 * 1000, 'first reply becomes due in two minutes');
eq(firstStart.simulationState.sched.nextPostAt, startedAt + 2 * 60 * 1000, 'rehearsal is seeded too');
eq(firstStart.botOrigin, 'user', 'browser-supplied origin cannot replace the safe user default');
eq(firstStart.hostedOnboardingTurnsCompleted, 0, 'browser-supplied onboarding history cannot be forged');

const establishedProfile = {
  enabled: true,
  hostedActivatedAt: new Date(startedAt).toISOString(),
  canReply: true,
  canStartDiscussions: true,
};
eq(policy.allocationFor(establishedProfile, boostEnd - 1).phase, 'new', 'boost lasts until the 72-hour boundary');
eq(policy.allocationFor(establishedProfile, boostEnd).phase, 'standard', 'standard allocation begins at 72 hours');
eq(policy.allocationFor(establishedProfile, boostEnd).dailyTurns, 3, 'standard allocation is applied');
const laterVisit = new Date(boostEnd + 24 * 60 * 60 * 1000).toISOString();
const visitContext = { ownerLastActiveAt: laterVisit };
eq(policy.allocationFor(establishedProfile, boostEnd, visitContext).phase, 'new',
  'a recent owner visit keeps an established bot on the exploratory cadence');
eq(policy.allocationFor(establishedProfile, Date.parse(laterVisit) + policy.OWNER_ACTIVITY_BOOST_MS - 1, visitContext).dailyTurns, 6,
  'activity boost remains active up to the inactivity boundary');
eq(policy.allocationFor(establishedProfile, Date.parse(laterVisit) + policy.OWNER_ACTIVITY_BOOST_MS, visitContext).dailyTurns, 3,
  'activity boost steps down after 72 hours without another visit');
eq(policy.allocationFor(establishedProfile, boostEnd, visitContext).continuedByOwnerActivity, true,
  'allocation explains when owner activity extended the initial boost');

const reconciled = policy.applyHostedPolicy({
  hostedActivatedAt: new Date(boostEnd).toISOString(),
  hostedDailyTurns: 99,
  postsPerHour: 99,
  commentsPerHour: 99,
}, establishedProfile, boostEnd);
eq(reconciled.hostedActivatedAt, establishedProfile.hostedActivatedAt, 'client cannot reset the boost clock');
eq(reconciled.hostedDailyTurns, 3, 'reconciliation applies the standard allocation');
eq(reconciled.postsPerHour * 24, 1, 'standard mixed allocation includes one post opportunity');
eq(reconciled.commentsPerHour * 24, 2, 'standard mixed allocation includes two reply opportunities');
const activeReconciled = policy.applyHostedPolicy({}, establishedProfile, boostEnd, visitContext);
eq(activeReconciled.hostedDailyTurns, 6, 'reconciliation applies the active-owner boost');

const postOnly = policy.applyHostedPolicy({
  canReply: false,
  canStartDiscussions: false,
  canShareLinks: true,
}, {}, startedAt);
eq(postOnly.postsPerHour * 24, 6, 'article-only bot uses all opportunities for posts');
eq(postOnly.commentsPerHour, 0, 'article-only bot has no reply cadence');

const replyOnly = policy.applyHostedPolicy({
  canReply: true,
  canStartDiscussions: false,
  canShareLinks: false,
}, {}, startedAt);
eq(replyOnly.postsPerHour, 0, 'reply-only bot has no post cadence');
eq(replyOnly.commentsPerHour * 24, 6, 'reply-only bot uses all opportunities for replies');

const earlierDue = startedAt + 30 * 1000;
const firstStartWithEarlierSchedule = policy.applyHostedPolicy({ enabled: true }, {
  canReply: true,
  canStartDiscussions: false,
  hostedActivatedAt: null,
  sched: { nextCommentAt: earlierDue },
}, startedAt);
eq(firstStartWithEarlierSchedule.sched.nextCommentAt, earlierDue, 'activation never postpones an earlier due turn');

const resumed = policy.applyHostedPolicy({ enabled: true }, {
  ...establishedProfile,
  enabled: false,
}, startedAt + 24 * 60 * 60 * 1000);
eq(resumed.hostedActivatedAt, establishedProfile.hostedActivatedAt, 'pause and resume do not restart the boost');
eq(Object.prototype.hasOwnProperty.call(resumed, 'sched'), false, 'resume does not reseed established schedules');

const almostOnboarded = {
  botOrigin: 'user',
  hostedActivatedAt: new Date(startedAt).toISOString(),
  hostedOnboardingTurnsCompleted: 4,
};
eq(policy.processingFor(almostOnboarded, boostEnd).phase, 'onboarding', 'compute onboarding survives the shorter cadence boost');
eq(policy.processingFor(almostOnboarded, boostEnd).turnsRemaining, 1, 'completed activity consumes onboarding turns');
eq(policy.processingFor({ ...almostOnboarded, hostedOnboardingTurnsCompleted: 5 }, boostEnd).phase,
  'standard', 'compute onboarding expires after five completed scheduled turns');
eq(policy.processingFor(almostOnboarded, startedAt + policy.ONBOARDING_MAX_MS).phase,
  'standard', 'unused compute onboarding expires at the 30-day long-stop');
eq(policy.processingFor({ botOrigin: 'system' }, startedAt).phase,
  'system', 'explicit system origin persists as the spare-capacity class');
const reconciledSystem = policy.applyHostedPolicy({}, {
  botOrigin: 'system',
  hostedOnboardingTurnsCompleted: 12,
  hostedActivatedAt: new Date(startedAt).toISOString(),
}, startedAt);
eq(reconciledSystem.botOrigin, 'system', 'trusted explicit system origin survives hosted reconciliation');
eq(reconciledSystem.hostedOnboardingTurnsCompleted, 12,
  'trusted system activity evidence survives hosted reconciliation');
const rareActivity = populationActivity.initialState({}, {
  nowMs: startedAt,
  quantile: 0.2,
  random: () => 0.5,
});
const systemStarted = policy.applyHostedPolicy({
  enabled: true,
  populationActivity: populationActivity.initialState({}, {
    nowMs: startedAt,
    quantile: 0.99,
    random: () => 0.5,
  }),
}, {
  botOrigin: 'system',
  enabled: false,
  canReply: true,
  canStartDiscussions: false,
  hostedActivatedAt: null,
  populationActivity: rareActivity,
}, startedAt);
eq(policy.allocationFor(systemStarted, startedAt).phase, 'system-ecology',
  'system bot cadence comes from the separate population ecology');
eq(systemStarted.hostedDailyTurns, rareActivity.currentDailyOpportunities,
  'system bot rate reflects its persistent activity tendency');
eq(systemStarted.commentsPerHour * 24, rareActivity.currentDailyOpportunities,
  'system reply cadence receives the ecology opportunity rate');
eq(systemStarted.populationActivity.band, 'rare',
  'client input cannot replace the server-managed system activity state');
eq(Object.prototype.hasOwnProperty.call(systemStarted, 'sched'), false,
  'system activation lets stochastic ecology seed the first opportunity instead of synchronising a cohort');

eq(policy.admissionFor({ botOrigin: 'user' }, { online: false, queued: 20, running: 1 }).admit,
  true, 'user-created turns remain admissible under congestion');
eq(policy.admissionFor({ botOrigin: 'system' }, { online: false, queued: 0, running: 0 }).admit,
  false, 'system population does not backlog while DELL is offline');
eq(policy.admissionFor({ botOrigin: 'system' }, { online: true, queued: 1, running: 0 }).admit,
  false, 'system population yields while user work is waiting');
eq(policy.admissionFor({ botOrigin: 'system' }, { online: true, queued: 0, running: 0 }, {
  activeSyntheticTurns: 1,
}).admit, false, 'only one system-population turn is admitted at a time');
eq(policy.admissionFor({ botOrigin: 'system' }, { online: true, queued: 0, running: 0 }).admit,
  true, 'system population may use genuinely spare capacity');

console.log('hosted policy: ' + checks + ' checks passed');
