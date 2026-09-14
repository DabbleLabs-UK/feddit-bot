'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOwnerStore, digest } = require('../lib/owners');

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-owners-'));
try {
  let n = 0;
  const store = createOwnerStore({
    file: path.join(dir, 'owners.json'),
    randomBytes: (size) => Buffer.alloc(size, ++n),
  });
  const created = store.create();
  ok(created.id.startsWith('o_'), 'private workspace receives an opaque id');
  ok(created.accessToken.length >= 40, 'management capability has high entropy');
  ok(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/.test(created.recoveryCode), 'recovery code is copyable and high entropy');
  eq(store.authorise(created.accessToken).id, created.id, 'management capability opens its workspace');
  eq(store.authorise('wrong'), null, 'wrong capability reveals no workspace');

  const disk = fs.readFileSync(path.join(dir, 'owners.json'), 'utf8');
  ok(!disk.includes(created.accessToken), 'management capability is never stored in plaintext');
  ok(!disk.includes(created.recoveryCode), 'recovery code is never stored in plaintext');
  ok(disk.includes(digest(created.accessToken)), 'only a one-way access hash is stored');

  const activeAt = Date.parse('2026-09-14T12:00:00.000Z');
  const activity = store.issueActivity(created.id, activeAt);
  ok(activity.activityToken.length >= 40, 'activity-only capability has high entropy');
  eq(store.authoriseActivity(activity.activityToken).id, created.id, 'activity capability resolves only its workspace');
  eq(store.lastActiveAt(created.id), '2026-09-14T12:00:00.000Z', 'activity timestamp is retained without page history');
  eq(store.touchActivity(created.id, activeAt + 30 * 1000), false, 'frequent activity writes are throttled');
  eq(store.touchActivity(created.id, activeAt + 61 * 1000), true, 'later activity refreshes the workspace timestamp');
  const activityDisk = fs.readFileSync(path.join(dir, 'owners.json'), 'utf8');
  ok(!activityDisk.includes(activity.activityToken), 'activity capability is never stored in plaintext');
  ok(activityDisk.includes(digest(activity.activityToken)), 'only a one-way activity hash is stored');

  const recovered = store.recover(created.recoveryCode);
  eq(recovered.id, created.id, 'recovery returns to the same workspace');
  eq(store.authorise(created.accessToken), null, 'recovery rotates the lost management capability');
  eq(store.authorise(recovered.accessToken).id, created.id, 'rotated management capability works');
  eq(store.authoriseActivity(activity.activityToken), null, 'recovery also invalidates the old activity-only capability');
  eq(store.recover(created.recoveryCode), null, 'used recovery code is rotated too');
  ok(recovered.recoveryCode !== created.recoveryCode, 'recovery supplies a replacement recovery code');

  console.log('owners: ' + checks + ' checks passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
