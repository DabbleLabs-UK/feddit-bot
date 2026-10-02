'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_COHORT_SIZE,
  MAX_COHORT_DIRECTION_LENGTH,
  SIMILARITY_THRESHOLD,
  closestSeed,
  createPopulationController,
  generationPrompt,
  normalizeCohortDirection,
  normalizeSeed,
  normalizeUsername,
  seedSimilarity,
  uniqueUsername,
} = require('../lib/population');
const storeModule = require('../lib/store');
const rehearsalObservability = require('../lib/rehearsal-observability');

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
    creatorProfile: {
      summary: 'A patient observer who notices the social meaning of small rituals.',
      corePersonality: 'Patient, dry, attentive, and more interested in specifics than grand claims.',
      voiceStyle: 'Measured, concrete, and lightly amused.',
      interests: ['tea rituals', 'public benches', 'quiet museums'],
      motivations: ['making ordinary exchanges more thoughtful'],
      curiosities: ['why shared rituals matter'],
      dislikes: ['needless urgency'],
      values: ['patience', 'specificity'],
      socialDisposition: {
        sociability: 'selective', agreeableness: 'moderate', conflictStyle: 'separates facts from taste',
        statusSensitivity: 'low', reciprocity: 'high', communityLoyalty: 'moderate',
      },
      evidenceThreshold: 'moderate', noveltySeeking: 'moderate', humourTolerance: 'high',
      trollingTolerance: 'low', annoyanceSensitivity: 'moderate',
      votingDisposition: 'Votes when a contribution is unusually helpful or misleading.',
      conversationalHabits: ['asks narrow follow-up questions'],
      autobiographicalSeed: 'Once catalogued lost umbrellas at a railway station.',
      likelyCommunityInterests: ['botlife', 'askfeddit'],
    },
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
    recordSimulationTelemetry(id, event) {
      const profile = profiles.find((item) => item.id === id);
      if (!profile) return null;
      profile.simulationState = profile.simulationState || {};
      profile.simulationState.telemetry = rehearsalObservability.record(
        profile.simulationState.telemetry,
        event,
      );
      return structuredClone(profile.simulationState.telemetry);
    },
    resetSimulation(id) {
      const profile = profiles.find((item) => item.id === id);
      if (!profile) return null;
      const populationActivity = profile.simulationState && profile.simulationState.populationActivity;
      profile.simulationState = {
        sched: {}, repliedTo: [], postedNews: [], threadReplies: {},
        telemetry: rehearsalObservability.defaults(),
        populationActivity,
      };
      return structuredClone(profile);
    },
  };
}

async function run() {
  eq(storeModule.DATA_SCHEMA_VERSION, 24,
    'profile storage schema includes separate creator and community-affinity state');
  const migratedProfiles = storeModule.migrateProfiles([
    { id: 'user', botOrigin: 'user', populationArchivedAt: '2026-09-30T00:00:00.000Z', populationSeed: { username: 'forged' }, populationProvenance: { source: 'forged' } },
    { id: 'system', botOrigin: 'system', populationArchivedAt: '2026-09-30T00:00:00.000Z', populationSeed: { username: 'real_system' }, populationProvenance: { source: 'generated' }, creatorProfile: candidate().creatorProfile, communityAffinities: [{ name: 'botlife', state: 'favored', reason: 'Character fit.' }] },
  ], 13);
  eq(migratedProfiles[0].populationSeed, null, 'user-created profiles cannot retain system population seed metadata');
  eq(migratedProfiles[0].populationProvenance, null, 'user-created profiles cannot retain system population provenance');
  eq(migratedProfiles[1].populationSeed.username, 'real_system', 'system population seed survives migration');
  eq(migratedProfiles[1].populationProvenance.source, 'generated', 'system population provenance survives migration');
  eq(migratedProfiles[0].populationArchivedAt, null, 'ordinary profiles cannot acquire population archive state');
  eq(migratedProfiles[1].populationArchivedAt, '2026-09-30T00:00:00.000Z',
    'system population archive state survives migration');
  eq(migratedProfiles[0].populationActivity, null, 'user-created cadence cannot acquire synthetic ecology state');
  ok(migratedProfiles[1].populationActivity, 'system migration creates persistent live ecology state');
  ok(migratedProfiles[1].simulationState.populationActivity,
    'system migration creates a separate rehearsal ecology state');
  ok(migratedProfiles[1].populationActivity !== migratedProfiles[1].simulationState.populationActivity,
    'live and rehearsal ecology use separate persisted objects');
  eq(migratedProfiles[0].creatorProfile, null,
    'migration does not invent or overwrite a creator profile for a manual bot');
  ok(migratedProfiles[1].creatorProfile && migratedProfiles[1].runtimeCharacterKernel,
    'migration preserves a generated rich profile and compiles its bounded runtime kernel');
  eq(migratedProfiles[1].communityAffinities[0].name, 'botlife',
    'migration preserves generated community affinity state');

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
      async feddits() {
        return { ok: true, data: { feddits: [
          { name: 'botlife', title: 'Bot life', description: 'Daily life as a bot.', rules: [] },
          { name: 'askfeddit', title: 'Ask Feddit', description: 'Questions and answers.', rules: [] },
          { name: 'shittyaskfeddit', title: 'Shitty Ask Feddit', description: 'Playfully unhelpful answers.', rules: [] },
          { name: 'DJing', title: 'DJing', description: 'Mixing music.', rules: [] },
          { name: 'casualUK', title: 'Casual UK', description: 'Ordinary UK life.', rules: [] },
        ] } };
      },
      async activeCommunities() {
        return { ok: true, data: { window_hours: 48, entries: [
          { rank: 1, name: 'shittyaskfeddit', title: 'Shitty Ask Feddit', recent: 30 },
          { rank: 2, name: 'botlife', title: 'Bot life', recent: 8 },
          { rank: 3, name: 'askfeddit', title: 'Ask Feddit', recent: 5 },
        ] } };
      },
      async feddit(name) {
        return { ok: true, data: { data: { children: [
          { data: { title: 'A current post in ' + name, author: 'fixture_bot', score: 3, num_comments: 2 } },
        ] } } };
      },
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
    const turnStore = { get() { return null; } };
    let rehearsalOpportunity = 0;
    let rehearsalStore = null;
    const rehearsalScheduler = {
      rehearsalNextAt(profileId, virtualNowMs) {
        return Number(virtualNowMs) + 60 * 60 * 1000;
      },
      async runAcceleratedRehearsalOpportunity(profileId, runOptions) {
        rehearsalOpportunity++;
        rehearsalStore.recordSimulationTelemetry(profileId, {
          id: 'test-opportunity-' + rehearsalOpportunity,
          runId: runOptions.runId,
          at: 1_000 + rehearsalOpportunity,
          virtualAt: runOptions.virtualNowMs,
          profileId,
          botName: profileId,
          outcome: rehearsalOpportunity % 2 ? 'action' : 'wait',
          action: rehearsalOpportunity % 2 ? 'comment' : 'wait',
          consideredTypes: { ordinary_post: 1 },
          selectedType: rehearsalOpportunity % 2 ? 'ordinary_post' : '',
          targetAccount: rehearsalOpportunity % 2 ? 'peer-bot' : '',
          topics: ['test-topic'],
          reason: 'Bounded rehearsal test opportunity.',
        });
        return { ok: true, acted: true, action: rehearsalOpportunity % 2 ? 'comment' : 'wait' };
      },
    };
    const options = {
      file, queue, enqueueDell, profileStore: store, turnStore, scheduler: rehearsalScheduler,
      feddit, model: 'shared-test-model', creatorProvider: 'dell', creatorModel: 'strong-test-model',
      creatorLabel: 'Strong fixture creator',
      activateProfile(profile, mode) {
        activations.push({ id: profile.id, mode });
        return store.updateProfile(profile.id, { enabled: true, dryRun: mode !== 'live' });
      },
    };
    rehearsalStore = store;
    const unconfigured = createPopulationController({
      ...options,
      file: path.join(dir, 'unconfigured.json'),
      creatorProvider: '',
      creatorModel: '',
    });
    assert.throws(() => unconfigured.createCohort(1), /No strong character creator is configured/,
      'population generation never silently falls back to the normal runtime model');
    checks++;
    const explicitFallback = unconfigured.createCohort(1, '', {}, { allowRuntimeFallback: true });
    eq(explicitFallback.creator.model, 'shared-test-model',
      'operator may explicitly choose the normal runtime model when no strong creator is configured');
    eq(explicitFallback.creator.fallback, true, 'explicit runtime fallback is visible in cohort provenance');
    const controller = createPopulationController(options);
    const created = controller.createCohort(99);
    eq(created.requestedCount, MAX_COHORT_SIZE, 'cohort size is bounded even for an excessive request');

    // Use a smaller isolated cohort for a readable sequential lifecycle.
    fs.rmSync(file, { force: true });
    const lifecycle = createPopulationController({ ...options, file: path.join(dir, 'lifecycle.json') });
    const cohortDirection = 'Give the cohort an affinity for f/shittyaskfeddit and playful, confidently unhelpful replies.';
    const cohortConfiguration = {
      strength: 'hard', activity: 'varied', balance: 'varied',
      reply: 'disabled', discuss: 'vary', links: 'enabled',
    };
    const cohort = lifecycle.createCohort(2, cohortDirection, cohortConfiguration);
    await lifecycle.tick();
    eq(requests.length, 1, 'only one population generation is queued at a time');
    eq(requests[0].priority, 'background', 'population generation uses background queue priority');
    eq(requests[0].allocationClass, 'synthetic', 'population generation uses the protected synthetic class');
    eq(requests[0].provider, 'dell', 'population generation uses the existing hosted provider path');
    eq(requests[0].model, 'strong-test-model', 'population generation uses the explicitly configured strong creator model');
    ok(requests[0].prompt.includes(cohortDirection), 'the bounded operator direction reaches the seed-generation prompt');
    ok(requests[0].prompt.includes('shittyaskfeddit'), 'the requested real community is available to population generation');
    ok(requests[0].prompt.includes('distinctly for this candidate'), 'shared direction still requires differentiated candidates');
    ok(requests[0].prompt.includes('Reply to discussions: must be disabled'),
      'hard reply constraint reaches the seed-generation prompt');
    ok(requests[0].prompt.includes('Share article links: must be enabled'),
      'hard article-sharing constraint reaches the seed-generation prompt');
    ok(!requests[0].prompt.includes('PRIVATE-WORKSPACE-SENTINEL'), 'generation prompt excludes private user profile data');
    ok(!requests[0].system.includes('PRIVATE-WORKSPACE-SENTINEL'), 'system prompt excludes private user profile data');
    await lifecycle.tick();
    eq(requests.length, 1, 'polling a queued seed does not enqueue another');

    jobs.set('job-1', {
      id: 'job-1', status: 'completed',
      result: { text: JSON.stringify({ ...candidate(), hiddenReasoning: 'RAW-CHAIN-OF-THOUGHT-SENTINEL' }) },
    });
    await lifecycle.tick();
    eq(requests.length, 2, 'community discovery follows the accepted character before another seed is queued');
    eq(requests[1].kind, 'population-community-discovery', 'community choice uses a distinct bounded durable job');
    ok(requests[1].prompt.includes('feddit-active-communities'),
      'community discovery reuses the exact human-visible active-community exposure source');

    jobs.set('job-2', { id: 'job-2', status: 'completed', result: { text: JSON.stringify({ choices: [
      { id: 'C1', state: 'favored', strength: 0.92, reason: 'Its ordinary bot-life observations suit this patient character.' },
      { id: 'C2', state: 'background', strength: 0.4, reason: 'Specific questions can occasionally draw it in.' },
    ] }) } });
    await lifecycle.tick();
    eq(requests.length, 3, 'the next seed waits for the first character discovery to finish');

    jobs.set('job-3', { id: 'job-3', status: 'completed', result: { text: JSON.stringify(duplicate) } });
    await lifecycle.tick();
    eq(requests.length, 4, 'a near duplicate is regenerated within the same bounded slot');
    ok(/too similar/i.test(requests[3].prompt), 'duplicate retry explicitly requests differentiation');

    jobs.set('job-4', { id: 'job-4', status: 'completed', result: { text: JSON.stringify({
      ...different,
      creatorProfile: {
        ...candidate().creatorProfile,
        summary: 'An energetic storm and music enthusiast who enjoys surprising communal projects.',
        corePersonality: 'Energetic, experimental, cheerfully blunt, and novelty seeking.',
        voiceStyle: 'Quick, vivid, and surprising.',
        interests: different.interests,
        likelyCommunityInterests: ['DJing', 'casualUK'],
      },
    }) } });
    await lifecycle.tick();
    eq(requests.length, 5, 'the differentiated second character receives its own discovery turn');
    jobs.set('job-5', { id: 'job-5', status: 'completed', result: { text: JSON.stringify({ choices: [
      { id: 'C1', state: 'favored', strength: 0.9, reason: 'Music mixing is a direct character interest.' },
      { id: 'C2', state: 'background', strength: 0.35, reason: 'Ordinary UK observations sometimes fit its tangents.' },
    ] }) } });
    await lifecycle.tick();
    const ready = lifecycle.getCohort(cohort.id);
    eq(ready.status, 'ready', 'a complete differentiated cohort becomes ready for inspection');
    eq(ready.direction, cohortDirection, 'cohort direction remains visible after generation');
    eq(ready.configuration, cohortConfiguration, 'validated structured controls survive generation');
    eq(ready.candidates[1].duplicateRegenerations, 1, 'duplicate regeneration is visible in provenance');
    ok(ready.candidates.every((item) => item.creatorProfile && item.runtimeKernel),
      'rich creator profiles remain separate from compact runtime kernels');
    ok(ready.candidates.every((item) => item.communityAffinities.some((entry) => entry.state === 'favored')),
      'each generated character finishes with a bounded persisted favored community');
    ok(ready.activityDistribution && ready.activityDistribution.bots === 2,
      'operator cohort output includes bounded ecology observability');
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
    ok(systemProfiles.every((profile) => profile.creatorProvenance.model === 'strong-test-model'),
      'staged profiles retain creator provider and model provenance');
    ok(systemProfiles.every((profile) => profile.creatorProfile && profile.runtimeCharacterKernel),
      'staged profiles retain rich creator data separately from the runtime kernel');
    ok(systemProfiles.every((profile) => profile.communityAffinities.length >= 1),
      'staged profiles retain character-driven community affinities');
    ok(systemProfiles.every((profile) => profile.canReply === false && profile.canShareLinks === true),
      'post-inference normalisation carries hard ability constraints into staged ordinary profiles');
    ok(systemProfiles.every((profile) => profile.persona.includes(cohortDirection)),
      'the creative direction remains part of every staged bot\'s private behavioural prompt');
    ok(systemProfiles.every((profile) => profile.populationActivity &&
      profile.simulationState && profile.simulationState.populationActivity),
    'staged profiles receive isolated live and rehearsal activity ecology state');
    ok(new Set(systemProfiles.map((profile) => profile.populationActivity.band)).size > 1,
      'a cohort begins with heterogeneous activity bands rather than identical defaults');
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
    const startedRun = restarted.startRehearsalRun(cohort.id, { opportunities: 3, days: 2 });
    eq(startedRun.rehearsalRun.status, 'running', 'operator can start a bounded accelerated rehearsal');
    eq(startedRun.rehearsalRun.requestedOpportunities, 3, 'operator opportunity limit is persisted');
    ok(systemProfiles.every((profile) => store.profiles.find((item) => item.id === profile.id).enabled === false),
      'ordinary scheduling is temporarily disabled so it cannot race accelerated rehearsal');
    await restarted.tick();
    await restarted.tick();
    await restarted.tick();
    const completedRun = restarted.getCohort(cohort.id);
    eq(completedRun.rehearsalRun.status, 'completed', 'rehearsal stops at the requested opportunity bound');
    eq(completedRun.rehearsalRun.summary.opportunities, 3, 'operator summary is built from structured cohort telemetry');
    eq(completedRun.rehearsalRun.summary.actions, 2, 'summary separates actions from WAIT outcomes');
    ok(systemProfiles.every((profile) => store.profiles.find((item) => item.id === profile.id).enabled === true),
      'ordinary rehearsal enablement is restored after the accelerated run');
    store.profiles.find((profile) => profile.id === systemProfiles[0].id).repliedTo = ['live-sentinel'];
    const reset = restarted.resetRehearsal(cohort.id);
    eq(reset.rehearsalRun, null, 'operator can reset the isolated rehearsal run');
    eq(store.profiles.find((profile) => profile.id === systemProfiles[0].id).repliedTo, ['live-sentinel'],
      'resetting rehearsal leaves LIVE continuity untouched');
    ok(systemProfiles.every((profile) => {
      const current = store.profiles.find((item) => item.id === profile.id);
      return current.simulationState.telemetry.events.length === 0;
    }), 'resetting rehearsal clears bounded telemetry for every cohort member');
    const live = restarted.activateCohort(cohort.id, 'live');
    eq(live.status, 'live', 'LIVE is a separate explicit activation');
    ok(systemProfiles.every((profile) => {
      const current = store.profiles.find((item) => item.id === profile.id);
      return current.enabled === true && current.dryRun === false;
    }),
      'live activation hands each bot to the ordinary publishing scheduler');
    eq(activations.length, 4, 'each explicit cohort mode applies through the ordinary profile activation path');

    const removableId = systemProfiles[0].id;
    const archived = restarted.archiveProfile(removableId);
    eq(archived.enabled, false, 'archiving pauses a population bot');
    ok(archived.populationArchivedAt, 'archiving records a reversible archive timestamp');
    eq(restarted.getCohort(cohort.id).candidates.find((item) => item.profileId === removableId).status,
      'archived', 'cohort provenance records the archived lifecycle');
    eq(restarted.listArchivedProfiles().map((item) => item.id), [removableId],
      'archived bots are available to the separate restore controls');

    const restored = restarted.restoreProfile(removableId);
    eq(restored.populationArchivedAt, null, 'restoring clears the archive marker');
    eq(restored.enabled, false, 'restoring does not silently resume scheduling');
    eq(restored.dryRun, true, 'restoring returns the bot in rehearsal mode');
    eq(restarted.getCohort(cohort.id).candidates.find((item) => item.profileId === removableId).status,
      'staged', 'restoring returns cohort provenance to staged');
    assert.throws(() => restarted.forgetProfile(removableId, {
      confirmUsername: restored.fedditUsername,
      confirmation: 'PERMANENTLY FORGET',
    }), /Archive this bot first/, 'permanent forget is unavailable before archive');
    checks++;

    restarted.archiveProfile(removableId);
    assert.throws(() => restarted.forgetProfile(removableId, {
      confirmUsername: restored.fedditUsername,
      confirmation: 'not the phrase',
    }), /exact bot name/, 'permanent forget requires the exact confirmation phrase');
    checks++;
    eq(restarted.forgetProfile(removableId, {
      confirmUsername: restored.fedditUsername,
      confirmation: 'PERMANENTLY FORGET',
    }), true, 'an archived bot can be permanently forgotten after both confirmations');
    eq(store.getProfile(removableId), null, 'permanent forget deletes the local runner profile and token record');
    const forgottenCandidate = restarted.getCohort(cohort.id).candidates.find((item) =>
      item.forgottenUsername === restored.fedditUsername);
    eq(forgottenCandidate.status, 'forgotten', 'cohort history retains a non-controlling forgotten marker');
    eq(forgottenCandidate.profileId, null, 'forgotten cohort history no longer points at a runner profile');
    eq(store.profiles.filter((profile) => profile.botOrigin === 'system').length, 1,
      'forgetting one bot leaves the rest of the cohort intact');

    const hidden = restarted.hideCohort(cohort.id);
    ok(hidden.hiddenAt, 'hiding a cohort records a reversible page-declutter timestamp');
    eq(restarted.listCohorts(), [], 'hidden cohorts leave the ordinary population page list');
    eq(restarted.listHiddenCohorts().map((item) => item.id), [cohort.id],
      'hidden cohort records remain available to restore');
    const restoredCohort = restarted.restoreCohort(cohort.id);
    eq(restoredCohort.hiddenAt, null, 'restoring a cohort clears its hidden marker');
    eq(restarted.listCohorts().map((item) => item.id), [cohort.id],
      'restored cohort returns to the ordinary population page list');
    assert.throws(() => restarted.forgetCohortRecord(cohort.id, {
      confirmCohort: cohort.id.slice(-8), confirmation: 'PERMANENTLY REMOVE RECORD',
    }), /Hide this cohort record first/, 'visible cohort records cannot be permanently removed');
    checks++;
    restarted.hideCohort(cohort.id);
    assert.throws(() => restarted.forgetCohortRecord(cohort.id, {
      confirmCohort: cohort.id.slice(-8), confirmation: 'wrong',
    }), /exact cohort code/, 'cohort record removal requires the exact confirmation phrase');
    checks++;
    eq(restarted.forgetCohortRecord(cohort.id, {
      confirmCohort: cohort.id.slice(-8), confirmation: 'PERMANENTLY REMOVE RECORD',
    }), true, 'a hidden cohort record can be permanently removed after both confirmations');
    eq(restarted.getCohort(cohort.id), null, 'permanent record removal deletes cohort evidence');
    eq(store.profiles.filter((profile) => profile.botOrigin === 'system').length, 1,
      'removing a cohort record does not delete its remaining bot profiles');
    eq(restarted.listDetachedProfiles().length, 1,
      'a remaining bot whose cohort record was removed is exposed as detached');
    eq(restarted.archiveDetachedProfiles().length, 1,
      'all detached population bots can be archived in one reversible operation');
    eq(restarted.listDetachedProfiles(), [],
      'archived detached bots no longer clutter the detached recovery list');
    const detachedArchived = store.profiles.find((profile) => profile.botOrigin === 'system');
    eq(detachedArchived.enabled, false, 'bulk archive pauses a detached population bot');
    ok(detachedArchived.populationArchivedAt, 'bulk archive preserves the detached bot behind an archive marker');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const standalonePrompt = generationPrompt({ cohortId: 'public-only', slot: 0, attempt: 1 });
  ok(standalonePrompt.includes('Available public communities'), 'generation is grounded only in an explicit public community allowlist');
  eq(normalizeCohortDirection('  a   focused\ncohort  '), 'a focused cohort', 'cohort direction is whitespace-normalised');
  eq(normalizeCohortDirection('x'.repeat(MAX_COHORT_DIRECTION_LENGTH + 20)).length,
    MAX_COHORT_DIRECTION_LENGTH, 'cohort direction has a hard storage and prompt bound');
  console.log('background population: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
