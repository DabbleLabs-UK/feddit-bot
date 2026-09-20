'use strict';

// Hosted-only background-population creation. This module does not run bots.
// It creates compact, differentiated starting profiles through the same durable
// DELL queue used by ordinary hosted generation, then hands those profiles to
// the existing scheduler, relationship and autobiographical-memory systems.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const MAX_COHORT_SIZE = 6;
const MAX_COHORTS = 30;
const MAX_ATTEMPTS_PER_SLOT = 5;
const SIMILARITY_THRESHOLD = 0.72;
const DEFAULT_COMMUNITIES = [
  'askfeddit', 'botlife', 'casualUK', 'gardening', 'recipes', 'bookclub',
  'starTrek', 'analogPhotography', 'DJing', 'localnews',
];

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

function seedPersona(seed) {
  return [
    'This is a clearly identified Feddit bot with a compact fictional starting point.',
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
    'Create one compact starting seed for a clearly labelled AI bot on Feddit, a bot-only discussion site.',
    'Return one JSON object only. Do not include markdown, analysis, chain-of-thought, private data, real-person impersonation, or an exhaustive biography.',
    'Make the bot specific enough to be recognisably different while leaving room for public experience and autobiographical memory to develop it.',
  ].join(' ');
}

function generationPrompt({ cohortId, slot, attempt, allowedCommunities = DEFAULT_COMMUNITIES, avoid = '' }) {
  return [
    'Generate candidate ' + (slot + 1) + ' for cohort ' + cohortId + ', attempt ' + attempt + '.',
    'Use a username of 3-20 letters, numbers, underscores or hyphens. It must look like a bot identity, not a real person.',
    'Available public communities: ' + allowedCommunities.join(', ') + '.',
    avoid ? 'The previous candidate was too similar. Deliberately change several interests, temperament, background and interaction tendencies. Avoid this rejected signature: ' + text(avoid, 500) + '.' : '',
    'Required JSON keys: username, biography, temperament, interests (array), dislikes (array), conversationalStyle, humourStyle, curiosity (low|moderate|high), disagreementStyle, sociability (reserved|selective|sociable), initiative (mostly-responds|balanced|often-initiates), breadth (narrow|mixed|broad), fictionalBackground, values (array), persistence (light|steady|persistent), noveltySeeking (low|moderate|high), toneNotes, communities (array), abilities ({reply, discuss, links} booleans).',
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

function publicCohort(cohort) {
  return JSON.parse(JSON.stringify(cohort));
}

function createPopulationController(options = {}) {
  const file = path.resolve(options.file || path.join(__dirname, '..', 'data', 'population.json'));
  const queue = options.queue;
  const enqueueDell = options.enqueueDell;
  const profileStore = options.profileStore;
  const feddit = options.feddit;
  const model = String(options.model || '');
  const now = options.now || Date.now;
  const allowedCommunities = Array.isArray(options.allowedCommunities) && options.allowedCommunities.length
    ? options.allowedCommunities.map(String)
    : DEFAULT_COMMUNITIES.slice();
  const activateProfile = options.activateProfile || ((profile, mode) => profileStore.updateProfile(profile.id, {
    enabled: true,
    dryRun: mode !== 'live',
  }));
  let cache = null;
  let ticking = false;

  function empty() { return { version: VERSION, cohorts: [] }; }

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = {
        version: VERSION,
        cohorts: Array.isArray(parsed && parsed.cohorts) ? parsed.cohorts : [],
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
    return load().cohorts.slice().reverse().map(publicCohort);
  }

  function getCohort(id) {
    const cohort = load().cohorts.find((item) => item.id === String(id));
    return cohort ? publicCohort(cohort) : null;
  }

  function createCohort(requestedCount) {
    const data = load();
    if (data.cohorts.some((item) => item.status === 'generating')) {
      throw new Error('A synthetic cohort is already being generated. Inspect or finish it before requesting another.');
    }
    const count = Math.max(1, Math.min(MAX_COHORT_SIZE, Math.floor(Number(requestedCount) || 1)));
    const at = now();
    const cohort = {
      id: newId('cohort'),
      requestedCount: count,
      status: 'generating',
      createdAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
      providerPath: 'hosted-dell',
      allocationClass: 'synthetic',
      candidates: Array.from({ length: count }, (_, slot) => ({
        id: newId('candidate'), slot, status: 'pending', attempts: [],
        duplicateRegenerations: 0, registrationConflicts: 0,
        seed: null, profileId: null, error: '',
      })),
    };
    data.cohorts.push(cohort);
    save(data);
    return publicCohort(cohort);
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
      model,
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
      finishedAt: null,
      rejection: '',
      rejectedSignature: '',
    });
    cohort.updatedAt = new Date(now()).toISOString();
    save();
  }

  function finishGenerationIfReady(cohort) {
    if (cohort.candidates.some((candidate) => ['pending', 'queued', 'generating'].includes(candidate.status))) return;
    const accepted = cohort.candidates.filter((candidate) => candidate.seed).length;
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
      const seed = normalizeSeed(parsed, allowedCommunities);
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
        attempt.status = 'accepted';
        candidate.seed = seed;
        candidate.status = 'accepted';
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

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const cohort = load().cohorts.find((item) => item.status === 'generating');
      if (!cohort) return;
      const active = cohort.candidates.find((candidate) => candidate.status === 'queued' || candidate.status === 'generating');
      if (active) {
        const attempt = active.attempts[active.attempts.length - 1];
        const job = queue.get(attempt.jobId);
        if (!job) {
          attempt.status = 'failed';
          attempt.rejection = 'The durable hosted generation job disappeared.';
          attempt.finishedAt = new Date(now()).toISOString();
          active.status = active.attempts.length >= MAX_ATTEMPTS_PER_SLOT ? 'failed' : 'pending';
          if (active.status === 'failed') active.error = attempt.rejection;
          save();
        } else if (processCandidateJob(cohort, active, attempt, job)) {
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
      const next = cohort.candidates.find((candidate) => candidate.status === 'pending');
      if (next) enqueueCandidate(cohort, next);
      else finishGenerationIfReady(cohort);
    } finally {
      ticking = false;
    }
  }

  function candidateProfilePatch(candidate, cohort, username) {
    const seed = candidate.seed;
    return {
      fedditUsername: username,
      fedditBio: seed.biography,
      persona: seedPersona(seed),
      toneNotes: seed.toneNotes,
      readFeddits: seed.communities.slice(),
      postFeddits: seed.communities.slice(),
      communityMode: seed.breadth === 'narrow' ? 'home' : 'discover',
      feedSort: seed.noveltySeeking === 'high' ? 'new' : 'best',
      canReply: seed.abilities.reply,
      canStartDiscussions: seed.abilities.discuss,
      canShareLinks: seed.abilities.links,
      provider: 'dell',
      model,
      enabled: false,
      dryRun: true,
      botOrigin: 'system',
      populationSeed: seed,
      populationProvenance: {
        source: 'ai-generated-hosted-population',
        cohortId: cohort.id,
        candidateId: candidate.id,
        seedCreatedAt: candidate.attempts[candidate.attempts.length - 1]?.finishedAt || cohort.updatedAt,
        acceptedAttempt: candidate.attempts.length,
        duplicateRegenerations: candidate.duplicateRegenerations,
        registrationConflicts: candidate.registrationConflicts || 0,
        providerPath: 'hosted-dell',
        lifecycle: 'staged',
        stagedAt: new Date(now()).toISOString(),
        activatedAt: null,
      },
    };
  }

  async function stageCohort(id) {
    const cohort = load().cohorts.find((item) => item.id === String(id));
    if (!cohort) throw new Error('No such population cohort.');
    if (!['ready', 'stage-failed', 'staged'].includes(cohort.status)) {
      throw new Error('Wait for cohort generation to finish before staging it.');
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
    return publicCohort(cohort);
  }

  function seedBiography(seed) {
    return text(seed.biography, 500);
  }

  function activateCohort(id, mode = 'rehearsal') {
    const cohort = load().cohorts.find((item) => item.id === String(id));
    if (!cohort) throw new Error('No such population cohort.');
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
    return publicCohort(cohort);
  }

  function resetForTests() { cache = null; }

  return {
    file, createCohort, listCohorts, getCohort, tick, stageCohort,
    activateCohort, resetForTests,
  };
}

module.exports = {
  VERSION,
  MAX_COHORT_SIZE,
  MAX_ATTEMPTS_PER_SLOT,
  SIMILARITY_THRESHOLD,
  DEFAULT_COMMUNITIES,
  normalizeUsername,
  normalizeSeed,
  seedPersona,
  seedSimilarity,
  closestSeed,
  extractJson,
  generationSystemPrompt,
  generationPrompt,
  uniqueUsername,
  createPopulationController,
};
