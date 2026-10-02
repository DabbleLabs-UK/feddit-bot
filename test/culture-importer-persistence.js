'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCultureImporter } = require('../lib/culture-importer');
const { createFetchLayerSource } = require('../lib/culture-importer/fetchlayer-source');
const { createCultureImportUiSessions } = require('../lib/culture-importer/ui-sessions');
const { defaultWorkspaceFile } = require('../lib/culture-importer/workspace-store');

const fixtures = path.join(__dirname, 'fixtures', 'culture-importer');
const posts = JSON.parse(fs.readFileSync(path.join(fixtures, 'fetchlayer-community-posts.json'), 'utf8'));
const thread1 = JSON.parse(fs.readFileSync(path.join(fixtures, 'fetchlayer-thread-post1.json'), 'utf8'));
const thread2 = JSON.parse(fs.readFileSync(path.join(fixtures, 'fetchlayer-thread-post2.json'), 'utf8'));
const analysisFixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'provider-analysis.json'), 'utf8'));
const candidatesFixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'provider-candidates.json'), 'utf8'));

let checks = 0;

function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-culture-persistence-'));
  const cacheDirectory = path.join(root, 'cache');
  const workspaceFile = path.join(root, 'culture-import-workspaces.json');
  const previousDataDirectory = process.env.FEDDIT_BOT_DATA_DIR;
  process.env.FEDDIT_BOT_DATA_DIR = path.join(root, 'packaged-desktop-data');
  eq(defaultWorkspaceFile(), path.join(root, 'packaged-desktop-data', 'culture-import-workspaces.json'),
    'workspace persistence follows the packaged desktop private data root');
  if (previousDataDirectory === undefined) delete process.env.FEDDIT_BOT_DATA_DIR;
  else process.env.FEDDIT_BOT_DATA_DIR = previousDataDirectory;
  let now = Date.parse('2026-10-02T12:00:00.000Z');
  let upstreamCalls = 0;
  const source = createFetchLayerSource({
    cacheDirectory,
    cacheTtlMs: 60_000,
    apiKey: 'fixture-key-never-persisted',
    now: () => now,
    transport: {
      async postJson(url, body) {
        upstreamCalls++;
        if (url.includes('community-posts')) return structuredClone(posts);
        return structuredClone(body.url.includes('/post1/') ? thread1 : thread2);
      },
    },
  });

  const input = { subreddit: 'ExampleSub', maxPosts: 2, maxComments: 4 };
  await source.fetchCorpus(input, { refresh: true, onProgress() {} });
  eq(upstreamCalls, 3, 'fixture setup creates one private corpus through mocked external boundaries');
  upstreamCalls = 0;

  let providerCalls = 0;
  const importer = createCultureImporter({
    source,
    now: () => now,
    providerClient: {
      async generate(request) {
        providerCalls++;
        const structured = request.system.includes('Analyse') ? analysisFixture : candidatesFixture;
        return {
          provider: request.providerOverride,
          model: request.model,
          structured: structuredClone(structured),
          text: JSON.stringify(structured),
        };
      },
    },
  });

  const legacyBackend = createCultureImportUiSessions({
    importer,
    workspaceFile: path.join(root, 'legacy-workspaces.json'),
    now: () => now,
    makeId: () => 'legacy-recovered-session',
  });
  const legacyRecovered = legacyBackend.restore('desktop');
  eq(legacyRecovered.source.posts, 2, 'desktop migration recovers the existing private corpus without a saved workspace');
  eq(legacyRecovered.source.comments, 4, 'desktop migration preserves the existing cached comment sample');
  eq(legacyRecovered.source.cache.reused, 'recovered', 'desktop migration records that the orphaned cache entry was recovered');
  eq(upstreamCalls, 0, 'desktop migration makes zero upstream calls');
  const hostedWithoutWorkspace = legacyBackend.restore('hosted:different-operator');
  eq(hostedWithoutWorkspace.source, null, 'hosted operators do not inherit an unowned cache entry during restoration');

  let idSequence = 0;
  const options = {
    importer,
    workspaceFile,
    now: () => now,
    makeId: () => 'persisted-session-' + (++idSequence),
    existingSeeds: () => [],
  };
  const owner = 'fixture-owner';
  const firstBackend = createCultureImportUiSessions(options);
  let session = firstBackend.create(owner, { ...input, cacheOnly: true });
  session = await firstBackend.wait(owner, session.id);
  eq(session.source.posts, 2, 'saved sample is attached to the review workspace');
  eq(session.source.comments, 4, 'saved comments are attached to the review workspace');
  eq(upstreamCalls, 0, 'opening a matching saved sample makes zero upstream calls');

  firstBackend.analyse(owner, session.id, { provider: 'ollama', model: 'fixture-model' });
  session = await firstBackend.wait(owner, session.id);
  firstBackend.generate(owner, session.id, {
    provider: 'ollama',
    model: 'fixture-model',
    count: 2,
    targetCommunities: ['shittyaskfeddit'],
    contributorLabels: ['contributor-1'],
    archetypes: ['confident absurdist'],
  });
  session = await firstBackend.wait(owner, session.id);
  eq(providerCalls, 2, 'fixture analysis and character generation each run once before persistence');
  const analysisId = session.analysis.id;

  let stagingCalls = 0;
  await firstBackend.stage(owner, session.id, { selected: [0], edits: [] }, async () => {
    stagingCalls++;
    return {
      ok: true,
      cohort: { id: 'fixture-cohort', status: 'staged' },
      results: [{ index: 0, ok: true, code: 'STAGED', username: session.candidates[0].seed.username }],
    };
  });
  eq(stagingCalls, 1, 'fixture staging occurs only through the explicit action');

  const persisted = fs.readFileSync(workspaceFile, 'utf8');
  ok(!persisted.includes('fixture-key-never-persisted'), 'workspace persistence excludes the FetchLayer credential');
  ok(!persisted.includes(posts.items[0].title), 'workspace persistence keeps a cache reference instead of duplicating raw corpus text');

  const reopened = firstBackend.restore(owner);
  eq(reopened.id, session.id, 'refresh or reopen selects the existing saved workspace');
  eq(reopened.source.posts, 2, 'refresh or reopen restores the source summary');
  eq(upstreamCalls, 0, 'refresh or reopen restoration makes zero upstream calls');
  eq(providerCalls, 2, 'refresh or reopen restoration makes zero AI calls');
  eq(stagingCalls, 1, 'refresh or reopen restoration never repeats staging');

  const restartedBackend = createCultureImportUiSessions(options);
  const restarted = restartedBackend.get(owner, session.id);
  assert.throws(
    () => restartedBackend.get('different-owner', session.id),
    (error) => error && error.code === 'IMPORT_SESSION_NOT_FOUND',
    'persisted workspaces remain isolated by their opaque owner identity',
  );
  checks++;
  eq(restarted.source.available, true, 'backend restart rehydrates the corpus from its private cache reference');
  eq(restarted.analysis.id, analysisId, 'backend restart restores completed culture analysis');
  eq(restarted.candidates.length, 2, 'backend restart restores completed candidate generation');
  eq(restarted.staging.cohort.status, 'staged', 'backend restart preserves staging evidence without re-running it');
  eq(providerCalls, 2, 'backend restart performs no AI generation');
  eq(stagingCalls, 1, 'backend restart performs no staging');

  const compatible = await source.fetchCorpus({
    subreddit: 'ExampleSub',
    maxPosts: 1,
    maxComments: 2,
    since: '2023-11-14T21:00:00.000Z',
  }, { cacheOnly: true, onProgress() {} });
  eq(compatible.cache.reused, 'compatible', 'a compatible future request reuses the saved corpus');
  eq(compatible.corpus.posts.length, 1, 'compatible reuse applies the new post bound locally');
  eq(upstreamCalls, 0, 'compatible future reuse makes zero upstream calls');

  now += 2 * 60_000;
  const inProcessStale = firstBackend.get(owner, session.id);
  eq(inProcessStale.source.cache.state, 'stale', 'an open workspace reports expiry as soon as its freshness window passes');
  eq(inProcessStale.sourceStatus.state, 'stale', 'an open workspace exposes expiry without a backend restart');
  const staleBackend = createCultureImportUiSessions(options);
  const stale = staleBackend.get(owner, session.id);
  eq(stale.sourceStatus.state, 'stale', 'expired cache data restores with an explicit stale status');
  eq(stale.source.available, true, 'expired saved data remains reviewable without a forced refetch');
  eq(upstreamCalls, 0, 'expired restoration never fetches automatically');

  const cacheFile = path.join(cacheDirectory, stale.source.cache.key + '.json');
  fs.rmSync(cacheFile);
  const missingBackend = createCultureImportUiSessions(options);
  const missing = missingBackend.get(owner, session.id);
  eq(missing.source.available, false, 'a missing corpus reference remains visible but unavailable');
  eq(missing.sourceStatus.state, 'missing', 'missing cache data has an explicit status');
  eq(missing.analysis.id, restarted.analysis.id, 'missing corpus does not erase completed culture analysis');
  eq(missing.candidates.length, 2, 'missing corpus does not erase completed candidates');
  eq(providerCalls, 2, 'missing corpus restoration makes no AI call');
  eq(stagingCalls, 1, 'missing corpus restoration does not repeat staging');
  eq(upstreamCalls, 0, 'missing corpus restoration does not retrieve automatically');

  const emptySource = createFetchLayerSource({
    cacheDirectory: path.join(root, 'empty-cache'),
    apiKey: 'unused-fixture-key',
    transport: { async postJson() { throw new Error('restore must not use transport'); } },
  });
  const emptyImporter = createCultureImporter({ source: emptySource, providerClient: { generate() { throw new Error('restore must not generate'); } } });
  const emptyBackend = createCultureImportUiSessions({
    importer: emptyImporter,
    workspaceFile: path.join(root, 'empty-workspaces.json'),
    makeId: () => 'empty-restore-session',
  });
  const empty = emptyBackend.restore('empty-owner');
  eq(empty.source, null, 'restore with no workspace or corpus returns an empty review workspace');
  eq(empty.sourceStatus.state, 'missing', 'restore with no saved data reports a cache miss explicitly');

  console.log('culture importer persistence: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
