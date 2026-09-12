'use strict';

const assert = require('node:assert/strict');
const packs = require('../lib/profile-pack');

const original = {
  id: 'p_private',
  fedditUsername: 'news_numbnut',
  refName: '',
  token: 'feddit_NEVER_EXPORT_THIS',
  persona: 'A highly opinionated local-news reader.',
  toneNotes: 'Short and excitable.',
  botType: 'news',
  mode: 'post',
  postFeddits: ['localnews'],
  readFeddits: [],
  postsPerHour: 0.5,
  provider: 'deepseek',
  model: 'machine-specific-model',
  deepseekModel: 'paid-machine-policy',
  enabled: true,
  deployment: { target: 'hosted' },
  postedNews: ['https://example.com/already-posted'],
  repliedTo: ['t3_12'],
  sched: { nextPostAt: 1234 },
  activity: [{ at: '2026-09-12T12:00:00Z', kind: 'post', ok: true }],
};

const moved = packs.exportProfile(original);
assert.equal(moved.format, packs.FORMAT);
assert.equal(moved.version, packs.VERSION);
assert.equal(moved.kind, 'move');
assert.equal(moved.bot.persona, original.persona);
assert.deepEqual(moved.runtime.postedNews, original.postedNews);
assert.equal('token' in moved.bot, false);
assert.equal('token' in moved.runtime, false);
assert.equal('provider' in moved.bot, false);
assert.equal('model' in moved.bot, false);
assert.equal('deepseekModel' in moved.bot, false);
assert.equal('enabled' in moved.bot, false);
assert.equal('deployment' in moved.bot, false);
assert.equal(JSON.stringify(moved).includes('NEVER_EXPORT_THIS'), false);
assert.equal(JSON.stringify(moved).includes('machine-specific-model'), false);

const imported = packs.importPatch(moved);
assert.equal(imported.persona, original.persona);
assert.deepEqual(imported.postedNews, original.postedNews);
assert.equal(imported.enabled, false);
assert.equal('provider' in imported, false);
assert.equal('token' in imported, false);

const template = packs.exportProfile(original, { template: true });
assert.equal(template.kind, 'template');
assert.equal(template.sourceProfileId, null);
assert.equal(template.bot.fedditUsername, '');
assert.equal('runtime' in template, false);

assert.deepEqual(packs.validate(null), {
  ok: false,
  error: 'The bot profile must be a JSON object.',
});
assert.equal(packs.validate({ format: 'something-else', version: 1, bot: {} }).ok, false);

console.log('profile-pack: all checks passed');
