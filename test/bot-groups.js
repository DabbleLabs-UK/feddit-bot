'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-bot-groups-'));
const previousDataDir = process.env.FEDDIT_BOT_DATA_DIR;
process.env.FEDDIT_BOT_DATA_DIR = dir;
let store = require('../lib/store');
let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function reload() {
  delete require.cache[require.resolve('../lib/store')];
  store = require('../lib/store');
}
function withoutGroup(profile) {
  const copy = structuredClone(profile);
  delete copy.groupId;
  return copy;
}

try {
  const first = { ownerId: 'owner-first' };
  const second = { ownerId: 'owner-second' };
  eq(store.listGroups(), [], 'new desktop workspace has no groups');
  eq(store.profileDefaults().groupId, '', 'new profiles default to ungrouped');
  const desktop = store.createGroup(' Desktop ');
  const group = store.createGroup(' First ', { ...first, id: 'import-stable-first' });
  const other = store.createGroup('Second', second);
  eq(group.name, 'First', 'group names are trimmed');
  eq(store.listGroups().map((item) => item.id), [desktop.id], 'desktop cannot list hosted groups');
  eq(store.listGroups(first).map((item) => item.id), [group.id], 'owner sees only its own group');
  eq(store.listGroups(second).map((item) => item.id), [other.id], 'other owner has an independent list');
  eq(store.createGroup('Ignored', { ...first, id: group.id }), group, 'stable import id is idempotent');
  eq(store.createGroup('Collision', { ...second, id: group.id }), null, 'stable id cannot claim another owner group');
  eq(store.listGroups(first).length, 1, 'stable import does not duplicate a group');
  assert.throws(() => store.createGroup('   ', first), /Group name/);
  assert.throws(() => store.createGroup('x'.repeat(81), first), /Group name/);
  assert.throws(() => store.createGroup('Bad id', { ...first, id: '../bad' }), /Group id/);
  checks += 3;
  const listed = store.listGroups(first)[0];
  listed.name = 'Mutated by caller';
  eq(store.listGroups(first)[0].name, 'First', 'returned group objects cannot mutate stored groups');

  const profile = store.createProfile({
    ...first, persona: 'Keep this character', enabled: true, dryRun: false,
    canReply: true, canStartDiscussions: true, canShareLinks: true, canVote: true,
    postsPerHour: 0.125, articlePostsPerHour: 0.25, commentsPerHour: 0.75, votesPerHour: 1.5,
    sched: { ...store.schedDefaults(), nextPostAt: 123456, nextArticleAt: 234567, nextCommentAt: 345678, nextVoteAt: 456789 },
    repliedTo: ['t1_saved'], postedNews: ['https://example.test/saved'], customImportField: { keep: true },
  });
  const otherProfile = store.createProfile({ ...second, groupId: other.id });
  const desktopProfile = store.createProfile({ groupId: desktop.id });
  const before = withoutGroup(profile);
  eq(store.assignProfileGroup(profile.id, group.id, second), null, 'another owner cannot assign this profile');
  eq(store.assignProfileGroup(profile.id, group.id), null, 'desktop cannot assign hosted profiles');
  eq(store.assignProfileGroup(desktopProfile.id, desktop.id, first), null, 'hosted owner cannot assign desktop profiles');
  eq(store.assignProfileGroup(profile.id, group.id, first).groupId, group.id, 'owner can assign its own group');
  eq(withoutGroup(store.getProfile(profile.id)), before, 'assignment preserves every unrelated profile field');
  eq(store.assignProfileGroup(profile.id, other.id, first).groupId, '', 'foreign group falls back to ungrouped');
  eq(store.assignProfileGroup(profile.id, 'missing', first).groupId, '', 'unknown group falls back to ungrouped');
  eq(store.assignProfileGroup(profile.id, {}, first).groupId, '', 'malformed group falls back to ungrouped');
  eq(store.assignProfileGroup(profile.id, '', first).groupId, '', 'explicit ungrouped assignment is supported');
  store.assignProfileGroup(profile.id, group.id, first);
  eq(store.renameGroup(group.id, 'Wrong', second), null, 'foreign owner cannot rename a group');
  eq(store.renameGroup(group.id, 'Wrong'), null, 'desktop cannot rename a hosted group');
  eq(store.renameGroup(group.id, 'Renamed', first).name, 'Renamed', 'group can be renamed');
  eq(store.getProfile(profile.id).groupId, group.id, 'rename preserves stable profile assignment');
  eq(store.deleteGroup(group.id, second), false, 'foreign owner cannot delete a group');
  eq(store.deleteGroup(group.id), false, 'desktop cannot delete a hosted group');

  reload();
  eq(store.listGroups(first)[0].name, 'Renamed', 'group rename survives reload');
  eq(store.getProfile(profile.id).groupId, group.id, 'assignment survives reload');
  eq(withoutGroup(store.getProfile(profile.id)), before, 'reload preserves unrelated profile state and cadence');
  eq(store.updateProfile(profile.id, { groupId: other.id }).groupId, '', 'ordinary profile patch cannot link a foreign group');
  eq(store.createProfile({ ...first, groupId: other.id }).groupId, '', 'profile creation cannot link a foreign group');
  store.assignProfileGroup(profile.id, group.id, first);
  const count = store.listProfiles().length;
  eq(store.deleteGroup(group.id, first), true, 'owner can delete its group');
  eq(store.getProfile(profile.id).groupId, '', 'deleting a group detaches its bots');
  eq(store.listProfiles().length, count, 'deleting a group never deletes bots');
  eq(withoutGroup(store.getProfile(profile.id)), before, 'deletion preserves every unrelated profile field');
  eq(store.getProfile(otherProfile.id).groupId, other.id, 'deletion does not change another owner assignment');
  eq(store.getProfile(desktopProfile.id).groupId, desktop.id, 'deletion does not change desktop assignment');
  reload();
  eq(store.listGroups(first), [], 'group deletion survives reload');
  eq(store.getProfile(profile.id).groupId, '', 'detachment survives reload');

  const disk = JSON.parse(fs.readFileSync(store.DATA_FILE, 'utf8'));
  const original = structuredClone(disk.profiles);
  disk.schemaVersion = 25;
  delete disk.groups;
  for (const item of disk.profiles) delete item.groupId;
  fs.writeFileSync(store.DATA_FILE, JSON.stringify(disk));
  reload();
  eq(store.listGroups(), [], 'schema 25 migration adds an empty group list');
  for (const item of store.listProfiles()) {
    eq(item.groupId, '', 'schema 25 profiles migrate to ungrouped');
    const expected = original.find((saved) => saved.id === item.id);
    eq(withoutGroup(item), withoutGroup({ ...expected, token: '' }), 'migration preserves unrelated profile fields and cadence');
  }
  const migrated = JSON.parse(fs.readFileSync(store.DATA_FILE, 'utf8'));
  eq(migrated.schemaVersion, 26, 'migration persists schema 26');
  eq(migrated.groups, [], 'migration persists empty groups');

  migrated.groups = [other];
  migrated.profiles.find((item) => item.id === profile.id).groupId = other.id;
  migrated.profiles.find((item) => item.id === desktopProfile.id).groupId = 'unknown';
  fs.writeFileSync(store.DATA_FILE, JSON.stringify(migrated));
  reload();
  eq(store.getProfile(profile.id).groupId, '', 'stored foreign assignment normalizes to ungrouped');
  eq(store.getProfile(desktopProfile.id).groupId, '', 'stored missing assignment normalizes to ungrouped');
  console.log('bot-groups: ' + checks + ' checks passed');
} finally {
  if (previousDataDir === undefined) delete process.env.FEDDIT_BOT_DATA_DIR;
  else process.env.FEDDIT_BOT_DATA_DIR = previousDataDir;
  fs.rmSync(dir, { recursive: true, force: true });
}
