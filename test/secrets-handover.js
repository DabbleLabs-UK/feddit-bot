'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-secrets-handover-'));
process.env.FEDDIT_BOT_DATA_DIR = tempDir;

try {
  const secrets = require('../lib/secrets');
  const profileId = 'profile_move';
  const oldToken = 'feddit_' + '01'.repeat(32);
  const replacement = 'feddit_' + 'ab'.repeat(32);

  assert.equal(secrets.empty().schemaVersion, 3);
  secrets.setFedditToken(profileId, oldToken);
  const staged = secrets.stageFedditHandover(profileId, replacement);
  assert.equal(staged.status, 'staged');
  assert.equal(secrets.getFedditToken(profileId), oldToken, 'old token remains active while rotation is unconfirmed');
  assert.equal(secrets.getFedditHandover(profileId).token, replacement);
  assert.throws(() => secrets.stageFedditHandover(profileId, 'different'));

  const ready = secrets.markFedditHandoverReady(profileId);
  assert.equal(ready.status, 'ready');
  assert.equal(secrets.getFedditToken(profileId), '', 'old token is removed once replacement is confirmed');
  assert.equal(secrets.getFedditHandover(profileId).token, replacement);

  assert.equal(secrets.completeFedditHandover(profileId), true);
  assert.equal(secrets.getFedditHandover(profileId), null);
  assert.equal(secrets.completeFedditHandover(profileId), false);

  secrets.setFedditToken(profileId, oldToken);
  secrets.stageFedditHandover(profileId, replacement);
  secrets.deleteProfileSecrets(profileId);
  assert.equal(secrets.getFedditToken(profileId), '');
  assert.equal(secrets.getFedditHandover(profileId), null);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('secrets-handover: all checks passed');
