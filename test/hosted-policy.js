'use strict';

const assert = require('node:assert/strict');
const policy = require('../lib/hosted-policy');

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
eq(advertised.firstTurnDueMinutes, 2, 'first turn becomes due promptly');
eq(advertised.maxActiveJobsPerBot, 1, 'only one active job is allowed per bot');
eq(advertised.queueOrder, 'round-robin-with-aging', 'fair queue order is public');

eq(policy.allocationFor({}, startedAt).phase, 'not-started', 'draft has not started its boost clock');
eq(policy.allocationFor({}, startedAt).dailyTurns, 6, 'draft previews the new-bot allocation');

const firstStart = policy.applyHostedPolicy({
  enabled: true,
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: false,
  hostedDailyTurns: 999,
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

const establishedProfile = {
  enabled: true,
  hostedActivatedAt: new Date(startedAt).toISOString(),
  canReply: true,
  canStartDiscussions: true,
};
eq(policy.allocationFor(establishedProfile, boostEnd - 1).phase, 'new', 'boost lasts until the 72-hour boundary');
eq(policy.allocationFor(establishedProfile, boostEnd).phase, 'standard', 'standard allocation begins at 72 hours');
eq(policy.allocationFor(establishedProfile, boostEnd).dailyTurns, 3, 'standard allocation is applied');

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

console.log('hosted policy: ' + checks + ' checks passed');
