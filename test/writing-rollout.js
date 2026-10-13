'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const rollout = require('../lib/writing-rollout');

assert.equal(rollout.RELEASED_VERSION, 1);
assert.equal(rollout.CANARY_VERSION, 3);
assert.equal(rollout.MAX_PROFILES, 3);
assert.deepEqual(rollout.defaults(), { version: 1, profileIds: [] });
const selected = { version: 1, profileIds: ['first', 'Second_2', 'third-3'] };
const normalized = rollout.normalize(selected);
assert.deepEqual(normalized, selected);
assert.notEqual(normalized.profileIds, selected.profileIds, 'normalization returns an independent list');
for (const malformed of [undefined, null, false, [], {}, { version: 1 },
  { version: '1', profileIds: ['first'] }, { version: 2, profileIds: ['first'] },
  { version: 1, profileIds: ['first'], enabled: true }]) {
  assert.deepEqual(rollout.normalize(malformed), rollout.defaults());
}
for (const ids of [undefined, null, false, {}, 'first', [''], [1], ['a b'], ['a/b'], ['a.b'], ['a\n'],
  ['a\r'], ['\u00e9'], ['a'.repeat(101)], ['first', 'first'], ['first', null], new Array(1),
  ['first', 'second', 'third', 'fourth']]) {
  assert.throws(() => rollout.validateProfileIds(ids), { code: 'INVALID_WRITING_CANARY' });
  assert.deepEqual(rollout.normalize({ version: 1, profileIds: ids }), rollout.defaults(), 'malformed lists fail closed entirely');
}
assert.deepEqual(rollout.validateProfileIds(['a'.repeat(100)]), ['a'.repeat(100)]);
assert.equal(rollout.select(undefined, 'first', { kind: 'ordinary' }), 1);
assert.equal(rollout.select({ writingCanary: selected }, 'first', { kind: 'ordinary' }), 3);
assert.equal(rollout.select({ writingCanary: selected }, 'First', { kind: 'ordinary' }), 1);
assert.equal(rollout.select({ writingCanary: selected }, 'missing', { kind: 'ordinary' }), 1);
for (const kind of [undefined, null, '', 'burst', 'manual', 'preview', 'simulation', 'ordinary-burst', 'ORDINARY']) {
  assert.equal(rollout.select({ writingCanary: selected }, 'first', { kind }), 1, 'only ordinary turns are eligible');
}
assert.equal(rollout.select({ writingCanary: selected }, 'first'), 1);
assert.equal(rollout.select({ writingCanary: rollout.defaults() }, 'first', { kind: 'ordinary' }), 1, 'removal restores released writing');

// Real store writes stay in this fixture directory; separate Node processes
// verify both the disk contract and restart behavior without loading live data.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-writing-rollout-'));
const root = path.resolve(__dirname, '..');
function run(source) {
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, FEDDIT_BOT_DATA_DIR: dir },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
try {
  assert.deepEqual(run("console.log(JSON.stringify(require('./lib/store').getSettings().writingCanary))"), rollout.defaults());
  const initial = run("const s=require('./lib/store');s.createProfile({refName:'fixture',enabled:false,dryRun:true});s.updateSettings({paused:true});console.log(JSON.stringify({settings:s.getSettings(),profiles:s.listProfiles(),schema:s.DATA_SCHEMA_VERSION}))");
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
  const id = initial.profiles[0].id;
  assert.deepEqual(run("const s=require('./lib/store');console.log(JSON.stringify(s.updateSettings({writingCanary:{version:1,profileIds:[" + JSON.stringify(id) + "]}}).writingCanary))"), { version: 1, profileIds: [id] });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
  assert.equal(after.schemaVersion, before.schemaVersion, 'no schema migration');
  assert.deepEqual(after.profiles, before.profiles, 'enrollment does not edit profiles or deadlines');
  assert.deepEqual(after.groups, before.groups, 'enrollment does not edit groups');
  assert.deepEqual({ ...after.settings, writingCanary: before.settings.writingCanary }, before.settings, 'only enrollment changes');
  assert.deepEqual(run("console.log(JSON.stringify(require('./lib/store').getSettings().writingCanary))"), { version: 1, profileIds: [id] }, 'enrollment survives process restart');
  assert.deepEqual(run("const s=require('./lib/store');console.log(JSON.stringify(s.updateSettings({writingCanary:{version:1,profileIds:['valid','bad id']}}).writingCanary))"), rollout.defaults(), 'updates normalize malformed config without partial enrollment');
  const corrupt = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
  corrupt.settings.writingCanary = { version: 1, profileIds: [id, 'bad id'] };
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify(corrupt));
  assert.deepEqual(run("console.log(JSON.stringify(require('./lib/store').getSettings().writingCanary))"), rollout.defaults(), 'restart normalizes malformed stored config');
  assert.deepEqual(run("const s=require('./lib/store');console.log(JSON.stringify(s.updateSettings({writingCanary:{version:1,profileIds:[]}}).writingCanary))"), rollout.defaults());
  assert.deepEqual(run("console.log(JSON.stringify(require('./lib/store').getSettings().writingCanary))"), rollout.defaults(), 'removal survives restart');
  console.log('PASS writing rollout: bounded strict enrollment, fail-closed config, ordinary-only selection, Burst/manual released, isolated store persistence and no profile mutation');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
