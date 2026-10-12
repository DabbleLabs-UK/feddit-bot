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
  assert.deepEqual(result.nextState.startCursor, { comments: 40, posts: 8 });
  assert.deepEqual(result.nextState.pendingEventIds, ['t1_48', 't1_51']);

  const fetched = [
    ...[101, 102, 103, 104, 105, 106].map((id) => event({ event_id: 't1_' + id, comment_id: id })),
    ...[21, 22].map((id) => event({
      event_id: 't3_' + id, source_type: 'post', type: 'mention_in_post', post_id: id, comment_id: null,
    })),
  ];
  const replayCalls = [];
  const replayFeddit = {
    attention: async (_token, cursor) => {
      replayCalls.push(cursor);
      return {
        ok: true,
        data: {
          cursor: { comments: 120, posts: 30 },
          has_more: false,
          events: fetched.filter((raw) => Number(raw.event_id.slice(3)) >
            (raw.event_id.startsWith('t1_') ? cursor.afterComment : cursor.afterPost)),
        },
      };
    },
  };
  const overflow = await attention.gather({
    feddit: replayFeddit,
    token: 'feddit_token',
    state: { cursor: { comments: 100, posts: 20 }, seenEventIds: [] },
    nowMs,
  });
  const expectedIds = fetched.map((raw) => raw.event_id);
  assert.equal(overflow.candidates.length, 8, 'gather retains more than the four offered attention slots');
  assert.deepEqual(overflow.nextState.pendingEventIds, expectedIds,
    'every normalized unseen event stays pending, including events omitted by a later menu or filter');

  const savedScan = JSON.parse(JSON.stringify(overflow.nextState));
  const noncontiguous = attention.handledScan(savedScan, ['t1_102', 't1_104', 't1_106', 't3_22']);
  assert.deepEqual(noncontiguous, {
    cursor: { comments: 100, posts: 20 },
    seenEventIds: ['t1_102', 't1_104', 't1_106', 't3_22'],
  }, 'noncontiguous handled targets are acknowledged without crossing earlier unhandled events');
  assert.deepEqual(savedScan, overflow.nextState, 'deriving a receipt does not mutate the durable scan');

  const noOffered = attention.handledScan(savedScan, []);
  assert.deepEqual(noOffered, { cursor: { comments: 100, posts: 20 }, seenEventIds: [] },
    'an empty offered menu cannot acknowledge fetched valid candidates');
  const noOfferedReplay = await attention.gather({
    feddit: replayFeddit, token: 'feddit_token', state: noOffered, nowMs,
  });
  assert.deepEqual(noOfferedReplay.nextState.pendingEventIds, expectedIds,
    'all unoffered candidates remain replayable');

  const commentsHandled = attention.handledScan(savedScan, new Set(expectedIds.filter((id) => id.startsWith('t1_'))));
  assert.deepEqual(commentsHandled.cursor, { comments: 120, posts: 20 },
    'pending posts do not hold back handled comment progress');
  const postsHandled = attention.handledScan(savedScan, ['t3_21', 't3_22']);
  assert.deepEqual(postsHandled.cursor, { comments: 100, posts: 30 },
    'pending comments do not hold back handled post progress');

  const partial = attention.handledScan(savedScan, new Set(['t1_101', 't1_103', 't1_105', 't3_21']));
  assert.deepEqual(partial.cursor, { comments: 101, posts: 21 },
    'each source advances to immediately before its earliest still-pending event');
  const restoredState = JSON.parse(JSON.stringify(partial));
  const replayed = await attention.gather({
    feddit: replayFeddit, token: 'feddit_token', state: restoredState, nowMs,
  });
  assert.deepEqual(replayCalls.at(-1), { afterComment: 101, afterPost: 21, limit: 100 },
    'a restored scan starts from its committed source cursors');
  assert.deepEqual(replayed.nextState.pendingEventIds, ['t1_102', 't1_104', 't1_106', 't3_22'],
    'restored acknowledged targets are skipped while every remaining candidate is offered again');
  const finished = attention.handledScan(replayed.nextState, replayed.nextState.pendingEventIds);
  assert.deepEqual(finished.cursor, { comments: 120, posts: 30 });
  const finalState = {
    cursor: finished.cursor,
    seenEventIds: [...new Set([...restoredState.seenEventIds, ...finished.seenEventIds])],
  };
  assert.deepEqual(finalState.seenEventIds.slice().sort(), expectedIds.slice().sort(),
    'later handling completes selective receipts without losing any event');
  const complete = await attention.gather({
    feddit: replayFeddit, token: 'feddit_token', state: finalState, nowMs,
  });
  assert.deepEqual(complete.candidates, []);

  const stale = await attention.gather({
    feddit: {
      attention: async () => ({
        ok: true,
        data: {
          cursor: { comments: 145, posts: 45 },
          has_more: false,
          events: [
            event({ event_id: 't1_141', comment_id: 141, created_utc: Math.floor(nowMs / 1000) - 31 * 24 * 60 * 60 }),
            event({ event_id: 't3_41', source_type: 'post', post_id: 41, type: 'unknown' }),
          ],
        },
      }),
    },
    token: 'feddit_token', state: finalState, nowMs,
  });
  assert.deepEqual(stale.candidates, []);
  assert.deepEqual(stale.nextState.pendingEventIds, []);
  assert.deepEqual(attention.handledScan(stale.nextState, []), {
    cursor: { comments: 145, posts: 45 }, seenEventIds: ['t1_141', 't3_41'],
  }, 'expired and invalid noncandidates can still advance the scan without a handled target');

  const unknownPending = { startCursor: { comments: 40, posts: 8 }, cursor: { comments: 60, posts: 12 },
    seenEventIds: ['t1_48', 't1_51', 't3_10'] };
  assert.deepEqual(attention.handledScan(unknownPending, []), {
    cursor: { comments: 40, posts: 8 }, seenEventIds: [],
  }, 'missing pending metadata cannot silently acknowledge a legacy scan');
  assert.deepEqual(attention.handledScan({ ...unknownPending, pendingEventIds: null }, new Set(['t1_51'])), {
    cursor: { comments: 40, posts: 8 }, seenEventIds: ['t1_51'],
  }, 'unknown pending metadata still permits an exact handled receipt without guessing cursor safety');
  assert.deepEqual(attention.handledScan({ cursor: { comments: 60, posts: 12 }, seenEventIds: ['t1_48'] }, []), {
    cursor: { comments: 0, posts: 0 }, seenEventIds: [],
  }, 'a missing scan baseline supplies no advancing cursor evidence');
  assert.deepEqual(attention.handledScan(savedScan, ['101', 't1_101 ', 't3_101', { key: 't1_101' }]), noOffered,
    'handled evidence must match the exact event fullname');
  assert.deepEqual(attention.handledScan({
    startCursor: { comments: 100, posts: 20 }, cursor: { comments: 90, posts: 10 },
    seenEventIds: ['t1_99', 't3_19'], pendingEventIds: ['t1_99', 't3_19'],
  }, []), { cursor: { comments: 100, posts: 20 }, seenEventIds: [] },
  'overlapping old events cannot rewind the already-committed source cursors');

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
