'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPopulationController } = require('../lib/population');
const {
  desktopStagingDestination,
  createDesktopCultureStageRoute,
} = require('../lib/culture-importer/desktop-staging');

let checks = 0;

function eq(actual, expected, message) {
  checks++;
  assert.deepEqual(actual, expected, message);
}

function ok(value, message) {
  checks++;
  assert.ok(value, message);
}

async function capture(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to fail.');
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
    logActivity() {},
  };
}

function seed(username) {
  return {
    username,
    biography: 'A fictional desktop bot staged from a reviewed culture candidate.',
    temperament: 'curious and restrained',
    interests: ['community rituals', 'odd questions'],
    dislikes: ['repetition'],
    conversationalStyle: 'brief observations',
    humourStyle: 'dry',
    curiosity: 0.7,
    disagreementStyle: 'asks for specifics',
    sociability: 0.6,
    initiative: 0.5,
    breadth: 0.4,
    fictionalBackground: 'Keeps notes about imaginary village meetings.',
    values: ['curiosity', 'specificity'],
    persistence: 0.4,
    noveltySeeking: 0.6,
    toneNotes: 'plain language',
    communities: ['shittyaskfeddit'],
    abilities: { reply: true, discuss: true, links: false },
  };
}

async function run() {
  eq(desktopStagingDestination({}), 'local',
    'new desktop staging requests default to the local workspace');
  eq(desktopStagingDestination({ destination: 'local' }), 'local',
    'the desktop app can explicitly select local staging');
  eq(desktopStagingDestination({ destination: 'hosted' }), 'hosted',
    'the desktop app can explicitly select optional hosted staging');
  eq(desktopStagingDestination({ managementLink: 'https://feddit-bots.dabblelabs.uk/#manage=legacy' }), 'hosted',
    'legacy desktop requests containing only a management link retain hosted routing');
  const invalid = await capture(() => desktopStagingDestination({ destination: 'somewhere-else' }));
  eq(invalid.code, 'INVALID_STAGING_DESTINATION', 'unknown destinations are rejected before staging');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-culture-local-stage-'));
  const store = fakeStore();
  const registrations = [];
  const publications = [];
  const controller = createPopulationController({
    file: path.join(root, 'population.json'),
    profileStore: store,
    feddit: {
      async register(input) {
        registrations.push(structuredClone(input));
        return { ok: true, status: 201, data: { token: 'fixture-token' } };
      },
      async post(input) { publications.push(structuredClone(input)); },
      async comment(input) { publications.push(structuredClone(input)); },
    },
    queue: { get() { return null; } },
    enqueueDell() { throw new Error('Local staging must not enqueue creator work.'); },
    model: 'fixture-model',
    now: () => Date.parse('2026-10-02T12:00:00.000Z'),
    random: () => 0.5,
  });
  try {
    const localRoute = createDesktopCultureStageRoute({
      destination: 'local',
      managementLink: 'https://feddit-bots.dabblelabs.uk/#manage=must-not-be-used',
    }, {
      localStageExternalSeeds: controller.stageExternalSeeds.bind(controller),
      async fetch() { throw new Error('Local staging must not contact the hosted workspace.'); },
    });
    eq(localRoute.destination, 'local', 'local routing is reported explicitly');
    const localResult = await localRoute.stageExternalSeeds({
      populationSeeds: [seed('local_candidate')],
      provenance: { source: 'subreddit-culture-importer', reference: 'local-fixture' },
    });
    eq(localResult.results.map((item) => item.code), ['STAGED'],
      'local routing reuses the authoritative population staging result');
    eq(registrations.length, 1, 'local staging performs one bounded mocked registration');
    eq(publications.length, 0, 'local staging does not publish anything');
    eq(store.profiles.length, 1, 'local staging creates the bot profile in this desktop store');
    ok(store.profiles.every((profile) => profile.enabled === false && profile.dryRun === true),
      'locally staged profiles remain disabled in rehearsal');
    ok(!JSON.stringify(fs.readFileSync(path.join(root, 'population.json'), 'utf8'))
      .includes('must-not-be-used'), 'an irrelevant hosted management link is not persisted locally');

    const missingHostedCapability = await capture(() => createDesktopCultureStageRoute({
      destination: 'hosted',
    }, { localStageExternalSeeds: controller.stageExternalSeeds.bind(controller) }));
    eq(missingHostedCapability.code, 'INVALID_MANAGEMENT_LINK',
      'hosted routing still requires its private management link');

    let hostedRequest = null;
    const hostedRoute = createDesktopCultureStageRoute({
      destination: 'hosted',
      managementLink: 'https://feddit-bots.dabblelabs.uk/#manage=private-capability',
    }, {
      localStageExternalSeeds: controller.stageExternalSeeds.bind(controller),
      async fetch(url, options) {
        hostedRequest = { url, options };
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ ok: true, cohort: { status: 'staged' }, results: [] });
          },
        };
      },
    });
    await hostedRoute.stageExternalSeeds({
      populationSeeds: [seed('hosted_candidate')],
      provenance: { source: 'subreddit-culture-importer' },
    });
    eq(hostedRoute.destination, 'hosted', 'hosted routing is reported explicitly');
    eq(new URL(hostedRequest.url).origin, 'https://feddit-bots.dabblelabs.uk',
      'hosted routing targets only the approved hosted origin');
    eq(hostedRequest.options.headers['X-Feddit-Bot-Owner'], 'private-capability',
      'hosted routing authorizes through the existing owner capability');
    ok(!hostedRequest.options.body.includes('private-capability') &&
      !hostedRequest.options.body.includes('managementLink'),
    'the hosted capability is absent from the compact seed payload');
    eq(registrations.length, 1,
      'hosted routing does not accidentally invoke the local registration boundary');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('culture importer staging destinations: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
