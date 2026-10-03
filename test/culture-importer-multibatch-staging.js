'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ui = require('../public/ui-culture-importer');
const { createCultureImportUiSessions } = require('../lib/culture-importer/ui-sessions');

let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

function seed(username) {
  return {
    username,
    biography: 'A bounded importer staging fixture.',
    temperament: 'curious',
    interests: ['fixtures'],
    dislikes: ['retries'],
    conversationalStyle: 'brief and specific',
    humourStyle: 'dry',
    curiosity: 'high',
    disagreementStyle: 'asks for evidence',
    sociability: 'balanced',
    initiative: 'balanced',
    breadth: 'mixed',
    fictionalBackground: 'Keeps a notebook of staging receipts.',
    values: ['safety'],
    persistence: 'steady',
    noveltySeeking: 'moderate',
    toneNotes: 'plain language',
    communities: ['botlife'],
    abilities: { reply: true, discuss: true, links: false },
  };
}

function candidates(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: 'culture_candidate_' + String(index).padStart(20, '0'),
    seed: seed('fixture_' + String(index).padStart(2, '0')),
    importerMetadata: {},
  }));
}

function draftsFor(items) {
  return ui.createCandidateDrafts(items);
}

function stagingApi(options = {}) {
  const calls = [];
  const session = {
    id: 'multi-session',
    candidates: candidates(24),
    staging: { results: [] },
  };
  let postCount = 0;
  return {
    calls,
    session,
    async api(route, request) {
      calls.push({ route, request: structuredClone(request) });
      if (!request) return { session: structuredClone(session) };
      postCount++;
      if (options.throwOnPost === postCount) throw new Error('fixture response was lost');
      const batch = request.body.selected;
      const results = batch.map((candidateId, index) => ({
        index,
        importerCandidateId: candidateId,
        importerCandidateIndex: Number(candidateId.slice(-2)),
        username: 'fixture_' + candidateId.slice(-2),
        ok: !(options.failOnPost === postCount && index === 1),
        code: options.failOnPost === postCount && index === 1 ? 'REGISTRATION_UNCERTAIN' : 'STAGED',
        message: options.failOnPost === postCount && index === 1 ? 'Check the saved result before another explicit attempt.' : 'Staged.',
      }));
      for (const result of results) {
        const existing = session.staging.results.findIndex((item) => item.importerCandidateId === result.importerCandidateId);
        if (existing >= 0) session.staging.results[existing] = result;
        else session.staging.results.push(result);
      }
      session.staging.ok = session.staging.results.every((result) => result.ok === true);
      session.staging.destination = request.body.destination;
      if (typeof options.afterPost === 'function') options.afterPost(postCount, session);
      return { result: structuredClone(session.staging), session: structuredClone(session) };
    },
  };
}

function mockImporter() {
  let sequence = 0;
  return {
    source: { id: 'fixture-source' },
    async fetchCorpus(input) {
      return {
        corpus: {
          subreddit: input.subreddit,
          fetchedAt: '2026-10-03T12:00:00.000Z',
          window: {},
          posts: [{ id: 'post' }],
          comments: [{ id: 'comment' }],
        },
        cache: { key: 'fixture-cache', hit: true },
      };
    },
    async analyseCulture(input) {
      return {
        analysis: { id: 'analysis-fixture', culture: { summary: 'Fixture culture.' }, contributors: [] },
        provider: { provider: input.provider, model: input.model },
      };
    },
    async generateCandidates(input) {
      const offset = sequence * 6;
      sequence++;
      return {
        candidates: Array.from({ length: input.count }, (_, index) => ({ seed: seed('persist_' + String(offset + index).padStart(2, '0')) })),
        rejected: [],
        requestedCount: input.count,
        complete: true,
        warnings: [],
        provider: { provider: input.provider, model: input.model },
        repairProvider: null,
      };
    },
  };
}

async function run() {
  const items = candidates(24);
  const plan = ui.stagingPlan(items, draftsFor(items), { destination: 'local' });
  eq(plan.candidateIds, items.map((candidate) => candidate.id),
    'the click snapshot uses all 24 stable candidate IDs in review order');
  eq(Object.keys(plan.editsById).length, 24, 'the click snapshot keeps one bounded edit per stable ID');

  const successful = stagingApi();
  const progress = [];
  const complete = await ui.runStagingBatches({
    api: successful.api,
    sessionPath: '/api/culture-imports/multi-session',
    plan,
    session: successful.session,
    onProgress(value) { progress.push(structuredClone(value)); },
  });
  const successfulPosts = successful.calls.filter((call) => call.request);
  eq(successfulPosts.length, 4, '24 selected candidates produce four sequential staging calls');
  ok(successfulPosts.every((call) => call.request.body.selected.length === 6),
    'every internal staging call remains bounded to six candidates');
  ok(successfulPosts.every((call) => call.request.body.destination === 'local' && !call.request.body.managementLink),
    'local batches retain local routing and never carry a hosted credential');
  eq(complete.state, 'completed', 'the four-call coordinator reaches a completed state');
  eq(complete.completed, 24, 'overall progress confirms all 24 candidates');
  eq(complete.outcomes.length, 24, 'overall progress exposes a per-candidate outcome');
  ok(progress.some((item) => item.batch === 3 && item.completed === 12),
    'overall progress advances between bounded calls');

  const partialHarness = stagingApi({ failOnPost: 2 });
  const partial = await ui.runStagingBatches({
    api: partialHarness.api,
    sessionPath: '/api/culture-imports/multi-session',
    plan,
    session: partialHarness.session,
  });
  eq(partialHarness.calls.filter((call) => call.request).length, 2,
    'a partial batch failure prevents later batches from starting');
  eq(partial.state, 'attention', 'partial failure is surfaced for explicit review');
  eq(partial.completed, 11, 'successful candidates in the partial batch remain confirmed');
  eq(partial.remaining.length, 13, 'the failed candidate and untouched later batches remain selected');
  ok(partial.outcomes.some((result) => result.code === 'REGISTRATION_UNCERTAIN'),
    'the per-candidate ambiguous registration result remains visible');

  let cancelRequested = false;
  const cancelledHarness = stagingApi({ afterPost() { cancelRequested = true; } });
  const cancelled = await ui.runStagingBatches({
    api: cancelledHarness.api,
    sessionPath: '/api/culture-imports/multi-session',
    plan,
    session: cancelledHarness.session,
    shouldCancel: () => cancelRequested,
  });
  eq(cancelledHarness.calls.filter((call) => call.request).length, 1,
    'cancellation stops safely between registration batches');
  eq(cancelled.state, 'cancelled', 'between-batch cancellation has a distinct state');
  eq(cancelled.remaining.length, 18, 'cancellation preserves all unstarted selections');

  const ambiguousHarness = stagingApi({ throwOnPost: 2 });
  const ambiguous = await ui.runStagingBatches({
    api: ambiguousHarness.api,
    sessionPath: '/api/culture-imports/multi-session',
    plan,
    session: ambiguousHarness.session,
  });
  eq(ambiguousHarness.calls.filter((call) => call.request).length, 2,
    'a lost response is never retried automatically');
  eq(ambiguousHarness.calls.filter((call) => !call.request).length, 1,
    'a lost response performs one read-only reconciliation');
  eq(ambiguous.ambiguousCandidateIds.length, 6,
    'the entire unanswered batch is identified as ambiguous');
  eq(ambiguous.remaining.length, 18,
    'confirmed earlier successes are excluded while ambiguous and untouched candidates remain');

  const hostedHarness = stagingApi();
  const hostedPlan = ui.stagingPlan(items.slice(0, 7), draftsFor(items.slice(0, 7)), { destination: 'hosted' });
  const hostedSecret = 'https://feddit-bots.dabblelabs.uk/#manage=fixture-secret';
  const hosted = await ui.runStagingBatches({
    api: hostedHarness.api,
    sessionPath: '/api/culture-imports/multi-session',
    plan: hostedPlan,
    managementLink: hostedSecret,
    session: { id: 'multi-session', staging: { results: [] } },
  });
  const hostedPosts = hostedHarness.calls.filter((call) => call.request);
  eq(hostedPosts.length, 2, 'hosted selection is also split into bounded calls');
  ok(hostedPosts.every((call) => call.request.body.managementLink === hostedSecret),
    'the transient hosted capability is used only at each explicit hosted boundary');
  ok(!JSON.stringify(hosted).includes('fixture-secret'),
    'the hosted capability is absent from returned progress and persisted outcomes');

  const lock = { busy: false };
  eq(ui.beginExclusiveStaging(lock), true, 'the first staging submission acquires the exclusive UI lock');
  eq(ui.beginExclusiveStaging(lock), false, 'a duplicate concurrent submission is rejected');
  ui.endExclusiveStaging(lock);
  eq(ui.beginExclusiveStaging(lock), true, 'the lock is available after the prior operation ends');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-importer-multibatch-'));
  try {
    const workspaceFile = path.join(root, 'workspaces.json');
    const importer = mockImporter();
    const sessions = createCultureImportUiSessions({
      importer,
      workspaceFile,
      makeId: () => 'persistent-session',
      now: () => Date.parse('2026-10-03T12:00:00.000Z'),
    });
    let session = sessions.create('desktop', { subreddit: 'ExampleSub', maxPosts: 1, maxComments: 1 });
    session = await sessions.wait('desktop', session.id);
    sessions.analyse('desktop', session.id, { provider: 'fixture', model: 'fixture' });
    await sessions.wait('desktop', session.id);
    sessions.generate('desktop', session.id, { provider: 'fixture', model: 'fixture', count: 24 });
    session = await sessions.wait('desktop', session.id);
    eq(session.candidates.length, 24, 'the persistent fixture contains the supported 24-candidate collection');
    let boundaryCalls = 0;
    for (let offset = 0; offset < 24; offset += 6) {
      const ids = session.candidates.slice(offset, offset + 6).map((candidate) => candidate.id);
      await sessions.stage('desktop', session.id, { selected: ids, edits: [] }, async (input) => {
        boundaryCalls++;
        return {
          ok: true,
          destination: 'local',
          cohort: { id: 'cohort-' + boundaryCalls, status: 'staged' },
          results: input.populationSeeds.map((item, index) => ({ index, ok: true, code: 'STAGED', username: item.username })),
        };
      });
    }
    eq(boundaryCalls, 4, 'the durable backend received exactly four bounded calls');
    const restarted = createCultureImportUiSessions({
      importer,
      workspaceFile,
      makeId: () => 'unused',
      now: () => Date.parse('2026-10-03T12:00:00.000Z'),
    });
    const restored = restarted.get('desktop', 'persistent-session');
    eq(restored.staging.confirmedCandidateIds.length, 24,
      'backend restart restores every confirmed per-candidate staging result');
    eq(restored.staging.batches.length, 4, 'backend restart restores four bounded batch receipts');
    await restarted.stage('desktop', restored.id, {
      selected: restored.candidates.slice(0, 6).map((candidate) => candidate.id), edits: [],
    }, async () => {
      boundaryCalls++;
      throw new Error('confirmed candidates must never be registered again');
    });
    eq(boundaryCalls, 4, 'a duplicate explicit submission cannot repeat confirmed registrations');
    const saved = fs.readFileSync(workspaceFile, 'utf8');
    ok(!saved.includes('fixture-secret') && !saved.includes('managementLink'),
      'durable workspace evidence contains no hosted management credential');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('culture importer multi-batch staging: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
