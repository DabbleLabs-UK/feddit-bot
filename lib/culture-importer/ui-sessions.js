'use strict';

const crypto = require('node:crypto');
const population = require('../population');
const {
  createCultureStagingBridge,
  compactPopulationSeed,
} = require('./staging');

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_OWNER = 8;

class CultureImportUiError extends Error {
  constructor(message, code = 'CULTURE_IMPORT_UI_FAILED', options = {}) {
    super(String(message || 'The culture importer request failed.'));
    this.name = 'CultureImportUiError';
    this.code = String(code || 'CULTURE_IMPORT_UI_FAILED');
    this.statusCode = Number(options.statusCode) || 409;
    this.results = Array.isArray(options.results) ? options.results : [];
    this.association = options.association || null;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function text(value, maximum = 200) {
  return String(value == null ? '' : value).trim().slice(0, maximum);
}

function ownerKey(value) {
  const key = text(value, 160);
  if (!key) throw new CultureImportUiError('An importer owner is required.', 'IMPORTER_OWNER_REQUIRED', { statusCode: 401 });
  return key;
}

function publicError(error) {
  if (!error) return null;
  return {
    code: text(error.code || error.name || 'IMPORT_FAILED', 100),
    phase: text(error.phase, 40),
    message: text(error.message || 'The importer action failed.', 1000),
    retryable: error.retryable === true,
  };
}

function sourceSummary(fetched) {
  if (!fetched || !fetched.corpus) return null;
  const corpus = fetched.corpus;
  return {
    subreddit: text(corpus.subreddit, 30),
    fetchedAt: text(corpus.fetchedAt, 80),
    window: clone(corpus.window || {}),
    posts: Array.isArray(corpus.posts) ? corpus.posts.length : 0,
    comments: Array.isArray(corpus.comments) ? corpus.comments.length : 0,
    cache: {
      key: text(fetched.cache && fetched.cache.key, 200),
      hit: fetched.cache && fetched.cache.hit === true,
    },
  };
}

function publicSession(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    input: clone(session.input),
    task: clone(session.task),
    source: sourceSummary(session.fetched),
    analysis: clone(session.analysed && session.analysed.analysis),
    analysisProvider: clone(session.analysed && session.analysed.provider),
    candidates: clone(session.importResult && session.importResult.candidates || []),
    complete: session.importResult ? session.importResult.complete === true : null,
    warnings: clone(session.importResult && session.importResult.warnings || []),
    rejectedCandidates: clone(session.importResult && session.importResult.rejectedCandidates || []),
    provenance: clone(session.importResult && session.importResult.provenance),
    stagingDefaults: clone(session.importResult && session.importResult.stagingDefaults),
    staging: clone(session.staging),
  };
}

function abortError() {
  const error = new Error('Import cancelled.');
  error.name = 'AbortError';
  error.code = 'IMPORT_CANCELLED';
  return error;
}

function normalizedInput(input = {}) {
  return {
    subreddit: text(input.subreddit, 30),
    maxPosts: Number(input.maxPosts),
    maxComments: Number(input.maxComments),
    since: input.since ? text(input.since, 80) : '',
    until: input.until ? text(input.until, 80) : '',
    refresh: input.refresh === true,
  };
}

function buildImportResult(session, generated, now) {
  const corpus = session.fetched.corpus;
  const analysisId = text(session.analysed.analysis && session.analysed.analysis.id, 160);
  const provenance = {
    schemaVersion: 1,
    importer: 'subreddit-culture-importer',
    sourceAdapter: text(session.sourceId || 'reddit-json', 80),
    subreddit: text(corpus.subreddit, 30),
    sourceFetchedAt: text(corpus.fetchedAt, 80),
    sourceWindow: clone(corpus.window || {}),
    sourceCounts: {
      posts: Array.isArray(corpus.posts) ? corpus.posts.length : 0,
      comments: Array.isArray(corpus.comments) ? corpus.comments.length : 0,
    },
    cache: {
      key: text(session.fetched.cache && session.fetched.cache.key, 200),
      hit: session.fetched.cache && session.fetched.cache.hit === true,
    },
    analysisId,
    providers: {
      analysis: clone(session.analysed.provider),
      candidates: clone(generated.provider),
      candidateRepair: clone(generated.repairProvider),
    },
    startedAt: session.createdAt,
    completedAt: new Date(Number(now())).toISOString(),
  };
  const candidates = generated.candidates.map((candidate) => ({
    seed: clone(candidate.seed),
    importerMetadata: {
      ...clone(candidate.importerMetadata || {}),
      provenance,
    },
  }));
  return {
    schemaVersion: 1,
    provenance,
    analysis: clone(session.analysed.analysis),
    candidates,
    populationSeeds: candidates.map((candidate) => clone(candidate.seed)),
    rejectedCandidates: clone(generated.rejected || []),
    requestedCount: generated.requestedCount,
    complete: generated.complete === true,
    warnings: clone(generated.warnings || []),
    stagingDefaults: {
      configuration: population.normalizeCohortConfiguration(session.populationConfiguration || {
        strength: 'soft',
        activity: 'varied',
      }),
    },
  };
}

function editedImportResult(importResult, edits = []) {
  const byIndex = new Map((Array.isArray(edits) ? edits : []).map((edit) => [Number(edit.index), edit]));
  const output = clone(importResult);
  output.candidates = output.candidates.map((candidate, index) => {
    const edit = byIndex.get(index);
    if (!edit || !edit.seed) return candidate;
    return {
      ...candidate,
      seed: compactPopulationSeed({ ...candidate.seed, ...clone(edit.seed) }),
    };
  });
  output.populationSeeds = output.candidates.map((candidate) => clone(candidate.seed));
  return output;
}

function createCultureImportUiSessions(options = {}) {
  const importer = options.importer;
  if (!importer || typeof importer.fetchCorpus !== 'function' || typeof importer.analyseCulture !== 'function' ||
      typeof importer.generateCandidates !== 'function') {
    throw new Error('A culture importer with staged public methods is required.');
  }
  const now = options.now || Date.now;
  const makeId = options.makeId || (() => 'culture_import_' + crypto.randomBytes(12).toString('hex'));
  const existingSeeds = options.existingSeeds || (() => []);
  const sessions = new Map();

  function prune() {
    const cutoff = Number(now()) - SESSION_TTL_MS;
    for (const [id, session] of sessions) {
      if (Date.parse(session.updatedAt) < cutoff && (!session.controller || session.controller.signal.aborted)) sessions.delete(id);
    }
  }

  function get(id, owner) {
    prune();
    const session = sessions.get(String(id || ''));
    if (!session || session.owner !== ownerKey(owner)) {
      throw new CultureImportUiError('That culture import session was not found.', 'IMPORT_SESSION_NOT_FOUND', { statusCode: 404 });
    }
    return session;
  }

  function setTask(session, phase, work) {
    if (session.task && ['running', 'cancelling'].includes(session.task.state)) {
      throw new CultureImportUiError('Wait for or cancel the current importer action first.', 'IMPORT_ACTION_RUNNING');
    }
    const controller = new AbortController();
    session.controller = controller;
    session.task = {
      phase,
      state: 'running',
      progress: { phase, state: 'started', current: 0, total: 1, message: 'Starting ' + phase + '.' },
      error: null,
    };
    session.updatedAt = new Date(Number(now())).toISOString();
    const runtime = {
      signal: controller.signal,
      refresh: session.input.refresh === true,
      onProgress(event) {
        session.task.progress = clone(event);
        session.updatedAt = new Date(Number(now())).toISOString();
      },
    };
    const workPromise = Promise.resolve().then(() => work(runtime));
    const cancelledPromise = new Promise((_resolve, reject) => {
      const rejectCancelled = () => reject(abortError());
      if (controller.signal.aborted) rejectCancelled();
      else controller.signal.addEventListener('abort', rejectCancelled, { once: true });
    });
    session.pending = Promise.race([workPromise, cancelledPromise])
      .then((result) => {
        if (controller.signal.aborted) throw abortError();
        session.task.state = 'completed';
        session.task.progress = {
          phase,
          state: 'completed',
          current: 1,
          total: 1,
          message: phase.charAt(0).toUpperCase() + phase.slice(1) + ' completed.',
        };
        session.updatedAt = new Date(Number(now())).toISOString();
        return result;
      })
      .catch((error) => {
        session.task.state = error && (error.name === 'AbortError' || error.code === 'IMPORT_CANCELLED') ? 'cancelled' : 'failed';
        session.task.error = publicError(error);
        session.updatedAt = new Date(Number(now())).toISOString();
      })
      .finally(() => {
        session.controller = null;
        session.pending = null;
      });
    return publicSession(session);
  }

  function create(owner, input = {}) {
    prune();
    const ownerId = ownerKey(owner);
    const ownerSessions = [...sessions.values()].filter((session) => session.owner === ownerId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    while (ownerSessions.length >= MAX_SESSIONS_PER_OWNER) {
      const old = ownerSessions.shift();
      if (old.controller) old.controller.abort();
      sessions.delete(old.id);
    }
    const createdAt = new Date(Number(now())).toISOString();
    const session = {
      id: makeId(),
      owner: ownerId,
      createdAt,
      updatedAt: createdAt,
      input: normalizedInput(input),
      sourceId: importer.source && importer.source.id,
      populationConfiguration: clone(input.populationConfiguration),
      fetched: null,
      analysed: null,
      importResult: null,
      staging: null,
      task: null,
      controller: null,
      pending: null,
    };
    sessions.set(session.id, session);
    return setTask(session, 'fetch', async (runtime) => {
      const fetched = await importer.fetchCorpus(session.input, runtime);
      if (runtime.signal.aborted) throw abortError();
      session.fetched = fetched;
      session.analysed = null;
      session.importResult = null;
      session.staging = null;
    });
  }

  function analyse(owner, id, input = {}) {
    const session = get(id, owner);
    if (!session.fetched) throw new CultureImportUiError('Fetch the source sample before analysing it.', 'SOURCE_SAMPLE_REQUIRED');
    const provider = text(input.provider, 80);
    const model = text(input.model, 180);
    return setTask(session, 'analyse', async (runtime) => {
      const analysed = await importer.analyseCulture({
        corpus: session.fetched.corpus,
        provider,
        model,
        maxContributors: Number(input.maxContributors) || undefined,
      }, runtime);
      if (runtime.signal.aborted) throw abortError();
      session.analysed = analysed;
      session.importResult = null;
      session.staging = null;
    });
  }

  function generate(owner, id, input = {}) {
    const session = get(id, owner);
    if (!session.analysed) throw new CultureImportUiError('Analyse the source sample before generating characters.', 'CULTURE_ANALYSIS_REQUIRED');
    const provider = text(input.provider, 80);
    const model = text(input.model, 180);
    const count = Math.max(1, Math.min(population.MAX_COHORT_SIZE, Math.floor(Number(input.count) || 1)));
    return setTask(session, 'generate', async (runtime) => {
      const generated = await importer.generateCandidates({
        analysis: session.analysed.analysis,
        corpus: session.fetched.corpus,
        count,
        provider,
        model,
        targetCommunities: Array.isArray(input.targetCommunities) ? input.targetCommunities : [],
        contributorLabels: Array.isArray(input.contributorLabels) ? input.contributorLabels : [],
        archetypes: Array.isArray(input.archetypes) ? input.archetypes : [],
        existingSeeds: clone(existingSeeds()),
      }, runtime);
      if (runtime.signal.aborted) throw abortError();
      session.importResult = buildImportResult(session, generated, now);
      session.staging = null;
    });
  }

  async function stage(owner, id, input = {}, stageExternalSeeds) {
    const session = get(id, owner);
    if (!session.importResult) throw new CultureImportUiError('Generate candidates before staging them.', 'CULTURE_CANDIDATES_REQUIRED');
    if (typeof stageExternalSeeds !== 'function') {
      throw new CultureImportUiError('The population staging destination is not available.', 'STAGING_DESTINATION_REQUIRED', { statusCode: 503 });
    }
    if (session.task && ['running', 'cancelling'].includes(session.task.state)) {
      throw new CultureImportUiError('Wait for or cancel the current importer action first.', 'IMPORT_ACTION_RUNNING');
    }
    const selected = Array.isArray(input.selected) ? input.selected : [];
    const reviewed = editedImportResult(session.importResult, input.edits);
    const bridge = createCultureStagingBridge({ stageExternalSeeds });
    try {
      session.staging = await bridge.stage(reviewed, selected);
      session.updatedAt = new Date(Number(now())).toISOString();
      return clone(session.staging);
    } catch (error) {
      session.staging = {
        ok: false,
        error: publicError(error),
        association: clone(error.association || null),
        results: clone(error.results || []),
      };
      session.updatedAt = new Date(Number(now())).toISOString();
      throw error;
    }
  }

  function cancel(owner, id) {
    const session = get(id, owner);
    if (!session.controller || !session.task || !['running', 'cancelling'].includes(session.task.state)) {
      return publicSession(session);
    }
    session.task.state = 'cancelling';
    session.task.progress = {
      ...(session.task.progress || {}),
      state: 'cancelling',
      message: 'Cancellation requested.',
    };
    session.controller.abort();
    session.updatedAt = new Date(Number(now())).toISOString();
    return publicSession(session);
  }

  return {
    create,
    get(owner, id) { return publicSession(get(id, owner)); },
    analyse,
    generate,
    stage,
    cancel,
    async wait(owner, id) {
      const session = get(id, owner);
      if (session.pending) await session.pending;
      return publicSession(session);
    },
  };
}

module.exports = {
  SESSION_TTL_MS,
  MAX_SESSIONS_PER_OWNER,
  CultureImportUiError,
  publicError,
  sourceSummary,
  editedImportResult,
  createCultureImportUiSessions,
};
