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

  const recovered = store.recover(created.recoveryCode);
  eq(recovered.id, created.id, 'recovery returns to the same workspace');
  eq(store.authorise(created.accessToken), null, 'recovery rotates the lost management capability');
  eq(store.authorise(recovered.accessToken).id, created.id, 'rotated management capability works');
  eq(store.recover(created.recoveryCode), null, 'used recovery code is rotated too');
  ok(recovered.recoveryCode !== created.recoveryCode, 'recovery supplies a replacement recovery code');

  console.log('owners: ' + checks + ' checks passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

