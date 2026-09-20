'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_COHORT_SIZE,
  SIMILARITY_THRESHOLD,
  closestSeed,
  createPopulationController,
  generationPrompt,
  normalizeSeed,
  normalizeUsername,
  seedSimilarity,
  uniqueUsername,
} = require('../lib/population');
const storeModule = require('../lib/store');

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

function candidate(overrides = {}) {
  return {
    username: 'teapot_observer',
    biography: 'Notices how small rituals make shared places feel human.',
    temperament: 'patient, dry, and attentive',
    interests: ['tea rituals', 'public benches', 'quiet museums'],
    dislikes: ['needless urgency'],
    conversationalStyle: 'offers one concrete observation before asking a narrow question',
    humourStyle: 'understated comparisons',
    curiosity: 'high',
    disagreementStyle: 'separates facts from taste and concedes useful points',
    sociability: 'selective',
    initiative: 'balanced',
    breadth: 'mixed',
    fictionalBackground: 'Once catalogued lost umbrellas at a railway station.',
    values: ['patience', 'specificity'],
    persistence: 'steady',
    noveltySeeking: 'moderate',
    toneNotes: 'measured, concrete, lightly amused',
    communities: ['botlife', 'askfeddit'],
    abilities: { reply: true, discuss: true, links: false },
    ...overrides,
  };
}

function fakeStore() {
  let sequence = 0;
  const profiles = [{
    id: 'user-private',
    fedditUsername: 'private_user_bot',
    botOrigin: 'user',
    persona: 'PRIVATE-WORKSPACE-SENTINEL',
    token: 'user-token',
  }];
  return {
    profiles,
    listProfiles() { return profiles.map((profile) => structuredClone(profile)); },
    getProfile(id) {
      const profile = profiles.find((item) => item.id === id);
      return profile ? structuredClone(profile) : null;
    },
    createProfile(patch) {
      const profile = { id: 'profile-' + (++sequence), createdAt: new Date().toISOString(), ...structuredClone(patch) };
      profiles.push(profile);
      return structuredClone(profile);
    },
    updateProfile(id, patch) {
      const index = profiles.findIndex((item) => item.id === id);
      if (index < 0) return null;
      profiles[index] = { ...profiles[index], ...structuredClone(patch) };
      return structuredClone(profiles[index]);
    },
    deleteProfile(id) {
      const index = profiles.findIndex((item) => item.id === id);
      if (index < 0) return false;
      profiles.splice(index, 1);
      return true;
    },
    logActivity(id, entry) {
      const profile = profiles.find((item) => item.id === id);
      if (!profile) return null;
      profile.activity = [...(profile.activity || []), structuredClone(entry)];
      return structuredClone(profile);
    },
  };
}

async function run() {
  eq(storeModule.DATA_SCHEMA_VERSION, 14, 'profile storage schema records population provenance support');
  const migratedProfiles = storeModule.migrateProfiles([
    { id: 'user', botOrigin: 'user', populationSeed: { username: 'forged' }, populationProvenance: { source: 'forged' } },
    { id: 'system', botOrigin: 'system', populationSeed: { username: 'real_system' }, populationProvenance: { source: 'generated' } },
  ], 13);
  eq(migratedProfiles[0].populationSeed, null, 'user-created profiles cannot retain system population seed metadata');
  eq(migratedProfiles[0].populationProvenance, null, 'user-created profiles cannot retain system population provenance');
  eq(migratedProfiles[1].populationSeed.username, 'real_system', 'system population seed survives migration');
  eq(migratedProfiles[1].populationProvenance.source, 'generated', 'system population provenance survives migration');

  eq(normalizeUsername('  A Real Name!?  '), 'a_real_name', 'username is normalised to the Feddit identity alphabet');
  ok(/^[a-z0-9_-]{3,20}$/.test(normalizeUsername('x')), 'short model names become valid Feddit usernames');
  eq(uniqueUsername('same_bot', new Set(['same_bot'])), 'same_bot_1', 'a deterministic suffix avoids a known collision');

  const first = normalizeSeed(candidate());
  const duplicate = normalizeSeed(candidate({ username: 'another_name' }));
  const different = normalizeSeed(candidate({
    username: 'loud_cloud_bot',
    biography: 'Chases storms, synth patches, and ambitious communal projects.',
    temperament: 'energetic and cheerfully blunt',
    interests: ['weather radar', 'modular synthesis', 'night buses'],
    conversationalStyle: 'starts with a bold question and follows surprising tangents',
    humourStyle: 'absurd callbacks',
    curiosity: 'moderate',
    disagreementStyle: 'challenges premises directly, then invites alternatives',
    sociability: 'sociable',
    initiative: 'often-initiates',
    breadth: 'broad',
    fictionalBackground: 'Claims to have learned rhythm from a faulty pedestrian crossing.',
    values: ['experimentation', 'candour'],
    persistence: 'light',
    noveltySeeking: 'high',
    toneNotes: 'quick, vivid, surprising',
    communities: ['DJing', 'casualUK'],
  }));
  ok(seedSimilarity(first, duplicate) >= SIMILARITY_THRESHOLD, 'duplicate scoring catches renamed copies');
  ok(seedSimilarity(first, different) < SIMILARITY_THRESHOLD, 'meaningfully different seeds remain available');
  ok(closestSeed(duplicate, [first]), 'closest-seed check rejects a near duplicate');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-population-'));
  try {
    const file = path.join(dir, 'population.json');
    const jobs = new Map();
    const requests = [];
    let jobSequence = 0;
    const queue = { get(id) { return jobs.get(id) ? structuredClone(jobs.get(id)) : null; } };
    const enqueueDell = (request) => {
      const job = { id: 'job-' + (++jobSequence), status: 'queued', result: null, lastError: '' };
      requests.push(structuredClone(request));
      jobs.set(job.id, job);
      return structuredClone(job);
    };
    const store = fakeStore();
    const registered = [];
    let conflictOnce = true;
    const feddit = {
      async register({ username, description }) {
        registered.push({ username, description });
        if (conflictOnce) {
          conflictOnce = false;
          return { ok: false, status: 409, error: 'taken' };
        }
        return { ok: true, status: 201, data: { token: 'token-' + username } };
      },
    };
    const activations = [];
    const options = {
      file, queue, enqueueDell, profileStore: store, feddit, model: 'shared-test-model',
      activateProfile(profile, mode) {
        activations.push({ id: profile.id, mode });
        return store.updateProfile(profile.id, { enabled: true, dryRun: mode !== 'live' });
      },
    };
    const controller = createPopulationController(options);
    const created = controller.createCohort(99);
    eq(created.requestedCount, MAX_COHORT_SIZE, 'cohort size is bounded even for an excessive request');

    // Use a smaller isolated cohort for a readable sequential lifecycle.
    fs.rmSync(file, { force: true });
    const lifecycle = createPopulationController({ ...options, file: path.join(dir, 'lifecycle.json') });
    const cohort = lifecycle.createCohort(2);
    await lifecycle.tick();
    eq(requests.length, 1, 'only one population generation is queued at a time');
    eq(requests[0].priority, 'background', 'population generation uses background queue priority');
    eq(requests[0].allocationClass, 'synthetic', 'population generation uses the protected synthetic class');
    eq(requests[0].provider, 'dell', 'population generation uses the existing hosted provider path');
    eq(requests[0].model, 'shared-test-model', 'population generation uses the configured shared hosted model');
    ok(!requests[0].prompt.includes('PRIVATE-WORKSPACE-SENTINEL'), 'generation prompt excludes private user profile data');
    ok(!requests[0].system.includes('PRIVATE-WORKSPACE-SENTINEL'), 'system prompt excludes private user profile data');
    await lifecycle.tick();
    eq(requests.length, 1, 'polling a queued seed does not enqueue another');

    jobs.set('job-1', {
      id: 'job-1', status: 'completed',
      result: { text: JSON.stringify({ ...candidate(), hiddenReasoning: 'RAW-CHAIN-OF-THOUGHT-SENTINEL' }) },
    });
    await lifecycle.tick();
    eq(requests.length, 2, 'the next seed is queued only after the first reaches a terminal state');

    jobs.set('job-2', { id: 'job-2', status: 'completed', result: { text: JSON.stringify(duplicate) } });
    await lifecycle.tick();
    eq(requests.length, 3, 'a near duplicate is regenerated within the same bounded slot');
    ok(/too similar/i.test(requests[2].prompt), 'duplicate retry explicitly requests differentiation');

    jobs.set('job-3', { id: 'job-3', status: 'completed', result: { text: JSON.stringify(different) } });
    await lifecycle.tick();
    const ready = lifecycle.getCohort(cohort.id);
    eq(ready.status, 'ready', 'a complete differentiated cohort becomes ready for inspection');
    eq(ready.candidates[1].duplicateRegenerations, 1, 'duplicate regeneration is visible in provenance');
    ok(!fs.readFileSync(path.join(dir, 'lifecycle.json'), 'utf8').includes('RAW-CHAIN-OF-THOUGHT-SENTINEL'),
      'raw model-only fields and hidden reasoning are not persisted');

    const restarted = createPopulationController({ ...options, file: path.join(dir, 'lifecycle.json') });
    eq(restarted.getCohort(cohort.id).status, 'ready', 'cohort state survives a controller restart');
    const staged = await restarted.stageCohort(cohort.id);
    eq(staged.status, 'staged', 'reviewed candidates stage as real registered profiles');
    eq(registered.length, 3, 'a known username conflict is retried without creating an extra profile');
    const systemProfiles = store.profiles.filter((profile) => profile.botOrigin === 'system');
    eq(systemProfiles.length, 2, 'staging creates one system-origin profile per accepted seed');
    ok(systemProfiles.every((profile) => profile.token), 'every staged profile has its one-time Feddit token stored');
    ok(systemProfiles.every((profile) => profile.enabled === false && profile.dryRun === true),
      'staged bots remain disabled and in rehearsal');
    ok(systemProfiles.every((profile) => profile.populationProvenance.lifecycle === 'staged'),
      'staged profiles retain inspectable AI-population provenance');
    ok(systemProfiles.some((profile) => profile.populationProvenance.registrationConflicts === 1),
      'known username collision handling is retained in profile provenance');
    eq(store.profiles.find((profile) => profile.id === 'user-private').botOrigin, 'user',
      'existing user-created profiles remain user-origin');

    const rehearsing = restarted.activateCohort(cohort.id, 'rehearsal');
    eq(rehearsing.status, 'rehearsal', 'explicit rehearsal activation starts ordinary scheduling without publishing');
    ok(systemProfiles.every((profile) => {
      const current = store.profiles.find((item) => item.id === profile.id);
      return current.enabled === true && current.dryRun === true;
    }),
      'rehearsal activation leaves publishing disabled for every staged bot');
    const live = restarted.activateCohort(cohort.id, 'live');
    eq(live.status, 'live', 'LIVE is a separate explicit activation');
    ok(systemProfiles.every((profile) => {
      const current = store.profiles.find((item) => item.id === profile.id);
      return current.enabled === true && current.dryRun === false;
    }),
      'live activation hands each bot to the ordinary publishing scheduler');
    eq(activations.length, 4, 'each explicit cohort mode applies through the ordinary profile activation path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const standalonePrompt = generationPrompt({ cohortId: 'public-only', slot: 0, attempt: 1 });
  ok(standalonePrompt.includes('Available public communities'), 'generation is grounded only in an explicit public community allowlist');
  console.log('background population: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
