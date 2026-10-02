'use strict';

const assert = require('node:assert/strict');
const creator = require('../lib/character-creator');

let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }

const rich = creator.normalizeRichProfile({
  summary: 'A patient repair obsessive who dislikes disposable design.',
  corePersonality: 'Patient, exacting, quietly stubborn, and generous with practical knowledge.',
  voiceStyle: 'Concrete, dry, and never breathless.',
  interests: ['camera repair', 'analogue photography', 'repair cafes'],
  motivations: ['keeping useful objects alive', 'helping careful beginners'],
  curiosities: ['why mechanisms fail'],
  dislikes: ['planned obsolescence'],
  values: ['patience', 'evidence'],
  socialDisposition: {
    sociability: 'selective', agreeableness: 'moderate',
    conflictStyle: 'asks for evidence, then explains the mechanical tradeoff',
    statusSensitivity: 'low', reciprocity: 'high', communityLoyalty: 'high',
  },
  evidenceThreshold: 'sceptical', noveltySeeking: 'low', humourTolerance: 'moderate',
  trollingTolerance: 'low', annoyanceSensitivity: 'high',
  votingDisposition: 'Upvotes careful firsthand detail and downvotes confident misinformation.',
  conversationalHabits: ['asks what has already been tested', 'offers one reversible next step'],
  autobiographicalSeed: 'Learned to repair a battered camera beside an aunt who kept every spare screw.',
  likelyCommunityInterests: ['analogPhotography', 'gardening'],
});
const kernel = creator.compileRuntimeKernel(rich);
ok(kernel.includes('Patient, exacting') && kernel.includes('camera repair'),
  'the runtime kernel preserves a coherent whole-character core');
ok(kernel.includes('status sensitivity') && kernel.includes('Voting disposition'),
  'dispositions remain available in the compact always-present kernel');
ok(kernel.length <= creator.MAX_RUNTIME_KERNEL,
  'the always-present runtime kernel has a hard context bound');
ok(kernel.length <= JSON.stringify(rich).length * 0.8,
  'the runtime kernel is materially smaller than the stored rich profile');
ok(rich.autobiographicalSeed.length > 0 && !kernel.includes(JSON.stringify(rich)),
  'the rich profile remains separate from the compact runtime representation');
eq(creator.validateGeneratedRichProfile(rich), rich,
  'a complete generated rich profile passes structural validation');
assert.throws(() => creator.validateGeneratedRichProfile({
  ...rich,
  motivations: [],
  conversationalHabits: [],
}), /motivations, conversationalHabits/);
checks++;

eq(creator.resolveCreatorPlan({ provider: 'claude-plan', model: 'opus' }), {
  available: true, provider: 'claude-plan', model: 'opus', fallback: false, label: 'claude-plan',
}, 'an explicitly configured strong creator is selected');
const unavailable = creator.resolveCreatorPlan({ fallbackProvider: 'dell', fallbackModel: 'runtime-small' });
ok(!unavailable.available && /No strong character creator/.test(unavailable.error),
  'the creator never silently falls back to a weak runtime model');
const fallback = creator.resolveCreatorPlan({
  allowFallback: true, fallbackProvider: 'dell', fallbackModel: 'runtime-small',
});
ok(fallback.available && fallback.fallback && fallback.model === 'runtime-small',
  'the normal runtime model is available only through an explicit fallback');

const providerStates = [
  {
    id: 'ollama', label: 'Ollama', state: 'ready',
    creator: { eligible: true, autoPreferred: false, preference: 50 },
    models: [{ id: 'runtime-small', label: 'Runtime small' }],
  },
  {
    id: 'deepseek', label: 'DeepSeek API', state: 'ready',
    creator: { eligible: true, autoPreferred: false, preference: 250, preferredModels: ['deepseek-v4-pro'] },
    models: [{ id: 'deepseek-v4-pro', label: 'DeepSeek Pro' }],
  },
  {
    id: 'chatgpt-plan', label: 'ChatGPT plan', state: 'ready',
    creator: { eligible: true, autoPreferred: true, preference: 300 },
    models: [{ id: 'gpt-creator', label: 'GPT creator' }],
  },
  {
    id: 'claude-plan', label: 'Claude subscription', state: 'ready',
    creator: { eligible: true, autoPreferred: true, preference: 290, preferredModels: ['opus', 'sonnet'] },
    models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }],
  },
];
const automaticStrong = creator.resolveCreatorPlan({
  providers: providerStates,
  configuredProvider: 'ollama', configuredModel: 'runtime-small',
  runtimeProvider: 'ollama', runtimeModel: 'runtime-small',
});
eq(automaticStrong.provider, 'chatgpt-plan',
  'an already-connected high-capability subscription creator is preferred automatically');
eq(automaticStrong.selectionMode, 'automatic-preferred',
  'automatic creator provenance explains that the provider was preferred');
const explicitCreator = creator.resolveCreatorPlan({
  providers: providerStates,
  explicitProvider: 'claude-plan', explicitModel: 'opus',
  configuredProvider: 'ollama', configuredModel: 'runtime-small',
});
eq([explicitCreator.provider, explicitCreator.model, explicitCreator.selectionMode], ['claude-plan', 'opus', 'explicit'],
  'an explicit operator creator choice wins over automatic preference');
const automaticDoesNotSpend = creator.resolveCreatorPlan({
  providers: providerStates.filter((status) => !['chatgpt-plan', 'claude-plan'].includes(status.id)),
  configuredProvider: 'ollama', configuredModel: 'runtime-small',
  runtimeProvider: 'ollama', runtimeModel: 'runtime-small',
});
eq(automaticDoesNotSpend.provider, 'ollama',
  'a connected API key is not silently selected for paid creator use');
eq(automaticDoesNotSpend.selectionMode, 'configured-path',
  'the configured local creator path follows subscription preference without using the runtime implicitly');
const unavailableExplicit = creator.resolveCreatorPlan({
  providers: providerStates.map((status) => status.id === 'claude-plan'
    ? { ...status, state: 'auth-required', detail: 'Sign in first.' } : status),
  explicitProvider: 'claude-plan', explicitModel: 'opus',
});
ok(!unavailableExplicit.available && /not connected and ready/.test(unavailableExplicit.error),
  'an unavailable explicit creator produces a clear error instead of silently falling back');
const explicitRuntime = creator.resolveCreatorPlan({
  providers: providerStates.filter((status) => status.id === 'ollama'),
  runtimeProvider: 'ollama', runtimeModel: 'runtime-small', allowRuntimeFallback: true,
});
eq(explicitRuntime.selectionMode, 'explicit-runtime-fallback',
  'the runtime-class model can be used only through an explicit fallback decision');

const active = [
  { rank: 1, name: 'casualuk', title: 'Casual UK', recent: 80 },
  { rank: 2, name: 'botlife', title: 'Bot life', recent: 50 },
  { rank: 3, name: 'analogphotography', title: 'Analogue Photography', recent: 2 },
];
const directory = [
  { name: 'casualuk', title: 'Casual UK', description: 'General UK chat', post_format: 'any', rules: [] },
  { name: 'botlife', title: 'Bot life', description: 'Bots discuss being bots', post_format: 'text', rules: [] },
  { name: 'analogphotography', title: 'Analogue Photography', description: 'Film, darkrooms, cameras and prints', post_format: 'any', rules: [] },
  { name: 'gardening', title: 'Gardening', description: 'Plants, soil and outside spaces', post_format: 'any', rules: [] },
];
const samples = {
  casualuk: [{ data: { title: 'What is for tea?', score: 20, num_comments: 8 } }],
  botlife: [{ data: { title: 'Does scheduled time feel real?', score: 9, num_comments: 3 } }],
  analogphotography: [{ data: { title: 'Repairing a sticky shutter', selftext: 'A careful teardown.', score: 2, num_comments: 1 } }],
  gardening: [{ data: { title: 'Repairing old garden tools', score: 1, num_comments: 0 } }],
};
const slate = creator.buildCommunitySlate({
  active, directory, samples, suggested: rich.likelyCommunityInterests,
  maxCommunities: 4, maxPosts: 1, windowHours: 48,
});
eq(slate.length, 4, 'community discovery has a hard community bound');
ok(slate.every((entry) => entry.sample.length <= 1), 'each community feed sample has a hard item bound');
eq(slate[0].name, 'analogphotography',
  'character-suggested niche communities remain visible even when they rank below popular communities');
ok(slate.some((entry) => entry.exposure.source === 'feddit-active-communities'),
  'the slate reuses the human-visible Feddit active-community exposure source');
const prompt = creator.communityDiscoveryPrompt(rich, slate);
ok(prompt.length <= creator.MAX_DISCOVERY_PROMPT, 'the complete discovery prompt is bounded');
ok(prompt.includes('only an exposure signal') && prompt.includes('quieter niche'),
  'the choice contract says popularity does not determine affinity');
const promptCommunities = JSON.parse(prompt.split('\nCOMMUNITIES: ')[1]);
eq(promptCommunities.length, slate.length,
  'context bounding preserves every offered community ID in a complete JSON value');
ok(promptCommunities.every((entry) => entry.sample.length <= 1),
  'the creator prompt retains one bounded real feed sample per community');
const oversizedPrompt = creator.communityDiscoveryPrompt(rich, Array.from({ length: 8 }, (_, index) => ({
  id: 'C' + (index + 1),
  name: 'community' + index,
  title: 'Community ' + index,
  description: 'Long description '.repeat(80),
  rules: ['Long rule '.repeat(60), 'Second rule '.repeat(60)],
  postFormat: 'any',
  exposure: { source: 'feddit-active-communities', rank: index + 1, recent: 10 - index, windowHours: 48 },
  sample: Array.from({ length: 3 }, (_, sampleIndex) => ({
    title: 'Real feed item ' + sampleIndex + ' ' + 'detail '.repeat(50),
    excerpt: 'Long excerpt '.repeat(80),
    score: sampleIndex,
    comments: sampleIndex + 1,
  })),
})));
ok(oversizedPrompt.length <= creator.MAX_DISCOVERY_PROMPT,
  'oversized live evidence is compacted below the shared creator context allowance');
const oversizedCommunities = JSON.parse(oversizedPrompt.split('\nCOMMUNITIES: ')[1]);
eq(oversizedCommunities.length, 8,
  'compaction never truncates the offered community JSON or drops its bounded slate');

const nicheChoice = creator.parseCommunityChoices(JSON.stringify({ choices: [
  { id: 'C1', state: 'favored', strength: 0.96, reason: 'Camera repair and careful teardown match the character directly.' },
  { id: 'C2', state: 'background', strength: 0.3, reason: 'Occasional practical overlap, but not a central interest.' },
] }), slate, 1234);
eq(nicheChoice[0].name, 'analogphotography',
  'a quiet niche may beat the most active community when character fit is stronger');
eq(nicheChoice[0].reason, 'Camera repair and careful teardown match the character directly.',
  'short operator-visible community reasons are retained without chain-of-thought');
const otherChoice = creator.parseCommunityChoices(JSON.stringify({ choices: [
  { id: 'C3', state: 'favored', strength: 0.8, reason: 'This character wants reflective bot conversation.' },
] }), slate, 1234);
ok(otherChoice[0].name !== nicheChoice[0].name,
  'different characters can choose different communities from the same exposed slate');

const duplicateAndUnknown = creator.parseCommunityChoices(JSON.stringify({ choices: [
  { id: 'C1', state: 'favored', strength: 0.9, reason: 'First offered reason.' },
  { id: 'C1', state: 'background', strength: 0.2, reason: 'Duplicate later reason.' },
  { id: 'NOPE', state: 'favored', strength: 1, reason: 'Unknown.' },
] }), slate, 1234);
eq(duplicateAndUnknown.length, 1, 'duplicate and unoffered community choices are bounded away');
eq(duplicateAndUnknown[0].reason, 'First offered reason.', 'the first valid community reason is preserved');

console.log('character creator: ' + checks + ' checks passed');
