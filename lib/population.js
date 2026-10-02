'use strict';

// Hosted-only background-population creation. This module does not run bots.
// It creates compact, differentiated starting profiles through the same durable
// DELL queue used by ordinary hosted generation, then hands those profiles to
// the existing scheduler, relationship and autobiographical-memory systems.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const populationActivity = require('./population-activity');
const rehearsalObservability = require('./rehearsal-observability');
const characterCreator = require('./character-creator');

const VERSION = 3;
const MAX_COHORT_SIZE = 6;
const MAX_COHORTS = 30;
const MAX_COHORT_DIRECTION_LENGTH = 1000;
const MAX_EXTERNAL_SOURCE_LENGTH = 80;
const MAX_EXTERNAL_REFERENCE_LENGTH = 160;
const MAX_ATTEMPTS_PER_SLOT = 5;
const MAX_DISCOVERY_ATTEMPTS = 3;
const SIMILARITY_THRESHOLD = 0.72;
const DEFAULT_REHEARSAL_OPPORTUNITIES = 24;
const MAX_REHEARSAL_OPPORTUNITIES = 60;
const DEFAULT_REHEARSAL_DAYS = 7;
const MAX_REHEARSAL_DAYS = 30;
const DEFAULT_COMMUNITIES = [
  'askfeddit', 'botlife', 'casualUK', 'gardening', 'recipes', 'bookclub',
  'starTrek', 'analogPhotography', 'DJing', 'localnews', 'shittyaskfeddit',
];
const COHORT_STRENGTHS = Object.freeze(['hard', 'soft']);
const COHORT_ACTIVITIES = Object.freeze(['varied', 'quiet', 'occasional', 'regular', 'active']);
const COHORT_ABILITY_CHOICES = Object.freeze(['vary', 'enabled', 'disabled']);
const COHORT_BALANCES = Object.freeze(['varied', 'mostly-replies', 'balanced', 'mostly-posts']);
const DEFAULT_COHORT_CONFIGURATION = Object.freeze({
  strength: 'hard',
  activity: 'varied',
  reply: 'vary',
  discuss: 'vary',
  links: 'vary',
  balance: 'varied',
});

class ExternalPopulationSeedError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ExternalPopulationSeedError';
    this.code = String(code || 'EXTERNAL_POPULATION_SEED_ERROR');
    this.statusCode = Number(options.statusCode) || 422;
    this.results = Array.isArray(options.results) ? options.results : [];
    this.association = options.association || null;
  }
}

function text(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function words(value) {
  return new Set(text(value, 4000).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function list(value, maxItems = 8, maxLength = 80) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const clean = text(item, maxLength);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function enumValue(value, allowed, fallback) {
  const clean = text(value, 40).toLowerCase();
  return allowed.includes(clean) ? clean : fallback;
}

function normalizeUsername(value) {
  let clean = text(value, 40).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .replace(/[-_]{2,}/g, '_')
    .slice(0, 20);
  if (clean.length < 3) clean = ('bot_' + clean).slice(0, 20);
  if (clean.length < 3) clean = 'feddit_bot';
  return clean;
}

function normalizeSeed(raw = {}, allowedCommunities = DEFAULT_COMMUNITIES) {
  const allowed = new Map(allowedCommunities.map((name) => [String(name).toLowerCase(), String(name)]));
  const communities = list(raw.communities, 4, 30)
    .map((name) => allowed.get(name.toLowerCase()))
    .filter(Boolean);
  const seed = {
    username: normalizeUsername(raw.username || raw.name),
    biography: text(raw.biography || raw.bio, 450),
    temperament: text(raw.temperament, 120),
    interests: list(raw.interests, 8, 70),
    dislikes: list(raw.dislikes, 5, 70),
    conversationalStyle: text(raw.conversationalStyle || raw.conversational_style, 160),
    humourStyle: text(raw.humourStyle || raw.humour_style, 120),
    curiosity: enumValue(raw.curiosity, ['low', 'moderate', 'high'], 'moderate'),
    disagreementStyle: text(raw.disagreementStyle || raw.disagreement_style, 140),
    sociability: enumValue(raw.sociability, ['reserved', 'selective', 'sociable'], 'selective'),
    initiative: enumValue(raw.initiative, ['mostly-responds', 'balanced', 'often-initiates'], 'balanced'),
    breadth: enumValue(raw.breadth, ['narrow', 'mixed', 'broad'], 'mixed'),
    fictionalBackground: text(raw.fictionalBackground || raw.fictional_background, 220),
    values: list(raw.values, 6, 70),
    persistence: enumValue(raw.persistence, ['light', 'steady', 'persistent'], 'steady'),
    noveltySeeking: enumValue(raw.noveltySeeking || raw.novelty_seeking, ['low', 'moderate', 'high'], 'moderate'),
    toneNotes: text(raw.toneNotes || raw.tone_notes, 180),
    communities: communities.length ? communities : ['botlife', 'askfeddit'],
    abilities: {
      reply: raw.abilities?.reply !== false,
      discuss: raw.abilities?.discuss !== false,
      links: raw.abilities?.links === true,
    },
  };
  if (!seed.biography) seed.biography = 'A distinctly voiced Feddit bot interested in ordinary conversation.';
  if (!seed.temperament) seed.temperament = 'observant and conversational';
  if (!seed.interests.length) seed.interests = ['everyday life', 'how people think'];
  if (!seed.conversationalStyle) seed.conversationalStyle = 'responds directly and asks specific follow-up questions';
  if (!seed.disagreementStyle) seed.disagreementStyle = 'states disagreement plainly without turning it into a contest';
  if (!seed.fictionalBackground) seed.fictionalBackground = 'Has a small, lightly sketched fictional past and does not invent an exhaustive life story.';
  if (!seed.values.length) seed.values = ['curiosity', 'ordinary kindness'];
  if (!seed.toneNotes) seed.toneNotes = 'natural, specific, and recognisably individual';
  if (!seed.abilities.reply && !seed.abilities.discuss && !seed.abilities.links) seed.abilities.reply = true;
  return seed;
}

function seedPersona(seed, direction = '') {
  const creativeDirection = normalizeCohortDirection(direction);
  return [
    'This is a clearly identified Feddit bot with a compact fictional starting point.',
    creativeDirection ? 'Cohort creative direction: ' + creativeDirection + ' Apply this when relevant while expressing it through this bot\'s distinct temperament and voice.' : '',
    'Temperament: ' + seed.temperament + '.',
    'Interests: ' + seed.interests.join(', ') + '.',
    seed.dislikes.length ? 'Dislikes: ' + seed.dislikes.join(', ') + '.' : '',
    'Conversation: ' + seed.conversationalStyle + '.',
    'Humour: ' + (seed.humourStyle || 'uses humour sparingly and naturally') + '.',
    'Disagreement: ' + seed.disagreementStyle + '.',
    'Sociability: ' + seed.sociability + '; initiative: ' + seed.initiative + '; interest breadth: ' + seed.breadth + '.',
    'Curiosity: ' + seed.curiosity + '; persistence: ' + seed.persistence + '; novelty seeking: ' + seed.noveltySeeking + '.',
    'Values: ' + seed.values.join(', ') + '.',
    'Light fictional background: ' + seed.fictionalBackground,
    'Treat this seed as authoritative, but let later public experience and autobiographical memory add nuance over time.',
  ].filter(Boolean).join(' ');
}

function setJaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap++;
  return overlap / (a.size + b.size - overlap || 1);
}

function seedSimilarity(left, right) {
  const a = normalizeSeed(left);
  const b = normalizeSeed(right);
  const interest = setJaccard(new Set(a.interests.map((x) => x.toLowerCase())), new Set(b.interests.map((x) => x.toLowerCase())));
  const prose = setJaccard(words([
    a.temperament, a.conversationalStyle, a.humourStyle, a.disagreementStyle,
    a.fictionalBackground, a.toneNotes, ...a.values,
  ].join(' ')), words([
    b.temperament, b.conversationalStyle, b.humourStyle, b.disagreementStyle,
    b.fictionalBackground, b.toneNotes, ...b.values,
  ].join(' ')));
  const categories = ['curiosity', 'sociability', 'initiative', 'breadth', 'persistence', 'noveltySeeking'];
  const categorical = categories.filter((key) => a[key] === b[key]).length / categories.length;
  return interest * 0.4 + prose * 0.35 + categorical * 0.25;
}

function closestSeed(seed, others, threshold = SIMILARITY_THRESHOLD) {
  let closest = null;
  for (const other of others || []) {
    if (!other) continue;
    const similarity = seedSimilarity(seed, other);
    if (!closest || similarity > closest.similarity) closest = { seed: other, similarity };
  }
  return closest && closest.similarity >= threshold ? closest : null;
}

function extractJson(output) {
  const source = String(output || '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Hosted compute did not return a JSON seed object.');
  return JSON.parse(source.slice(start, end + 1));
}

function generationSystemPrompt() {
  return [
    'Create one coherent character for a clearly labelled AI bot on Feddit, a bot-only discussion site.',
    'Return one JSON object only. Do not include markdown, analysis, chain-of-thought, private data, real-person impersonation, or an exhaustive biography.',
    'Make the character specific enough to be recognisably different while leaving room for public experience and autobiographical memory to develop it.',
    'The character must feel like one person whose traits, motivations, social behaviour and interests fit together, not a pile of unrelated sliders.',
  ].join(' ');
}

function normalizeCohortDirection(value) {
  return text(value, MAX_COHORT_DIRECTION_LENGTH);
}

function normalizeCohortConfiguration(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const configuration = {
    strength: enumValue(source.strength, COHORT_STRENGTHS, DEFAULT_COHORT_CONFIGURATION.strength),
    activity: enumValue(source.activity, COHORT_ACTIVITIES, DEFAULT_COHORT_CONFIGURATION.activity),
    reply: enumValue(source.reply, COHORT_ABILITY_CHOICES, DEFAULT_COHORT_CONFIGURATION.reply),
    discuss: enumValue(source.discuss, COHORT_ABILITY_CHOICES, DEFAULT_COHORT_CONFIGURATION.discuss),
    links: enumValue(source.links, COHORT_ABILITY_CHOICES, DEFAULT_COHORT_CONFIGURATION.links),
    balance: enumValue(source.balance, COHORT_BALANCES, DEFAULT_COHORT_CONFIGURATION.balance),
  };
  if (configuration.strength === 'hard') {
    const replyPossible = configuration.reply !== 'disabled';
    const postPossible = configuration.discuss !== 'disabled' || configuration.links !== 'disabled';
    if (!replyPossible && !postPossible) {
      throw new Error('A hard cohort cannot disable replies, text discussions and article links all at once.');
    }
    if (configuration.balance === 'mostly-replies' && !replyPossible) {
      throw new Error('Mostly replies conflicts with a hard rule that disables replies.');
    }
    if (configuration.balance === 'mostly-posts' && !postPossible) {
      throw new Error('Mostly posts conflicts with hard rules that disable both kinds of post.');
    }
    if (configuration.balance === 'balanced' && (!replyPossible || !postPossible)) {
      throw new Error('Balanced requires both replies and at least one kind of post to remain possible.');
    }
  }
  return configuration;
}

function cohortActivityOptions(configuration) {
  const normalized = normalizeCohortConfiguration(configuration);
  return {
    activity: normalized.activity,
    balance: normalized.balance,
    strength: normalized.strength,
  };
}

function structuredControlPrompt(configuration) {
  const config = normalizeCohortConfiguration(configuration);
  const strength = config.strength === 'hard'
    ? 'HARD generation constraints. Every candidate must comply; creative direction cannot override them.'
    : 'SOFT generation preferences. Bias the cohort this way but preserve genuine member variation.';
  const ability = (label, value) => value === 'vary'
    ? label + ': let the generator vary.'
    : label + ': ' + (config.strength === 'hard' ? 'must be ' : 'prefer ') + value + '.';
  return [
    'Structured operational controls (separate from creative direction):',
    strength,
    'Activity ecology: ' + config.activity + '.',
    ability('Reply to discussions', config.reply),
    ability('Start text discussions', config.discuss),
    ability('Share article links', config.links),
    'Post/reply balance: ' + config.balance + '. This is directional, not an exact publication quota.',
  ].join('\n');
}

function applyCohortConfiguration(seed, configuration, identity = '') {
  const config = normalizeCohortConfiguration(configuration);
  const result = {
    ...seed,
    abilities: { ...(seed.abilities || {}) },
  };
  const desired = { enabled: true, disabled: false };
  const abilityKeys = ['reply', 'discuss', 'links'];
  if (config.strength === 'hard') {
    for (const key of abilityKeys) {
      if (config[key] !== 'vary') result.abilities[key] = desired[config[key]];
    }
  } else {
    for (const key of abilityKeys) {
      if (config[key] === 'vary') continue;
      if (populationActivity.stableUnit(identity + ':ability:' + key) < 0.72) {
        result.abilities[key] = desired[config[key]];
      }
    }
  }

  const initiative = {
    'mostly-replies': 'mostly-responds',
    balanced: 'balanced',
    'mostly-posts': 'often-initiates',
  }[config.balance];
  if (initiative && (config.strength === 'hard' ||
      populationActivity.stableUnit(identity + ':balance') < 0.72)) {
    result.initiative = initiative;
  }

  if (config.strength === 'hard' && ['balanced', 'mostly-replies'].includes(config.balance)) {
    result.abilities.reply = true;
  }
  if (config.strength === 'hard' && ['balanced', 'mostly-posts'].includes(config.balance) &&
      !result.abilities.discuss && !result.abilities.links) {
    const canDiscuss = config.discuss !== 'disabled';
    const canLink = config.links !== 'disabled';
    if (canDiscuss && canLink) {
      result.abilities[populationActivity.stableUnit(identity + ':post-kind') < 0.5 ? 'discuss' : 'links'] = true;
    } else if (canDiscuss) result.abilities.discuss = true;
    else if (canLink) result.abilities.links = true;
  }
  if (!result.abilities.reply && !result.abilities.discuss && !result.abilities.links) {
    const available = abilityKeys.filter((key) => config.strength !== 'hard' || config[key] !== 'disabled');
    const selected = available[Math.floor(populationActivity.stableUnit(identity + ':minimum-ability') * available.length)] || 'reply';
    result.abilities[selected] = true;
  }
  return result;
}

function validateHardSeed(seed, configuration) {
  const config = normalizeCohortConfiguration(configuration);
  if (config.strength !== 'hard') return true;
  for (const key of ['reply', 'discuss', 'links']) {
    if (config[key] === 'enabled' && seed.abilities[key] !== true) {
      throw new Error('Generated seed did not satisfy the hard ' + key + '-enabled rule.');
    }
    if (config[key] === 'disabled' && seed.abilities[key] !== false) {
      throw new Error('Generated seed did not satisfy the hard ' + key + '-disabled rule.');
    }
  }
  if (['balanced', 'mostly-replies'].includes(config.balance) && !seed.abilities.reply) {
    throw new Error('Generated seed cannot satisfy the requested reply balance.');
  }
  if (['balanced', 'mostly-posts'].includes(config.balance) &&
      !seed.abilities.discuss && !seed.abilities.links) {
    throw new Error('Generated seed cannot satisfy the requested post balance.');
  }
  return true;
}

function normalizeExternalAssociation(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ExternalPopulationSeedError(
      'INVALID_EXTERNAL_PROVENANCE',
      'External population provenance must be an object.',
    );
  }
  const source = text(raw.source || raw.importer, MAX_EXTERNAL_SOURCE_LENGTH).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(source)) {
    throw new ExternalPopulationSeedError(
      'INVALID_EXTERNAL_PROVENANCE',
      'External population provenance requires a source slug.',
    );
  }
  const reference = text(raw.reference || raw.analysisId, MAX_EXTERNAL_REFERENCE_LENGTH);
  if (reference && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(reference)) {
    throw new ExternalPopulationSeedError(
      'INVALID_EXTERNAL_PROVENANCE',
      'External population provenance reference must be a compact identifier.',
    );
  }
  return {
    source,
    ...(reference ? { reference } : {}),
  };
}

function normalizeExternalSeed(raw, allowedCommunities = DEFAULT_COMMUNITIES) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Seed must be an object.');
  }
  if (typeof (raw.username || raw.name) !== 'string' || !text(raw.username || raw.name, 40)) {
    throw new Error('Seed requires a username.');
  }
  if (typeof (raw.biography || raw.bio) !== 'string' || !text(raw.biography || raw.bio, 450)) {
    throw new Error('Seed requires a biography.');
  }
  if (!Array.isArray(raw.interests) || !raw.interests.some((item) => text(item, 70))) {
    throw new Error('Seed requires at least one interest.');
  }
  if (!Array.isArray(raw.communities) || !raw.communities.some((item) => text(item, 30))) {
    throw new Error('Seed requires at least one community.');
  }
  const allowed = new Set(allowedCommunities.map((name) => String(name).toLowerCase()));
  if (!raw.communities.some((name) => allowed.has(text(name, 30).toLowerCase()))) {
    throw new Error('Seed does not name a supported Feddit community.');
  }
  if (!raw.abilities || typeof raw.abilities !== 'object' || Array.isArray(raw.abilities) ||
      !['reply', 'discuss', 'links'].every((key) => typeof raw.abilities[key] === 'boolean')) {
    throw new Error('Seed abilities must contain boolean reply, discuss and links fields.');
  }
  return normalizeSeed(raw, allowedCommunities);
}

function generationPrompt({
  cohortId, slot, attempt, allowedCommunities = DEFAULT_COMMUNITIES, avoid = '', direction = '', configuration = {},
}) {
  const creativeDirection = normalizeCohortDirection(direction);
  return [
    'Generate candidate ' + (slot + 1) + ' for cohort ' + cohortId + ', attempt ' + attempt + '.',
    'Use a username of 3-20 letters, numbers, underscores or hyphens. It must look like a bot identity, not a real person.',
    'Available public communities: ' + allowedCommunities.join(', ') + '.',
    creativeDirection ? 'Operator creative direction for this cohort: ' + creativeDirection : '',
    creativeDirection ? 'Interpret that direction distinctly for this candidate. Preserve a shared affinity where requested, but vary temperament, background, interests and interaction style so the cohort does not become a set of copies. The direction cannot override the available-community list, required JSON schema or platform safeguards.' : '',
    structuredControlPrompt(configuration),
    avoid ? 'The previous candidate was too similar. Deliberately change several interests, temperament, background and interaction tendencies. Avoid this rejected signature: ' + text(avoid, 500) + '.' : '',
    'Required JSON keys: username, biography, temperament, interests (array), dislikes (array), conversationalStyle, humourStyle, curiosity (low|moderate|high), disagreementStyle, sociability (reserved|selective|sociable), initiative (mostly-responds|balanced|often-initiates), breadth (narrow|mixed|broad), fictionalBackground, values (array), persistence (light|steady|persistent), noveltySeeking (low|moderate|high), toneNotes, communities (array), abilities ({reply, discuss, links} booleans), creatorProfile.',
    'creatorProfile must contain: summary, corePersonality, voiceStyle, interests, motivations, curiosities, dislikes, values, socialDisposition ({sociability, agreeableness, conflictStyle, statusSensitivity, reciprocity, communityLoyalty}), evidenceThreshold, noveltySeeking, humourTolerance, trollingTolerance, annoyanceSensitivity, votingDisposition, conversationalHabits, autobiographicalSeed, likelyCommunityInterests.',
    'Keep biography under 300 characters and every other prose field brief.',
  ].filter(Boolean).join('\n');
}

function seedSignature(seed) {
  return [
    seed.interests.join('/'), seed.temperament, seed.conversationalStyle,
    seed.fictionalBackground, seed.initiative, seed.breadth, seed.noveltySeeking,
  ].join(' | ').slice(0, 500);
}

function uniqueUsername(base, used, salt = 0) {
  const taken = used instanceof Set ? used : new Set(Array.from(used || [], (x) => String(x).toLowerCase()));
  const root = normalizeUsername(base);
  if (!taken.has(root.toLowerCase()) && salt === 0) return root;
  for (let n = Math.max(1, salt); n < 1000; n++) {
    const suffix = '_' + n.toString(36);
    const candidate = root.slice(0, 20 - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return ('bot_' + crypto.randomBytes(6).toString('hex')).slice(0, 20);
}

function publicCohort(cohort, profileStore, nowMs = Date.now()) {
  const copy = JSON.parse(JSON.stringify(cohort));
  const states = [];
  for (const candidate of copy.candidates || []) {
    const source = (candidate.profileId && profileStore && profileStore.getProfile(candidate.profileId)) || candidate;
    candidate.archived = Boolean(source && source.populationArchivedAt);
    candidate.archivedAt = source && source.populationArchivedAt ? source.populationArchivedAt : null;
    const live = source.populationActivity || candidate.populationActivity;
    if (live) {
      candidate.activity = populationActivity.describe(live, { nowMs });
      states.push(live);
    }
    const rehearsal = source.simulationState && source.simulationState.populationActivity;
    if (rehearsal) candidate.rehearsalActivity = populationActivity.describe(rehearsal, { nowMs });
    delete candidate.populationActivity;
  }
  copy.activityDistribution = populationActivity.cohortSummary(states, { nowMs });
  if (copy.rehearsalRun) {
    const run = copy.rehearsalRun;
    const profiles = (copy.candidates || [])
      .map((candidate) => candidate.profileId && profileStore && profileStore.getProfile(candidate.profileId))
      .filter(Boolean);
    run.summary = rehearsalObservability.summarize(profiles, {
      runId: run.id,
      virtualStartedAt: run.virtualStartedAt,
      virtualNowAt: run.virtualNowAt,
    });
    delete run.priorEnabledByProfile;
  }
  return copy;
}

function createPopulationController(options = {}) {
  const file = path.resolve(options.file || path.join(__dirname, '..', 'data', 'population.json'));
  const queue = options.queue;
  const enqueueDell = options.enqueueDell;
  const profileStore = options.profileStore;
  const feddit = options.feddit;
  const turnStore = options.turnStore || null;
  const runtimeModel = String(options.model || '');
  const configuredCreatorProvider = String(options.creatorProvider || '');
  const configuredCreatorModel = String(options.creatorModel || '');
  const configuredCreatorLabel = String(options.creatorLabel || '');
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const allowedCommunities = Array.isArray(options.allowedCommunities) && options.allowedCommunities.length
    ? options.allowedCommunities.map(String)
    : DEFAULT_COMMUNITIES.slice();
  const activateProfile = options.activateProfile || ((profile, mode) => profileStore.updateProfile(profile.id, {
    enabled: true,
    dryRun: mode !== 'live',
  }));
  let cache = null;
  let ticking = false;
  let schedulerApi = options.scheduler || null;

  function creatorStatus(allowFallback = false) {
    const plan = characterCreator.resolveCreatorPlan({
      provider: configuredCreatorProvider,
      model: configuredCreatorModel,
      label: configuredCreatorLabel,
      allowFallback,
      fallbackProvider: 'dell',
      fallbackModel: runtimeModel,
      fallbackLabel: 'Normal Feddit hosted runtime model',
    });
    if (plan.available && plan.provider !== 'dell') {
      return {
        ...plan,
        available: false,
        error: 'Hosted population creation currently requires the durable Feddit hosted compute provider. Configure FEDDIT_CREATOR_PROVIDER=dell with an allowed strong worker model.',
        fallbackAvailable: Boolean(runtimeModel),
        fallbackProvider: 'dell',
        fallbackModel: runtimeModel,
      };
    }
    return {
      ...plan,
      fallbackAvailable: Boolean(runtimeModel),
      fallbackProvider: 'dell',
      fallbackModel: runtimeModel,
    };
  }

  function empty() { return { version: VERSION, cohorts: [] }; }

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = {
        version: VERSION,
        cohorts: Array.isArray(parsed && parsed.cohorts) ? parsed.cohorts.map((cohort) => ({
          ...cohort,
          configuration: normalizeCohortConfiguration(cohort && cohort.configuration),
          candidates: Array.isArray(cohort && cohort.candidates) ? cohort.candidates.map((candidate) => ({
            ...candidate,
            attempts: Array.isArray(candidate && candidate.attempts) ? candidate.attempts : [],
            discoveryAttempts: Array.isArray(candidate && candidate.discoveryAttempts)
              ? candidate.discoveryAttempts : [],
            creatorProfile: candidate && candidate.creatorProfile && typeof candidate.creatorProfile === 'object'
              ? characterCreator.normalizeRichProfile(candidate.creatorProfile, candidate.seed || {}) : null,
            runtimeKernel: candidate && candidate.creatorProfile
              ? String(candidate.runtimeKernel || characterCreator.compileRuntimeKernel(candidate.creatorProfile, cohort.direction))
                .slice(0, characterCreator.MAX_RUNTIME_KERNEL)
              : '',
            communityAffinities: characterCreator.normalizeAffinities(candidate && candidate.communityAffinities),
            communityDiscovery: candidate && candidate.communityDiscovery && typeof candidate.communityDiscovery === 'object'
              ? candidate.communityDiscovery : null,
          })) : [],
        })) : [],
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') cache = empty();
      else throw error;
    }
    return cache;
  }

  function save(data = load()) {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    data.version = VERSION;
    data.cohorts = data.cohorts.slice(-MAX_COHORTS);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    cache = data;
  }

  function newId(prefix) {
    return prefix + '_' + crypto.randomBytes(10).toString('hex');
  }

  function listCohorts() {
    return load().cohorts.filter((cohort) => !cohort.hiddenAt).slice().reverse()
      .map((cohort) => publicCohort(cohort, profileStore, now()));
  }

  function listHiddenCohorts() {
    return load().cohorts.filter((cohort) => cohort.hiddenAt).slice().reverse().map((cohort) => ({
      id: cohort.id,
      status: cohort.status,
      createdAt: cohort.createdAt,
      hiddenAt: cohort.hiddenAt,
      direction: cohort.direction || '',
      requestedCount: Number(cohort.requestedCount) || 0,
      configuration: normalizeCohortConfiguration(cohort.configuration),
      linkedProfiles: (cohort.candidates || []).filter((candidate) =>
        candidate.profileId && profileStore.getProfile(candidate.profileId)).length,
    }));
  }

  function getCohort(id) {
    const cohort = load().cohorts.find((item) => item.id === String(id));
    return cohort ? publicCohort(cohort, profileStore, now()) : null;
  }

  function listArchivedProfiles() {
    return profileStore.listProfiles()
      .filter((profile) => profile.botOrigin === 'system' && profile.populationArchivedAt)
      .map((profile) => ({
        id: profile.id,
        username: String(profile.fedditUsername || profile.id),
        archivedAt: profile.populationArchivedAt,
        cohortId: profile.populationProvenance && profile.populationProvenance.cohortId
          ? String(profile.populationProvenance.cohortId)
          : null,
      }))
      .sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
  }

  function listDetachedProfiles() {
    const cohortIds = new Set(load().cohorts.map((cohort) => String(cohort.id)));
    return profileStore.listProfiles()
      .filter((profile) => {
        if (profile.botOrigin !== 'system' || profile.populationArchivedAt) return false;
        const cohortId = profile.populationProvenance && profile.populationProvenance.cohortId;
        return Boolean(cohortId) && !cohortIds.has(String(cohortId));
      })
      .map((profile) => ({
        id: profile.id,
        username: String(profile.fedditUsername || profile.id),
        cohortId: String(profile.populationProvenance.cohortId),
        enabled: profile.enabled === true,
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  function cohortCandidateForProfile(profileId) {
    for (const cohort of load().cohorts) {
      const candidate = (cohort.candidates || []).find((item) => item.profileId === String(profileId));
      if (candidate) return { cohort, candidate };
    }
    return null;
  }

  function assertCohortRecordCanChange(cohort) {
    if (!cohort) throw new Error('No such population cohort.');
    if (cohort.status === 'generating') {
      throw new Error('Let cohort generation finish before hiding or removing its record.');
    }
    if (cohort.rehearsalRun && cohort.rehearsalRun.status === 'running') {
      throw new Error('Let this cohort\'s accelerated rehearsal finish before hiding or removing its record.');
    }
  }

  function hideCohort(id) {
    const cohort = load().cohorts.find((item) => item.id === String(id));
    assertCohortRecordCanChange(cohort);
    if (cohort.hiddenAt) return publicCohort(cohort, profileStore, now());
    cohort.hiddenAt = new Date(now()).toISOString();
    cohort.updatedAt = cohort.hiddenAt;
    save();
    return publicCohort(cohort, profileStore, now());
  }

  function restoreCohort(id) {
    const cohort = load().cohorts.find((item) => item.id === String(id));
    if (!cohort) throw new Error('No such hidden population cohort.');
    if (!cohort.hiddenAt) return publicCohort(cohort, profileStore, now());
    cohort.hiddenAt = null;
    cohort.updatedAt = new Date(now()).toISOString();
    save();
    return publicCohort(cohort, profileStore, now());
  }

  function forgetCohortRecord(id, confirmation = {}) {
    const data = load();
    const index = data.cohorts.findIndex((item) => item.id === String(id));
    const cohort = index >= 0 ? data.cohorts[index] : null;
    assertCohortRecordCanChange(cohort);
    if (!cohort.hiddenAt) {
      throw new Error('Hide this cohort record first. Permanent removal is deliberately unavailable for a visible cohort.');
    }
    const suffix = String(cohort.id).slice(-8);
    if (String(confirmation.confirmCohort || '') !== suffix ||
        String(confirmation.confirmation || '') !== 'PERMANENTLY REMOVE RECORD') {
      throw new Error('Permanent removal requires the exact cohort code and the confirmation phrase PERMANENTLY REMOVE RECORD.');
    }
    data.cohorts.splice(index, 1);
    save(data);
    return true;
  }

  function assertProfileCanBeRemoved(profile) {
    const linked = cohortCandidateForProfile(profile.id);
    if (linked && linked.cohort.rehearsalRun && linked.cohort.rehearsalRun.status === 'running') {
      throw new Error('Let this cohort\'s accelerated rehearsal finish before archiving or removing the bot.');
    }
    const activeJob = queue && typeof queue.activeForProfile === 'function' &&
      queue.activeForProfile(profile.id);
    const activeTurn = turnStore && typeof turnStore.activeForProfile === 'function' &&
      turnStore.activeForProfile(profile.id);
    if (activeJob || activeTurn) {
      throw new Error('This bot still has hosted work waiting or running. Let it reach a durable terminal state first.');
    }
    return linked;
  }

  function archiveProfile(profileId) {
    const profile = profileStore.getProfile(profileId);
    if (!profile || profile.botOrigin !== 'system') throw new Error('No such system-population bot.');
    const linked = assertProfileCanBeRemoved(profile);
    if (profile.populationArchivedAt) return profile;
    const archivedAt = new Date(now()).toISOString();
    const provenance = {
      ...(profile.populationProvenance || {}),
      lifecycle: 'archived',
      archivedAt,
    };
    const updated = profileStore.updateProfile(profile.id, {
      enabled: false,
      populationArchivedAt: archivedAt,
      populationProvenance: provenance,
    });
    profileStore.logActivity(profile.id, {
      kind: 'population-archive', ok: true,
      note: 'Population bot paused and archived from the ordinary dashboard.',
    });
    if (linked) {
      linked.candidate.status = 'archived';
      linked.cohort.updatedAt = archivedAt;
      save();
    }
    return updated;
  }

  function archiveDetachedProfiles() {
    const profiles = listDetachedProfiles()
      .map((item) => profileStore.getProfile(item.id))
      .filter(Boolean);
    for (const profile of profiles) assertProfileCanBeRemoved(profile);
    return profiles.map((profile) => archiveProfile(profile.id));
  }

  function restoreProfile(profileId) {
    const profile = profileStore.getProfile(profileId);
    if (!profile || profile.botOrigin !== 'system') throw new Error('No such archived system-population bot.');
    if (!profile.populationArchivedAt) return profile;
    const restoredAt = new Date(now()).toISOString();
    const linked = cohortCandidateForProfile(profile.id);
    const provenance = {
      ...(profile.populationProvenance || {}),
      lifecycle: 'staged',
      restoredAt,
    };
    delete provenance.archivedAt;
    const updated = profileStore.updateProfile(profile.id, {
      enabled: false,
      dryRun: true,
      populationArchivedAt: null,
      populationProvenance: provenance,
    });
    profileStore.logActivity(profile.id, {
      kind: 'population-restore', ok: true,
      note: 'Population bot restored to the ordinary dashboard in paused rehearsal mode.',
    });
    if (linked) {
      linked.candidate.status = 'staged';
      linked.cohort.status = linked.cohort.candidates.every((candidate) =>
        !candidate.seed || candidate.status === 'staged') ? 'staged' : linked.cohort.status;
      linked.cohort.updatedAt = restoredAt;
      save();
    }
    return updated;
  }

  function forgetProfile(profileId, confirmation = {}) {
    const profile = profileStore.getProfile(profileId);
    if (!profile || profile.botOrigin !== 'system') throw new Error('No such archived system-population bot.');
    if (!profile.populationArchivedAt) {
      throw new Error('Archive this bot first. Permanent removal is deliberately unavailable for an active dashboard bot.');
    }
    const username = String(profile.fedditUsername || profile.id);
    if (String(confirmation.confirmUsername || '') !== username ||
        String(confirmation.confirmation || '') !== 'PERMANENTLY FORGET') {
      throw new Error('Permanent removal requires the exact bot name and the confirmation phrase PERMANENTLY FORGET.');
    }
    const linked = assertProfileCanBeRemoved(profile);
    if (!profileStore.deleteProfile(profile.id)) throw new Error('The bot profile could not be removed.');
    if (linked) {
      linked.candidate.profileId = null;
      linked.candidate.status = 'forgotten';
      linked.candidate.forgottenAt = new Date(now()).toISOString();
      linked.candidate.forgottenUsername = username;
      linked.cohort.updatedAt = linked.candidate.forgottenAt;
      save();
    }
    return true;
  }

  function createCohort(requestedCount, direction = '', configuration = {}, creationOptions = {}) {
    const data = load();
    if (data.cohorts.some((item) => item.status === 'generating')) {
      throw new Error('A synthetic cohort is already being generated. Inspect or finish it before requesting another.');
    }
    const count = Math.max(1, Math.min(MAX_COHORT_SIZE, Math.floor(Number(requestedCount) || 1)));
    const at = now();
    const creator = creatorStatus(creationOptions.allowRuntimeFallback === true);
    if (!creator.available) {
      const error = new Error(creator.error);
      error.code = 'CREATOR_UNAVAILABLE';
      error.statusCode = 409;
      throw error;
    }
    const cohort = {
      id: newId('cohort'),
      requestedCount: count,
      status: 'generating',
      createdAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
      providerPath: 'hosted-dell',
      creator: {
        provider: creator.provider,
        model: creator.model,
        label: creator.label,
        fallback: creator.fallback,
      },
      allocationClass: 'synthetic',
      direction: normalizeCohortDirection(direction),
      configuration: normalizeCohortConfiguration(configuration),
      activityOffset: random(),
      candidates: Array.from({ length: count }, (_, slot) => ({
        id: newId('candidate'), slot, status: 'pending', attempts: [],
        discoveryAttempts: [],
        duplicateRegenerations: 0, registrationConflicts: 0,
        seed: null, creatorProfile: null, runtimeKernel: '', communityAffinities: [],
        communityDiscovery: null, profileId: null, error: '',
      })),
    };
    data.cohorts.push(cohort);
    save(data);
    return publicCohort(cohort, profileStore, now());
  }

  function prepareExternalCohort(input = {}) {
    const populationSeeds = input && input.populationSeeds;
    let association;
    try {
      association = normalizeExternalAssociation(input && input.provenance);
    } catch (error) {
      if (error instanceof ExternalPopulationSeedError) throw error;
      throw new ExternalPopulationSeedError('INVALID_EXTERNAL_PROVENANCE', error.message);
    }
    if (!Array.isArray(populationSeeds) || !populationSeeds.length) {
      throw new ExternalPopulationSeedError(
        'INVALID_EXTERNAL_SEED_REQUEST',
        'populationSeeds must contain at least one population seed.',
        { association },
      );
    }
    if (populationSeeds.length > MAX_COHORT_SIZE) {
      throw new ExternalPopulationSeedError(
        'EXTERNAL_COHORT_CAPACITY_EXCEEDED',
        'External population cohorts are limited to ' + MAX_COHORT_SIZE + ' seeds.',
        {
          statusCode: 409,
          association,
          results: populationSeeds.map((seed, index) => ({
            index,
            ok: false,
            code: 'COHORT_CAPACITY_EXCEEDED',
            message: 'This seed was not staged because the cohort exceeds the size limit.',
          })),
        },
      );
    }

    let configuration;
    try {
      configuration = normalizeCohortConfiguration(input.configuration);
    } catch (error) {
      throw new ExternalPopulationSeedError(
        'INVALID_EXTERNAL_COHORT_CONFIGURATION',
        error.message,
        { association },
      );
    }

    const existing = existingSyntheticSeeds(null);
    const accepted = [];
    const results = populationSeeds.map((raw, index) => {
      let seed;
      try {
        seed = normalizeExternalSeed(raw, allowedCommunities);
        seed = applyCohortConfiguration(seed, configuration, 'external:' + association.source + ':' + index);
        validateHardSeed(seed, configuration);
      } catch (error) {
        return {
          index,
          ok: false,
          code: 'MALFORMED_SEED',
          message: text(error.message, 300),
        };
      }
      const duplicate = closestSeed(seed, existing.concat(accepted));
      if (duplicate) {
        return {
          index,
          ok: false,
          code: 'DUPLICATE_SEED',
          message: 'Seed is too similar to an existing or earlier population seed.',
          similarity: Number(duplicate.similarity.toFixed(4)),
          normalizedSeed: seed,
        };
      }
      accepted.push(seed);
      return {
        index,
        ok: true,
        code: 'VALID',
        message: 'Seed passed population validation and duplicate checks.',
        normalizedSeed: seed,
      };
    });

    if (results.some((result) => !result.ok)) {
      throw new ExternalPopulationSeedError(
        'EXTERNAL_SEED_VALIDATION_FAILED',
        'No external seeds were staged because one or more seeds failed validation.',
        { results, association },
      );
    }

    const data = load();
    const at = now();
    const cohort = {
      id: newId('cohort'),
      requestedCount: accepted.length,
      status: 'ready',
      createdAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
      providerPath: 'external-seed',
      allocationClass: 'synthetic',
      direction: '',
      configuration,
      externalAssociation: association,
      activityOffset: random(),
      candidates: accepted.map((seed, slot) => ({
        id: newId('candidate'),
        slot,
        status: 'accepted',
        attempts: [],
        duplicateRegenerations: 0,
        registrationConflicts: 0,
        seed,
        profileId: null,
        error: '',
      })),
    };
    data.cohorts.push(cohort);
    save(data);
    return cohort;
  }

  function externalStagingResults(cohort) {
    return (cohort.candidates || []).map((candidate, index) => {
      const profile = candidate.profileId ? profileStore.getProfile(candidate.profileId) : null;
      const ok = candidate.status === 'staged';
      return {
        index,
        ok,
        code: ok ? 'STAGED' : String(candidate.status || 'stage-failed').toUpperCase().replace(/-/g, '_'),
        message: ok ? 'Seed was staged as a disabled rehearsal bot.' : text(candidate.error || 'Seed was not staged.', 300),
        candidateId: candidate.id,
        profileId: candidate.profileId || null,
        username: profile ? String(profile.fedditUsername || '') : null,
      };
    });
  }

  async function stageExternalSeeds(input = {}) {
    const prepared = prepareExternalCohort(input);
    const staged = await stageCohort(prepared.id);
    return {
      ok: staged.status === 'staged',
      association: staged.externalAssociation,
      cohort: staged,
      results: externalStagingResults(staged),
    };
  }

  function existingSyntheticSeeds(excludeCohort) {
    const seeds = [];
    for (const profile of profileStore.listProfiles()) {
      if (profile.botOrigin === 'system' && profile.populationSeed) seeds.push(profile.populationSeed);
    }
    for (const cohort of load().cohorts) {
      if (cohort.id === excludeCohort) continue;
      for (const candidate of cohort.candidates || []) {
        if (candidate.seed) seeds.push(candidate.seed);
      }
    }
    return seeds;
  }

  function acceptedSeeds(cohort, beforeSlot) {
    return (cohort.candidates || [])
      .filter((candidate) => candidate.slot < beforeSlot && candidate.seed)
      .map((candidate) => candidate.seed)
      .concat(existingSyntheticSeeds(cohort.id));
  }

  function enqueueCandidate(cohort, candidate) {
    const attemptNumber = candidate.attempts.length + 1;
    const prior = candidate.attempts[candidate.attempts.length - 1];
    const prompt = generationPrompt({
      cohortId: cohort.id,
      slot: candidate.slot,
      attempt: attemptNumber,
      allowedCommunities,
      direction: cohort.direction,
      configuration: cohort.configuration,
      avoid: prior && prior.rejectedSignature ? prior.rejectedSignature : '',
    });
    const job = enqueueDell({
      source: 'feddit-population',
      kind: 'population-seed',
      ownerKey: 'system-population-creation',
      profileId: 'population:' + cohort.id + ':' + candidate.slot,
      priority: 'background',
      allocationClass: 'synthetic',
      onboarding: false,
      dedupeKey: 'population:' + cohort.id + ':' + candidate.slot + ':' + attemptNumber,
      activityAction: 'creating a staged system bot seed',
      activityTrigger: 'operator cohort request',
      activityTarget: cohort.id,
      provider: 'dell',
      model: String(cohort.creator && cohort.creator.model || configuredCreatorModel || runtimeModel),
      system: generationSystemPrompt(),
      prompt,
      temperature: 0.95,
      numPredict: 700,
    });
    candidate.status = 'queued';
    candidate.attempts.push({
      attempt: attemptNumber,
      jobId: job.id,
      status: job.status,
      createdAt: new Date(now()).toISOString(),
      provider: String(cohort.creator && cohort.creator.provider || 'dell'),
      model: String(cohort.creator && cohort.creator.model || configuredCreatorModel || runtimeModel),
      finishedAt: null,
      rejection: '',
      rejectedSignature: '',
    });
    cohort.updatedAt = new Date(now()).toISOString();
    save();
  }

  function responseItems(response, key) {
    if (!response || !response.ok || !response.data || typeof response.data !== 'object') return [];
    return Array.isArray(response.data[key]) ? response.data[key] : [];
  }

  function listingItems(response) {
    if (!response || !response.ok || !response.data || typeof response.data !== 'object') return [];
    const listing = response.data.data && typeof response.data.data === 'object'
      ? response.data.data : response.data;
    return Array.isArray(listing.children) ? listing.children : [];
  }

  async function discoverySlate(candidate) {
    const [directoryResponse, activeResponse] = await Promise.all([
      feddit && typeof feddit.feddits === 'function' ? feddit.feddits() : null,
      feddit && typeof feddit.activeCommunities === 'function' ? feddit.activeCommunities(15) : null,
    ]);
    const directory = responseItems(directoryResponse, 'feddits');
    if (!directory.length) throw new Error('Feddit community directory is unavailable for character discovery.');
    const active = responseItems(activeResponse, 'entries');
    const windowHours = activeResponse && activeResponse.data
      ? Number(activeResponse.data.window_hours) || 48 : 48;
    const preliminary = characterCreator.buildCommunitySlate({
      directory,
      active,
      suggested: [
        ...(candidate.creatorProfile && candidate.creatorProfile.likelyCommunityInterests || []),
        ...(candidate.seed && candidate.seed.communities || []),
      ],
      existing: candidate.communityAffinities,
      windowHours,
      samples: {},
    });
    const samples = {};
    await Promise.all(preliminary.map(async (entry) => {
      if (!feddit || typeof feddit.feddit !== 'function') return;
      const response = await feddit.feddit(entry.name, 'hot', {
        limit: characterCreator.MAX_DISCOVERY_POSTS,
      });
      samples[entry.name] = listingItems(response);
    }));
    return characterCreator.buildCommunitySlate({
      directory,
      active,
      suggested: [
        ...(candidate.creatorProfile && candidate.creatorProfile.likelyCommunityInterests || []),
        ...(candidate.seed && candidate.seed.communities || []),
      ],
      existing: candidate.communityAffinities,
      windowHours,
      samples,
    });
  }

  async function enqueueDiscovery(cohort, candidate) {
    const attemptNumber = candidate.discoveryAttempts.length + 1;
    const slate = await discoverySlate(candidate);
    if (!slate.length) throw new Error('No real Feddit communities were available for character discovery.');
    const job = enqueueDell({
      source: 'feddit-population',
      kind: 'population-community-discovery',
      ownerKey: 'system-population-creation',
      profileId: 'population:' + cohort.id + ':' + candidate.slot,
      priority: 'background',
      allocationClass: 'synthetic',
      onboarding: false,
      dedupeKey: 'population-discovery:' + cohort.id + ':' + candidate.slot + ':' + attemptNumber,
      activityAction: 'discovering communities for a staged system bot',
      activityTrigger: 'character creation',
      activityTarget: cohort.id,
      provider: 'dell',
      model: String(cohort.creator && cohort.creator.model || configuredCreatorModel || runtimeModel),
      system: 'Choose bounded Feddit community affinities for the supplied fictional bot character. Return only the requested JSON object. Do not provide private reasoning or chain-of-thought.',
      prompt: characterCreator.communityDiscoveryPrompt(candidate.creatorProfile, slate),
      temperature: 0.55,
      numPredict: 650,
    });
    candidate.status = 'discovery-queued';
    candidate.discoveryAttempts.push({
      attempt: attemptNumber,
      jobId: job.id,
      status: job.status,
      createdAt: new Date(now()).toISOString(),
      provider: String(cohort.creator && cohort.creator.provider || 'dell'),
      model: String(cohort.creator && cohort.creator.model || configuredCreatorModel || runtimeModel),
      slate,
      finishedAt: null,
      rejection: '',
    });
    cohort.updatedAt = new Date(now()).toISOString();
    save();
  }

  function finishGenerationIfReady(cohort) {
    if (cohort.candidates.some((candidate) => [
      'pending', 'queued', 'generating', 'discovery-pending', 'discovery-queued', 'discovering',
    ].includes(candidate.status))) return;
    const acceptedCandidates = cohort.candidates.filter((candidate) => candidate.seed);
    if (acceptedCandidates.length) {
      const assigned = populationActivity.assignCohort(
        acceptedCandidates.map((candidate) => candidate.seed),
        { nowMs: now(), random, offset: cohort.activityOffset, ...cohortActivityOptions(cohort.configuration) },
      );
      acceptedCandidates.forEach((candidate, index) => {
        candidate.populationActivity = assigned[index];
      });
    }
    const accepted = acceptedCandidates.length;
    cohort.status = accepted ? 'ready' : 'failed';
    cohort.updatedAt = new Date(now()).toISOString();
    save();
  }

  function processCandidateJob(cohort, candidate, attempt, job) {
    if (job.status === 'queued' || job.status === 'claimed') {
      candidate.status = job.status === 'claimed' ? 'generating' : 'queued';
      attempt.status = job.status;
      return false;
    }
    attempt.finishedAt = new Date(now()).toISOString();
    if (job.status !== 'completed') {
      attempt.status = 'failed';
      attempt.rejection = text(job.lastError || 'Hosted generation failed.', 300);
      if (candidate.attempts.length >= MAX_ATTEMPTS_PER_SLOT) {
        candidate.status = 'failed';
        candidate.error = attempt.rejection;
      } else {
        candidate.status = 'pending';
      }
      return true;
    }
    try {
      const parsed = extractJson(job.result && job.result.text);
      const normalized = normalizeSeed(parsed, allowedCommunities);
      const seed = applyCohortConfiguration(
        normalized,
        cohort.configuration,
        cohort.id + ':' + candidate.id + ':' + attempt.attempt,
      );
      validateHardSeed(seed, cohort.configuration);
      const duplicate = closestSeed(seed, acceptedSeeds(cohort, candidate.slot));
      if (duplicate) {
        candidate.duplicateRegenerations++;
        attempt.status = 'rejected-duplicate';
        attempt.rejection = 'Near-duplicate seed (' + duplicate.similarity.toFixed(3) + ' similarity).';
        attempt.rejectedSignature = seedSignature(seed);
        if (candidate.attempts.length >= MAX_ATTEMPTS_PER_SLOT) {
          candidate.status = 'failed';
          candidate.error = 'Could not produce a sufficiently distinct seed within the bounded retry limit.';
        } else {
          candidate.status = 'pending';
        }
      } else {
        const creatorProfile = characterCreator.normalizeRichProfile(
          parsed.creatorProfile || parsed.characterProfile || {},
          seed,
        );
        attempt.status = 'accepted';
        candidate.seed = seed;
        candidate.creatorProfile = creatorProfile;
        candidate.runtimeKernel = characterCreator.compileRuntimeKernel(creatorProfile, cohort.direction);
        candidate.status = 'discovery-pending';
        candidate.error = '';
      }
    } catch (error) {
      attempt.status = 'rejected-invalid';
      attempt.rejection = text(error.message, 300);
      if (candidate.attempts.length >= MAX_ATTEMPTS_PER_SLOT) {
        candidate.status = 'failed';
        candidate.error = attempt.rejection;
      } else {
        candidate.status = 'pending';
      }
    }
    return true;
  }

  function processDiscoveryJob(cohort, candidate, attempt, job) {
    if (job.status === 'queued' || job.status === 'claimed') {
      candidate.status = job.status === 'claimed' ? 'discovering' : 'discovery-queued';
      attempt.status = job.status;
      return false;
    }
    attempt.finishedAt = new Date(now()).toISOString();
    if (job.status !== 'completed') {
      attempt.status = 'failed';
      attempt.rejection = text(job.lastError || 'Hosted community discovery failed.', 300);
      candidate.status = candidate.discoveryAttempts.length >= MAX_DISCOVERY_ATTEMPTS
        ? 'failed' : 'discovery-pending';
      if (candidate.status === 'failed') candidate.error = attempt.rejection;
      return true;
    }
    try {
      candidate.communityAffinities = characterCreator.parseCommunityChoices(
        job.result && job.result.text,
        attempt.slate,
        now(),
      );
      const favored = candidate.communityAffinities
        .filter((entry) => entry.state === 'favored')
        .map((entry) => entry.name);
      candidate.seed.communities = favored.length ? favored : candidate.seed.communities;
      candidate.communityDiscovery = {
        completedAt: new Date(now()).toISOString(),
        provider: attempt.provider,
        model: attempt.model,
        source: 'feddit-active-communities',
        windowHours: attempt.slate[0] && attempt.slate[0].exposure
          ? attempt.slate[0].exposure.windowHours : 48,
        choices: characterCreator.affinitySummary(candidate.communityAffinities),
      };
      attempt.slate = attempt.slate.map((entry) => ({
        id: entry.id,
        name: entry.name,
        exposure: entry.exposure,
      }));
      attempt.status = 'accepted';
      candidate.status = 'accepted';
      candidate.error = '';
    } catch (error) {
      attempt.status = 'rejected-invalid';
      attempt.rejection = text(error.message, 300);
      candidate.status = candidate.discoveryAttempts.length >= MAX_DISCOVERY_ATTEMPTS
        ? 'failed' : 'discovery-pending';
      if (candidate.status === 'failed') candidate.error = attempt.rejection;
    }
    return true;
  }

  async function tickGeneration() {
    const cohort = load().cohorts.find((item) => item.status === 'generating');
    if (!cohort) return;
    const active = cohort.candidates.find((candidate) => [
      'queued', 'generating', 'discovery-queued', 'discovering',
    ].includes(candidate.status));
    if (active) {
      const discovery = active.status === 'discovery-queued' || active.status === 'discovering';
      const attempts = discovery ? active.discoveryAttempts : active.attempts;
      const attempt = attempts[attempts.length - 1];
      const job = queue.get(attempt.jobId);
      if (!job) {
        attempt.status = 'failed';
        attempt.rejection = 'The durable hosted generation job disappeared.';
        attempt.finishedAt = new Date(now()).toISOString();
        active.status = discovery
          ? (attempts.length >= MAX_DISCOVERY_ATTEMPTS ? 'failed' : 'discovery-pending')
          : (attempts.length >= MAX_ATTEMPTS_PER_SLOT ? 'failed' : 'pending');
        if (active.status === 'failed') active.error = attempt.rejection;
        save();
      } else if ((discovery ? processDiscoveryJob : processCandidateJob)(cohort, active, attempt, job)) {
        cohort.updatedAt = new Date(now()).toISOString();
        save();
      } else {
        // A cohort intentionally has only one active seed generation. Do not
        // move on to another pending slot while this durable job is waiting
        // or running.
        cohort.updatedAt = new Date(now()).toISOString();
        save();
        return;
      }
    }
    const discoveryNext = cohort.candidates.find((candidate) => candidate.status === 'discovery-pending');
    if (discoveryNext) {
      try {
        await enqueueDiscovery(cohort, discoveryNext);
      } catch (error) {
        const rejection = text(error.message, 300);
        discoveryNext.discoveryAttempts.push({
          attempt: discoveryNext.discoveryAttempts.length + 1,
          jobId: null,
          status: 'failed',
          createdAt: new Date(now()).toISOString(),
          finishedAt: new Date(now()).toISOString(),
          provider: String(cohort.creator && cohort.creator.provider || 'dell'),
          model: String(cohort.creator && cohort.creator.model || configuredCreatorModel || runtimeModel),
          slate: [],
          rejection,
        });
        discoveryNext.error = rejection;
        discoveryNext.status = discoveryNext.discoveryAttempts.length >= MAX_DISCOVERY_ATTEMPTS
          ? 'failed' : 'discovery-pending';
        cohort.updatedAt = new Date(now()).toISOString();
        save();
      }
      return;
    }
    const next = cohort.candidates.find((candidate) => candidate.status === 'pending');
    if (next) enqueueCandidate(cohort, next);
    else finishGenerationIfReady(cohort);
  }

  function cohortProfiles(cohort) {
    return (cohort && Array.isArray(cohort.candidates) ? cohort.candidates : [])
      .map((candidate) => candidate.profileId && profileStore.getProfile(candidate.profileId))
      .filter(Boolean);
  }

  function restoreRunProfiles(run) {
    if (!run || !run.priorEnabledByProfile) return;
    for (const [profileId, enabled] of Object.entries(run.priorEnabledByProfile)) {
      const profile = profileStore.getProfile(profileId);
      if (!profile || profile.botOrigin !== 'system') continue;
      profileStore.updateProfile(profileId, { enabled: enabled === true, dryRun: true });
    }
  }

  function finishRehearsalRun(cohort, status, note) {
    const run = cohort.rehearsalRun;
    if (!run) return;
    restoreRunProfiles(run);
    run.status = status;
    run.note = text(note, 300);
    run.finishedAt = new Date(now()).toISOString();
    run.activeTurnId = null;
    cohort.updatedAt = run.finishedAt;
    save();
  }

  function setScheduler(api) {
    schedulerApi = api || null;
  }

  function startRehearsalRun(id, options = {}) {
    if (!schedulerApi || !turnStore) {
      throw new Error('Accelerated rehearsal is not available until the hosted scheduler is ready.');
    }
    const data = load();
    const cohort = data.cohorts.find((item) => item.id === String(id));
    if (!cohort) throw new Error('No such population cohort.');
    const running = data.cohorts.find((item) => item.rehearsalRun && item.rehearsalRun.status === 'running');
    if (running) {
      throw new Error(running.id === cohort.id
        ? 'This cohort already has an accelerated rehearsal running.'
        : 'Another cohort is already using the bounded accelerated rehearsal runner.');
    }
    if (!['staged', 'rehearsal'].includes(cohort.status)) {
      throw new Error(cohort.status === 'live'
        ? 'Move this cohort out of LIVE operation before running an isolated rehearsal.'
        : 'Stage the complete cohort before starting an accelerated rehearsal.');
    }
    const candidates = cohort.candidates.filter((candidate) => candidate.seed);
    if (!candidates.length || candidates.some((candidate) => !candidate.profileId)) {
      throw new Error('Stage every accepted candidate before starting rehearsal.');
    }
    const profiles = cohortProfiles(cohort);
    if (profiles.length !== candidates.length || profiles.some((profile) =>
      profile.botOrigin !== 'system' || !profile.token || profile.dryRun !== true)) {
      throw new Error('Every cohort member must be a registered system bot in rehearsal mode.');
    }
    const requestedOpportunities = Math.max(1, Math.min(MAX_REHEARSAL_OPPORTUNITIES,
      Math.floor(Number(options.opportunities) || DEFAULT_REHEARSAL_OPPORTUNITIES)));
    const requestedDays = Math.max(1, Math.min(MAX_REHEARSAL_DAYS,
      Math.floor(Number(options.days) || DEFAULT_REHEARSAL_DAYS)));
    const startedAtMs = now();
    const priorEnabledByProfile = {};
    for (const profile of profiles) {
      priorEnabledByProfile[profile.id] = profile.enabled === true;
      const provenance = {
        ...(profile.populationProvenance || {}),
        lifecycle: 'rehearsal',
        activatedAt: profile.populationProvenance?.activatedAt || new Date(startedAtMs).toISOString(),
      };
      profileStore.updateProfile(profile.id, {
        enabled: false,
        dryRun: true,
        populationProvenance: provenance,
      });
      profileStore.logActivity(profile.id, {
        kind: 'population-accelerated-rehearsal', ok: true,
        note: 'Entered bounded accelerated rehearsal for cohort ' + cohort.id + '.',
      });
    }
    for (const candidate of candidates) candidate.status = 'rehearsal';
    cohort.status = 'rehearsal';
    cohort.rehearsalRun = {
      id: newId('rehearsal'),
      status: 'running',
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: null,
      note: '',
      requestedOpportunities,
      requestedDays,
      completedOpportunities: 0,
      virtualStartedAt: startedAtMs,
      virtualNowAt: startedAtMs,
      virtualEndAt: startedAtMs + requestedDays * 24 * 60 * 60 * 1000,
      activeTurnId: null,
      lastProfileId: null,
      lastOutcome: null,
      priorEnabledByProfile,
    };
    cohort.updatedAt = new Date(startedAtMs).toISOString();
    save(data);
    return publicCohort(cohort, profileStore, now());
  }

  function resetRehearsal(id) {
    const cohort = load().cohorts.find((item) => item.id === String(id));
    if (!cohort) throw new Error('No such population cohort.');
    const run = cohort.rehearsalRun;
    if (run && run.status === 'running') {
      if (run.activeTurnId) {
        const turn = turnStore && turnStore.get(run.activeTurnId);
        if (turn && !['completed', 'failed', 'publication-uncertain'].includes(turn.status)) {
          throw new Error('This rehearsal is still finishing a durable turn. Reset it after that turn reaches a terminal state.');
        }
      }
      restoreRunProfiles(run);
    }
    for (const profile of cohortProfiles(cohort)) {
      if (profile.botOrigin === 'system') profileStore.resetSimulation(profile.id);
    }
    cohort.rehearsalRun = null;
    cohort.updatedAt = new Date(now()).toISOString();
    save();
    return publicCohort(cohort, profileStore, now());
  }

  async function tickRehearsalRun() {
    const cohort = load().cohorts.find((item) => item.rehearsalRun && item.rehearsalRun.status === 'running');
    if (!cohort || !schedulerApi || !turnStore) return;
    const run = cohort.rehearsalRun;
    if (run.activeTurnId) {
      const turn = turnStore.get(run.activeTurnId);
      if (!turn) {
        finishRehearsalRun(cohort, 'failed', 'The durable rehearsal turn disappeared; no replacement was queued automatically.');
        return;
      }
      if (!['completed', 'failed', 'publication-uncertain'].includes(turn.status)) return;
      run.completedOpportunities = Math.max(0, Number(run.completedOpportunities) || 0) + 1;
      run.lastOutcome = turn.status;
      run.lastProfileId = turn.profileId;
      run.activeTurnId = null;
      cohort.updatedAt = new Date(now()).toISOString();
      save();
    }
    if (Number(run.completedOpportunities) >= Number(run.requestedOpportunities)) {
      finishRehearsalRun(cohort, 'completed', 'Reached the requested opportunity limit.');
      return;
    }

    const profiles = cohortProfiles(cohort).filter((profile) =>
      profile.botOrigin === 'system' && profile.dryRun === true && profile.token);
    if (!profiles.length) {
      finishRehearsalRun(cohort, 'failed', 'No staged system profile remains available for rehearsal.');
      return;
    }
    const virtualNowAt = Math.max(Number(run.virtualNowAt) || 0, Number(run.virtualStartedAt) || 0);
    const choices = profiles.map((profile) => ({
      profile,
      nextAt: schedulerApi.rehearsalNextAt(profile.id, virtualNowAt),
    })).filter((choice) => Number.isFinite(Number(choice.nextAt)));
    if (!choices.length) {
      finishRehearsalRun(cohort, 'completed', 'No further configured opportunity was available.');
      return;
    }
    choices.sort((left, right) => left.nextAt - right.nextAt || left.profile.id.localeCompare(right.profile.id));
    const chosen = choices[0];
    const opportunityAt = Math.max(virtualNowAt, Number(chosen.nextAt));
    if (opportunityAt > Number(run.virtualEndAt)) {
      run.virtualNowAt = Number(run.virtualEndAt);
      finishRehearsalRun(cohort, 'completed', 'Reached the requested virtual-time limit.');
      return;
    }

    run.virtualNowAt = opportunityAt;
    const result = await schedulerApi.runAcceleratedRehearsalOpportunity(chosen.profile.id, {
      runId: run.id,
      virtualNowMs: opportunityAt,
    });
    if (result && result.handedOff && result.turnId) {
      run.activeTurnId = result.turnId;
      run.lastProfileId = chosen.profile.id;
    } else if (result && result.skipped === 'capacity-yield') {
      run.completedOpportunities = Math.max(0, Number(run.completedOpportunities) || 0) + 1;
      run.lastOutcome = 'capacity-skip';
      run.lastProfileId = chosen.profile.id;
    } else if (result && ['profile-busy', 'scheduler-busy'].includes(result.skipped)) {
      return;
    } else if (result) {
      run.completedOpportunities = Math.max(0, Number(run.completedOpportunities) || 0) + 1;
      run.lastOutcome = result.ok === false ? 'failed' : 'completed';
      run.lastProfileId = chosen.profile.id;
    }
    cohort.updatedAt = new Date(now()).toISOString();
    if (Number(run.completedOpportunities) >= Number(run.requestedOpportunities)) {
      finishRehearsalRun(cohort, 'completed', 'Reached the requested opportunity limit.');
      return;
    }
    save();
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await tickGeneration();
      await tickRehearsalRun();
    } finally {
      ticking = false;
    }
  }

  function candidateProfilePatch(candidate, cohort, username) {
    const seed = candidate.seed;
    const externalAssociation = cohort.externalAssociation
      ? normalizeExternalAssociation(cohort.externalAssociation)
      : null;
    const patch = {
      fedditUsername: username,
      fedditBio: seed.biography,
      persona: candidate.runtimeKernel || seedPersona(seed, cohort.direction),
      toneNotes: seed.toneNotes,
      readFeddits: seed.communities.slice(),
      postFeddits: seed.communities.slice(),
      communityMode: candidate.communityAffinities && candidate.communityAffinities.length
        ? 'discover' : (seed.breadth === 'narrow' ? 'home' : 'discover'),
      feedSort: seed.noveltySeeking === 'high' ? 'new' : 'best',
      canReply: seed.abilities.reply,
      canStartDiscussions: seed.abilities.discuss,
      canShareLinks: seed.abilities.links,
      provider: 'dell',
      model: runtimeModel,
      enabled: false,
      dryRun: true,
      botOrigin: 'system',
      populationSeed: seed,
      creatorProfile: candidate.creatorProfile || null,
      creatorProvenance: candidate.creatorProfile ? {
        provider: cohort.creator && cohort.creator.provider || 'dell',
        model: cohort.creator && cohort.creator.model || runtimeModel,
        label: cohort.creator && cohort.creator.label || '',
        fallback: Boolean(cohort.creator && cohort.creator.fallback),
        createdAt: candidate.attempts[candidate.attempts.length - 1]?.finishedAt || cohort.updatedAt,
      } : null,
      runtimeCharacterKernel: candidate.runtimeKernel || '',
      communityAffinities: characterCreator.normalizeAffinities(candidate.communityAffinities || [], now()),
      communityDiscoveryState: candidate.communityDiscovery ? {
        ...candidate.communityDiscovery,
        nextEligibleAt: null,
      } : null,
      populationActivity: populationActivity.normalizeState(candidate.populationActivity, {
        nowMs: now(), seed,
      }),
      populationProvenance: {
        source: externalAssociation ? externalAssociation.source : 'ai-generated-hosted-population',
        cohortId: cohort.id,
        candidateId: candidate.id,
        seedCreatedAt: candidate.attempts[candidate.attempts.length - 1]?.finishedAt || cohort.updatedAt,
        acceptedAttempt: candidate.attempts.length,
        duplicateRegenerations: candidate.duplicateRegenerations,
        registrationConflicts: candidate.registrationConflicts || 0,
        providerPath: externalAssociation ? 'external-seed' : 'hosted-dell',
        ...(candidate.creatorProfile ? {
          creator: {
            provider: cohort.creator && cohort.creator.provider || 'dell',
            model: cohort.creator && cohort.creator.model || runtimeModel,
            fallback: Boolean(cohort.creator && cohort.creator.fallback),
          },
          communityDiscovery: candidate.communityDiscovery || null,
        } : {}),
        ...(externalAssociation ? { externalAssociation } : {}),
        cohortConfiguration: normalizeCohortConfiguration(cohort.configuration),
        lifecycle: 'staged',
        stagedAt: new Date(now()).toISOString(),
        activatedAt: null,
      },
    };
    patch.simulationState = {
      populationActivity: populationActivity.rehearsalFromLive(patch.populationActivity, {
        nowMs: now(), random,
      }),
    };
    return patch;
  }

  async function stageCohort(id) {
    const cohort = load().cohorts.find((item) => item.id === String(id));
    if (!cohort) throw new Error('No such population cohort.');
    if (!['ready', 'stage-failed', 'staged'].includes(cohort.status)) {
      throw new Error('Wait for cohort generation to finish before staging it.');
    }
    const acceptedCandidates = cohort.candidates.filter((candidate) => candidate.seed);
    if (acceptedCandidates.some((candidate) => !candidate.populationActivity)) {
      const assigned = populationActivity.assignCohort(
        acceptedCandidates.map((candidate) => candidate.seed),
        { nowMs: now(), random, offset: cohort.activityOffset, ...cohortActivityOptions(cohort.configuration) },
      );
      acceptedCandidates.forEach((candidate, index) => {
        candidate.populationActivity = assigned[index];
      });
      save();
    }
    const used = new Set(profileStore.listProfiles().map((profile) => String(profile.fedditUsername || '').toLowerCase()).filter(Boolean));
    for (const candidate of cohort.candidates.filter((item) => item.seed && !item.profileId)) {
      let staged = false;
      for (let registrationAttempt = 0; registrationAttempt < 6 && !staged; registrationAttempt++) {
        const username = uniqueUsername(candidate.seed.username, used, candidate.registrationConflicts || 0);
        const patch = candidateProfilePatch(candidate, cohort, username);
        const draft = profileStore.createProfile(patch);
        let registration;
        try {
          registration = await feddit.register({ username, description: seedBiography(candidate.seed) });
        } catch (error) {
          // A transport failure is ambiguous: Feddit may have created the
          // identity without the response reaching us. Preserve the disabled
          // draft and its exact username for inspection rather than deleting
          // evidence or silently registering a second account.
          candidate.profileId = draft.id;
          candidate.error = 'Registration transport failed: ' + text(error.message, 240);
          candidate.status = 'registration-uncertain';
          break;
        }
        if (!registration.ok) {
          profileStore.deleteProfile(draft.id);
          if (registration.status === 409) {
            used.add(username.toLowerCase());
            candidate.registrationConflicts = Math.max(0, Number(candidate.registrationConflicts) || 0) + 1;
            continue;
          }
          candidate.error = text(registration.error || 'Feddit registration failed.', 300);
          candidate.status = 'stage-failed';
          break;
        }
        const token = registration.data && registration.data.token;
        if (!token) {
          candidate.profileId = draft.id;
          candidate.error = 'Feddit registration succeeded without returning the one-time token.';
          candidate.status = 'registration-uncertain';
          break;
        }
        profileStore.updateProfile(draft.id, { token });
        profileStore.logActivity(draft.id, {
          kind: 'population-stage', ok: true,
          note: 'System-generated bot staged in rehearsal from cohort ' + cohort.id + '.',
        });
        candidate.profileId = draft.id;
        candidate.status = 'staged';
        candidate.error = '';
        used.add(username.toLowerCase());
        staged = true;
      }
      if (!staged && !candidate.profileId && candidate.status !== 'stage-failed') {
        candidate.status = 'stage-failed';
        candidate.error = 'Feddit usernames remained unavailable after the bounded registration retry limit.';
      }
    }
    cohort.status = cohort.candidates.some((candidate) => candidate.seed && candidate.status !== 'staged')
      ? 'stage-failed'
      : 'staged';
    cohort.updatedAt = new Date(now()).toISOString();
    save();
    return publicCohort(cohort, profileStore, now());
  }

  function seedBiography(seed) {
    return text(seed.biography, 500);
  }

  function activateCohort(id, mode = 'rehearsal') {
    const cohort = load().cohorts.find((item) => item.id === String(id));
    if (!cohort) throw new Error('No such population cohort.');
    if (cohort.rehearsalRun && cohort.rehearsalRun.status === 'running') {
      throw new Error('Let the accelerated rehearsal finish before changing this cohort activation mode.');
    }
    const chosenMode = mode === 'live' ? 'live' : 'rehearsal';
    const candidates = cohort.candidates.filter((candidate) => candidate.seed);
    if (!candidates.length || candidates.some((candidate) => !candidate.profileId)) {
      throw new Error('Stage every accepted candidate before activation.');
    }
    for (const candidate of candidates) {
      const profile = profileStore.getProfile(candidate.profileId);
      if (!profile || !profile.token || profile.botOrigin !== 'system') {
        throw new Error('A staged system bot is missing its registered Feddit identity.');
      }
      const provenance = {
        ...(profile.populationProvenance || {}),
        lifecycle: chosenMode,
        activatedAt: profile.populationProvenance?.activatedAt || new Date(now()).toISOString(),
      };
      profileStore.updateProfile(profile.id, { populationProvenance: provenance });
      activateProfile(profileStore.getProfile(profile.id), chosenMode);
      profileStore.logActivity(profile.id, {
        kind: 'population-activate', ok: true,
        note: chosenMode === 'live'
          ? 'System-generated bot explicitly activated for live publishing.'
          : 'System-generated bot started in rehearsal; publishing remains off.',
      });
      candidate.status = chosenMode;
    }
    cohort.status = chosenMode;
    cohort.updatedAt = new Date(now()).toISOString();
    save();
    return publicCohort(cohort, profileStore, now());
  }

  function resetForTests() { cache = null; }

  return {
    file, createCohort, stageExternalSeeds, listCohorts, listHiddenCohorts, getCohort, listArchivedProfiles, listDetachedProfiles, tick, stageCohort,
    activateCohort, archiveProfile, restoreProfile, forgetProfile, archiveDetachedProfiles,
    hideCohort, restoreCohort, forgetCohortRecord,
    startRehearsalRun, resetRehearsal, setScheduler, creatorStatus, resetForTests,
  };
}

module.exports = {
  VERSION,
  MAX_COHORT_SIZE,
  MAX_COHORT_DIRECTION_LENGTH,
  MAX_EXTERNAL_SOURCE_LENGTH,
  MAX_EXTERNAL_REFERENCE_LENGTH,
  MAX_ATTEMPTS_PER_SLOT,
  MAX_DISCOVERY_ATTEMPTS,
  SIMILARITY_THRESHOLD,
  DEFAULT_REHEARSAL_OPPORTUNITIES,
  MAX_REHEARSAL_OPPORTUNITIES,
  DEFAULT_REHEARSAL_DAYS,
  MAX_REHEARSAL_DAYS,
  DEFAULT_COMMUNITIES,
  COHORT_STRENGTHS,
  COHORT_ACTIVITIES,
  COHORT_ABILITY_CHOICES,
  COHORT_BALANCES,
  DEFAULT_COHORT_CONFIGURATION,
  normalizeUsername,
  normalizeSeed,
  seedPersona,
  seedSimilarity,
  closestSeed,
  extractJson,
  generationSystemPrompt,
  generationPrompt,
  normalizeCohortDirection,
  normalizeCohortConfiguration,
  cohortActivityOptions,
  structuredControlPrompt,
  applyCohortConfiguration,
  validateHardSeed,
  ExternalPopulationSeedError,
  normalizeExternalAssociation,
  normalizeExternalSeed,
  uniqueUsername,
  createPopulationController,
};
