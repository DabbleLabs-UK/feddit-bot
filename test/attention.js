'use strict';

const assert = require('node:assert/strict');
const attention = require('../lib/attention');

const nowMs = Date.parse('2026-09-14T12:00:00Z');

function event(overrides = {}) {
  return {
    source: 'feddit_attention',
    source_type: 'comment',
    type: 'nested_continuation',
    event_id: 't1_42',
    post_id: 7,
    comment_id: 42,
    parent_comment_id: 41,
    author: 'other_bot',
    community: 'botlife',
    created_utc: Math.floor(nowMs / 1000) - 60,
    directness: 'nested',
    directly_addresses_bot: false,
    mentioned: false,
    seen: false,
    reason: 'Nested continuation below this bot\'s comment.',
    body: 'The newly arrived reply.',
    context: {
      post: {
        post_id: 7,
        author: 'thread_bot',
        community: 'botlife',
        title: 'A discussion',
        kind: 'text',
        body: 'Opening body.',
      },
      parent_chain: [
        { comment_id: 37, author: 'a', body: 'one' },
        { comment_id: 38, author: 'b', body: 'two' },
        { comment_id: 39, author: 'c', body: 'three' },
        { comment_id: 40, author: 'd', body: 'four' },
        { comment_id: 41, author: 'e', body: 'five' },
      ],
    },
    ...overrides,
  };
}

const normalized = attention.normalizeEvent(event(), nowMs);
assert.equal(normalized.source, 'feddit_attention');
assert.equal(normalized.type, 'nested_continuation');
assert.equal(normalized.key, 't1_42');
assert.equal(normalized.postId, 7);
assert.equal(normalized.commentId, 42);
assert.equal(normalized.seen, false);
assert.match(normalized.context, /RECENT PARENT CHAIN/);
assert.doesNotMatch(normalized.context, /a: one/,
  'normalization keeps only the nearest four parents');
assert.match(normalized.context, /e: five/);

const ranked = attention.rank([
  attention.normalizeEvent(event({ type: 'mention_in_comment', event_id: 't1_50', comment_id: 50 }), nowMs),
  attention.normalizeEvent(event({ type: 'reply_to_own_post', event_id: 't1_49', comment_id: 49 }), nowMs),
  attention.normalizeEvent(event({ type: 'reply_to_own_comment', event_id: 't1_48', comment_id: 48 }), nowMs),
]);
assert.deepEqual(ranked.map((item) => item.type), [
  'reply_to_own_comment',
  'reply_to_own_post',
  'mention_in_comment',
], 'own-comment and own-post replies outrank a general mention');

assert.equal(attention.normalizeEvent(event({ event_id: 'bad' }), nowMs), null);
assert.equal(attention.normalizeEvent(event({ created_utc: Math.floor((nowMs - attention.MAX_EVENT_AGE_MS - 1) / 1000) }), nowMs), null,
  'stale historical attention is not reintroduced during migration');

(async () => {
  const calls = [];
  const feddit = {
    attention: async (_token, cursor) => {
      calls.push(cursor);
      if (calls.length === 1) {
        return {
          ok: true,
          data: {
            cursor: { comments: 50, posts: 10 },
            has_more: true,
            events: [
              event({ type: 'reply_to_own_comment', event_id: 't1_48', comment_id: 48 }),
              event({ type: 'mention_in_comment', event_id: 't1_49', comment_id: 49 }),
            ],
          },
        };
      }
      return {
        ok: true,
        data: {
          cursor: { comments: 60, posts: 12 },
          has_more: false,
          events: [event({ type: 'reply_to_own_post', event_id: 't1_51', comment_id: 51 })],
        },
      };
    },
  };
  const result = await attention.gather({
    feddit,
    token: 'feddit_token',
    state: { cursor: { comments: 40, posts: 8 }, seenEventIds: ['t1_49'] },
    nowMs,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2, 'bounded pagination follows has_more');
  assert.deepEqual(calls[0], { afterComment: 40, afterPost: 8, limit: 100 });
  assert.deepEqual(calls[1], { afterComment: 50, afterPost: 10, limit: 100 });
  assert.deepEqual(result.candidates.map((item) => item.eventId), ['t1_48', 't1_51'],
    'already-seen events are not offered again');
  assert.deepEqual(result.nextState.cursor, { comments: 60, posts: 12 });
  assert.deepEqual(result.nextState.seenEventIds.sort(), ['t1_48', 't1_51']);

  const failed = await attention.gather({
    feddit: { attention: async () => ({ ok: false, error: 'offline' }) },
    token: 'feddit_token',
    state: { cursor: { comments: 9, posts: 3 }, seenEventIds: [] },
    nowMs,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.nextState, null, 'failed reads never advance durable seen state');

  console.log('attention: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
