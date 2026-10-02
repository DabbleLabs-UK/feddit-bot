'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const population = require('../lib/population');
const { createCultureImporter } = require('../lib/culture-importer');
const { createFetchLayerSource } = require('../lib/culture-importer/fetchlayer-source');
const { createCultureImportUiSessions } = require('../lib/culture-importer/ui-sessions');

const fixtures = path.join(__dirname, 'fixtures', 'culture-importer');
const posts = JSON.parse(fs.readFileSync(path.join(fixtures, 'fetchlayer-community-posts.json'), 'utf8'));
const thread1 = JSON.parse(fs.readFileSync(path.join(fixtures, 'fetchlayer-thread-post1.json'), 'utf8'));
const thread2 = JSON.parse(fs.readFileSync(path.join(fixtures, 'fetchlayer-thread-post2.json'), 'utf8'));
const analysisFixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'provider-analysis.json'), 'utf8'));
const candidatesFixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'provider-candidates.json'), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-culture-integration-'));

let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function ok(value, message) {
  assert.ok(value, message);
  checks++;
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

async function run() {
  let sourceRequests = 0;
  const source = createFetchLayerSource({
    cacheDirectory: path.join(root, 'source-cache'),
    apiKey: 'fixture-key',
    now: () => Date.parse('2026-10-02T10:00:00.000Z'),
    transport: {
      async postJson(url, body) {
        sourceRequests++;
        if (url.includes('community-posts')) return structuredClone(posts);
        return structuredClone(body.url.includes('/post1/') ? thread1 : thread2);
      },
    },
  });
  const providerCalls = [];
  const providerClient = {
    async generate(request) {
      providerCalls.push(structuredClone({
        provider: request.providerOverride,
        model: request.model,
        structuredOutput: request.structuredOutput,
      }));
      const structured = request.system.includes('Analyse')
        ? structuredClone(analysisFixture)
        : structuredClone(candidatesFixture);
      return {
        provider: request.providerOverride,
        model: request.model,
        structured,
        text: JSON.stringify(structured),
      };
    },
  };
  const importer = createCultureImporter({
    source,
    providerClient,
    now: () => Date.parse('2026-10-02T11:00:00.000Z'),
  });
  const sessions = createCultureImportUiSessions({
    importer,
    persistence: false,
    makeId: () => 'fixture-session',
    now: () => Date.parse('2026-10-02T12:00:00.000Z'),
    existingSeeds: () => [],
  });

  const owner = 'fixture-operator';
  sessions.create(owner, {
    subreddit: 'ExampleSub',
    maxPosts: 2,
    maxComments: 4,
    targetCommunities: ['shittyaskfeddit'],
  });
  let session = await sessions.wait(owner, 'fixture-session');
  eq(session.task.state, 'completed', 'fixture subreddit import completes');
  eq(session.source.posts, 2, 'fixture import exposes the bounded post count');
  eq(session.source.comments, 4, 'fixture import exposes the bounded comment count');
  eq(sourceRequests, 3, 'fixture import performs only mocked source requests');

  sessions.analyse(owner, session.id, { provider: 'ollama', model: 'fixture-model' });
  session = await sessions.wait(owner, session.id);
  eq(session.task.state, 'completed', 'fixture culture analysis completes');
  ok(session.analysis.culture.summary, 'fixture culture analysis is reviewable');

  sessions.generate(owner, session.id, {
    provider: 'ollama',
    model: 'fixture-model',
    count: 2,
    targetCommunities: ['shittyaskfeddit'],
    contributorLabels: ['contributor-1'],
    archetypes: ['confident absurdist'],
  });
  session = await sessions.wait(owner, session.id);
  eq(session.task.state, 'completed', 'fixture candidate generation completes');
  eq(session.candidates.length, 2, 'generated candidates are available for review and selection');
  eq(providerCalls, [
    { provider: 'ollama', model: 'fixture-model', structuredOutput: true },
    { provider: 'ollama', model: 'fixture-model', structuredOutput: true },
  ], 'analysis and generation use only the mocked selected provider and model');

  const store = fakeStore();
  const registrations = [];
  const publications = [];
  const controller = population.createPopulationController({
    file: path.join(root, 'population.json'),
    profileStore: store,
    feddit: {
      async register(input) {
        registrations.push(structuredClone(input));
        return { ok: true, status: 201, data: { token: 'fixture-token-' + input.username } };
      },
      async post(input) { publications.push({ type: 'post', input: structuredClone(input) }); },
      async comment(input) { publications.push({ type: 'comment', input: structuredClone(input) }); },
    },
    queue: { get() { return null; } },
    enqueueDell() { throw new Error('Explicit staging must not enqueue generation.'); },
    model: 'fixture-model',
    now: () => Date.parse('2026-10-02T12:00:00.000Z'),
    random: () => 0.5,
  });
  eq(registrations.length, 0, 'generation does not automatically stage candidates');
  eq(controller.listCohorts().length, 0, 'generation creates no cohort state');

  const editedSeed = {
    ...structuredClone(session.candidates[1].seed),
    username: 'edited_oracle',
    biography: 'An edited fixture candidate selected after review.',
  };
  editedSeed.importerEvidence = 'must-not-cross-the-staging-boundary';
  let stagingRequest = null;
  const outcome = await sessions.stage(owner, session.id, {
    selected: [1],
    edits: [{ index: 1, seed: editedSeed }],
  }, async (input) => {
    stagingRequest = structuredClone(input);
    return controller.stageExternalSeeds(input);
  });

  eq(stagingRequest.populationSeeds.map((seed) => seed.username), ['edited_oracle'],
    'explicit staging sends only the selected edited candidate');
  ok(!JSON.stringify(stagingRequest).includes('must-not-cross-the-staging-boundary'),
    'review-only importer evidence does not enter population seeds');
  eq(outcome.cohort.status, 'staged', 'explicit staging reports a staged cohort');
  eq(outcome.results[0].code, 'STAGED', 'explicit staging returns the per-seed success result');
  eq(registrations.length, 1, 'registration begins only after explicit staging');
  eq(publications.length, 0, 'staging publishes no posts or comments');
  eq(store.profiles.length, 1, 'staging creates exactly the selected profile');
  eq(store.profiles[0].enabled, false, 'staged profile remains disabled');
  eq(store.profiles[0].dryRun, true, 'staged profile remains in rehearsal');
  eq(store.profiles[0].populationProvenance.activatedAt, null,
    'staging does not activate the profile');

  console.log('culture importer integration: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
