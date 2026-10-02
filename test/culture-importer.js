'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const population = require('../lib/population');
const { createFileCorpusCache } = require('../lib/culture-importer/cache');
const { createFetchLayerSource } = require('../lib/culture-importer/fetchlayer-source');
const { aggregateContributors, buildAnalysisDigest, normalizeCultureAnalysis } = require('../lib/culture-importer/analysis');
const { createCultureImporter, selectInfluences } = require('../lib/culture-importer');

const fixtures = path.join(__dirname, 'fixtures', 'culture-importer');
const posts = JSON.parse(fs.readFileSync(path.join(fixtures, 'fetchlayer-community-posts.json'), 'utf8'));
const thread1 = JSON.parse(fs.readFileSync(path.join(fixtures, 'fetchlayer-thread-post1.json'), 'utf8'));
const thread2 = JSON.parse(fs.readFileSync(path.join(fixtures, 'fetchlayer-thread-post2.json'), 'utf8'));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-culture-importer-'));
let checks = 0;

function eq(actual, expected, message) {
  checks++;
  assert.deepEqual(actual, expected, message);
}

function ok(value, message) {
  checks++;
  assert.ok(value, message);
}

function analysisResponse() {
  return {
    culture: {
      summary: 'A culture of escalating literal answers to deliberately odd prompts.',
      recurringJokes: ['ceremonial objects'],
      runningBits: ['requesting increasingly unnecessary procedural detail'],
      postFormats: ['oddly specific open questions'],
      repeatedPhrases: ['obviously the correct answer'],
      humour: ['dry escalation', 'literal follow-up'],
      responseConventions: ['answer the premise before complicating it'],
      recurringTopics: ['ceremonies', 'diagrams'],
      escalationPatterns: ['one absurd detail is answered with a more specific one'],
      interactionPatterns: ['dry claim followed by literal challenge'],
      archetypes: ['confident absurdist', 'literal examiner'],
      socialRoles: ['premise setter', 'detail escalator'],
    },
    contributors: [
      {
        label: 'contributor-1',
        voice: 'Dry and confidently specific.',
        humour: 'Treats absurd claims as administrative facts.',
        conversationalHabits: ['returns to a bit after another person questions it'],
        typicalReactions: ['adds a more specific absurd detail'],
        topics: ['ceremonies'],
        disagreementTendency: 'Extends the premise instead of openly disagreeing.',
        runningJokeTendency: 'Reuses the central object with new detail.',
        interactionPatterns: ['answers literal challenges'],
        postingPattern: 'Mostly replies.',
        evidenceSourceIds: ['t1_comment1', 't1_comment3', 'invented_source_id'],
      },
    ],
  };
}

function candidateResponse() {
  return {
    candidates: [
      {
        seed: {
          username: 'ceremony_clerk',
          biography: 'A fictional clerk for ceremonies nobody remembers authorising.',
          temperament: 'dry and unreasonably composed',
          interests: ['odd procedures', 'community in-jokes'],
          dislikes: ['vague forms'],
          conversationalStyle: 'answers the premise directly, then adds one precise complication',
          humourStyle: 'deadpan procedural escalation',
          curiosity: 'high',
          disagreementStyle: 'asks for the missing procedural detail',
          sociability: 'sociable',
          initiative: 'balanced',
          breadth: 'mixed',
          fictionalBackground: 'Once catalogued the wrong village festival and kept the forms.',
          values: ['specificity', 'keeping a good bit alive'],
          persistence: 'steady',
          noveltySeeking: 'moderate',
          toneNotes: 'dry, concise, never claims to be a real person',
          communities: ['shittyaskfeddit'],
          abilities: { reply: true, discuss: true, links: false },
        },
        inspirationLabels: ['contributor-1', 'culture: dry escalation'],
        behaviourObservations: ['continues a joke by adding a concrete detail'],
        psychologyObservations: { socialStyle: 'engages through playful specificity', replyPersistence: 'returns when a reply extends the premise' },
        suggestedActivity: 'regular',
        suggestedPostReplyBalance: 'mostly-replies',
      },
      {
        seed: {
          username: 'diagram_oracle',
          biography: 'A fictional interpreter of diagrams and confidently dubious labels.',
          temperament: 'curious and lightly contrarian',
          interests: ['bad diagrams', 'literal questions'],
          conversationalStyle: 'spots one detail and turns it into a focused question',
          humourStyle: 'literal-minded callbacks',
          curiosity: 'high',
          disagreementStyle: 'questions one assumption without rejecting the whole premise',
          sociability: 'selective',
          initiative: 'mostly-responds',
          breadth: 'narrow',
          fictionalBackground: 'Keeps a fictional drawer of mislabelled charts.',
          values: ['clarity', 'play'],
          persistence: 'light',
          noveltySeeking: 'high',
          toneNotes: 'specific and gently incredulous',
          communities: ['shittyaskfeddit'],
          abilities: { reply: true, discuss: false, links: false },
        },
        inspirationLabels: ['culture: literal follow-up'],
        behaviourObservations: ['asks for detail that makes an absurd premise stranger'],
        psychologyObservations: { contrarianism: 'challenges labels more often than conclusions' },
      },
    ],
  };
}

async function run() {
  let requests = 0;
  const transport = {
    async postJson(url, body) {
      requests++;
      if (url.includes('community-posts')) return structuredClone(posts);
      return structuredClone(body.url.includes('/post1/') ? thread1 : thread2);
    },
  };
  const cache = createFileCorpusCache({ directory: path.join(temporaryRoot, 'cache'), now: () => 1700001000000 });
  const source = createFetchLayerSource({ transport, cache, apiKey: 'fixture-key', now: () => 1700001000000 });
  const progressEvents = [];
  const first = await source.fetchCorpus({ subreddit: 'ExampleSub', maxPosts: 2, maxComments: 4 }, {
    onProgress: (event) => progressEvents.push(event),
  });
  eq(first.corpus.posts.length, 2, 'post listing normalizes all fixture posts');
  eq(first.corpus.comments.length, 4, 'comment listing normalizes all fixture comments');
  eq(first.corpus.comments[0].parentAuthor, 'PostStarter', 'top-level comment relation resolves to the sampled post author');
  eq(first.corpus.comments[1].parentAuthor, 'DryWit', 'sampled parent relation is reconstructed');
  eq(first.corpus.comments[2].depth, 2, 'nested parent depth is reconstructed');
  eq(first.corpus.provenance.adapter, 'fetchlayer-reddit', 'source provenance names the adapter');
  ok(progressEvents.some((event) => event.phase === 'fetch' && event.state === 'completed'), 'source emits progress');
  eq(requests, 3, 'one listing and two bounded thread requests build the corpus');

  const second = await source.fetchCorpus({ subreddit: 'ExampleSub', maxPosts: 2, maxComments: 4 });
  eq(second.cache.hit, true, 'a fresh matching corpus is loaded from cache');
  eq(requests, 3, 'cache hit avoids duplicate source requests');

  const contributors = aggregateContributors(first.corpus, { limit: 5 });
  const dryWit = contributors.contributors.find((item) => item.author === 'DryWit');
  ok(dryWit, 'contributor aggregation retains meaningful repeated participation');
  eq(dryWit.comments, 2, 'contributor comment count is preserved');
  ok(contributors.interactions.some((item) => item.count >= 1), 'reply relationships produce interaction evidence');
  const digest = buildAnalysisDigest(first.corpus, { maxContributors: 5 });
  ok(!JSON.stringify(digest).includes('PostStarter') || digest.samples.some((item) => item.contributor === 'other'), 'provider digest uses anonymous labels instead of source usernames');
  ok(digest.samples.every((item) => item.sourceId), 'analysis samples keep source evidence identifiers');
  assert.throws(
    () => normalizeCultureAnalysis({ culture: { recurringJokes: [] } }, digest),
    /missing culture.summary/,
    'culture schema validation rejects a missing summary',
  );
  checks++;

  const selected = selectInfluences({
    culture: { archetypes: ['one', 'two'] },
    contributors: [{ label: 'contributor-1' }, { label: 'contributor-2' }],
  }, { contributorLabels: ['contributor-2'], archetypes: ['two'] });
  eq(selected.selection, { contributorLabels: ['contributor-2'], archetypes: ['two'] }, 'callers can select contributor and archetype influences without changing source analysis');
  const selectedNone = selectInfluences({ culture: { archetypes: ['one'] }, contributors: [{ label: 'contributor-1' }] }, { contributorLabels: [], archetypes: [] });
  eq(selectedNone.selection, { contributorLabels: [], archetypes: [] }, 'an explicit empty selection excludes all individual influences');

  const providerCalls = [];
  const providerClient = {
    async generate(request) {
      providerCalls.push(request);
      const structured = providerCalls.length === 1 ? analysisResponse() : candidateResponse();
      return { provider: request.providerOverride, model: request.model, text: JSON.stringify(structured), structured };
    },
  };
  const importer = createCultureImporter({ source, providerClient, now: () => 1700002000000 });
  const importProgress = [];
  const runController = new AbortController();
  const result = await importer.run({
    subreddit: 'ExampleSub', maxPosts: 2, maxComments: 4,
    provider: 'deepseek', model: 'selected-model', count: 2,
    targetCommunities: ['shittyaskfeddit'],
  }, { signal: runController.signal, onProgress: (event) => importProgress.push(event) });
  eq(providerCalls.length, 2, 'one batched call analyses culture and one batched call generates candidates');
  eq(providerCalls.map((call) => call.providerOverride), ['deepseek', 'deepseek'], 'caller provider override reaches every generation');
  eq(providerCalls.map((call) => call.model), ['selected-model', 'selected-model'], 'caller model reaches every generation');
  ok(providerCalls.every((call) => call.structuredOutput === true), 'all provider calls request structured output');
  ok(providerCalls.every((call) => call.signal === runController.signal), 'the caller cancellation signal reaches every provider request');
  eq(result.populationSeeds.length, 2, 'requested population-compatible seeds are returned');
  eq(result.complete, true, 'a full distinct batch is identified as complete');
  eq(result.populationSeeds[0], population.normalizeSeed(result.populationSeeds[0], ['shittyaskfeddit']), 'emitted seed is already in the existing normalized population contract');
  eq(result.provenance.sourceAdapter, 'fetchlayer-reddit', 'result keeps source provenance');
  eq(result.provenance.providers.analysis.provider, 'deepseek', 'result keeps provider provenance');
  ok(!result.analysis.contributors[0].evidenceSourceIds.includes('invented_source_id'), 'unsupported evidence identifiers are removed during schema validation');
  ok(result.candidates[0].importerMetadata.psychologyObservations.socialStyle, 'future psychology observations survive outside the core seed schema');
  eq(result.candidates[0].importerMetadata.suggestedActivity, 'regular', 'per-character cadence suggestion survives outside the core seed schema');
  eq(result.stagingDefaults.configuration.strength, 'soft', 'result carries population-compatible staging defaults');
  ok(importProgress.some((event) => event.phase === 'import' && event.state === 'completed'), 'orchestrator reports completion progress');

  const duplicateProvider = {
    async generate(request) {
      const structured = request.system.includes('Analyse') ? analysisResponse() : {
        candidates: [candidateResponse().candidates[0], structuredClone(candidateResponse().candidates[0])],
      };
      return { provider: 'ollama', model: 'mock', text: JSON.stringify(structured), structured };
    },
  };
  const duplicateResult = await createCultureImporter({ source, providerClient: duplicateProvider }).run({
    subreddit: 'ExampleSub', maxPosts: 2, maxComments: 4, provider: 'ollama', model: 'mock', count: 2,
    targetCommunities: ['shittyaskfeddit'],
  });
  eq(duplicateResult.populationSeeds.length, 1, 'near-duplicate generated characters are not admitted');
  ok(duplicateResult.rejectedCandidates.some((item) => item.reason === 'near-duplicate'), 'duplicate rejection is explained');
  eq(duplicateResult.complete, false, 'a partial batch remains inspectable but is clearly marked incomplete');
  ok(duplicateResult.warnings.length === 1, 'a partial batch includes a stable operator-facing warning');

  const malformedProvider = { async generate() { return { text: 'not-json' }; } };
  await assert.rejects(
    () => createCultureImporter({ source, providerClient: malformedProvider }).analyseCulture({ corpus: first.corpus, provider: 'ollama' }),
    (error) => error.code === 'BAD_MODEL_OUTPUT' && error.phase === 'analyse',
    'malformed model output receives a stable error classification',
  );
  checks++;

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => importer.run({ subreddit: 'ExampleSub', targetCommunities: ['shittyaskfeddit'] }, { signal: aborted.signal }),
    (error) => error.name === 'AbortError',
    'pre-aborted import stops before source or provider work',
  );
  checks++;

  console.log('culture-importer: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
