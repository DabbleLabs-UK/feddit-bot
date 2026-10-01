'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const population = require('../lib/population');
const { createRedditJsonSource } = require('../lib/culture-importer/reddit-json-source');
const {
  createCultureImporter,
  createCultureStagingBridge,
  CultureStagingError,
} = require('../lib/culture-importer');
const { parseArgs, stageImportResult } = require('../bin/import-subreddit-culture');

const fixtures = path.join(__dirname, 'fixtures', 'culture-importer');
const posts = JSON.parse(fs.readFileSync(path.join(fixtures, 'reddit-posts.json'), 'utf8'));
const comments = JSON.parse(fs.readFileSync(path.join(fixtures, 'reddit-comments.json'), 'utf8'));
const analysisFixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'provider-analysis.json'), 'utf8'));
const candidatesFixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'provider-candidates.json'), 'utf8'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-culture-staging-'));
let checks = 0;

function eq(actual, expected, message) {
  checks++;
  assert.deepEqual(actual, expected, message);
}

function ok(value, message) {
  checks++;
  assert.ok(value, message);
}

function fakeStore() {
  let sequence = 0;
  const profiles = [];
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

function populationHarness(name, register) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'population.json');
  const store = fakeStore();
  const registrations = [];
  const publications = [];
  const controller = population.createPopulationController({
    file,
    profileStore: store,
    feddit: {
      async register(input) {
        registrations.push(structuredClone(input));
        if (register) return register(input, registrations.length);
        return { ok: true, status: 201, data: { token: 'fixture-token-' + input.username } };
      },
      async post(input) { publications.push(structuredClone(input)); },
      async comment(input) { publications.push(structuredClone(input)); },
    },
    queue: { get() { return null; } },
    enqueueDell() { throw new Error('Culture staging must not enqueue population generation.'); },
    model: 'fixture-model',
    now: () => Date.parse('2026-10-02T12:00:00.000Z'),
    random: () => 0.5,
  });
  return { controller, file, store, registrations, publications };
}

function boundedCandidateFixture() {
  const fixture = structuredClone(candidatesFixture);
  const seed = fixture.candidates[0].seed;
  seed.username = 'ceremony_clerk_username_that_is_far_too_long';
  seed.biography = 'b'.repeat(520);
  seed.temperament = 't'.repeat(150);
  seed.interests = Array.from({ length: 10 }, (_, index) => 'interest-' + index + '-' + 'i'.repeat(80));
  seed.dislikes = Array.from({ length: 7 }, (_, index) => 'dislike-' + index + '-' + 'd'.repeat(80));
  seed.conversationalStyle = 'c'.repeat(190);
  seed.humourStyle = 'h'.repeat(150);
  seed.disagreementStyle = 'd'.repeat(170);
  seed.fictionalBackground = 'f'.repeat(260);
  seed.values = Array.from({ length: 8 }, (_, index) => 'value-' + index + '-' + 'v'.repeat(80));
  seed.toneNotes = 'n'.repeat(210);
  return fixture;
}

function checkSeedBounds(seed) {
  const scalarBounds = {
    username: 20,
    biography: 450,
    temperament: 120,
    conversationalStyle: 160,
    humourStyle: 120,
    disagreementStyle: 140,
    fictionalBackground: 220,
    toneNotes: 180,
  };
  for (const [field, maximum] of Object.entries(scalarBounds)) {
    ok(seed[field].length <= maximum, field + ' stays within the population seed bound');
  }
  const listBounds = {
    interests: [8, 70],
    dislikes: [5, 70],
    values: [6, 70],
    communities: [4, 30],
  };
  for (const [field, bounds] of Object.entries(listBounds)) {
    ok(seed[field].length <= bounds[0], field + ' stays within the population item-count bound');
    ok(seed[field].every((item) => item.length <= bounds[1]), field + ' entries stay within the population text bound');
  }
}

async function createFixtureImport() {
  let sourceRequests = 0;
  const source = createRedditJsonSource({
    cacheDirectory: path.join(root, 'source-cache'),
    requestDelayMs: 0,
    now: () => 1700001000000,
    transport: {
      async getJson(url) {
        sourceRequests++;
        return structuredClone(url.includes('/new.json') ? posts : comments);
      },
    },
  });
  const providerCalls = [];
  const providerClient = {
    async generate(request) {
      providerCalls.push(request);
      const structured = request.system.includes('Analyse')
        ? structuredClone(analysisFixture)
        : boundedCandidateFixture();
      return {
        provider: request.providerOverride,
        model: request.model,
        structured,
        text: JSON.stringify(structured),
      };
    },
  };
  const importer = createCultureImporter({ source, providerClient, now: () => 1700002000000 });
  const result = await importer.run({
    subreddit: 'ExampleSub',
    maxPosts: 2,
    maxComments: 4,
    count: 2,
    provider: 'ollama',
    model: 'fixture-model',
    targetCommunities: ['shittyaskfeddit'],
  });
  return { result, sourceRequests, providerCalls };
}

async function capture(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to fail.');
}

async function run() {
  const generated = await createFixtureImport();
  const importResult = generated.result;
  eq(generated.sourceRequests, 2, 'end-to-end import fetches the bounded post and comment fixtures');
  eq(generated.providerCalls.length, 2, 'end-to-end import uses one analysis and one character-generation call');
  eq(importResult.populationSeeds.length, 2, 'fixture generation produces two reviewable population seeds');
  for (const seed of importResult.populationSeeds) {
    eq(seed, population.normalizeSeed(seed, ['shittyaskfeddit']),
      'generated character is already normalized to the existing population contract');
    checkSeedBounds(seed);
  }
  importResult.candidates[1].seed.importerAnalysis = 'NESTED_IMPORTER_ANALYSIS_MUST_NOT_BE_SUBMITTED';
  importResult.candidates[1].seed.abilities.importerSuggestion = 'NESTED_ABILITY_METADATA_MUST_NOT_BE_SUBMITTED';

  const successful = populationHarness('successful');
  let successfulStageCalls = 0;
  let successfulRequest = null;
  const successfulBridge = createCultureStagingBridge({
    async stageExternalSeeds(input) {
      successfulStageCalls++;
      successfulRequest = structuredClone(input);
      return successful.controller.stageExternalSeeds(input);
    },
  });
  const review = successfulBridge.review(importResult);
  eq(successfulBridge.review(importResult).map((item) => item.id), review.map((item) => item.id),
    'review candidate identifiers are deterministic');
  eq(new Set(review.map((item) => item.id)).size, 2, 'each review candidate has a distinct stable identifier');
  eq(successful.registrations.length, 0, 'corpus fetch, analysis and character generation never register bots');
  eq(successful.controller.listCohorts().length, 0, 'generation alone never creates population cohort state');

  const staged = await successfulBridge.stage(importResult, [review[1].id]);
  eq(successfulStageCalls, 1, 'explicit staging makes exactly one staging-boundary call');
  eq(successfulRequest.populationSeeds.length, 1, 'only the selected candidate is submitted');
  eq(successfulRequest.populationSeeds[0].username, 'diagram_oracle', 'the selected candidate identity is preserved');
  eq(Object.keys(successfulRequest).sort(), ['configuration', 'populationSeeds', 'provenance'],
    'the staging request contains only compact seeds, bounded provenance and cohort configuration');
  ok(!JSON.stringify(successfulRequest).includes('RICH_SOURCE_ANALYSIS_MUST_NOT_ENTER_RUNTIME') &&
    !JSON.stringify(successfulRequest).includes('RICH_CANDIDATE_ANALYSIS_MUST_NOT_ENTER_RUNTIME') &&
    !JSON.stringify(successfulRequest).includes('NESTED_IMPORTER_ANALYSIS_MUST_NOT_BE_SUBMITTED') &&
    !JSON.stringify(successfulRequest).includes('NESTED_ABILITY_METADATA_MUST_NOT_BE_SUBMITTED'),
  'rich source and candidate analysis never enters the staging request');
  eq(successful.registrations.length, 1, 'registration starts only after the explicit staging action');
  eq(staged.results[0].importerCandidateId, review[1].id,
    'the staging result keeps the stable importer candidate identifier');
  eq(staged.results[0].importerCandidateIndex, 1,
    'the staging result keeps the original review index');
  eq(staged.results[0].code, 'STAGED', 'the real staging logic returns the normal successful result code');
  eq(staged.cohort.status, 'staged', 'explicit staging stops at the staged lifecycle');
  eq(successful.publications.length, 0, 'explicit staging never publishes a post or comment');
  ok(successful.store.profiles.every((profile) => profile.enabled === false && profile.dryRun === true),
    'staged bots remain disabled in rehearsal');
  const successfulRuntime = JSON.stringify({
    population: JSON.parse(fs.readFileSync(successful.file, 'utf8')),
    profiles: successful.store.profiles,
  });
  ok(!successfulRuntime.includes('RICH_SOURCE_ANALYSIS_MUST_NOT_ENTER_RUNTIME') &&
    !successfulRuntime.includes('RICH_CANDIDATE_ANALYSIS_MUST_NOT_ENTER_RUNTIME'),
  'rich importer analysis cannot enter cohort, profile, seed or persona runtime fields');

  const duplicate = populationHarness('duplicate');
  const duplicateResult = structuredClone(importResult);
  duplicateResult.candidates[1].seed = {
    ...structuredClone(duplicateResult.candidates[0].seed),
    username: 'renamed_near_duplicate',
  };
  duplicateResult.populationSeeds[1] = structuredClone(duplicateResult.candidates[1].seed);
  const duplicateBridge = createCultureStagingBridge({ populationController: duplicate.controller });
  const duplicateReview = duplicateBridge.review(duplicateResult);
  const duplicateError = await capture(() => duplicateBridge.stage(duplicateResult, [0, 1]));
  eq(duplicateError.code, 'EXTERNAL_SEED_VALIDATION_FAILED',
    'explicit staging preserves the authoritative population validation error');
  eq(duplicateError.results.map((item) => item.code), ['VALID', 'DUPLICATE_SEED'],
    'authoritative duplicate checks remain visible per selected seed');
  eq(duplicateError.results.map((item) => item.importerCandidateId), duplicateReview.map((item) => item.id),
    'validation failures retain stable importer identifiers');
  eq(duplicate.registrations.length, 0, 'an atomically rejected selection performs no registration');

  const partial = populationHarness('partial', (input, attempt) => {
    if (attempt === 2) return { ok: false, status: 503, error: 'fixture unavailable' };
    return { ok: true, status: 201, data: { token: 'fixture-token-' + input.username } };
  });
  let partialStageCalls = 0;
  const partialBridge = createCultureStagingBridge({
    async stageExternalSeeds(input) {
      partialStageCalls++;
      return partial.controller.stageExternalSeeds(input);
    },
  });
  const partialReview = partialBridge.review(importResult);
  const partialResult = await partialBridge.stage(importResult, [0, 1]);
  eq(partialStageCalls, 1, 'a partial failure is not retried by the importer bridge');
  eq(partial.registrations.length, 2, 'a non-collision registration failure is not blindly retried');
  eq(partialResult.results.map((item) => item.code), ['STAGED', 'STAGE_FAILED'],
    'partial registration keeps one stable result for each selected seed');
  eq(partialResult.results.map((item) => item.importerCandidateId), partialReview.map((item) => item.id),
    'partial results retain their stable importer candidate identifiers');
  ok(partial.store.profiles.every((profile) => profile.enabled === false),
    'the successfully staged member of a partial cohort remains disabled');

  const oversized = structuredClone(importResult);
  oversized.candidates = Array.from({ length: population.MAX_COHORT_SIZE + 1 }, (_, index) => {
    const candidate = structuredClone(importResult.candidates[index % importResult.candidates.length]);
    candidate.seed.username = 'selection_bot_' + index;
    return candidate;
  });
  oversized.populationSeeds = oversized.candidates.map((candidate) => candidate.seed);
  let oversizedStageCalls = 0;
  const oversizedBridge = createCultureStagingBridge({
    async stageExternalSeeds() {
      oversizedStageCalls++;
      throw new Error('Oversized selections must not reach staging.');
    },
  });
  const oversizedError = await capture(() => oversizedBridge.stage(
    oversized,
    oversized.candidates.map((candidate, index) => index),
  ));
  ok(oversizedError instanceof CultureStagingError, 'oversized selection fails in the importer bridge');
  eq(oversizedError.code, 'EXTERNAL_COHORT_CAPACITY_EXCEEDED',
    'oversized selection uses the existing external cohort capacity classification');
  eq(oversizedStageCalls, 0, 'oversized selection is never split into staging calls');

  const importFile = path.join(root, 'reviewed-import.json');
  fs.writeFileSync(importFile, JSON.stringify(importResult), 'utf8');
  const parsed = parseArgs([
    'stage', '--input', importFile, '--select', '1', '--server-url', 'http://127.0.0.1:4567',
  ]);
  eq(parsed.action, 'stage', 'development harness exposes staging as a separate explicit action');
  let httpCalls = 0;
  let httpRequest = null;
  const harnessResult = await stageImportResult(parsed, {
    ownerToken: 'fixture-owner-capability',
    async fetch(url, options) {
      httpCalls++;
      httpRequest = { url, options };
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            association: body.provenance,
            cohort: { status: 'staged' },
            results: [{ index: 0, ok: true, code: 'STAGED', candidateId: 'candidate-fixture' }],
          });
        },
      };
    },
  });
  eq(httpCalls, 1, 'development harness calls the staging endpoint once without retries');
  eq(new URL(httpRequest.url).pathname, '/api/population/external-seeds/stage',
    'development harness uses the frozen external-seed endpoint');
  eq(httpRequest.options.headers['X-Feddit-Bot-Owner'], 'fixture-owner-capability',
    'development harness reuses the existing operator authorization header');
  eq(JSON.parse(httpRequest.options.body).populationSeeds.map((seed) => seed.username), ['diagram_oracle'],
    'development harness posts only the explicitly selected seed');
  eq(harnessResult.results[0].importerCandidateId, review[1].id,
    'HTTP harness result retains the stable importer candidate identifier');

  console.log('culture importer staging: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
