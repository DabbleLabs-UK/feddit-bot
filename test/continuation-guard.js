'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../lib/continuation-guard');

let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function rejects(fn, pattern, message) {
  assert.throws(fn, pattern, message);
  checks++;
}

const nowMs = Date.UTC(2026, 9, 12, 12);
eq(guard.VERSION, 2, 'continuation has its own version');
eq(guard.MAX_ATTEMPTS, 3, 'three accounted attempts are allowed');
eq(guard.WINDOW_MS, 3600000, 'the guard uses one rolling hour');
eq(guard.ATTEMPT_CAP, 500, 'each continuity has bounded attempt history');
eq(guard.defaults(), { version: 2, attempts: [] }, 'new profiles start without invented history');

let state = guard.defaults();
for (let i = 0; i < 3; i++) {
  eq(guard.count(state, 10, nowMs) < guard.MAX_ATTEMPTS, true, 'attempt ' + (i + 1) + ' is admitted');
  state = guard.record(state, 10, { nowMs, targetKey: 'turn:' + i }).state;
}
eq(guard.count(state, 10, nowMs) < guard.MAX_ATTEMPTS, false, 'the fourth attempt is blocked');
eq(guard.count(state, 11, nowMs), 0, 'a different thread has its own allowance');
eq(guard.count(state, 10, nowMs + guard.WINDOW_MS - 1), 3, 'attempts count immediately before expiry');
eq(guard.count(state, 10, nowMs + guard.WINDOW_MS), 0, 'attempts expire exactly at the one-hour boundary');
eq(guard.count(state, 10, nowMs - 1000), 3, 'future timestamps remain conservative after a clock rollback');

const replay = guard.record(state, 10, { nowMs: nowMs + guard.WINDOW_MS, targetKey: 'turn:0' });
eq(replay.counted, false, 'an expired attempt ID is not accounted again');
eq(replay.count, 0, 'an expired replay does not renew the allowance window');
eq(replay.state, state, 'duplicate bookkeeping never refreshes the original timestamp');
const later = guard.record(state, 10, { nowMs: nowMs + 100, targetKey: 'turn:later' });
eq(later.count, 4, 'bookkeeping preserves confirmed attempts even if admission was bypassed');
eq(guard.count(later.state, 10, nowMs + guard.WINDOW_MS), 1, 'expiry rolls per timestamp rather than resetting a whole bucket');
eq(state.attempts.length, 3, 'recording leaves the input state unchanged');

const normalized = guard.normalize({ attempts: [
  null,
  { postId: 10, targetKey: 'valid', at: nowMs },
  { postId: '10', targetKey: 'valid', at: nowMs + 100 },
  { postId: 10, targetKey: '', at: nowMs },
  { postId: 10, targetKey: 'missing-time' },
  { postId: 10, targetKey: 'bad-time', at: '123' },
  { postId: 10, targetKey: 'negative-time', at: -1 },
  { postId: 10, targetKey: 'infinite-time', at: Infinity },
  { postId: {}, targetKey: 'bad-post', at: nowMs },
] });
eq(normalized, { version: 2, attempts: [{ postId: '10', targetKey: 'valid', at: nowMs + 100 }] },
  'normalization drops malformed records and deduplicates conservatively');
eq(guard.normalize({ attempts: {} }), guard.defaults(), 'invalid history does not invent attempts');
eq(guard.count(guard.record(null, 10, { nowMs: 0, targetKey: 'epoch' }).state, 10, 0), 1,
  'an explicitly injected zero timestamp is supported');
rejects(() => guard.record(null, 10, { nowMs }), /stable.*targetKey/, 'recording needs a stable attempt identity');
rejects(() => guard.count(null, 10, NaN), /timestamp/, 'invalid clocks cannot silently disable the guard');

const overBound = { attempts: Array.from({ length: 520 }, (_, i) => ({
  postId: String(i), targetKey: 'attempt:' + i, at: nowMs + i,
})) };
const bounded = guard.normalize(overBound);
eq(bounded.attempts.length, 500, 'normalization bounds stored history');
eq(bounded.attempts[0].targetKey, 'attempt:20', 'normalization evicts oldest inserted history');
eq(overBound.attempts.length, 520, 'normalization does not mutate its input');
const appended = guard.record(bounded, 999, { nowMs, targetKey: 'new' });
eq(appended.state.attempts.length, 500, 'new recording retains the bound');
eq(appended.state.attempts[0].targetKey, 'attempt:21', 'new recording evicts the oldest retained attempt');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-continuation-'));
const previousDataDir = process.env.FEDDIT_BOT_DATA_DIR;
process.env.FEDDIT_BOT_DATA_DIR = dataDir;
const storePath = require.resolve('../lib/store');

try {
  const legacyLive = { '10': 8, '20': 2 };
  const legacySimulation = { '10': 5 };
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({
    schemaVersion: 26,
    profiles: [{
      id: 'legacy', fedditUsername: 'legacy_bot', dryRun: false,
      repliedTo: ['t1_unchanged'],
      simulationState: { threadReplies: legacySimulation, threadOrder: ['10'] },
    }],
    groups: [],
    settings: { threadReplies: legacyLive, threadOrder: ['10', '20'] },
  }), 'utf8');
  let store = require('../lib/store');
  const legacy = store.getProfile('legacy');
  const live = { continuationVersion: 2, profileId: legacy.id, nowMs };
  const simulation = { ...live, simulation: true };
  eq(store.DATA_SCHEMA_VERSION, 27, 'the additive store migration is versioned');
  eq(legacy.replyGuardState, guard.defaults(), 'legacy global history is not attributed to a profile');
  eq(legacy.simulationState.replyGuardState, guard.defaults(), 'legacy untimed rehearsal counts do not invent timestamps');
  eq(legacy.repliedTo, ['t1_unchanged'], 'migration preserves existing reply dedupe');
  eq(store.getSettings().threadReplies, legacyLive, 'migration preserves legacy global counts');
  eq(store.getSettings().threadOrder, ['10', '20'], 'migration preserves legacy FIFO order');
  eq(legacy.simulationState.threadReplies, legacySimulation, 'migration preserves legacy rehearsal counts');
  const migratedDisk = JSON.parse(fs.readFileSync(store.DATA_FILE, 'utf8'));
  eq(migratedDisk.schemaVersion, 27, 'the migration is saved to disk');
  eq(migratedDisk.profiles[0].replyGuardState, guard.defaults(), 'empty versioned live state is persisted');

  eq(store.getThreadReplyCount(10), 8, 'missing version keeps the runner-wide legacy count');
  eq(store.getThreadReplyCount(10, { continuationVersion: 1, profileId: 'other' }), 8,
    'version 1 ignores profile identity for live counts');
  eq(store.getThreadReplyCount(10, { simulation: true }), 8,
    'legacy rehearsal calls without a profile preserve their old global fallback');
  eq(store.getThreadReplyCount(10, { continuationVersion: 1, simulation: true, profileId: legacy.id }), 5,
    'version 1 keeps isolated legacy rehearsal counts');
  eq(store.getThreadReplyCount(10, live), 0, 'version 2 starts independently of legacy live counts');
  rejects(() => store.getThreadReplyCount(10, { continuationVersion: 2 }), /profileId/,
    'version-2 reads cannot fall back to global state');
  rejects(() => store.bumpThreadReply(10, { continuationVersion: 2 }), /profileId/,
    'version-2 writes cannot fall back to global state');
  rejects(() => store.bumpThreadReply(10, live), /targetKey/, 'version-2 store writes require an attempt identity');

  eq(store.bumpThreadReply(10, { ...live, targetKey: 'live:one' }), 1, 'a version-2 live attempt is recorded');
  eq(store.bumpThreadReply(10, { ...simulation, targetKey: 'live:one' }), 1,
    'the same ID in rehearsal is independent of live history');
  eq(store.bumpThreadReply(10, { ...simulation, targetKey: 'simulation:two' }), 2,
    'rehearsal has its own count');
  eq(store.getThreadReplyCount(10, live), 1, 'rehearsal bookkeeping leaves live state intact');
  eq(store.getThreadReplyCount(10), 8, 'version-2 attempts do not modify the global legacy ledger');
  eq(store.getThreadReplyCount(10, { simulation: true, profileId: legacy.id }), 5,
    'version-2 rehearsal attempts do not modify legacy rehearsal history');

  for (let i = 0; i < 12; i++) {
    const profile = store.createProfile({ fedditUsername: 'independent_' + i });
    const options = { continuationVersion: 2, profileId: profile.id, nowMs };
    eq(store.getThreadReplyCount(10, options), 0, 'profile ' + i + ' starts independently');
    for (let attempt = 0; attempt < 3; attempt++) {
      eq(store.bumpThreadReply(10, { ...options, targetKey: 'shared-target:' + attempt }), attempt + 1,
        'profile ' + i + ' can account its own attempt ' + (attempt + 1));
    }
    eq(store.getThreadReplyCount(10, options) < guard.MAX_ATTEMPTS, false,
      'profile ' + i + ' is blocked at its own fourth attempt');
  }
  eq(store.getThreadReplyCount(10, live), 1, 'other profiles never consume the original profile allowance');

  store.updateProfile(legacy.id, {
    replyGuardState: guard.defaults(),
    simulationState: { replyGuardState: guard.defaults() },
  });
  eq(store.getThreadReplyCount(10, live), 1, 'ordinary edits cannot clear live guard state');
  eq(store.getThreadReplyCount(10, simulation), 2, 'ordinary edits cannot clear rehearsal guard state');
  const hydrated = store.getProfile(legacy.id);
  hydrated.replyGuardState.attempts.length = 0;
  hydrated.simulationState.replyGuardState.attempts.length = 0;
  eq(store.getThreadReplyCount(10, live), 1, 'hydration does not expose the mutable live journal');
  eq(store.getThreadReplyCount(10, simulation), 2, 'hydration does not expose the mutable rehearsal journal');

  delete require.cache[storePath];
  store = require('../lib/store');
  eq(store.getThreadReplyCount(10, live), 1, 'live guard survives a store restart');
  eq(store.getThreadReplyCount(10, simulation), 2, 'rehearsal guard survives a store restart');
  eq(store.bumpThreadReply(10, { ...live, nowMs: nowMs + 1000, targetKey: 'live:one' }), 1,
    'replayed bookkeeping is idempotent after restart');
  eq(store.getProfile(legacy.id).replyGuardState.attempts[0].at, nowMs,
    'replayed bookkeeping preserves the original attempt timestamp');
  eq(store.getThreadReplyCount(10, { ...live, nowMs: nowMs + guard.WINDOW_MS - 1 }), 1,
    'store reads keep the attempt immediately before expiry');
  eq(store.getThreadReplyCount(10, { ...live, nowMs: nowMs + guard.WINDOW_MS }), 0,
    'store reads expire at exactly one hour');
  eq(store.bumpThreadReply(10, { ...live, nowMs: nowMs + guard.WINDOW_MS, targetKey: 'live:one' }), 0,
    'late replay cannot renew an expired attempt');
  eq(store.getThreadReplyCount(10), 8, 'legacy counts have no new time expiry');
  eq(store.bumpThreadReply(10, { continuationVersion: 1, profileId: legacy.id }), 9,
    'legacy durable replay still increments its original global ledger');
  eq(store.bumpThreadReply(10, { continuationVersion: 1, simulation: true, profileId: legacy.id }), 6,
    'legacy rehearsal replay still increments its original profile ledger');
  eq(store.getThreadReplyCount(10, live), 1, 'legacy replay does not enter version-2 history');

  eq(store.resetSimulation(legacy.id), true, 'rehearsal reset succeeds');
  eq(store.getThreadReplyCount(10, simulation), 0, 'rehearsal reset clears only rehearsal guard history');
  eq(store.getThreadReplyCount(10, live), 1, 'rehearsal reset preserves live guard history');
  eq(store.getThreadReplyCount(10), 9, 'rehearsal reset preserves legacy live history');
  eq(store.getProfile(legacy.id).simulationState.replyGuardState, guard.defaults(),
    'reset restores versioned empty rehearsal state');
  const implicitClock = store.createProfile({ fedditUsername: 'real_clock' });
  const implicitOptions = { continuationVersion: 2, profileId: implicitClock.id, targetKey: 'clock:one' };
  eq(store.bumpThreadReply(99, implicitOptions), 1, 'store writes default to the current clock');
  eq(store.getThreadReplyCount(99, implicitOptions), 1, 'store reads default to the current clock');

  console.log('continuation-guard: ' + checks + ' checks passed');
} finally {
  delete require.cache[storePath];
  if (previousDataDir === undefined) delete process.env.FEDDIT_BOT_DATA_DIR;
  else process.env.FEDDIT_BOT_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
}
