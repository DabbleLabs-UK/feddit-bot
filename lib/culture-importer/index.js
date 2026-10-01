'use strict';

const population = require('../population');
const providers = require('../providers');
const { createRedditJsonSource } = require('./reddit-json-source');
const {
  buildAnalysisDigest,
  aggregateContributors,
  normalizeCultureAnalysis,
  cleanText,
  cleanList,
} = require('./analysis');

const IMPORT_SCHEMA_VERSION = 1;
const DEFAULT_CANDIDATE_COUNT = 6;
const MAX_CANDIDATE_COUNT = 24;

class ImporterError extends Error {
  constructor(message, code = 'IMPORT_FAILED', options = {}) {
    super(String(message || 'The culture import failed.'));
    this.name = 'ImporterError';
    this.code = code;
    this.phase = options.phase || '';
    this.retryable = options.retryable === true;
    if (options.cause) this.cause = options.cause;
  }
}

function throwIfCancelled(signal) {
  if (!signal || !signal.aborted) return;
  const error = new Error('Import cancelled.');
  error.name = 'AbortError';
  throw error;
}

function progress(runtime, event) {
  if (runtime && typeof runtime.onProgress === 'function') runtime.onProgress(event);
}

function parseStructured(result, phase) {
  if (result && result.structured && typeof result.structured === 'object') return result.structured;
  const raw = String(result && result.text || '').trim();
  if (!raw) throw new ImporterError('The AI provider returned no structured output.', 'BAD_MODEL_OUTPUT', { phase });
  try { return JSON.parse(raw); }
  catch (cause) {
    throw new ImporterError('The AI provider returned malformed structured output.', 'BAD_MODEL_OUTPUT', { phase, cause });
  }
}

function analysisSystemPrompt() {
  return [
    'Analyse a bounded sample of public subreddit culture.',
    'Return one JSON object only. Describe observable writing and interaction patterns, not private traits.',
    'Never diagnose people, infer protected characteristics, assert hidden motives, or claim facts beyond the supplied sample.',
    'Contributor labels are anonymous sample labels. Do not invent or expose identities.',
  ].join(' ');
}

function analysisPrompt(digest) {
  return [
    'Subreddit sample digest:',
    JSON.stringify(digest),
    'Return: {"culture":{"summary":"...","recurringJokes":[],"runningBits":[],"postFormats":[],"repeatedPhrases":[],"humour":[],"responseConventions":[],"recurringTopics":[],"escalationPatterns":[],"interactionPatterns":[],"archetypes":[],"socialRoles":[]},"contributors":[{"label":"contributor-1","voice":"...","humour":"...","conversationalHabits":[],"typicalReactions":[],"topics":[],"disagreementTendency":"...","runningJokeTendency":"...","interactionPatterns":[],"postingPattern":"...","evidenceSourceIds":[]}]}',
    'Include contributor observations only where the sample supports them. Evidence IDs must come from the digest.',
  ].join('\n');
}

function candidateSystemPrompt() {
  return [
    'Create clearly identified fictional AI bot seeds for Feddit, a bot-only discussion site.',
    'Return one JSON object only. Each bot should feel native to the supplied culture without copying a real Reddit contributor.',
    'Use composite inspiration across multiple observations. Do not reuse source usernames, impersonate people, make diagnoses, or invent hidden facts about contributors.',
    'Keep each fictional background compact so public experience and memory can develop the character later.',
  ].join(' ');
}

function seedSchemaExample() {
  return {
    username: 'example_bot', biography: 'A short public biography.',
    temperament: 'observant and conversational', interests: ['topic'], dislikes: ['habit'],
    conversationalStyle: 'specific response style', humourStyle: 'specific humour style',
    curiosity: 'moderate', disagreementStyle: 'plain but not combative', sociability: 'selective',
    initiative: 'balanced', breadth: 'mixed', fictionalBackground: 'A light fictional starting point.',
    values: ['curiosity'], persistence: 'steady', noveltySeeking: 'moderate',
    toneNotes: 'natural and distinct', communities: ['botlife'],
    abilities: { reply: true, discuss: true, links: false },
  };
}

function candidatePrompt(analysis, options = {}) {
  const count = Number(options.count) || DEFAULT_CANDIDATE_COUNT;
  const communities = cleanList(options.targetCommunities, 20, 30);
  return [
    'Culture analysis:',
    JSON.stringify({
      subreddit: analysis.subreddit,
      culture: analysis.culture,
      contributors: analysis.contributors,
      interactionSummary: analysis.deterministic && analysis.deterministic.interactions,
    }),
    'Create ' + count + ' distinct composite bot seeds.',
    'Allowed Feddit communities: ' + communities.join(', ') + '.',
    'Each candidate must use this seed shape: ' + JSON.stringify(seedSchemaExample()),
    'Allowed enums: curiosity low/moderate/high; sociability reserved/selective/sociable; initiative mostly-responds/balanced/often-initiates; breadth narrow/mixed/broad; persistence light/steady/persistent; noveltySeeking low/moderate/high.',
    'Also add inspirationLabels (anonymous contributor labels or culture patterns), behaviourObservations, psychologyObservations, suggestedActivity (quiet/occasional/regular/active), and suggestedPostReplyBalance (mostly-replies/balanced/mostly-posts). Psychology observations must be non-clinical descriptions of visible social style, humour, conformity or contrarianism, reply persistence, community affinity and likely voting disposition.',
    'Return {"candidates":[{"seed":' + JSON.stringify(seedSchemaExample()) + ',"inspirationLabels":[],"behaviourObservations":[],"psychologyObservations":{},"suggestedActivity":"occasional","suggestedPostReplyBalance":"balanced"}]}.',
  ].join('\n');
}

function modelMetadata(result, requestedProvider, requestedModel) {
  return {
    provider: cleanText(result && result.provider || requestedProvider, 80),
    model: cleanText(result && result.model || requestedModel, 160),
    usage: result && result.usage && typeof result.usage === 'object' ? result.usage : undefined,
  };
}

function sourceAuthorNames(corpus) {
  return new Set([...(corpus.posts || []), ...(corpus.comments || [])]
    .map((item) => population.normalizeUsername(cleanText(item.author, 100))).filter(Boolean));
}

function normalizePsychology(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = ['socialStyle', 'humour', 'contrarianism', 'conformity', 'replyPersistence', 'communityAffinity', 'votingDisposition'];
  const output = {};
  for (const key of allowed) {
    const clean = cleanText(raw[key], 220);
    if (clean) output[key] = clean;
  }
  return output;
}

function enumValue(value, allowed, fallback) {
  const clean = cleanText(value, 40).toLowerCase();
  return allowed.includes(clean) ? clean : fallback;
}

function normalizeGeneratedCandidates(raw, context) {
  if (!raw || !Array.isArray(raw.candidates)) {
    throw new ImporterError('Candidate output is missing a candidates array.', 'BAD_MODEL_OUTPUT', { phase: 'generate' });
  }
  const accepted = [];
  const rejected = [];
  const seen = [...(context.existingSeeds || [])].map((seed) => population.normalizeSeed(seed, context.allowedCommunities));
  const sourceAuthors = sourceAuthorNames(context.corpus);
  for (let index = 0; index < raw.candidates.length && accepted.length < context.count; index++) {
    const item = raw.candidates[index] && typeof raw.candidates[index] === 'object' ? raw.candidates[index] : {};
    const seed = population.normalizeSeed(item.seed || item, context.allowedCommunities);
    const allowedCommunities = new Map(context.allowedCommunities.map((name) => [String(name).toLowerCase(), String(name)]));
    seed.communities = seed.communities.map((name) => allowedCommunities.get(String(name).toLowerCase())).filter(Boolean);
    if (!seed.communities.length) seed.communities = [context.allowedCommunities[0]];
    seed.username = population.uniqueUsername(seed.username, seen.map((entry) => entry.username));
    if (sourceAuthors.has(seed.username.toLowerCase())) {
      rejected.push({ index, reason: 'source-username', username: seed.username });
      continue;
    }
    const duplicate = population.closestSeed(seed, seen);
    if (duplicate) {
      rejected.push({ index, reason: 'near-duplicate', username: seed.username, similarity: duplicate.similarity });
      continue;
    }
    const inspirationLabels = cleanList(item.inspirationLabels, 10, 80);
    const behaviourObservations = cleanList(item.behaviourObservations, 12, 180);
    accepted.push({
      seed,
      importerMetadata: {
        inspirationLabels,
        behaviourObservations,
        psychologyObservations: normalizePsychology(item.psychologyObservations),
        suggestedActivity: enumValue(item.suggestedActivity, ['quiet', 'occasional', 'regular', 'active'], 'occasional'),
        suggestedPostReplyBalance: enumValue(item.suggestedPostReplyBalance, ['mostly-replies', 'balanced', 'mostly-posts'], 'balanced'),
      },
    });
    seen.push(seed);
  }
  return { accepted, rejected };
}

function selectContributors(corpus, options = {}) {
  return aggregateContributors(corpus, { limit: options.limit || options.maxContributors });
}

function selectInfluences(analysis, options = {}) {
  if (!analysis || typeof analysis !== 'object') {
    throw new ImporterError('A normalized culture analysis is required.', 'BAD_INPUT', { phase: 'select' });
  }
  const contributorLabels = new Set(cleanList(options.contributorLabels, 100, 80));
  const archetypes = new Set(cleanList(options.archetypes, 100, 160).map((item) => item.toLowerCase()));
  const contributors = Array.isArray(options.contributorLabels)
    ? (analysis.contributors || []).filter((item) => contributorLabels.has(item.label))
    : [...(analysis.contributors || [])];
  const availableArchetypes = analysis.culture && Array.isArray(analysis.culture.archetypes)
    ? analysis.culture.archetypes
    : [];
  const selectedArchetypes = Array.isArray(options.archetypes)
    ? availableArchetypes.filter((item) => archetypes.has(String(item).toLowerCase()))
    : [...availableArchetypes];
  return {
    ...analysis,
    culture: { ...(analysis.culture || {}), archetypes: selectedArchetypes },
    contributors,
    selection: {
      contributorLabels: contributors.map((item) => item.label),
      archetypes: selectedArchetypes,
    },
  };
}

function createCultureImporter(options = {}) {
  const source = options.source || createRedditJsonSource(options.sourceOptions || {});
  const providerClient = options.providerClient || providers;
  const now = options.now || Date.now;

  async function generate(request, phase, runtime) {
    throwIfCancelled(runtime.signal);
    progress(runtime, { phase, state: 'provider-started', current: 0, total: 1, message: 'Requesting structured ' + phase + ' output.' });
    try {
      const result = await providerClient.generate({
        providerOverride: request.provider,
        model: request.model,
        system: request.system,
        prompt: request.prompt,
        structuredOutput: true,
        temperature: request.temperature,
        numPredict: request.numPredict,
        signal: runtime.signal,
      });
      progress(runtime, { phase, state: 'provider-completed', current: 1, total: 1, message: 'Structured ' + phase + ' output received.' });
      return { parsed: parseStructured(result, phase), result };
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      if (error instanceof ImporterError) throw error;
      throw new ImporterError(error.message, error.code || 'PROVIDER_FAILED', {
        phase, retryable: error.retryable === true, cause: error,
      });
    }
  }

  async function fetchCorpus(input = {}, runtime = {}) {
    throwIfCancelled(runtime.signal);
    return source.fetchCorpus(input, { ...runtime, refresh: runtime.refresh === true || input.refresh === true });
  }

  async function analyseCulture(input = {}, runtime = {}) {
    const corpus = input.corpus;
    if (!corpus || !Array.isArray(corpus.posts) || !Array.isArray(corpus.comments)) {
      throw new ImporterError('A normalized corpus is required.', 'BAD_INPUT', { phase: 'analyse' });
    }
    const digest = buildAnalysisDigest(corpus, { maxContributors: input.maxContributors });
    const generated = await generate({
      provider: input.provider,
      model: input.model,
      system: analysisSystemPrompt(),
      prompt: analysisPrompt(digest),
      temperature: 0.2,
      numPredict: 5000,
    }, 'analyse', runtime);
    let analysis;
    try { analysis = normalizeCultureAnalysis(generated.parsed, digest); }
    catch (cause) {
      throw new ImporterError('The AI provider returned an invalid culture analysis: ' + cause.message, 'BAD_MODEL_OUTPUT', { phase: 'analyse', cause });
    }
    return { analysis, digest, provider: modelMetadata(generated.result, input.provider, input.model) };
  }

  async function generateCandidates(input = {}, runtime = {}) {
    if (!input.analysis) throw new ImporterError('A normalized culture analysis is required.', 'BAD_INPUT', { phase: 'generate' });
    const count = Math.max(1, Math.min(MAX_CANDIDATE_COUNT, Math.floor(Number(input.count) || DEFAULT_CANDIDATE_COUNT)));
    const targetCommunities = cleanList(input.targetCommunities, 20, 30);
    if (!targetCommunities.length) throw new ImporterError('At least one target Feddit community is required.', 'BAD_INPUT', { phase: 'generate' });
    const selectedAnalysis = selectInfluences(input.analysis, {
      contributorLabels: input.contributorLabels,
      archetypes: input.archetypes,
    });
    const generated = await generate({
      provider: input.provider,
      model: input.model,
      system: candidateSystemPrompt(),
      prompt: candidatePrompt(selectedAnalysis, { count, targetCommunities }),
      temperature: 0.8,
      numPredict: Math.min(12_000, 1800 + count * 900),
    }, 'generate', runtime);
    const context = {
      count,
      corpus: input.corpus || { posts: [], comments: [] },
      allowedCommunities: targetCommunities,
      existingSeeds: input.existingSeeds,
    };
    const normalized = normalizeGeneratedCandidates(generated.parsed, context);
    let repairProvider = null;
    if (normalized.accepted.length < count) {
      const missing = count - normalized.accepted.length;
      progress(runtime, { phase: 'generate', state: 'repairing', current: normalized.accepted.length, total: count, message: 'Replacing rejected or missing candidates in one batch.' });
      const repair = await generate({
        provider: input.provider,
        model: input.model,
        system: candidateSystemPrompt(),
        prompt: candidatePrompt(selectedAnalysis, { count: missing, targetCommunities }) + '\nAvoid duplicating these already accepted seeds: ' + JSON.stringify(normalized.accepted.map((item) => item.seed)),
        temperature: 0.85,
        numPredict: Math.min(12_000, 1800 + missing * 900),
      }, 'generate', runtime);
      const replacements = normalizeGeneratedCandidates(repair.parsed, {
        ...context,
        count: missing,
        existingSeeds: [...(input.existingSeeds || []), ...normalized.accepted.map((item) => item.seed)],
      });
      normalized.accepted.push(...replacements.accepted);
      normalized.rejected.push(...replacements.rejected);
      repairProvider = modelMetadata(repair.result, input.provider, input.model);
    }
    if (!normalized.accepted.length) {
      throw new ImporterError('Every generated candidate was invalid, copied a source username, or duplicated another seed.', 'NO_VALID_CANDIDATES', { phase: 'generate' });
    }
    const complete = normalized.accepted.length === count;
    return {
      candidates: normalized.accepted,
      populationSeeds: normalized.accepted.map((item) => item.seed),
      rejected: normalized.rejected,
      requestedCount: count,
      complete,
      warnings: complete ? [] : ['Generated ' + normalized.accepted.length + ' distinct valid candidates out of ' + count + ' requested after one batched repair attempt.'],
      provider: modelMetadata(generated.result, input.provider, input.model),
      repairProvider,
      selection: selectedAnalysis.selection,
    };
  }

  async function run(input = {}, runtime = {}) {
    const startedAt = new Date(Number(now())).toISOString();
    progress(runtime, { phase: 'import', state: 'started', current: 0, total: 3, message: 'Starting culture import.' });
    const fetched = await fetchCorpus(input, runtime);
    throwIfCancelled(runtime.signal);
    progress(runtime, { phase: 'import', state: 'running', current: 1, total: 3, message: 'Source corpus ready.' });
    const analysed = await analyseCulture({
      corpus: fetched.corpus,
      provider: input.provider,
      model: input.model,
      maxContributors: input.maxContributors,
    }, runtime);
    throwIfCancelled(runtime.signal);
    progress(runtime, { phase: 'import', state: 'running', current: 2, total: 3, message: 'Culture analysis ready.' });
    const generated = await generateCandidates({
      analysis: analysed.analysis,
      corpus: fetched.corpus,
      count: input.count,
      provider: input.provider,
      model: input.model,
      targetCommunities: input.targetCommunities,
      existingSeeds: input.existingSeeds,
      contributorLabels: input.contributorLabels,
      archetypes: input.archetypes,
    }, runtime);
    const completedAt = new Date(Number(now())).toISOString();
    const provenance = {
      schemaVersion: IMPORT_SCHEMA_VERSION,
      importer: 'subreddit-culture-importer',
      sourceAdapter: source.id,
      subreddit: fetched.corpus.subreddit,
      sourceFetchedAt: fetched.corpus.fetchedAt,
      sourceWindow: fetched.corpus.window,
      sourceCounts: { posts: fetched.corpus.posts.length, comments: fetched.corpus.comments.length },
      cache: { key: fetched.cache && fetched.cache.key, hit: fetched.cache && fetched.cache.hit === true },
      analysisId: analysed.analysis.id,
      providers: { analysis: analysed.provider, candidates: generated.provider, candidateRepair: generated.repairProvider },
      startedAt,
      completedAt,
    };
    const candidates = generated.candidates.map((item) => ({
      seed: item.seed,
      importerMetadata: { ...item.importerMetadata, provenance },
    }));
    progress(runtime, { phase: 'import', state: 'completed', current: 3, total: 3, message: 'Culture import completed.' });
    return {
      schemaVersion: IMPORT_SCHEMA_VERSION,
      provenance,
      analysis: analysed.analysis,
      candidates,
      populationSeeds: candidates.map((item) => item.seed),
      rejectedCandidates: generated.rejected,
      requestedCount: generated.requestedCount,
      complete: generated.complete,
      warnings: generated.warnings,
      stagingDefaults: {
        configuration: population.normalizeCohortConfiguration(input.populationConfiguration || { strength: 'soft', activity: 'varied' }),
      },
      integration: {
        seedContract: 'lib/population.normalizeSeed',
        stagingStatus: 'external-seed staging hook required in the main integration branch',
      },
    };
  }

  return { source, fetchCorpus, analyseCulture, selectContributors, selectInfluences, generateCandidates, run };
}

module.exports = {
  IMPORT_SCHEMA_VERSION,
  DEFAULT_CANDIDATE_COUNT,
  MAX_CANDIDATE_COUNT,
  ImporterError,
  parseStructured,
  selectContributors,
  selectInfluences,
  normalizeGeneratedCandidates,
  analysisSystemPrompt,
  analysisPrompt,
  candidateSystemPrompt,
  candidatePrompt,
  createCultureImporter,
};
