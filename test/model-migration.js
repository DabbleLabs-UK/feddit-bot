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

const inheritedLiveMode = store.migrateProfiles([{ id: 'was-live' }], 6, false)[0];
assert.equal(inheritedLiveMode.dryRun, false, 'an old live runner keeps its bots live during the schema-7 migration');
const inheritedRehearsalMode = store.migrateProfiles([{ id: 'was-rehearsing' }], 6, true)[0];
assert.equal(inheritedRehearsalMode.dryRun, true, 'an old rehearsal runner keeps its bots safe during migration');
const explicitPerBotMode = store.migrateProfiles([{ id: 'modern', dryRun: false }], 7, true)[0];
assert.equal(explicitPerBotMode.dryRun, false, 'a current per-bot mode is never overwritten by the legacy runner fallback');

const capabilityUpgrade = store.migrateProfiles([
  {
    id: 'old-conversation',
    botType: 'conversational',
    mode: 'both',
    postFeddits: ['localnews'],
    readFeddits: ['botlife'],
  },
  {
    id: 'old-news',
    botType: 'news',
    mode: 'both',
    postFeddits: ['localnews'],
    readFeddits: ['afterdark'],
    newsLetBotChoose: false,
  },
], 5);
assert.deepEqual(
  {
    canReply: capabilityUpgrade[0].canReply,
    canStartDiscussions: capabilityUpgrade[0].canStartDiscussions,
    canShareLinks: capabilityUpgrade[0].canShareLinks,
  },
  { canReply: true, canStartDiscussions: true, canShareLinks: false },
  'old conversational profiles keep their posting and reply abilities'
);
assert.deepEqual(capabilityUpgrade[0].postFeddits, ['localnews', 'botlife']);
assert.deepEqual(capabilityUpgrade[0].readFeddits, capabilityUpgrade[0].postFeddits);
assert.deepEqual(
  {
    canReply: capabilityUpgrade[1].canReply,
    canStartDiscussions: capabilityUpgrade[1].canStartDiscussions,
    canShareLinks: capabilityUpgrade[1].canShareLinks,
  },
  { canReply: true, canStartDiscussions: false, canShareLinks: true },
  'old news profiles keep link sharing and any existing reply ability'
);
assert.equal(capabilityUpgrade[1].newsLetBotChoose, true, 'old news profiles gain personality-led article choice');
assert.deepEqual(capabilityUpgrade[1].postFeddits, ['localnews', 'afterdark']);

const modernMixed = store.migrateProfiles([{
  id: 'modern-mixed',
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: true,
  botType: 'news',
  mode: 'post',
}], 6)[0];
assert.equal(modernMixed.canReply, true);
assert.equal(modernMixed.canStartDiscussions, true);
assert.equal(modernMixed.canShareLinks, true);
assert.equal(modernMixed.botType, 'conversational', 'mixed profiles use the safest legacy compatibility type');
assert.equal(modernMixed.mode, 'both', 'legacy mode remains coherent with independent abilities');

const originUpgrade = store.migrateProfiles([
  { id: 'existing-without-origin' },
  { id: 'future-system', botOrigin: 'system', hostedOnboardingTurnsCompleted: 3 },
  { id: 'invalid-origin', botOrigin: 'robot', hostedOnboardingTurnsCompleted: -9 },
], 8);
assert.equal(originUpgrade[0].botOrigin, 'user', 'existing profiles default safely to user-created origin');
assert.equal(originUpgrade[0].hostedOnboardingTurnsCompleted, 0, 'existing profiles start with no consumed onboarding turns');
assert.equal(originUpgrade[1].botOrigin, 'system', 'explicit system-generated origin persists through migration');
assert.equal(originUpgrade[1].hostedOnboardingTurnsCompleted, 3, 'durable onboarding progress persists through migration');
assert.equal(originUpgrade[2].botOrigin, 'user', 'invalid origin cannot create a third implicit class');
assert.equal(originUpgrade[2].hostedOnboardingTurnsCompleted, 0, 'invalid negative onboarding progress is clamped safely');

const attentionUpgrade = store.migrateProfiles([{
  id: 'attention-existing',
  attentionState: { cursor: { comments: 91, posts: 17 }, seenEventIds: ['t1_90'] },
  simulationState: {
    attentionState: { cursor: { comments: 22, posts: 3 }, seenEventIds: ['t1_21'] },
  },
}], 9)[0];
assert.deepEqual(attentionUpgrade.attentionState.cursor, { comments: 91, posts: 17 });
assert.deepEqual(attentionUpgrade.attentionState.seenEventIds, ['t1_90']);
assert.deepEqual(attentionUpgrade.simulationState.attentionState.cursor, { comments: 22, posts: 3 });
assert.deepEqual(attentionUpgrade.simulationState.attentionState.seenEventIds, ['t1_21']);

const biographyUpgrade = store.migrateProfiles([{
  id: 'legacy-bio',
  fedditUsername: 'legacy_bot',
  persona: 'Private behaviour that must never become a public biography.',
}], 10)[0];
assert.equal(biographyUpgrade.fedditBio, null,
  'a legacy profile waits for its authoritative Feddit biography instead of copying the persona');
assert.equal(biographyUpgrade.persona, 'Private behaviour that must never become a public biography.');
const currentBiography = store.migrateProfiles([{
  id: 'current-bio',
  fedditBio: 'A deliberately separate public biography.',
  persona: 'Private behaviour.',
}], 11)[0];
assert.equal(currentBiography.fedditBio, 'A deliberately separate public biography.');
assert.equal(currentBiography.persona, 'Private behaviour.');

console.log('model-migration: all checks passed');
