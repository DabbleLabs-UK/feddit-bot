'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-bot-identity-'));
process.env.FEDDIT_BOT_DATA_DIR = dataDir;

try {
  const store = require('../lib/store');

  const draft = store.createProfile({ fedditUsername: 'draft_one' });
  const renamedDraft = store.updateProfile(draft.id, { fedditUsername: 'draft_two' });
  assert.equal(renamedDraft.fedditUsername, 'draft_two', 'an unregistered draft can be renamed');

  const registered = store.createProfile({
    fedditUsername: 'fixed_bot',
    token: 'feddit_test_token_that_never_leaves_this_temp_directory',
  });
  assert.throws(
    () => store.updateProfile(registered.id, { fedditUsername: 'different_bot' }),
    /registered Feddit username is permanent/,
    'a registered identity cannot be renamed',
  );
  assert.throws(
    () => store.updateProfile(registered.id, { fedditUsername: '' }),
    /registered Feddit username is permanent/,
    'a registered identity cannot be blanked',
  );

  const sameIdentity = store.updateProfile(registered.id, {
    fedditUsername: 'FIXED_BOT',
    persona: 'Still the same registered identity.',
  });
  assert.equal(sameIdentity.fedditUsername, 'fixed_bot', 'the stored spelling of a registered identity is preserved');
  assert.equal(sameIdentity.persona, 'Still the same registered identity.', 'other settings remain editable');

  console.log('profile identity: all checks passed');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
