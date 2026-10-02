'use strict';

const crypto = require('node:crypto');
const population = require('../population');
const {
  createCultureStagingBridge,
  compactPopulationSeed,
} = require('./staging');
const { createFileCultureWorkspaceStore } = require('./workspace-store');

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

function sourceSummary(fetched, at = Date.now()) {
  if (!fetched || !fetched.corpus) return null;
  const corpus = fetched.corpus;
  const storedAt = text(fetched.cache && fetched.cache.storedAt, 80);
  const storedAtMs = Date.parse(storedAt || corpus.fetchedAt || '');
  const expiresAt = Number(fetched.cache && fetched.cache.expiresAt) || null;
  const cacheState = expiresAt && expiresAt <= Number(at)
    ? 'stale'
    : text(fetched.cache && fetched.cache.state, 40);
  return {
    available: true,
    subreddit: text(corpus.subreddit, 30),
    fetchedAt: text(corpus.fetchedAt, 80),
    window: clone(corpus.window || {}),
    posts: Array.isArray(corpus.posts) ? corpus.posts.length : 0,
    comments: Array.isArray(corpus.comments) ? corpus.comments.length : 0,
    provider: text(corpus.provenance && corpus.provenance.provider, 80),
    complete: corpus.provenance ? corpus.provenance.complete === true : true,
    warnings: Array.isArray(corpus.warnings) ? corpus.warnings.map((warning) => text(warning, 500)).filter(Boolean) : [],
    cache: {
      key: text(fetched.cache && fetched.cache.key, 200),
      hit: fetched.cache && fetched.cache.hit === true,
      state: cacheState,
      reused: text(fetched.cache && fetched.cache.reused, 40),
      storedAt,
      expiresAt,
      ageMs: Number.isFinite(storedAtMs) ? Math.max(0, Number(at) - storedAtMs) : null,
    },
  };
}

function publicSession(session, at = Date.now()) {
  const liveSource = sourceSummary(session.fetched, at);
  const source = liveSource || clone(session.sourceSnapshot);
  if (source && !liveSource) source.available = false;
  const sourceStatus = clone(session.sourceStatus || { state: source ? 'missing' : 'none', message: '' });
  if (source && source.available !== false && source.cache && source.cache.state === 'stale') {
    sourceStatus.state = 'stale';
    sourceStatus.message = 'The saved source sample is past its freshness window. It remains reviewable and was not fetched automatically.';
  }
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    input: clone(session.input),
    task: clone(session.task),
    source,
    sourceStatus,
    analysis: clone(session.analysed && session.analysed.analysis),
    analysisProvider: clone(session.analysed && session.analysed.provider),
    review: clone(session.review),
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
    cacheOnly: input.cacheOnly === true,
  };
}

function buildImportResult(session, generated, now) {
  const corpus = session.fetched.corpus;
  const analysisId = text(session.analysed.analysis && session.analysed.analysis.id, 160);
  const provenance = {
    schemaVersion: 1,
    importer: 'subreddit-culture-importer',
    sourceAdapter: text(session.sourceId || 'fetchlayer-reddit', 80),
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

function persistedSession(session, at) {
  return {
    id: session.id,
    owner: session.owner,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    input: clone(session.input),
    sourceId: session.sourceId,
    populationConfiguration: clone(session.populationConfiguration),
    sourceRef: session.fetched && session.fetched.cache && session.fetched.cache.key
      ? { key: text(session.fetched.cache.key, 200) }
      : clone(session.sourceRef),
    sourceSnapshot: sourceSummary(session.fetched, at) || clone(session.sourceSnapshot),
    sourceStatus: clone(session.sourceStatus),
    analysed: session.analysed ? {
      analysis: clone(session.analysed.analysis),
      provider: clone(session.analysed.provider),
    } : null,
    importResult: clone(session.importResult),
    review: clone(session.review),
    staging: clone(session.staging),
    task: clone(session.task),
  };
}

function interruptedTask(task) {
  if (!task || !['running', 'cancelling'].includes(task.state)) return clone(task);
  return {
    phase: text(task.phase, 40),
    state: 'failed',
    progress: clone(task.progress),
    error: {
      code: 'IMPORT_ACTION_INTERRUPTED',
      phase: text(task.phase, 40),
      message: 'The importer backend restarted before this action completed. Saved completed work was preserved; run the action again explicitly if needed.',
      retryable: false,
    },
  };
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
  const workspaceStore = options.persistence === false
    ? null
    : (options.workspaceStore || createFileCultureWorkspaceStore({ file: options.workspaceFile }));

  function persist() {
    if (!workspaceStore) return;
    workspaceStore.save([...sessions.values()].map((session) => persistedSession(session, now())));
  }

  function hydrate(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const id = text(snapshot.id, 200);
    const owner = text(snapshot.owner, 160);
    const createdAt = text(snapshot.createdAt, 80);
    const updatedAt = text(snapshot.updatedAt, 80);
    if (!id || !owner || !Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) return null;
    const session = {
      id,
      owner,
      createdAt,
      updatedAt,
      input: normalizedInput(snapshot.input),
      sourceId: text(snapshot.sourceId || importer.source && importer.source.id, 80),
      populationConfiguration: clone(snapshot.populationConfiguration),
      sourceRef: snapshot.sourceRef && snapshot.sourceRef.key
        ? { key: text(snapshot.sourceRef.key, 200) }
        : null,
      sourceSnapshot: clone(snapshot.sourceSnapshot),
      sourceStatus: clone(snapshot.sourceStatus),
      fetched: null,
      analysed: clone(snapshot.analysed),
      importResult: clone(snapshot.importResult),
      review: clone(snapshot.review),
      staging: clone(snapshot.staging),
      task: interruptedTask(snapshot.task),
      controller: null,
      pending: null,
    };
    const cache = importer.source && importer.source.cache;
    if (session.sourceRef && cache && typeof cache.get === 'function') {
      const cached = cache.get(session.sourceRef.key, { allowExpired: true });
      if (cached.hit) {
        session.fetched = {
          corpus: cached.value,
          cache: { ...cached, value: undefined, reused: 'workspace' },
        };
        session.sourceSnapshot = sourceSummary(session.fetched, now());
        session.sourceStatus = {
          state: cached.state === 'stale' ? 'stale' : 'available',
          message: cached.state === 'stale'
            ? 'The saved source sample is past its freshness window. It was restored without fetching; use Refresh source sample only if fresh data is required.'
            : 'Saved source sample restored from the private cache without an upstream request.',
        };
      } else {
        session.sourceStatus = {
          state: cached.state === 'miss' ? 'missing' : (cached.state || 'missing'),
          message: 'The saved source reference is no longer available. No retrieval was started.',
        };
      }
    } else if (session.sourceSnapshot) {
      session.sourceStatus = {
        state: 'missing',
        message: 'The saved source reference is no longer available. No retrieval was started.',
      };
    }
    return session;
  }

  if (workspaceStore) {
    const loaded = workspaceStore.load();
    for (const snapshot of loaded.sessions || []) {
      const session = hydrate(snapshot);
      if (session) sessions.set(session.id, session);
    }
  }

  function prune() {
    const cutoff = Number(now()) - SESSION_TTL_MS;
    let changed = false;
    for (const [id, session] of sessions) {
      if (Date.parse(session.updatedAt) < cutoff && (!session.controller || session.controller.signal.aborted)) {
        sessions.delete(id);
        changed = true;
      }
    }
    if (changed) persist();
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
    persist();
    const runtime = {
      signal: controller.signal,
      refresh: session.input.refresh === true,
      cacheOnly: session.input.cacheOnly === true,
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
        persist();
        return result;
      })
      .catch((error) => {
        session.task.state = error && (error.name === 'AbortError' || error.code === 'IMPORT_CANCELLED') ? 'cancelled' : 'failed';
        session.task.error = publicError(error);
        if (phase === 'fetch' && error && error.code === 'FETCHLAYER_CACHE_MISS') {
          session.sourceStatus = {
            state: 'missing',
            message: 'No compatible saved source sample is available. Nothing was retrieved; use Retrieve fresh source sample to make an explicit upstream request.',
          };
        }
        session.updatedAt = new Date(Number(now())).toISOString();
        persist();
      })
      .finally(() => {
        session.controller = null;
        session.pending = null;
      });
    return publicSession(session, now());
  }

  function newSession(ownerId, input = {}) {
    const createdAt = new Date(Number(now())).toISOString();
    return {
      id: makeId(),
      owner: ownerId,
      createdAt,
      updatedAt: createdAt,
      input: normalizedInput(input),
      sourceId: importer.source && importer.source.id,
      populationConfiguration: clone(input.populationConfiguration),
      sourceRef: null,
      sourceSnapshot: null,
      sourceStatus: { state: 'none', message: '' },
      fetched: null,
      analysed: null,
      importResult: null,
      review: null,
      staging: null,
      task: null,
      controller: null,
      pending: null,
    };
  }

  function restore(owner) {
    prune();
    const ownerId = ownerKey(owner);
    const existing = [...sessions.values()].filter((session) => session.owner === ownerId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (existing) return publicSession(existing, now());

    const mayRecoverUnownedCache = ownerId === 'desktop' || options.recoverUnownedCache === true;
    const recover = mayRecoverUnownedCache && importer.source && typeof importer.source.recoverLatestCorpus === 'function'
      ? importer.source.recoverLatestCorpus()
      : { found: false, state: 'unsupported' };
    const recoveredInput = recover.found ? {
      subreddit: recover.input && recover.input.subreddit || recover.corpus.subreddit,
      maxPosts: recover.input && recover.input.maxPosts || recover.corpus.posts.length,
      maxComments: recover.input && recover.input.maxComments || recover.corpus.comments.length,
      since: recover.input && recover.input.sinceMs != null
        ? new Date(Number(recover.input.sinceMs)).toISOString()
        : recover.corpus.window && recover.corpus.window.since || '',
      until: recover.input && recover.input.untilMs != null
        ? new Date(Number(recover.input.untilMs)).toISOString()
        : recover.corpus.window && recover.corpus.window.until || '',
    } : { subreddit: '', maxPosts: 100, maxComments: 600 };
    const session = newSession(ownerId, recoveredInput);
    if (recover.found) {
      session.fetched = { corpus: recover.corpus, cache: recover.cache };
      session.sourceRef = recover.cache && recover.cache.key ? { key: recover.cache.key } : null;
      session.sourceSnapshot = sourceSummary(session.fetched, now());
      session.sourceStatus = {
        state: recover.cache && recover.cache.state === 'stale' ? 'stale' : 'available',
        message: recover.cache && recover.cache.state === 'stale'
          ? 'Recovered an expired saved source sample without fetching. Use Refresh source sample only if fresh data is required.'
          : 'Recovered the latest saved source sample without an upstream request.',
      };
      session.task = {
        phase: 'restore',
        state: 'completed',
        progress: { phase: 'restore', state: 'completed', current: 1, total: 1, message: 'Saved source sample restored.' },
        error: null,
      };
    } else {
      session.sourceStatus = {
        state: 'missing',
        message: 'No saved source sample is available. No retrieval was started.',
      };
    }
    sessions.set(session.id, session);
    persist();
    return publicSession(session, now());
  }

  function create(owner, input = {}) {
    if (input && input.restore === true) return restore(owner);
    prune();
    const ownerId = ownerKey(owner);
    const ownerSessions = [...sessions.values()].filter((session) => session.owner === ownerId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    while (ownerSessions.length >= MAX_SESSIONS_PER_OWNER) {
      const old = ownerSessions.shift();
      if (old.controller) old.controller.abort();
      sessions.delete(old.id);
    }
    const session = newSession(ownerId, input);
    session.sourceStatus = { state: 'loading', message: 'Looking for a compatible saved source sample before retrieval.' };
    sessions.set(session.id, session);
    return setTask(session, 'fetch', async (runtime) => {
      const fetched = await importer.fetchCorpus(session.input, runtime);
      if (runtime.signal.aborted) throw abortError();
      session.fetched = fetched;
      session.sourceRef = fetched.cache && fetched.cache.key ? { key: fetched.cache.key } : null;
      session.sourceSnapshot = sourceSummary(fetched, now());
      session.sourceStatus = {
        state: fetched.cache && fetched.cache.state === 'stale' ? 'stale' : 'available',
        message: fetched.cache && fetched.cache.hit
          ? 'Saved source sample reused without an upstream request.'
          : 'Fresh source sample retrieved by explicit request and saved privately.',
      };
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
    session.review = {
      provider,
      model,
      count,
      targetCommunities: Array.isArray(input.targetCommunities) ? clone(input.targetCommunities) : [],
      contributorLabels: Array.isArray(input.contributorLabels) ? clone(input.contributorLabels) : [],
      archetypes: Array.isArray(input.archetypes) ? clone(input.archetypes) : [],
    };
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
      persist();
      return clone(session.staging);
    } catch (error) {
      session.staging = {
        ok: false,
        error: publicError(error),
        association: clone(error.association || null),
        results: clone(error.results || []),
      };
      session.updatedAt = new Date(Number(now())).toISOString();
      persist();
      throw error;
    }
  }

  function cancel(owner, id) {
    const session = get(id, owner);
    if (!session.controller || !session.task || !['running', 'cancelling'].includes(session.task.state)) {
      return publicSession(session, now());
    }
    session.task.state = 'cancelling';
    session.task.progress = {
      ...(session.task.progress || {}),
      state: 'cancelling',
      message: 'Cancellation requested.',
    };
    session.controller.abort();
    session.updatedAt = new Date(Number(now())).toISOString();
    persist();
    return publicSession(session, now());
  }

  return {
    create,
    restore,
    get(owner, id) { return publicSession(get(id, owner), now()); },
    analyse,
    generate,
    stage,
    cancel,
    async wait(owner, id) {
      const session = get(id, owner);
      if (session.pending) await session.pending;
      return publicSession(session, now());
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
