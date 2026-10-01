'use strict';

const assert = require('node:assert/strict');
const saveState = require('../public/ui-save-state');

const original = { profile: '{"persona":"one"}', biography: 'bio' };
const changed = { profile: '{"persona":"two"}', biography: 'bio' };

assert.equal(saveState.snapshotsEqual(original, { ...original }), true);
assert.equal(saveState.snapshotsEqual(original, changed), false);

assert.deepEqual(
  saveState.resolveConfirmedSave(changed, { ...changed }, 4, 4),
  { dirty: false, phase: 'saved', message: 'Saved' },
  'a confirmed response clears dirty state only when the current editor still matches the saved payload',
);
assert.deepEqual(
  saveState.resolveConfirmedSave(changed, original, 4, 5),
  { dirty: true, phase: 'dirty', message: 'Newer changes are still unsaved' },
  'typing during an in-flight save cannot be reported as fully saved',
);

assert.deepEqual(
  saveState.resolveFailedSave('network unavailable'),
  { dirty: true, phase: 'error', message: 'Save failed - network unavailable' },
  'a failed request remains dirty and exposes a concise retry reason',
);

assert.equal(saveState.dirtyControlVisible(false, 'clean'), false, 'clean editors do not show an intrusive save control');
assert.equal(saveState.dirtyControlVisible(true, 'dirty'), true, 'editing reveals the reachable save control');
assert.equal(saveState.dirtyControlVisible(false, 'saving'), true, 'save progress stays visible');
assert.equal(saveState.dirtyControlVisible(false, 'saved'), true, 'confirmed success can be acknowledged transiently');
assert.equal(saveState.dirtyControlVisible(true, 'error'), true, 'failure keeps retry reachable');

const token = { sequence: 7, profileId: 'bot-a' };
assert.equal(saveState.isSaveCurrent(token, 7, 'bot-a'), true);
assert.equal(saveState.isSaveCurrent(token, 8, 'bot-a'), false, 'an older response loses to a later save');
assert.equal(saveState.isSaveCurrent(token, 7, 'bot-b'), false, 'a response for another bot cannot clear its state');

assert.equal(saveState.shouldWarnBeforeUnload(false, null), false);
assert.equal(saveState.shouldWarnBeforeUnload(true, null), true);
assert.equal(saveState.shouldWarnBeforeUnload(false, Promise.resolve()), true);

console.log('ui-save-state: all checks passed');
