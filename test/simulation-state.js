'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-bot-simulation-'));
process.env.FEDDIT_BOT_DATA_DIR = dataDir;

try {
  const store = require('../lib/store');
  const profile = store.createProfile({ fedditUsername: 'simulation_test' });
  const id = profile.id;
  const options = { simulation: true, profileId: id };

  store.updateSched(id, { nextPostAt: 111, sentPosts: [101] });
  store.updateSched(id, { nextPostAt: 222, sentPosts: [202] }, options);
  store.recordReplied(id, 't3_live');
  store.recordReplied(id, 't3_simulation', options);
  store.recordAttentionScan(id, { cursor: { comments: 12, posts: 3 }, seenEventIds: ['t1_live'] });
  store.recordAttentionScan(id, { cursor: { comments: 22, posts: 5 }, seenEventIds: ['t1_simulation'] }, options);
  store.recordPostedNews(id, 'https://example.com/live');
  store.recordPostedNews(id, 'https://example.com/simulation', options);
  store.recordNewsDomain(id, '2026-09-13', 'example.com');
  store.recordNewsDomain(id, '2026-09-13', 'simulation.example', options);
  store.recordSocialEvent(id, {
    id: 'live:incoming:t1_30', account: 'alice', direction: 'incoming',
    kind: 'reply_to_own_post', threadKey: 't3_10', text: 'gardening and tomatoes',
  });
  store.recordSocialEvent(id, {
    id: 'rehearsal:incoming:t1_40', account: 'bob', direction: 'incoming',
    kind: 'reply_to_own_post', threadKey: 't3_20', text: 'music and synthesisers',
  }, options);
  store.bumpThreadReply(10);
  store.bumpThreadReply(20, options);
  store.logActivity(id, { kind: 'comment', dryRun: true, ok: true, note: 'simulation card' });
  store.logActivity(id, { kind: 'comment', dryRun: false, ok: true, note: 'live history' });

  assert.equal(store.getProfile(id).sched.nextPostAt, 111);
  assert.equal(store.getProfile(id).simulationState.sched.nextPostAt, 222);
  assert.equal(store.hasReplied(id, 't3_live'), true);
  assert.equal(store.hasReplied(id, 't3_simulation'), false);
  assert.equal(store.hasReplied(id, 't3_simulation', options), true);
  assert.deepEqual(store.getAttentionState(id).cursor, { comments: 12, posts: 3 });
  assert.deepEqual(store.getAttentionState(id, options).cursor, { comments: 22, posts: 5 });
  assert.deepEqual(store.getAttentionState(id).seenEventIds, ['t1_live']);
  assert.deepEqual(store.getAttentionState(id, options).seenEventIds, ['t1_simulation']);
  assert.equal(store.hasPostedNews(id, 'https://example.com/live'), true);
  assert.equal(store.hasPostedNews(id, 'https://example.com/simulation'), false);
  assert.equal(store.hasPostedNews(id, 'https://example.com/simulation', options), true);
  assert.equal(store.getThreadReplyCount(10), 1);
  assert.equal(store.getThreadReplyCount(20, options), 1);
  assert.equal(store.getSocialState(id).relationships.alice.interactionCount, 1);
  assert.equal(store.getSocialState(id).relationships.bob, undefined, 'rehearsal social evidence does not enter live continuity');
  assert.equal(store.getSocialState(id, options).relationships.bob.interactionCount, 1);
  assert.equal(store.getSocialState(id, options).relationships.alice, undefined, 'live social evidence does not enter rehearsal continuity');

  assert.equal(store.resetSimulation(id), true);
  const reset = store.getProfile(id);
  assert.equal(reset.sched.nextPostAt, 111, 'live cadence is preserved');
  assert.deepEqual(reset.repliedTo, ['t3_live'], 'live reply dedupe is preserved');
  assert.deepEqual(reset.attentionState.cursor, { comments: 12, posts: 3 }, 'live attention cursor is preserved');
  assert.deepEqual(reset.attentionState.seenEventIds, ['t1_live'], 'live seen events are preserved');
  assert.deepEqual(reset.postedNews, ['https://example.com/live'], 'live article dedupe is preserved');
  assert.equal(store.getThreadReplyCount(10), 1, 'live thread cap is preserved');
  assert.equal(store.getSocialState(id).relationships.alice.interactionCount, 1, 'live social continuity is preserved');
  assert.equal(reset.simulationState.sched.nextPostAt, null, 'simulation cadence is reset');
  assert.deepEqual(reset.simulationState.repliedTo, [], 'simulation reply dedupe is reset');
  assert.deepEqual(reset.simulationState.attentionState, store.attentionDefaults(), 'simulation attention is reset');
  assert.deepEqual(reset.simulationState.postedNews, [], 'simulation article dedupe is reset');
  assert.equal(store.getThreadReplyCount(20, options), 0, 'simulation thread cap is reset');
  assert.deepEqual(store.getSocialState(id, options), store.socialDefaults(), 'simulation social continuity is reset');
  assert.deepEqual(reset.activity.map((entry) => entry.note), ['live history'], 'only simulation cards are removed');

  const migrated = store.migrateProfiles([{ id: 'old' }], 4)[0];
  assert.equal(migrated.feedSort, 'best', 'old profiles get the Best feed view');
  assert.deepEqual(migrated.socialState, store.socialDefaults(), 'old profiles get bounded live social continuity');
  assert.deepEqual(migrated.simulationState, store.simulationDefaults(), 'old profiles get separate simulation state');

  console.log('simulation-state: all checks passed');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
