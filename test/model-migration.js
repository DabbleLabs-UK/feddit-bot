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

const legacyArticleCadence = store.migrateProfiles([{
  id: 'legacy-article-cadence',
  botType: 'news',
  mode: 'post',
  postsPerHour: 6,
  newsMinGapMinutes: 30,
  sched: { nextPostAt: 123456, nextArticleAt: null },
  simulationState: { sched: { nextPostAt: 654321, nextArticleAt: null } },
}], 18)[0];
assert.equal(legacyArticleCadence.postsPerHour, 0,
  'a legacy link-only bot does not gain text-post activity');
assert.equal(legacyArticleCadence.articlePostsPerHour, 2,
  'the old 30-minute article gap becomes a safe 2-article-per-hour cadence');
assert.equal('newsMinGapMinutes' in legacyArticleCadence, false,
  'the retired parallel article cadence field is removed');
assert.equal(legacyArticleCadence.sched.nextArticleAt, 123456,
  'a link-only bot keeps its existing live due time on the article timer');
assert.equal(legacyArticleCadence.sched.nextPostAt, null,
  'the obsolete link-only text timer is cleared');
assert.equal(legacyArticleCadence.simulationState.sched.nextArticleAt, 654321,
  'a link-only bot keeps its rehearsal due time on the article timer');

const slowerLegacyArticle = store.migrateProfiles([{
  id: 'slower-legacy-article',
  canReply: false,
  canStartDiscussions: false,
  canShareLinks: true,
  postsPerHour: 0.05,
  newsMinGapMinutes: 30,
}], 18)[0];
assert.equal(slowerLegacyArticle.postsPerHour, 0,
  'a link-only bot keeps no text-post cadence');
assert.equal(slowerLegacyArticle.articlePostsPerHour, 0.05,
  'a low existing article rate is never raised by the migration');

const ordinaryCadence = store.migrateProfiles([{
  id: 'ordinary-cadence',
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: false,
  postsPerHour: 0.2,
  commentsPerHour: 1,
  newsMinGapMinutes: 1,
}], 18)[0];
assert.equal(ordinaryCadence.postsPerHour, 0.2, 'ordinary post cadence is unchanged');
assert.equal(ordinaryCadence.articlePostsPerHour, 0, 'ordinary bots gain no article cadence');
assert.equal(ordinaryCadence.commentsPerHour, 1, 'reply cadence remains independent');
assert.equal('newsMinGapMinutes' in ordinaryCadence, false, 'obsolete fields are purged from every profile');

const schema19Mixed = store.migrateProfiles([{
  id: 'schema-19-mixed',
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: true,
  postsPerHour: 0.4,
  commentsPerHour: 0.7,
}], 19)[0];
assert.equal(schema19Mixed.postsPerHour, 0.2,
  'an unrecoverable schema-19 mixed cadence is conservatively split into text posts');
assert.equal(schema19Mixed.articlePostsPerHour, 0.2,
  'an unrecoverable schema-19 mixed cadence is conservatively split into article posts');
assert.equal(schema19Mixed.postsPerHour + schema19Mixed.articlePostsPerHour, 0.4,
  'migration never increases the former aggregate posting cadence');

const legacyMixed = store.migrateProfiles([{
  id: 'legacy-mixed',
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: true,
  postsPerHour: 6,
  newsMinGapMinutes: 30,
}], 18)[0];
assert.equal(legacyMixed.articlePostsPerHour, 2,
  'an older mixed record recovers its reliable article ceiling');
assert.equal(legacyMixed.postsPerHour, 4,
  'the remaining old shared rate is available to text posts');
assert.equal(legacyMixed.postsPerHour + legacyMixed.articlePostsPerHour, 6,
  'recovering an old article ceiling does not increase aggregate posting cadence');

const unlimitedLegacyMixed = store.migrateProfiles([{
  id: 'legacy-mixed-zero-gap',
  canReply: false,
  canStartDiscussions: true,
  canShareLinks: true,
  postsPerHour: 0.5,
  newsMinGapMinutes: 0,
}], 18)[0];
assert.equal(unlimitedLegacyMixed.postsPerHour, 0,
  'an explicit zero legacy gap does not invent a hidden 30-minute limit');
assert.equal(unlimitedLegacyMixed.articlePostsPerHour, 0.5,
  'an explicit zero legacy gap safely keeps the old aggregate rate on article activity');

console.log('model-migration: all checks passed');
