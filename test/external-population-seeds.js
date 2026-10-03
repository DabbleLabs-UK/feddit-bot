'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_COHORT_SIZE,
  ExternalPopulationSeedError,
  createPopulationController,
  normalizeSeed,
} = require('../lib/population');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'external-population-seeds.json'),
  'utf8',
));

let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }

function fakeStore(initialProfiles = []) {
  let sequence = 0;
  const profiles = structuredClone(initialProfiles);
  return {
    profiles,
    listProfiles() { return structuredClone(profiles); },
    getProfile(id) {
      const profile = profiles.find((item) => item.id === id);
      return profile ? structuredClone(profile) : null;
    },
    createProfile(patch) {
      const profile = { id: 'profile-' + (++sequence), ...structuredClone(patch) };
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

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-external-seeds-'));
  const file = path.join(dir, 'population.json');
  const store = fakeStore(options.initialProfiles || []);
  const registrations = [];
  const publications = [];
  const feddit = {
    async register(input) {
      registrations.push(structuredClone(input));
      if (options.register) return options.register(input, registrations.length);
      return { ok: true, status: 201, data: { token: 'token-' + input.username } };
    },
    async post(input) { publications.push(structuredClone(input)); },
    async comment(input) { publications.push(structuredClone(input)); },
  };
  const controller = createPopulationController({
    file,
    profileStore: store,
    feddit,
    queue: { get() { return null; } },
    enqueueDell() { throw new Error('External staging must not enqueue seed generation.'); },
    model: 'fixture-model',
    creatorProvider: 'dell',
    creatorModel: 'strong-fixture-model',
    now: () => Date.parse('2026-10-02T12:00:00.000Z'),
    random: () => 0.5,
  });
  return {
    dir, file, store, registrations, publications, controller,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function requestFor(seeds = fixture.populationSeeds) {
  return {
    populationSeeds: structuredClone(seeds),
    provenance: structuredClone(fixture.provenance),
    configuration: { strength: 'soft', activity: 'varied' },
    direction: 'EXTERNAL_DIRECTION_MUST_NOT_ENTER_RUNTIME',
    analysis: structuredClone(fixture.analysis),
    candidates: structuredClone(fixture.candidates),
  };
}

async function expectExternalError(action, code, message) {
  let caught = null;
  try { await action(); } catch (error) { caught = error; }
  ok(caught instanceof ExternalPopulationSeedError, message + ' returns the stable external-seed error type');
  eq(caught && caught.code, code, message + ' returns a stable error code');
  return caught;
}

async function run() {
  const stagedHarness = harness();
  try {
    eq(stagedHarness.registrations.length, 0,
      'loading importer analysis output does not register an identity before explicit staging');
    const result = await stagedHarness.controller.stageExternalSeeds(requestFor());
    eq(result.ok, true, 'multiple valid importer seeds stage successfully');
    eq(result.results.map((item) => item.code), ['STAGED', 'STAGED'],
      'the hook returns a stable successful result for each seed');
    eq(result.association, {
      source: 'subreddit-culture-importer',
      reference: 'culture-analysis-fixture',
    }, 'only the bounded source association is returned');
    eq(stagedHarness.registrations.length, 2,
      'registration occurs once per seed only during the explicit staging call');
    eq(stagedHarness.publications.length, 0, 'staging makes no post or comment');

    const stagedProfiles = stagedHarness.store.profiles;
    eq(stagedProfiles.length, 2, 'one ordinary population profile is created for each staged seed');
    ok(stagedProfiles.every((profile) => profile.enabled === false && profile.dryRun === true),
      'staged external bots remain disabled in rehearsal');
    ok(stagedProfiles.every((profile) => profile.populationProvenance.lifecycle === 'staged'),
      'external profiles retain the ordinary staged lifecycle');
    ok(stagedProfiles.every((profile) =>
      profile.populationProvenance.source === 'subreddit-culture-importer' &&
      profile.populationProvenance.providerPath === 'external-seed'),
    'safe importer provenance is associated with each staged profile');
    eq(stagedProfiles[0].populationSeed, normalizeSeed(fixture.populationSeeds[0]),
      'the normal compact population seed is the runtime seed');

    const stored = fs.readFileSync(stagedHarness.file, 'utf8');
    const runtime = JSON.stringify(stagedProfiles);
    ok(!stored.includes('RICH_IMPORTER_METADATA_MUST_NOT_ENTER_RUNTIME') &&
      !runtime.includes('RICH_IMPORTER_METADATA_MUST_NOT_ENTER_RUNTIME') &&
      !runtime.includes('PRIVATE_IMPORTER_PSYCHOLOGY_SENTINEL') &&
      !stored.includes('EXTERNAL_DIRECTION_MUST_NOT_ENTER_RUNTIME') &&
      !runtime.includes('EXTERNAL_DIRECTION_MUST_NOT_ENTER_RUNTIME'),
    'rich importer analysis and psychology metadata are not retained or added to persona/runtime data');
    ok(!stagedProfiles.some((profile) => profile.persona.includes('RICH_IMPORTER_METADATA')),
      'rich importer metadata does not enter the generated persona');
    eq(result.cohort.status, 'staged', 'the cohort stops at staged rather than rehearsal or live activation');
  } finally {
    stagedHarness.cleanup();
  }

  const malformedHarness = harness();
  try {
    const malformed = { username: 'missing_contract_fields' };
    const error = await expectExternalError(
      () => malformedHarness.controller.stageExternalSeeds(requestFor([fixture.populationSeeds[0], malformed])),
      'EXTERNAL_SEED_VALIDATION_FAILED',
      'malformed selection',
    );
    eq(error.results[0].code, 'VALID', 'valid seeds remain identifiable in an atomically rejected selection');
    eq(error.results[1].code, 'MALFORMED_SEED', 'the malformed seed has a per-seed validation result');
    eq(malformedHarness.registrations.length, 0, 'atomic validation failure consumes no Feddit identities');
    eq(malformedHarness.store.profiles.length, 0, 'atomic validation failure creates no profile drafts');
    eq(malformedHarness.controller.listCohorts().length, 0, 'atomic validation failure creates no cohort state');
  } finally {
    malformedHarness.cleanup();
  }

  const duplicateHarness = harness();
  try {
    const duplicate = {
      ...structuredClone(fixture.populationSeeds[0]),
      username: 'renamed_near_duplicate',
    };
    const error = await expectExternalError(
      () => duplicateHarness.controller.stageExternalSeeds(requestFor([fixture.populationSeeds[0], duplicate])),
      'EXTERNAL_SEED_VALIDATION_FAILED',
      'near-duplicate selection',
    );
    eq(error.results[1].code, 'DUPLICATE_SEED', 'authoritative population similarity catches renamed copies');
    ok(error.results[1].similarity > 0.72, 'duplicate result reports bounded similarity evidence');
    eq(duplicateHarness.registrations.length, 0, 'duplicate rejection consumes no identities');
  } finally {
    duplicateHarness.cleanup();
  }

  const existingDuplicateHarness = harness({
    initialProfiles: [{
      id: 'existing-system-bot',
      fedditUsername: fixture.populationSeeds[0].username,
      botOrigin: 'system',
      populationSeed: fixture.populationSeeds[0],
    }],
  });
  try {
    const error = await expectExternalError(
      () => existingDuplicateHarness.controller.stageExternalSeeds(requestFor([fixture.populationSeeds[0]])),
      'EXTERNAL_SEED_VALIDATION_FAILED',
      'existing population duplicate',
    );
    eq(error.results[0].code, 'DUPLICATE_SEED', 'existing system profiles remain duplicate authorities');
    eq(existingDuplicateHarness.registrations.length, 0, 'existing duplicate consumes no new identity');
  } finally {
    existingDuplicateHarness.cleanup();
  }

  const collisionHarness = harness({
    register(input, attempt) {
      if (attempt === 1) return { ok: false, status: 409, error: 'taken' };
      return { ok: true, status: 201, data: { token: 'token-' + input.username } };
    },
  });
  try {
    const result = await collisionHarness.controller.stageExternalSeeds(requestFor([fixture.populationSeeds[1]]));
    eq(result.ok, true, 'known identity collisions use the existing bounded retry path');
    eq(collisionHarness.registrations.map((item) => item.username), ['night_bus_synth', 'night_bus_synth_1'],
      'identity collision preserves the existing deterministic username suffix');
    eq(result.cohort.candidates[0].registrationConflicts, 1,
      'collision count remains visible in cohort provenance');
    eq(collisionHarness.store.profiles.length, 1, 'rejected identity draft is removed before the successful retry');
  } finally {
    collisionHarness.cleanup();
  }

  const partialHarness = harness({
    register(input, attempt) {
      if (attempt === 2) {
        return {
          ok: false,
          status: 429,
          retryAfterSec: 4321,
          error: 'Rate limited by Feddit (429), retry in 4321s. Registration limit reached: 50 new bot registrations per day from your network.',
        };
      }
      return { ok: true, status: 201, data: { token: 'token-' + input.username } };
    },
  });
  try {
    const result = await partialHarness.controller.stageExternalSeeds(requestFor());
    eq(result.ok, false, 'ordinary staging partial-failure semantics are preserved');
    eq(result.results.map((item) => item.code), ['STAGED', 'STAGE_FAILED'],
      'partial staging reports a stable result for each seed');
    ok(result.results[1].message.includes('50 new bot registrations per day from your network'),
      'the importer receives the clear Feddit daily-limit response');
    eq(partialHarness.registrations.length, 2,
      'a rate-limited candidate is not retried or registered under another name');
    eq(partialHarness.store.profiles.length, 1, 'failed registration leaves no ordinary failed draft');
    ok(partialHarness.store.profiles[0].enabled === false,
      'a successful member of a partial cohort remains disabled');
  } finally {
    partialHarness.cleanup();
  }

  const capacityHarness = harness();
  try {
    const tooMany = Array.from({ length: MAX_COHORT_SIZE + 1 }, (_, index) => ({
      ...structuredClone(fixture.populationSeeds[index % 2]),
      username: 'capacity_bot_' + index,
    }));
    const error = await expectExternalError(
      () => capacityHarness.controller.stageExternalSeeds(requestFor(tooMany)),
      'EXTERNAL_COHORT_CAPACITY_EXCEEDED',
      'oversized external cohort',
    );
    eq(error.results.length, MAX_COHORT_SIZE + 1, 'capacity rejection accounts for every submitted seed');
    eq(capacityHarness.registrations.length, 0, 'capacity rejection consumes no identities');
    eq(capacityHarness.controller.listCohorts().length, 0, 'capacity rejection creates no cohort state');
  } finally {
    capacityHarness.cleanup();
  }

  const ordinaryHarness = harness();
  try {
    const ordinary = await ordinaryHarness.controller.createCohort(1, 'ordinary fixture');
    eq(ordinary.status, 'generating', 'ordinary generated cohorts still begin in the existing generation lifecycle');
    eq(ordinaryHarness.registrations.length, 0, 'ordinary generation still does not register before explicit staging');
  } finally {
    ordinaryHarness.cleanup();
  }

  console.log('external population seeds: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
