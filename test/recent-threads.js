'use strict';

const assert = require('node:assert/strict');
const recentThreads = require('../lib/recent-threads');

let checks = 0;
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

const nowMs = Date.UTC(2026, 8, 30, 12, 0, 0);
function thread(commentId, createdUtc, body = 'A genuinely new contribution.') {
  return {
    source: 'recent_comment_activity',
    event_id: 'active:t1_' + commentId,
    community: 'botlife',
    post: {
      id: 12,
      kind: 'text',
      author: 'thread_starter',
      feddit: 'botlife',
      title: 'An older discussion worth renewing',
      selftext: 'The bounded original post context.',
      created_utc: Math.floor(nowMs / 1000) - (14 * 24 * 60 * 60),
    },
    parent_comment: {
      id: 40,
      author: 'nearby_parent',
      body: 'The immediate parent gives local context.',
    },
    fresh_comment: {
      id: commentId,
      author: 'fresh_voice',
      body,
      created_utc: createdUtc,
    },
  };
}

const freshUtc = Math.floor(nowMs / 1000) - 60;
const normalized = recentThreads.normalize(thread(41, freshUtc), nowMs);
ok(normalized, 'a fresh comment can renew an older discussion');
eq(normalized.eventId, 'active:t1_41', 'the exact fresh comment is the renewal event');
ok(normalized.context.includes('POST BODY: The bounded original post context.') &&
  normalized.context.includes('NEARBY PARENT COMMENT by nearby_parent') &&
  normalized.context.includes('FRESH COMMENT by fresh_voice'),
'the candidate contains bounded post, immediate-parent and fresh-comment context');
eq(normalized.voteItems.map((item) => item.targetType), ['post', 'comment', 'comment'],
  'displayed renewed-thread content is immediately reusable for secondary voting');
eq(recentThreads.normalize(thread(42, Math.floor(nowMs / 1000) - (73 * 60 * 60)), nowMs), null,
  'activity outside the bounded renewal window is ignored');

let calls = 0;
const feddit = {
  async activeThreads(token, options) {
    calls++;
    eq(token, 'token', 'the bot credential authenticates the bounded source');
    eq(options, { communities: ['botlife'], limit: recentThreads.ENDPOINT_LIMIT },
      'the source request is community-scoped and hard-bounded');
    return {
      ok: true,
      data: {
        source: 'recent_comment_activity',
        window_hours: 72,
        threads: [thread(41, freshUtc), thread(42, freshUtc + 1)],
      },
    };
  },
};

(async () => {
  let result = await recentThreads.gather({
    feddit, token: 'token', communities: ['botlife'],
    state: { consideredEventIds: [] }, nowMs,
  });
  eq(result.candidates.map((item) => item.eventId), ['active:t1_41', 'active:t1_42'],
    'fresh unseen activity enters the candidate menu');
  eq(result.nextState.consideredEventIds, ['active:t1_41', 'active:t1_42'],
    'all valid displayed events are checkpointable after the durable snapshot');

  result = await recentThreads.gather({
    feddit, token: 'token', communities: ['botlife'],
    state: result.nextState, nowMs,
  });
  eq(result.candidates, [], 'unchanged comment activity is not offered repeatedly');

  const newerFeddit = {
    async activeThreads() {
      return { ok: true, data: { threads: [thread(43, freshUtc + 2, 'New activity on the same old post.')] } };
    },
  };
  result = await recentThreads.gather({
    feddit: newerFeddit, token: 'token', communities: ['botlife'],
    state: { consideredEventIds: ['active:t1_41', 'active:t1_42'] }, nowMs,
  });
  eq(result.candidates.map((item) => item.eventId), ['active:t1_43'],
    'a later comment renews the same old thread again');

  const failed = await recentThreads.gather({
    feddit: { async activeThreads() { return { ok: false, error: 'temporary failure' }; } },
    token: 'token', communities: ['botlife'], state: { consideredEventIds: ['active:t1_41'] }, nowMs,
  });
  eq(failed.nextState, null, 'a failed read never advances considered-event state');
  eq(calls, 2, 'each opportunity performs only one bounded active-thread request');
  console.log('recent threads: ' + checks + ' checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
