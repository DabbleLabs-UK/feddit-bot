'use strict';

const crypto = require('node:crypto');
const population = require('../population');

const EXTERNAL_STAGE_PATH = '/api/population/external-seeds/stage';
const COMPACT_SEED_FIELDS = Object.freeze([
  'username', 'biography', 'temperament', 'interests', 'dislikes',
  'conversationalStyle', 'humourStyle', 'curiosity', 'disagreementStyle',
  'sociability', 'initiative', 'breadth', 'fictionalBackground', 'values',
  'persistence', 'noveltySeeking', 'toneNotes', 'communities',
]);

class CultureStagingError extends Error {
  constructor(message, code = 'CULTURE_STAGING_FAILED', options = {}) {
    super(String(message || 'The culture candidate staging action failed.'));
    this.name = 'CultureStagingError';
    this.code = String(code || 'CULTURE_STAGING_FAILED');
    this.statusCode = Number(options.statusCode) || 422;
    this.results = Array.isArray(options.results) ? options.results : [];
    this.association = options.association || null;
    if (options.cause) this.cause = options.cause;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function importCandidates(importResult) {
  if (!importResult || typeof importResult !== 'object' || Array.isArray(importResult)) {
    throw new CultureStagingError(
      'A completed culture import result is required.',
      'INVALID_IMPORT_RESULT',
    );
  }
  if (Array.isArray(importResult.candidates) && importResult.candidates.length) {
    return importResult.candidates.map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || !candidate.seed) {
        throw new CultureStagingError(
          'Culture candidate ' + index + ' does not contain a population seed.',
          'INVALID_IMPORT_RESULT',
        );
      }
      return candidate;
    });
  }
  if (Array.isArray(importResult.populationSeeds) && importResult.populationSeeds.length) {
    return importResult.populationSeeds.map((seed) => ({ seed }));
  }
  throw new CultureStagingError(
    'The culture import result does not contain reviewable candidates.',
    'INVALID_IMPORT_RESULT',
  );
}

function candidateIdentifier(importResult, candidate) {
  const provenance = importResult.provenance && typeof importResult.provenance === 'object'
    ? importResult.provenance
    : {};
  const identity = {
    source: provenance.importer || 'subreddit-culture-importer',
    reference: provenance.analysisId || '',
    seed: candidate.seed,
  };
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(canonical(identity)))
    .digest('hex')
    .slice(0, 20);
  return 'culture_candidate_' + digest;
}

function compactPopulationSeed(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const seed = {};
  for (const field of COMPACT_SEED_FIELDS) {
    if (Object.hasOwn(source, field)) seed[field] = clone(source[field]);
  }
  if (source.abilities && typeof source.abilities === 'object' && !Array.isArray(source.abilities)) {
    seed.abilities = {};
    for (const field of ['reply', 'discuss', 'links']) {
      if (Object.hasOwn(source.abilities, field)) seed.abilities[field] = source.abilities[field];
    }
  }
  return seed;
}

function reviewCultureCandidates(importResult) {
  return importCandidates(importResult).map((candidate, index) => ({
    id: candidateIdentifier(importResult, candidate),
    index,
    seed: clone(candidate.seed),
    importerMetadata: clone(candidate.importerMetadata || {}),
  }));
}

function requestedSelection(selection) {
  if (Array.isArray(selection)) return selection;
  if (selection && Array.isArray(selection.candidateIds)) return selection.candidateIds;
  if (selection && Array.isArray(selection.indexes)) return selection.indexes;
  return [];
}

function resolveSelection(importResult, selection) {
  const review = reviewCultureCandidates(importResult);
  const requested = requestedSelection(selection);
  if (!requested.length) {
    throw new CultureStagingError(
      'Select at least one culture candidate to stage.',
      'INVALID_CANDIDATE_SELECTION',
    );
  }
  if (requested.length > population.MAX_COHORT_SIZE) {
    throw new CultureStagingError(
      'A staging selection is limited to ' + population.MAX_COHORT_SIZE + ' candidates and is never split automatically.',
      'EXTERNAL_COHORT_CAPACITY_EXCEEDED',
      {
        statusCode: 409,
        results: requested.map((value, index) => {
          const numeric = typeof value === 'number' || /^\d+$/.test(String(value).trim());
          const candidate = numeric
            ? review[Number(value)]
            : review.find((item) => item.id === String(value).trim());
          return {
            index,
            ok: false,
            code: 'COHORT_CAPACITY_EXCEEDED',
            message: 'This selection was not staged because it exceeds the cohort size limit.',
            requested: String(value),
            ...(candidate ? {
              importerCandidateId: candidate.id,
              importerCandidateIndex: candidate.index,
            } : {}),
          };
        }),
      },
    );
  }

  const selected = [];
  const seen = new Set();
  for (const value of requested) {
    const numeric = typeof value === 'number' || /^\d+$/.test(String(value).trim());
    const candidate = numeric
      ? review[Number(value)]
      : review.find((item) => item.id === String(value).trim());
    if (!candidate) {
      throw new CultureStagingError(
        'The selected culture candidate was not found: ' + String(value),
        'UNKNOWN_CANDIDATE',
      );
    }
    if (seen.has(candidate.id)) {
      throw new CultureStagingError(
        'The same culture candidate cannot be selected more than once: ' + candidate.id,
        'DUPLICATE_CANDIDATE_SELECTION',
      );
    }
    seen.add(candidate.id);
    selected.push(candidate);
  }
  return selected;
}

function buildExternalSeedStagingRequest(importResult, selection) {
  const selected = resolveSelection(importResult, selection);
  const provenance = importResult.provenance && typeof importResult.provenance === 'object'
    ? importResult.provenance
    : {};
  const request = {
    populationSeeds: selected.map((candidate) => compactPopulationSeed(candidate.seed)),
    provenance: {
      source: String(provenance.importer || 'subreddit-culture-importer'),
      ...(provenance.analysisId ? { reference: String(provenance.analysisId) } : {}),
    },
  };
  if (importResult.stagingDefaults && importResult.stagingDefaults.configuration) {
    request.configuration = clone(importResult.stagingDefaults.configuration);
  }
  return { request, selected };
}

function importerSelection(selected) {
  return selected.map((candidate, index) => ({
    index,
    importerCandidateId: candidate.id,
    importerCandidateIndex: candidate.index,
  }));
}

function correlateResults(results, selected) {
  const byIndex = new Map((Array.isArray(results) ? results : []).map((result) => [Number(result.index), result]));
  return selected.map((candidate, index) => {
    const result = byIndex.get(index);
    return {
      ...(result || {
        index,
        ok: false,
        code: 'MISSING_STAGE_RESULT',
        message: 'The staging boundary did not return a result for this seed.',
      }),
      index,
      importerCandidateId: candidate.id,
      importerCandidateIndex: candidate.index,
    };
  });
}

function correlateOutcome(outcome, selected) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new CultureStagingError(
      'The external staging boundary returned an invalid result.',
      'INVALID_STAGE_RESULT',
    );
  }
  return {
    ...outcome,
    importerSelection: importerSelection(selected),
    results: correlateResults(outcome.results, selected),
  };
}

function createCultureStagingBridge(options = {}) {
  const controller = options.populationController;
  const stageExternalSeeds = options.stageExternalSeeds ||
    (controller && typeof controller.stageExternalSeeds === 'function'
      ? controller.stageExternalSeeds.bind(controller)
      : null);

  return {
    review: reviewCultureCandidates,
    buildRequest: buildExternalSeedStagingRequest,
    async stage(importResult, selection) {
      if (typeof stageExternalSeeds !== 'function') {
        throw new CultureStagingError(
          'No external population staging boundary was configured.',
          'STAGING_BOUNDARY_REQUIRED',
        );
      }
      const prepared = buildExternalSeedStagingRequest(importResult, selection);
      try {
        const outcome = await stageExternalSeeds(prepared.request);
        return correlateOutcome(outcome, prepared.selected);
      } catch (error) {
        if (error && Array.isArray(error.results)) {
          error.results = correlateResults(error.results, prepared.selected);
          error.importerSelection = importerSelection(prepared.selected);
        }
        throw error;
      }
    },
  };
}

function createExternalSeedHttpStager(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new CultureStagingError('An HTTP fetch implementation is required.', 'HTTP_STAGER_UNAVAILABLE', {
      statusCode: 500,
    });
  }
  const ownerToken = String(options.ownerToken || '').trim();
  if (!ownerToken) {
    throw new CultureStagingError(
      'The existing population operator capability is required for staging.',
      'POPULATION_OPERATOR_CAPABILITY_REQUIRED',
      { statusCode: 401 },
    );
  }
  let endpoint;
  try {
    endpoint = new URL(EXTERNAL_STAGE_PATH, String(options.serverUrl || '')).toString();
  } catch (cause) {
    throw new CultureStagingError('A valid Feddit bot server URL is required.', 'INVALID_STAGE_SERVER_URL', {
      cause,
    });
  }

  return async function stageExternalSeeds(input) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Feddit-Bot-Owner': ownerToken,
        },
        body: JSON.stringify(input),
      });
    } catch (cause) {
      throw new CultureStagingError(
        'The external population staging request failed: ' + cause.message,
        'EXTERNAL_SEED_STAGE_REQUEST_FAILED',
        { statusCode: 503, cause },
      );
    }

    let body;
    try {
      const raw = await response.text();
      body = raw ? JSON.parse(raw) : {};
    } catch (cause) {
      throw new CultureStagingError(
        'The external population staging endpoint returned invalid JSON.',
        'INVALID_STAGE_RESPONSE',
        { statusCode: Number(response.status) || 502, cause },
      );
    }
    if (!response.ok) {
      throw new CultureStagingError(
        body && body.error && body.error.message || 'External population staging was rejected.',
        body && body.error && body.error.code || 'EXTERNAL_SEED_STAGE_REJECTED',
        {
          statusCode: Number(response.status) || 422,
          association: body && body.association,
          results: body && body.results,
        },
      );
    }
    return body;
  };
}

module.exports = {
  EXTERNAL_STAGE_PATH,
  COMPACT_SEED_FIELDS,
  CultureStagingError,
  candidateIdentifier,
  compactPopulationSeed,
  reviewCultureCandidates,
  resolveSelection,
  buildExternalSeedStagingRequest,
  correlateResults,
  createCultureStagingBridge,
  createExternalSeedHttpStager,
};
