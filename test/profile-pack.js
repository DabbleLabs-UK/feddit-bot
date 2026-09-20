'use strict';

const assert = require('node:assert/strict');
const packs = require('../lib/profile-pack');

const original = {
  id: 'p_private',
  fedditUsername: 'news_numbnut',
  refName: '',
  fedditBio: 'Publicly follows local stories with a suspicious eye.',
  token: 'feddit_NEVER_EXPORT_THIS',
  persona: 'A highly opinionated local-news reader.',
  toneNotes: 'Short and excitable.',
  canReply: true,
  canStartDiscussions: true,
  canShareLinks: true,
  botType: 'news',
  mode: 'post',
  postFeddits: ['localnews'],
  readFeddits: [],
  feedSort: 'controversial',
  postsPerHour: 0.5,
  provider: 'ollama',
  model: 'machine-specific-model',
  deepseekModel: 'paid-machine-policy',
  enabled: true,
  dryRun: false,
  botOrigin: 'system',
  hostedOnboardingTurnsCompleted: 4,
  deployment: { target: 'hosted' },
  postedNews: ['https://example.com/already-posted'],
  repliedTo: ['t3_12'],
  attentionState: { cursor: { comments: 44, posts: 9 }, seenEventIds: ['t1_43'] },
  socialState: {
    relationships: {
      alice: { account: 'alice', interactionCount: 2, lastAt: 100, recentEvents: [] },
    },
    seenEventIds: ['live:incoming:t1_43'],
  },
  memoryState: {
    episodes: [{ id: 'live:reply:100', at: 100, kind: 'reply', direction: 'outgoing', summary: 'Replied to Alice about local parks.' }],
    claims: [], conflicts: [], preoccupations: { parks: { weight: 1.2, lastAt: 100, evidenceCount: 1 } },
    seenEventIds: ['live:reply:100'],
  },
  sched: { nextPostAt: 1234 },
  activity: [{ at: '2026-09-12T12:00:00Z', kind: 'post', ok: true }],
  simulationState: { sched: { nextPostAt: 5678 }, repliedTo: ['t3_simulated'] },
};

const moved = packs.exportProfile(original);
assert.equal(moved.format, packs.FORMAT);
assert.equal(moved.version, packs.VERSION);
assert.equal(moved.kind, 'move');
assert.equal(moved.bot.persona, original.persona);
assert.equal(moved.bot.fedditBio, original.fedditBio);
assert.equal(moved.bot.canReply, true);
assert.equal(moved.bot.canStartDiscussions, true);
assert.equal(moved.bot.canShareLinks, true);
assert.deepEqual(moved.runtime.postedNews, original.postedNews);
assert.deepEqual(moved.runtime.attentionState, original.attentionState);
assert.deepEqual(moved.runtime.socialState, original.socialState);
assert.deepEqual(moved.runtime.memoryState, original.memoryState);
assert.equal(moved.bot.feedSort, 'controversial');
assert.deepEqual(moved.runtime.simulationState, original.simulationState);
assert.equal('token' in moved.bot, false);
assert.equal('token' in moved.runtime, false);
assert.equal('provider' in moved.bot, false);
assert.equal('model' in moved.bot, false);
assert.equal('deepseekModel' in moved.bot, false);
assert.deepEqual(moved.executionPreference, { localModel: 'machine-specific-model' });
assert.equal('enabled' in moved.bot, false);
assert.equal('dryRun' in moved.bot, false);
assert.equal('deployment' in moved.bot, false);
assert.equal('botOrigin' in moved.bot, false);
assert.equal('botOrigin' in moved.runtime, false);
assert.equal('hostedOnboardingTurnsCompleted' in moved.runtime, false);
assert.equal(JSON.stringify(moved).includes('NEVER_EXPORT_THIS'), false);
assert.equal(JSON.stringify(moved).includes('machine-specific-model'), true);

const imported = packs.importPatch(moved);
assert.equal(imported.persona, original.persona);
assert.equal(imported.fedditBio, original.fedditBio);
assert.equal(imported.canReply, true);
assert.equal(imported.canStartDiscussions, true);
assert.equal(imported.canShareLinks, true);
assert.deepEqual(imported.postedNews, original.postedNews);
assert.deepEqual(imported.attentionState, original.attentionState);
assert.deepEqual(imported.socialState, original.socialState);
assert.deepEqual(imported.memoryState, original.memoryState);
assert.equal(imported.feedSort, 'controversial');
assert.deepEqual(imported.simulationState, original.simulationState);
assert.equal(imported.enabled, false);
assert.equal('dryRun' in imported, false, 'a moved bot starts from the destination safe default');
assert.equal(imported.provider, 'ollama');
assert.equal(imported.model, 'machine-specific-model');
assert.equal('token' in imported, false);
assert.equal('botOrigin' in imported, false, 'portable files cannot assert shared-capacity provenance');
assert.equal('hostedOnboardingTurnsCompleted' in imported, false, 'portable files cannot carry destination onboarding priority');

const template = packs.exportProfile(original, { template: true });
assert.equal(template.kind, 'template');
assert.equal(template.sourceProfileId, null);
assert.equal(template.bot.fedditUsername, '');
assert.equal(template.bot.fedditBio, original.fedditBio);
assert.equal('runtime' in template, false);
assert.equal(JSON.stringify(template).includes('Replied to Alice'), false, 'templates exclude autobiographical runtime memory');
assert.deepEqual(template.executionPreference, { localModel: 'machine-specific-model' });

const cloudProfile = packs.exportProfile({ ...original, provider: 'deepseek', model: 'runner-private-cloud-model' });
assert.equal('executionPreference' in cloudProfile, false, 'cloud placement details stay destination-specific');
assert.equal(JSON.stringify(cloudProfile).includes('runner-private-cloud-model'), false);

assert.deepEqual(packs.validate(null), {
  ok: false,
  error: 'The bot profile must be a JSON object.',
});
assert.equal(packs.validate({ format: 'something-else', version: 1, bot: {} }).ok, false);

const replacementToken = 'feddit_' + 'ab'.repeat(32);
const handover = packs.createHandover(original, replacementToken);
assert.equal(handover.format, packs.HANDOVER_FORMAT);
assert.equal(handover.version, packs.HANDOVER_VERSION);
assert.equal(handover.fedditToken, replacementToken);
assert.equal(handover.profilePack.bot.persona, original.persona);
assert.equal(handover.profilePack.bot.fedditBio, original.fedditBio);
assert.equal(handover.profilePack.bot.provider, undefined);
assert.deepEqual(handover.profilePack.executionPreference, { localModel: 'machine-specific-model' });
assert.equal(packs.validateHandover(handover).ok, true);
const handedIn = packs.importHandoverPatch(handover);
assert.equal(handedIn.token, replacementToken);
assert.equal(handedIn.enabled, false);
assert.equal(handedIn.persona, original.persona);
assert.equal(handedIn.fedditBio, original.fedditBio);
assert.equal(handedIn.provider, 'ollama');
assert.equal(handedIn.model, 'machine-specific-model');
assert.equal(packs.validateHandover({ ...handover, fedditToken: 'not-a-token' }).ok, false);
assert.throws(() => packs.createHandover(original, 'not-a-token'));
assert.equal(packs.validate({
  format: packs.FORMAT,
  version: packs.VERSION,
  kind: 'template',
  bot: { fedditBio: 'x'.repeat(501) },
}).ok, false, 'portable biographies cannot exceed Feddit\'s limit');
assert.equal(packs.validate({
  format: packs.FORMAT,
  version: packs.VERSION,
  kind: 'move',
  bot: {},
  executionPreference: { localModel: 'bad\nmodel' },
}).ok, false, 'portable local-model preferences reject control characters');

console.log('profile-pack: all checks passed');
