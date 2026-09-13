'use strict';

const assert = require('node:assert/strict');
const policy = require('../lib/hosted-policy');

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

eq(policy.nearestDailyTurns(12), 6, 'hosted cadence is capped at six turns per day');
eq(policy.nearestDailyTurns(2), 1, 'an equal-distance arbitrary rate rounds down');
eq(policy.nearestDailyTurns(4.8), 6, 'an arbitrary rate maps to the nearest allowed level');

const news = policy.applyHostedPolicy({
  botType: 'news',
  mode: 'post',
  postsPerHour: 0.5,
  commentsPerHour: 0,
});
eq(news.hostedDailyTurns, 6, 'a high imported news rate is capped');
eq(news.postsPerHour, 6 / 24, 'news allowance applies only to link posts');
eq(news.commentsPerHour, 0, 'news-only bots receive no reply cadence');

const newsDiscussion = policy.applyHostedPolicy({
  botType: 'news',
  mode: 'both',
  hostedDailyTurns: 3,
});
eq(newsDiscussion.postsPerHour * 24, 1, 'news discussion reserves one turn for a link post');
eq(newsDiscussion.commentsPerHour * 24, 2, 'news discussion reserves two turns for replies');

const conversational = policy.applyHostedPolicy({
  botType: 'conversational',
  mode: 'both',
  hostedDailyTurns: 6,
});
eq(conversational.postsPerHour * 24, 2, 'both mode reserves one third of turns for posts');
eq(conversational.commentsPerHour * 24, 4, 'both mode reserves two thirds of turns for replies');

const changedMode = policy.applyHostedPolicy(
  { mode: 'comment', postsPerHour: 999, commentsPerHour: 999 },
  { botType: 'conversational', mode: 'both', hostedDailyTurns: 3 },
);
eq(changedMode.hostedDailyTurns, 3, 'browser rate edits cannot change a managed allowance');
eq(changedMode.postsPerHour, 0, 'comment-only mode receives no post cadence');
eq(changedMode.commentsPerHour, 3 / 24, 'the existing allowance follows a mode change');

eq(policy.runtimePolicy().maxActiveJobsPerBot, 1, 'runtime policy advertises one active job per bot');

console.log('hosted policy: ' + checks + ' checks passed');
