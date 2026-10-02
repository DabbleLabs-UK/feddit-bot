'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const population = require('../lib/population');
const { createCultureImporter } = require('../lib/culture-importer');
const {
  CANDIDATE_GENERATION_BATCH_SIZE,
  MAX_CANDIDATE_COLLECTION,
  createCultureImportUiSessions,
} = require('../lib/culture-importer/ui-sessions');
const ui = require('../public/ui-culture-importer');

let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

async function capture(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to fail.');
}

function seed(username, variant = 0) {
  const descriptors = [
    ['dry', 'procedures', 'forms', 'precise', 'deadpan', 'selective', 'steady'],
    ['warm', 'gardens', 'noise', 'patient', 'wordplay', 'sociable', 'light'],
    ['restless', 'maps', 'queues', 'abrupt', 'surreal', 'reserved', 'persistent'],
    ['careful', 'weather', 'rumours', 'questioning', 'literal', 'selective', 'steady'],
  ];
  const words = descriptors[variant % descriptors.length];
  return {
    username,
    biography: 'A fictional candidate number ' + variant + ' with a deliberately distinct background.',
    temperament: words[0] + ' and curious',
    interests: [words[1], 'topic-' + variant],
    dislikes: [words[2]],
    conversationalStyle: words[3] + ' replies about detail ' + variant,
    humourStyle: words[4] + ' humour',
    curiosity: variant % 2 ? 'moderate' : 'high',
    disagreementStyle: 'asks about assumption ' + variant,
    sociability: words[5],
    initiative: variant % 2 ? 'mostly-responds' : 'balanced',
    breadth: variant % 3 ? 'mixed' : 'broad',
    fictionalBackground: 'Keeps a fictional archive numbered ' + variant + '.',
    values: ['value-' + variant, words[1]],
    persistence: words[6],
    noveltySeeking: variant % 2 ? 'moderate' : 'high',
    toneNotes: 'Distinct fixture voice ' + variant + '.',
    communities: ['shittyaskfeddit'],
    abilities: { reply: true, discuss: variant % 2 === 0, links: false },
  };
}

function createMockImporter(options = {}) {
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  const corpus = {
    source: 'fixture-source',
    subreddit: 'ExampleSub',
    fetchedAt: new Date(now).toISOString(),
    window: { since: '2026-09-01T00:00:00.000Z' },
    posts: [{ sourceId: 't3_fixture', author: 'source-user', title: 'Question' }],
    comments: [{ sourceId: 't1_fixture', threadSourceId: 't3_fixture', author: 'reply-user', body: 'Reply' }],
    provenance: { provider: 'fixture', complete: true },
    warnings: [],
  };
  const cacheEntry = {
    hit: true,
    state: 'fresh',
    key: 'fixture-cache',
    storedAt: new Date(now).toISOString(),
    expiresAt: now + 60 * 60 * 1000,
    value: corpus,
  };
  let sequence = 0;
  let blockedStartedResolve;
  const state = {
    fetchCalls: 0,
    analysisCalls: 0,
    generationCalls: [],
    blockedStarted: new Promise((resolve) => { blockedStartedResolve = resolve; }),
  };
  const importer = {
    state,
    source: {
      id: 'fixture-source',
      cache: {
        get(key) {
          return key === cacheEntry.key ? structuredClone(cacheEntry) : { hit: false, state: 'miss', key };
        },
      },
    },
    async fetchCorpus(input, runtime) {
      state.fetchCalls++;
      runtime.onProgress({ phase: 'fetch', state: 'completed', current: 1, total: 1, message: 'Fixture corpus ready.' });
      return { corpus: structuredClone(corpus), cache: structuredClone({ ...cacheEntry, value: undefined }) };
    },
    async analyseCulture(input, runtime) {
      state.analysisCalls++;
      runtime.onProgress({ phase: 'analyse', state: 'completed', current: 1, total: 1, message: 'Fixture analysis ready.' });
      return {
        analysis: {
          id: 'analysis-fixture',
          subreddit: corpus.subreddit,
          culture: { summary: 'Fixture culture.', archetypes: ['fixture archetype'] },
          contributors: [{ label: 'contributor-1', evidenceSourceIds: ['t1_fixture'] }],
        },
        provider: { provider: input.provider, model: input.model },
      };
    },
    async generateCandidates(input, runtime) {
      const call = state.generationCalls.length + 1;
      state.generationCalls.push({
        count: input.count,
        existingSeeds: structuredClone(input.existingSeeds || []),
      });
      runtime.onProgress({ phase: 'generate', state: 'provider-started', current: 0, total: 1, message: 'Fixture provider started.' });
      if (options.failOnCall === call) {
        throw Object.assign(new Error('fixture later batch failed'), { code: 'PROVIDER_FAILED', phase: 'generate' });
      }
      if (options.blockOnCall === call) {
        blockedStartedResolve();
        return new Promise((_resolve, reject) => {
          runtime.signal.addEventListener('abort', () => {
            const error = new Error('fixture generation cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      const candidates = Array.from({ length: input.count }, () => {
        const variant = sequence++;
        return {
          seed: seed('collection_candidate_' + variant, variant),
          importerMetadata: { inspirationLabels: ['contributor-1'], batchFixture: call },
        };
      });
      return {
        candidates,
        rejected: [],
        requestedCount: input.count,
        complete: true,
        warnings: [],
        provider: { provider: input.provider, model: input.model },
        repairProvider: null,
      };
    },
  };
  return importer;
}

async function prepareSession(importer, workspaceFile, id, owner) {
  const sessions = createCultureImportUiSessions({
    importer,
    workspaceFile,
    makeId: () => id,
    now: () => Date.parse('2026-10-02T12:00:00.000Z'),
    existingSeeds: () => [seed('registered_existing', 99)],
  });
  sessions.create(owner, { subreddit: 'ExampleSub', maxPosts: 1, maxComments: 1 });
  await sessions.wait(owner, id);
  sessions.analyse(owner, id, { provider: 'ollama', model: 'fixture-model' });
  await sessions.wait(owner, id);
  return sessions;
}

function generationRequest(count) {
  return {
    provider: 'ollama',
    model: 'fixture-model',
    count,
    targetCommunities: ['shittyaskfeddit'],
    contributorLabels: ['contributor-1'],
    archetypes: ['fixture archetype'],
  };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-culture-collection-'));
  try {
    eq(MAX_CANDIDATE_COLLECTION, 24, 'the documented importer collection bound is 24 candidates');
    eq(CANDIDATE_GENERATION_BATCH_SIZE, 6, 'provider work remains bounded to six candidates per request');
    ok(MAX_CANDIDATE_COLLECTION > population.MAX_COHORT_SIZE,
      'generation collection capacity is independent from the frozen population staging limit');

    const importer = createMockImporter();
    const workspaceFile = path.join(root, 'collection-workspaces.json');
    const owner = 'fixture-owner';
    const id = 'collection-session';
    const sessions = await prepareSession(importer, workspaceFile, id, owner);

    sessions.generate(owner, id, generationRequest(7));
    let session = await sessions.wait(owner, id);
    eq(importer.state.generationCalls.map((call) => call.count), [6, 1],
      'a request above six is split into bounded provider batches');
    eq(session.candidates.length, 7, 'all candidates from the first multi-batch action are retained');
    eq(session.generationCapacity, { limit: 24, batchSize: 6, used: 7, remaining: 17 },
      'the review session reports collection capacity independently from staging');
    eq(session.generationBatches.length, 2, 'completed provider batches remain reviewable');
    eq(session.task.progress, {
      phase: 'generate', state: 'completed', current: 7, total: 7,
      message: 'Generation completed with 7 candidate(s) appended.',
    }, 'completed generation retains collection-aware progress');
    const firstIds = session.candidates.map((candidate) => candidate.id);
    eq(new Set(firstIds).size, 7, 'generated candidates receive stable distinct IDs');

    let drafts = ui.createCandidateDrafts(session.candidates);
    ui.updateCandidateDraft(drafts, 0, 'biography', 'A preserved browser-side edit.');
    ui.updateCandidateDraft(drafts, 0, 'selected', false);

    sessions.generate(owner, id, generationRequest(5));
    session = await sessions.wait(owner, id);
    eq(session.candidates.length, 12, 'a successive generation appends instead of replacing candidates');
    eq(session.candidates.slice(0, 7).map((candidate) => candidate.id), firstIds,
      'successive generation preserves earlier candidate IDs and ordering');
    eq(importer.state.generationCalls[2].existingSeeds.length, 8,
      'a successive batch receives the registered seed plus all seven earlier candidates for duplicate detection');
    drafts = ui.createCandidateDrafts(session.candidates, drafts);
    eq(drafts[0].seed.biography, 'A preserved browser-side edit.',
      'appending candidates preserves an existing draft edit');
    eq(drafts[0].selected, false, 'appending candidates preserves an existing selection');
    ok(drafts[11] && drafts[11].selected, 'newly appended candidates receive review drafts');

    const storage = { value: '', getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
    ui.writeClientState(storage, { sessionId: id, form: {}, candidateDrafts: drafts });
    const restoredDrafts = ui.readClientState(storage).candidateDrafts;
    eq(restoredDrafts[0].seed.biography, 'A preserved browser-side edit.',
      'refresh persistence preserves edits in a collection larger than six');
    ok(restoredDrafts[11], 'refresh persistence retains candidate draft indexes above the old six-item limit');

    let stagingCalls = 0;
    await sessions.stage(owner, id, {
      selected: [0, 1, 2, 3, 4, 5],
      edits: [],
    }, async (input) => {
      stagingCalls++;
      eq(input.populationSeeds.length, 6, 'one explicit staging call still contains at most six seeds');
      return {
        ok: true,
        cohort: { id: 'fixture-cohort', status: 'staged' },
        results: input.populationSeeds.map((item, index) => ({ index, ok: true, code: 'STAGED', username: item.username })),
      };
    });
    const stagingEvidence = sessions.get(owner, id).staging;

    sessions.generate(owner, id, generationRequest(2));
    session = await sessions.wait(owner, id);
    eq(session.candidates.length, 14, 'generation can append again after an explicit staging action');
    eq(session.staging, stagingEvidence, 'appending candidates preserves existing staging evidence without repeating it');
    eq(stagingCalls, 1, 'generation never repeats staging');
    eq(importer.state.fetchCalls, 1, 'successive generation never refetches the corpus');
    eq(importer.state.analysisCalls, 1, 'successive generation never regenerates culture analysis');

    const restarted = createCultureImportUiSessions({
      importer,
      workspaceFile,
      makeId: () => 'unused-restart-id',
      now: () => Date.parse('2026-10-02T12:00:00.000Z'),
      existingSeeds: () => [seed('registered_existing', 99)],
    });
    const restored = restarted.get(owner, id);
    eq(restored.candidates.length, 14, 'backend restart restores the whole candidate collection');
    eq(restored.candidates.slice(0, 7).map((candidate) => candidate.id), firstIds,
      'backend restart preserves stable IDs from the first batch');
    eq(restored.staging, stagingEvidence, 'backend restart restores staging evidence without re-running staging');
    eq(importer.state.fetchCalls, 1, 'backend restart restoration makes zero additional source calls');
    eq(importer.state.analysisCalls, 1, 'backend restart restoration makes zero additional analysis calls');

    const overSelection = await capture(() => restarted.stage(owner, id, {
      selected: [0, 1, 2, 3, 4, 5, 6],
      edits: [],
    }, async () => {
      stagingCalls++;
      throw new Error('over-limit selection must not reach staging');
    }));
    eq(overSelection.code, 'EXTERNAL_COHORT_CAPACITY_EXCEEDED',
      'a seven-candidate staging selection remains explicitly rejected');
    eq(stagingCalls, 1, 'an over-limit selection is never silently split into registrations');

    const collectionLimit = await capture(async () => restarted.generate(owner, id, generationRequest(11)));
    eq(collectionLimit.code, 'CULTURE_COLLECTION_LIMIT_EXCEEDED',
      'the 24-candidate collection bound is reported before provider work');

    const failingImporter = createMockImporter({ failOnCall: 2 });
    const failingFile = path.join(root, 'failing-workspaces.json');
    const failing = await prepareSession(failingImporter, failingFile, 'failing-session', 'failing-owner');
    failing.generate('failing-owner', 'failing-session', generationRequest(12));
    const failed = await failing.wait('failing-owner', 'failing-session');
    eq(failed.task.state, 'failed', 'a later provider batch failure remains visible');
    eq(failed.candidates.length, 6, 'completed batches survive a later batch failure');
    eq(failed.generationBatches.length, 1, 'only the completed batch is recorded after a later failure');
    ok(failed.warnings.some((warning) => warning.includes('Completed batches remain available')),
      'partial failure explains that completed candidates were retained');
    const failingRestart = createCultureImportUiSessions({
      importer: failingImporter,
      workspaceFile: failingFile,
      makeId: () => 'unused-failing-id',
      now: () => Date.parse('2026-10-02T12:00:00.000Z'),
    });
    eq(failingRestart.get('failing-owner', 'failing-session').candidates.length, 6,
      'partial results survive backend restart');

    const cancellingImporter = createMockImporter({ blockOnCall: 2 });
    const cancellingFile = path.join(root, 'cancelling-workspaces.json');
    const cancelling = await prepareSession(cancellingImporter, cancellingFile, 'cancelling-session', 'cancelling-owner');
    cancelling.generate('cancelling-owner', 'cancelling-session', generationRequest(12));
    await cancellingImporter.state.blockedStarted;
    cancelling.cancel('cancelling-owner', 'cancelling-session');
    const cancelled = await cancelling.wait('cancelling-owner', 'cancelling-session');
    eq(cancelled.task.state, 'cancelled', 'cancelling a later batch reaches a stable cancelled state');
    eq(cancelled.candidates.length, 6, 'completed batches survive cancellation of a later batch');
    const cancellingRestart = createCultureImportUiSessions({
      importer: cancellingImporter,
      workspaceFile: cancellingFile,
      makeId: () => 'unused-cancelling-id',
      now: () => Date.parse('2026-10-02T12:00:00.000Z'),
    });
    eq(cancellingRestart.get('cancelling-owner', 'cancelling-session').candidates.length, 6,
      'cancelled partial results survive backend restart');

    const realProviderResponses = [];
    const a = { seed: seed('duplicate_alpha', 0) };
    const b = { seed: seed('distinct_beta', 1) };
    const c = { seed: seed('distinct_gamma', 2) };
    const d = { seed: seed('distinct_delta', 3) };
    const realImporter = createCultureImporter({
      source: { id: 'unused-source' },
      providerClient: {
        async generate() {
          const call = realProviderResponses.length;
          const structured = call === 0
            ? { candidates: [a, b] }
            : call === 1
              ? { candidates: [a, c] }
              : { candidates: [d] };
          realProviderResponses.push(structured);
          return { provider: 'fixture', model: 'fixture', structured, text: JSON.stringify(structured) };
        },
      },
    });
    const analysis = {
      id: 'analysis-duplicates', subreddit: 'ExampleSub',
      culture: { archetypes: [] }, contributors: [], deterministic: { interactions: {} },
    };
    const firstBatch = await realImporter.generateCandidates({
      analysis, corpus: { posts: [], comments: [] }, count: 2,
      provider: 'fixture', model: 'fixture', targetCommunities: ['shittyaskfeddit'], existingSeeds: [],
    });
    const secondBatch = await realImporter.generateCandidates({
      analysis, corpus: { posts: [], comments: [] }, count: 2,
      provider: 'fixture', model: 'fixture', targetCommunities: ['shittyaskfeddit'],
      existingSeeds: firstBatch.populationSeeds,
    });
    eq(secondBatch.populationSeeds.map((item) => item.username), ['distinct_gamma', 'distinct_delta'],
      'real importer duplicate detection excludes an earlier-batch seed and accepts distinct replacements');
    ok(secondBatch.rejected.some((item) => item.reason === 'near-duplicate'),
      'cross-batch duplicate rejection remains explicit');

    console.log('culture importer collection: ' + checks + ' checks passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
