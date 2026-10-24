'use strict';

// The canary boundary is independent of the frozen theme-interest algorithm.
const VERSION = 1;
const LIMITS = Object.freeze({ communities: 8, configChars: 512 });
const community = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ? value : '';

function failure(code) {
  const error = new Error(code === 'THEME_SCOPE_CONFIG'
    ? 'Invalid theme-interest community configuration.' : 'Unsupported theme-interest scope.');
  error.code = code;
  return error;
}

function parseConfig(value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string' || value.length > LIMITS.configChars) throw failure('THEME_SCOPE_CONFIG');
  if (!value.trim()) return [];
  const names = value.split(',').map(name => name.trim().toLowerCase());
  if (names.length > LIMITS.communities || names.some(name => !community(name)) || new Set(names).size !== names.length) {
    throw failure('THEME_SCOPE_CONFIG');
  }
  return names;
}

function normalizeScope(raw) {
  // Absent scope belongs only to already-frozen, unscoped v1 operations.
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION ||
      Object.keys(raw).some(name => !['version', 'communities'].includes(name)) ||
      !Array.isArray(raw.communities) || !raw.communities.length || raw.communities.length > LIMITS.communities ||
      raw.communities.some(name => !community(name)) || new Set(raw.communities).size !== raw.communities.length) {
    throw failure('UNSUPPORTED_THEME_SCOPE');
  }
  return Object.freeze({ version: VERSION, communities: Object.freeze(raw.communities.slice()) });
}

function allows(raw, name) {
  const scope = normalizeScope(raw);
  return scope === null || !!community(name) && scope.communities.includes(name);
}

module.exports = { VERSION, LIMITS, parseConfig, normalizeScope, allows };
