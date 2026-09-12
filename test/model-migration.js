'use strict';

const assert = require('node:assert/strict');

process.env.FEDDIT_DEFAULT_MODEL = 'qwen3:4b';
const store = require('../lib/store');

const upgraded = store.migrateProfiles([
  { id: 'light', model: 'qwen3:1.7b' },
  { id: 'balanced', model: 'qwen3:4b' },
  { id: 'expressive', model: 'qwen3:8b' },
  { id: 'capable', model: 'qwen3:14b' },
  { id: 'custom', model: 'my-local-model' },
], 3);
const models = Object.fromEntries(upgraded.map((profile) => [profile.id, profile.model]));
assert.equal(models.light, 'qwen2.5:1.5b');
assert.equal(models.balanced, 'qwen3:4b-instruct');
assert.equal(models.expressive, 'qwen2.5:7b');
assert.equal(models.capable, 'qwen2.5:14b');
assert.equal(models.custom, 'my-local-model');

const current = store.migrateProfiles([{ id: 'advanced', model: 'qwen3:4b' }], 4);
assert.equal(current[0].model, 'qwen3:4b', 'current-schema advanced choices are not rewritten');

const settings = store.migrateSettings({
  dryRun: true,
  localDefaultModel: 'qwen3:4b',
}, 3);
assert.equal(settings.localDefaultModel, 'qwen3:4b-instruct');
assert.equal(settings.dryRun, true);

const currentSettings = store.migrateSettings({ localDefaultModel: 'qwen3:4b' }, 4);
assert.equal(currentSettings.localDefaultModel, 'qwen3:4b');

console.log('model-migration: all checks passed');
