'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CACHE_VERSION = 1;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function cacheKey(namespace, input) {
  const digest = crypto.createHash('sha256').update(stableJson(input)).digest('hex');
  return String(namespace || 'source').replace(/[^a-z0-9_-]+/gi, '-') + '-' + digest;
}

function defaultCacheDirectory() {
  const dataDir = process.env.FEDDIT_BOT_DATA_DIR
    ? path.resolve(process.env.FEDDIT_BOT_DATA_DIR)
    : path.resolve(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'culture-import-cache');
}

function createFileCorpusCache(options = {}) {
  const directory = path.resolve(options.directory || defaultCacheDirectory());
  const now = options.now || Date.now;
  const ttlMs = Math.max(60_000, Number(options.ttlMs) || DEFAULT_TTL_MS);

  function fileFor(key) {
    const clean = String(key || '').replace(/[^a-z0-9_-]+/gi, '-');
    if (!clean) throw new Error('A cache key is required.');
    return path.join(directory, clean + '.json');
  }

  function get(key, opts = {}) {
    const file = fileFor(key);
    try {
      const wrapper = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!wrapper || wrapper.version !== CACHE_VERSION || wrapper.key !== key || !wrapper.value) {
        return { hit: false, state: 'invalid', key, file };
      }
      const at = Number(now());
      const expired = !Number.isFinite(Number(wrapper.expiresAt)) || Number(wrapper.expiresAt) <= at;
      if (expired && opts.allowExpired !== true) {
        return {
          hit: false, state: 'expired', key, file,
          storedAt: wrapper.storedAt, expiresAt: wrapper.expiresAt,
        };
      }
      return {
        hit: true, state: expired ? 'stale' : 'fresh', key, file,
        storedAt: wrapper.storedAt, expiresAt: wrapper.expiresAt,
        value: structuredClone(wrapper.value),
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { hit: false, state: 'miss', key, file };
      return { hit: false, state: 'invalid', key, file, error: String(error.message || error) };
    }
  }

  function set(key, value, opts = {}) {
    fs.mkdirSync(directory, { recursive: true });
    const storedAtMs = Number(now());
    const expiresAtMs = storedAtMs + Math.max(60_000, Number(opts.ttlMs) || ttlMs);
    const file = fileFor(key);
    const temporary = file + '.' + process.pid + '.tmp';
    const wrapper = {
      version: CACHE_VERSION,
      key,
      storedAt: new Date(storedAtMs).toISOString(),
      expiresAt: expiresAtMs,
      value,
    };
    fs.writeFileSync(temporary, JSON.stringify(wrapper, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch { /* best effort on Windows */ }
    fs.renameSync(temporary, file);
    return {
      hit: false, state: 'stored', key, file,
      storedAt: wrapper.storedAt, expiresAt: expiresAtMs,
    };
  }

  return { directory, ttlMs, get, set };
}

module.exports = {
  CACHE_VERSION,
  DEFAULT_TTL_MS,
  stableJson,
  cacheKey,
  defaultCacheDirectory,
  createFileCorpusCache,
};
