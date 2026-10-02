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

  assert.equal(secrets.empty().schemaVersion, 5);
  const fetchLayerKey = 'fetchlayer-fixture-private-key';
  assert.deepEqual(secrets.publicFetchLayerView(), { hasKey: false });
  secrets.setFetchLayerKey(fetchLayerKey);
  assert.equal(secrets.getFetchLayerKey(), fetchLayerKey, 'FetchLayer key is available only through the protected store');
  assert.deepEqual(secrets.publicFetchLayerView(), { hasKey: true });
  assert.equal(JSON.stringify(secrets.publicFetchLayerView()).includes(fetchLayerKey), false,
    'FetchLayer public state never returns the stored key');
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

  const hostId = secrets.ensureChatgptHostId();
  assert.match(hostId, /^urn:uuid:/);
  secrets.saveChatgptRegistration('account-one', {
    clientId: 'oaiapp_test',
    subject: 'subject-one',
    email: 'person@example.test',
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    idToken: 'identity-secret',
    expiresAt: Date.now() + 60000,
    scopes: ['openid', 'chatgpt.tokens.use.direct'],
    models: [{ id: 'gpt-test', label: 'GPT Test' }],
  });
  const active = secrets.getActiveChatgptRegistration();
  assert.equal(active.clientId, 'oaiapp_test');
  assert.equal(active.refreshToken, 'refresh-secret', 'protected store retains the refresh credential');
  const safeView = secrets.publicChatgptView();
  assert.equal(safeView.accounts[0].email, 'person@example.test');
  assert.equal(JSON.stringify(safeView).includes('access-secret'), false, 'public account state excludes access tokens');
  assert.equal(JSON.stringify(safeView).includes('refresh-secret'), false, 'public account state excludes refresh tokens');
  assert.equal(JSON.stringify(safeView).includes('identity-secret'), false, 'public account state excludes ID tokens');
  assert.equal(secrets.deleteChatgptRegistration('account-one'), true);
  assert.equal(secrets.getActiveChatgptRegistration(), null);
  secrets.clearFetchLayerKey();
  assert.deepEqual(secrets.publicFetchLayerView(), { hasKey: false });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('secrets-handover: all checks passed');
