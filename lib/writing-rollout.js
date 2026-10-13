'use strict';

const RELEASED_VERSION = 1;
const CANARY_VERSION = 3;
const MAX_PROFILES = 3;

function defaults() { return { version: 1, profileIds: [] }; }

function validateProfileIds(profileIds) {
  if (!Array.isArray(profileIds) || profileIds.length > MAX_PROFILES ||
      Array.from(profileIds).some((id) => typeof id !== 'string' || id.length < 1 || id.length > 100 || /[^A-Za-z0-9_-]/.test(id)) ||
      new Set(profileIds).size !== profileIds.length) {
    const error = new Error('Provide up to ' + MAX_PROFILES + ' unique profile IDs using letters, numbers, underscores or hyphens (1-100 characters).');
    error.code = 'INVALID_WRITING_CANARY';
    throw error;
  }
  return profileIds.slice();
}

function normalize(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== 1 ||
      Object.keys(config).some((key) => key !== 'version' && key !== 'profileIds')) return defaults();
  try {
    return { version: 1, profileIds: validateProfileIds(config.profileIds) };
  } catch {
    // A malformed configuration must not partially enroll otherwise valid IDs.
    return defaults();
  }
}

function select(settings, profileId, options = {}) {
  if (!options || options.kind !== 'ordinary') return RELEASED_VERSION;
  return normalize(settings && settings.writingCanary).profileIds.includes(profileId)
    ? CANARY_VERSION : RELEASED_VERSION;
}

module.exports = { RELEASED_VERSION, CANARY_VERSION, MAX_PROFILES, defaults, validateProfileIds, normalize, select };
