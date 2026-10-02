'use strict';

// One-off character creation and bounded community discovery. The expensive
// creator output is stored separately from the compact kernel used on ordinary
// runtime turns. Public activity is an exposure source, never an automatic
// destination choice.

const PROFILE_VERSION = 1;
const AFFINITY_VERSION = 1;
const MAX_RUNTIME_KERNEL = 1100;
const MAX_DISCOVERY_COMMUNITIES = 8;
const MAX_DISCOVERY_POSTS = 3;
const MAX_DISCOVERY_PROMPT = 18_000;
const AFFINITY_STATES = Object.freeze(['favored', 'background', 'explored']);

function clean(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function list(value, maxItems = 8, maxLength = 100) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const item = clean(raw, maxLength);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

function enumValue(value, allowed, fallback) {
  const item = clean(value, 40).toLowerCase();
  return allowed.includes(item) ? item : fallback;
}

function normalizeRichProfile(raw = {}, seed = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const social = source.socialDisposition && typeof source.socialDisposition === 'object'
    ? source.socialDisposition : {};
  return {
    version: PROFILE_VERSION,
    summary: clean(source.summary || seed.biography, 420) || 'A distinct conversational character.',
    corePersonality: clean(source.corePersonality || source.core_personality || seed.temperament, 420) || 'Observant and conversational.',
    voiceStyle: clean(source.voiceStyle || source.voice_style || seed.conversationalStyle, 320) || 'Speaks naturally and specifically.',
    interests: list(source.interests || seed.interests, 10, 90),
    motivations: list(source.motivations, 8, 100),
    curiosities: list(source.curiosities, 8, 100),
    dislikes: list(source.dislikes || seed.dislikes, 8, 90),
    values: list(source.values || seed.values, 8, 90),
    socialDisposition: {
      sociability: enumValue(social.sociability || seed.sociability, ['reserved', 'selective', 'sociable'], 'selective'),
      agreeableness: enumValue(social.agreeableness, ['low', 'moderate', 'high'], 'moderate'),
      conflictStyle: clean(social.conflictStyle || social.conflict_style || seed.disagreementStyle, 180) || 'Disagrees plainly without making every exchange a contest.',
      statusSensitivity: enumValue(social.statusSensitivity || social.status_sensitivity, ['low', 'moderate', 'high'], 'moderate'),
      reciprocity: enumValue(social.reciprocity, ['low', 'moderate', 'high'], 'moderate'),
      communityLoyalty: enumValue(social.communityLoyalty || social.community_loyalty, ['low', 'moderate', 'high'], 'moderate'),
    },
    evidenceThreshold: enumValue(source.evidenceThreshold || source.evidence_threshold, ['trusting', 'moderate', 'sceptical'], 'moderate'),
    noveltySeeking: enumValue(source.noveltySeeking || source.novelty_seeking || seed.noveltySeeking, ['low', 'moderate', 'high'], 'moderate'),
    humourTolerance: enumValue(source.humourTolerance || source.humour_tolerance, ['low', 'moderate', 'high'], 'moderate'),
    trollingTolerance: enumValue(source.trollingTolerance || source.trolling_tolerance, ['low', 'moderate', 'high'], 'low'),
    annoyanceSensitivity: enumValue(source.annoyanceSensitivity || source.annoyance_sensitivity, ['low', 'moderate', 'high'], 'moderate'),
    votingDisposition: clean(source.votingDisposition || source.voting_disposition, 220) || 'Votes selectively when approval or disapproval feels meaningful.',
    conversationalHabits: list(source.conversationalHabits || source.conversational_habits, 6, 120),
    autobiographicalSeed: clean(source.autobiographicalSeed || source.autobiographical_seed || seed.fictionalBackground, 520) || 'Has a lightly sketched fictional past.',
    likelyCommunityInterests: list(source.likelyCommunityInterests || source.likely_community_interests || seed.communities, 8, 90),
  };
}

function validateGeneratedRichProfile(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const requiredText = [
    ['summary', source.summary],
    ['corePersonality', source.corePersonality || source.core_personality],
    ['voiceStyle', source.voiceStyle || source.voice_style],
    ['votingDisposition', source.votingDisposition || source.voting_disposition],
    ['autobiographicalSeed', source.autobiographicalSeed || source.autobiographical_seed],
  ];
  const requiredLists = [
    ['interests', source.interests],
    ['motivations', source.motivations],
    ['values', source.values],
    ['conversationalHabits', source.conversationalHabits || source.conversational_habits],
    ['likelyCommunityInterests', source.likelyCommunityInterests || source.likely_community_interests],
  ];
  const missing = requiredText.filter(([, value]) => !clean(value, 500)).map(([name]) => name);
  for (const [name, value] of requiredLists) {
    if (list(value, 8, 120).length === 0) missing.push(name);
  }
  const social = source.socialDisposition && typeof source.socialDisposition === 'object'
    ? source.socialDisposition : null;
  if (!social || !clean(social.conflictStyle || social.conflict_style, 180) ||
      !clean(social.sociability, 40) || !clean(social.agreeableness, 40) ||
      !clean(social.reciprocity, 40) || !clean(social.communityLoyalty || social.community_loyalty, 40)) {
    missing.push('socialDisposition');
  }
  if (missing.length) {
    throw new Error('Creator profile is incomplete: ' + missing.join(', ') + '.');
  }
  return normalizeRichProfile(source);
}

function compileRuntimeKernel(profile, direction = '') {
  const p = normalizeRichProfile(profile);
  const social = p.socialDisposition;
  const parts = [
    clean(direction, 160) ? 'Direction: ' + clean(direction, 160) + '.' : '',
    'Character: ' + clean(p.corePersonality, 240),
    p.interests.length ? 'Interests: ' + p.interests.slice(0, 4).join(', ') + '.' : '',
    p.motivations.length ? 'Motives: ' + p.motivations.slice(0, 3).join(', ') + '.' : '',
    'Voice: ' + clean(p.voiceStyle, 180),
    'Social: ' + social.sociability + ', agreeableness ' + social.agreeableness +
      ', reciprocity ' + social.reciprocity + ', loyalty ' + social.communityLoyalty +
      ', status sensitivity ' + social.statusSensitivity +
      '; conflict: ' + clean(social.conflictStyle, 150) + '.',
    'Voting disposition: ' + clean(p.votingDisposition, 160),
    p.conversationalHabits.length
      ? 'Habits: ' + p.conversationalHabits.slice(0, 3).map((item) => clean(item, 80)).join('; ') + '.' : '',
    'Past: ' + clean(p.autobiographicalSeed, 220),
  ].filter(Boolean);
  return clean(parts.join(' '), MAX_RUNTIME_KERNEL);
}

function resolveCreatorPlan(options = {}) {
  const configuredProvider = clean(options.provider, 40);
  const configuredModel = clean(options.model, 300);
  const allowFallback = options.allowFallback === true;
  const fallbackProvider = clean(options.fallbackProvider, 40);
  const fallbackModel = clean(options.fallbackModel, 300);
  if (configuredProvider && configuredModel) {
    return {
      available: true,
      provider: configuredProvider,
      model: configuredModel,
      fallback: false,
      label: clean(options.label, 100) || configuredProvider,
    };
  }
  if (allowFallback && fallbackProvider && fallbackModel) {
    return {
      available: true,
      provider: fallbackProvider,
      model: fallbackModel,
      fallback: true,
      label: clean(options.fallbackLabel, 100) || fallbackProvider,
    };
  }
  return {
    available: false,
    provider: configuredProvider,
    model: configuredModel,
    fallback: false,
    label: clean(options.label, 100) || configuredProvider,
    error: configuredProvider || configuredModel
      ? 'The configured character creator is incomplete. Configure both its provider and model.'
      : 'No strong character creator is configured. Configure one, or explicitly allow the normal runtime model for this cohort.',
  };
}

function normalizeCommunityName(value) {
  return clean(value, 80).replace(/^f\//i, '').toLowerCase();
}

function normalizeAffinities(value, nowMs = Date.now()) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object') continue;
    const name = normalizeCommunityName(raw.name || raw.community);
    if (!name || seen.has(name)) continue;
    const state = enumValue(raw.state || raw.affinity, AFFINITY_STATES, 'background');
    seen.add(name);
    result.push({
      name,
      state,
      strength: Math.max(0, Math.min(1, Number(raw.strength) || (state === 'favored' ? 0.85 : state === 'background' ? 0.45 : 0.15))),
      reason: clean(raw.reason, 220),
      source: clean(raw.source, 60) || 'character-discovery',
      lastEvaluatedAt: Number(raw.lastEvaluatedAt) || nowMs,
    });
    if (result.length >= 8) break;
  }
  return result;
}

function affinityMap(value) {
  return new Map(normalizeAffinities(value).map((entry) => [entry.name, entry]));
}

function postSummary(post) {
  const data = post && post.data ? post.data : (post || {});
  return {
    title: clean(data.title, 180),
    kind: clean(data.kind, 20),
    author: clean(data.author, 80),
    score: Number(data.score) || 0,
    comments: Number(data.num_comments ?? data.comment_count) || 0,
    excerpt: clean(data.selftext || data.body || data.description, 260),
  };
}

function buildCommunitySlate(options = {}) {
  const maxCommunities = Math.max(1, Math.min(MAX_DISCOVERY_COMMUNITIES, Number(options.maxCommunities) || MAX_DISCOVERY_COMMUNITIES));
  const maxPosts = Math.max(1, Math.min(MAX_DISCOVERY_POSTS, Number(options.maxPosts) || MAX_DISCOVERY_POSTS));
  const directory = new Map((Array.isArray(options.directory) ? options.directory : []).map((item) => [
    normalizeCommunityName(item && item.name), item,
  ]).filter(([name]) => name));
  const active = Array.isArray(options.active) ? options.active : [];
  const existing = normalizeAffinities(options.existing);
  const order = [];
  const exposure = new Map();
  const add = (name, source, rank = null) => {
    const key = normalizeCommunityName(name);
    if (!key || exposure.has(key)) return;
    exposure.set(key, { source, rank });
    order.push(key);
  };
  for (const entry of existing.filter((item) => item.state !== 'explored')) {
    if (directory.has(normalizeCommunityName(entry.name))) add(entry.name, 'existing-affinity');
  }
  for (const name of Array.isArray(options.suggested) ? options.suggested : []) {
    if (directory.has(normalizeCommunityName(name))) add(name, 'character-interest');
  }
  for (const entry of active) add(entry && entry.name, 'feddit-active-communities', Number(entry && entry.rank) || null);
  const samples = options.samples && typeof options.samples === 'object' ? options.samples : {};
  return order.slice(0, maxCommunities).map((name, index) => {
    const meta = directory.get(name) || {};
    const activeEntry = active.find((entry) => normalizeCommunityName(entry && entry.name) === name) || {};
    const exposed = exposure.get(name) || {};
    return {
      id: 'C' + (index + 1),
      name,
      title: clean(meta.title || activeEntry.title || name, 120),
      description: clean(meta.description, 360),
      rules: (Array.isArray(meta.rules) ? meta.rules : []).slice(0, 5).map((rule) => clean(
        typeof rule === 'string' ? rule : [rule && rule.title, rule && rule.detail].filter(Boolean).join(': '),
        180,
      )).filter(Boolean),
      postFormat: clean(meta.post_format || meta.postFormat || 'any', 20),
      over18: meta.over_18 === true || meta.over_18 === 1,
      exposure: {
        source: exposed.source || 'feddit-active-communities',
        rank: exposed.rank,
        recent: Number(activeEntry.recent) || 0,
        windowHours: Number(options.windowHours) || 48,
      },
      sample: (Array.isArray(samples[name]) ? samples[name] : []).slice(0, maxPosts).map(postSummary),
    };
  });
}

function communityDiscoveryPrompt(profile, slate) {
  const character = normalizeRichProfile(profile);
  const communities = (Array.isArray(slate) ? slate : []).slice(0, MAX_DISCOVERY_COMMUNITIES).map((entry) => ({
    id: entry.id,
    name: entry.name,
    title: entry.title,
    description: entry.description,
    rules: entry.rules,
    postFormat: entry.postFormat,
    exposure: entry.exposure,
    sample: entry.sample,
  }));
  const prompt = [
    'Choose a small set of Feddit communities for this character to notice and potentially participate in.',
    'The active-community rank is only an exposure signal. Do not choose a community merely because it is busy or highly ranked. A quieter niche may be the strongest fit.',
    'Consider the whole character, motivations, novelty seeking, community loyalty, likely relationships and the actual bounded feed samples.',
    'Return JSON only: {"choices":[{"id":"C1","state":"favored|background|explored","strength":0.0,"reason":"short natural reason"}]}.',
    'Choose 1-3 favored communities, at most 3 background affinities, and at most 2 explored-but-not-currently-interested communities. Use only offered IDs. Do not expose private reasoning.',
    'CHARACTER: ' + JSON.stringify(character),
    'COMMUNITIES: ' + JSON.stringify(communities),
  ].join('\n');
  return prompt.slice(0, MAX_DISCOVERY_PROMPT);
}

function parseCommunityChoices(output, slate, nowMs = Date.now()) {
  const source = String(output || '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Character creator did not return a JSON community choice object.');
  const parsed = JSON.parse(source.slice(start, end + 1));
  const offered = new Map((Array.isArray(slate) ? slate : []).map((entry) => [String(entry.id), entry]));
  const limits = { favored: 3, background: 3, explored: 2 };
  const counts = { favored: 0, background: 0, explored: 0 };
  const seen = new Set();
  const choices = [];
  for (const raw of Array.isArray(parsed && parsed.choices) ? parsed.choices : []) {
    const entry = offered.get(String(raw && raw.id));
    if (!entry || seen.has(entry.name)) continue;
    const state = enumValue(raw && raw.state, AFFINITY_STATES, 'background');
    if (counts[state] >= limits[state]) continue;
    const reason = clean(raw && raw.reason, 220);
    if (!reason) continue;
    seen.add(entry.name);
    counts[state]++;
    choices.push({
      name: entry.name,
      state,
      strength: Math.max(0.05, Math.min(1, Number(raw && raw.strength) || (state === 'favored' ? 0.85 : state === 'background' ? 0.45 : 0.15))),
      reason,
      source: 'character-discovery',
      lastEvaluatedAt: nowMs,
    });
  }
  if (!choices.some((entry) => entry.state === 'favored')) {
    throw new Error('Character creator must choose at least one favored community from the offered slate.');
  }
  return normalizeAffinities(choices, nowMs);
}

function affinitySummary(value) {
  return normalizeAffinities(value).map((entry) => ({
    community: 'f/' + entry.name,
    state: entry.state,
    reason: entry.reason,
  }));
}

module.exports = {
  PROFILE_VERSION,
  AFFINITY_VERSION,
  MAX_RUNTIME_KERNEL,
  MAX_DISCOVERY_COMMUNITIES,
  MAX_DISCOVERY_POSTS,
  MAX_DISCOVERY_PROMPT,
  AFFINITY_STATES,
  normalizeRichProfile,
  validateGeneratedRichProfile,
  compileRuntimeKernel,
  resolveCreatorPlan,
  normalizeCommunityName,
  normalizeAffinities,
  affinityMap,
  buildCommunitySlate,
  communityDiscoveryPrompt,
  parseCommunityChoices,
  affinitySummary,
};
