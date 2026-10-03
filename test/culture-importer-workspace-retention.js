'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function seed(index, edited = false) {
  return {
    username: 'retained_candidate_' + String(index + 1).padStart(2, '0'),
    biography: edited ? 'Retained operator edit ' + index : 'Generated biography ' + index,
    temperament: 'fixture temperament',
    interests: ['persistence'],
    dislikes: ['silent deletion'],
    conversationalStyle: 'specific',
    humourStyle: 'dry',
    curiosity: 'high',
    disagreementStyle: 'constructive',
    sociability: 'balanced',
    initiative: 'balanced',
    breadth: 'mixed',
    fictionalBackground: 'A bounded recovery fixture.',
    values: ['durability'],
    persistence: 'steady',
    noveltySeeking: 'moderate',
    toneNotes: 'concise',
    communities: ['shittyaskfeddit'],
    abilities: { reply: true, discuss: true, links: false },
  };
}

function candidateId(index) {
  return 'culture_candidate_' + index.toString(16).padStart(20, '0');
}

function snapshot(owner, id, timestamp) {
  const candidates = Array.from({ length: 24 }, (_, index) => ({
    id: candidateId(index + 1),
    seed: seed(index),
    importerMetadata: { reviewOnly: true },
  }));
  return {
    id,
    owner,
    createdAt: timestamp,
    updatedAt: timestamp,
    input: { subreddit: 'shittyaskreddit', maxPosts: 100, maxComments: 321, since: '', until: '', refresh: false, cacheOnly: true },
    sourceId: 'fixture-source',
    sourceRef: { key: 'retained-corpus' },
    sourceSnapshot: { available: true, subreddit: 'shittyaskreddit', posts: 100, comments: 321, cache: { key: 'retained-corpus' } },
    sourceStatus: { state: 'available', message: 'Saved fixture corpus.' },
    analysed: {
      analysis: { id: 'retained-analysis', culture: { summary: 'Retained culture analysis.' }, contributors: [] },
      provider: { provider: 'fixture', model: 'fixture-model' },
    },
    importResult: {
      schemaVersion: 1,
      provenance: { analysisId: 'retained-analysis' },
      candidates,
      populationSeeds: candidates.map((candidate) => candidate.seed),
      generationBatches: [{ index: 0, acceptedCount: 24, completedAt: timestamp }],
      complete: true,
      warnings: [],
      rejectedCandidates: [],
      stagingDefaults: { configuration: { strength: 'soft', activity: 'varied' } },
    },
    review: { provider: 'fixture', model: 'fixture-model', count: 24, targetCommunities: ['shittyaskfeddit'] },
    candidateReview: {
      updatedAt: timestamp,
      drafts: candidates.map((candidate, index) => ({
        id: candidate.id,
        index,
        selected: index % 3 !== 0,
        seed: seed(index, true),
      })),
    },
    staging: {
      ok: true,
      results: candidates.slice(0, 4).map((candidate, index) => ({
        importerCandidateId: candidate.id,
        importerCandidateIndex: index,
        ok: true,
        code: 'STAGED',
        username: candidate.seed.username,
      })),
    },
    task: { phase: 'generate', state: 'completed', progress: { phase: 'generate', state: 'completed', current: 24, total: 24 } },
  };
}

function backend(workspaceFile, now, counters) {
  const corpus = {
    subreddit: 'shittyaskreddit', fetchedAt: '2026-10-02T12:00:00.000Z', window: {},
    posts: Array.from({ length: 100 }, (_, index) => ({ id: 'post-' + index })),
    comments: Array.from({ length: 321 }, (_, index) => ({ id: 'comment-' + index })),
    provenance: { provider: 'fixture', complete: true }, warnings: [],
  };
  const importer = {
    source: {
      id: 'fixture-source',
      cache: {
        get(key) {
          eq(key, 'retained-corpus', 'restoration reads only the saved corpus reference');
          return { hit: true, state: 'stale', key, storedAt: '2026-10-02T12:00:00.000Z', expiresAt: Date.parse('2026-10-02T18:00:00.000Z'), value: corpus };
        },
      },
    },
    fetchCorpus() { counters.retrieval++; throw new Error('restoration must not retrieve'); },
    analyseCulture() { counters.ai++; throw new Error('restoration must not analyse'); },
    generateCandidates() { counters.ai++; throw new Error('restoration must not generate'); },
  };
  return createCultureImportUiSessions({ importer, workspaceFile, now: () => now.value });
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-culture-retention-'));
  const workspaceFile = path.join(root, 'culture-import-workspaces.json');
  const owner = 'retained-owner';
  const id = 'retained-workspace';
  const completedAt = '2026-10-02T12:00:00.000Z';
  fs.writeFileSync(workspaceFile, JSON.stringify({ version: 1, sessions: [snapshot(owner, id, completedAt)] }, null, 2));
  const now = { value: Date.parse('2027-04-02T12:00:00.000Z') };
  const counters = { retrieval: 0, ai: 0, staging: 0 };

  const first = backend(workspaceFile, now, counters);
  let restored = first.get(owner, id);
  eq(restored.id, id, 'elapsed time does not delete a completed review workspace');
  eq(restored.analysis.id, 'retained-analysis', 'completed culture analysis remains available');
  eq(restored.candidates.length, 24, 'all 24 generated candidates remain available');
  eq(restored.candidateReview.drafts.length, 24, 'all durable candidate edits and selections remain available');
  eq(restored.candidateReview.drafts[7].seed.biography, 'Retained operator edit 7', 'an edited candidate seed survives restoration');
  eq(restored.candidateReview.drafts.filter((draft) => draft.selected).length, 16, 'candidate selections survive restoration');
  eq(restored.staging.results.length, 4, 'staging evidence survives restoration');
  eq(first.restore(owner).id, id, 'reopening selects the existing completed workspace instead of a source-only replacement');

  restored = first.saveReview(owner, id, {
    drafts: restored.candidateReview.drafts.map((draft, index) => ({
      ...draft,
      selected: index === 23,
      seed: { ...draft.seed, biography: index === 23 ? 'Saved after polling' : draft.seed.biography },
    })),
  });
  eq(restored.candidateReview.drafts.filter((draft) => draft.selected).map((draft) => draft.index), [23],
    'a restored workspace can save revised selections without provider work');

  const restarted = backend(workspaceFile, now, counters).get(owner, id);
  eq(restarted.candidates.length, 24, 'backend restart restores the complete candidate collection');
  eq(restarted.candidateReview.drafts[23].seed.biography, 'Saved after polling', 'backend restart restores the latest candidate edit');
  eq(restarted.staging.results.length, 4, 'backend restart never repeats or discards staging evidence');
  eq(counters, { retrieval: 0, ai: 0, staging: 0 }, 'all restoration paths make zero retrieval, AI or staging calls');
  ok(fs.readFileSync(workspaceFile, 'utf8').includes('Saved after polling'), 'the revised review is persisted atomically');

  console.log('culture importer workspace retention: ' + checks + ' checks passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
