'use strict';

// Secret store: data/secrets.json holds the shared DeepSeek API key and each
// profile's Feddit bearer token. Kept OUT of profiles.json and the git repo
// (data/ is gitignored). Secrets are:
//   - written atomically (temp file + rename), like the profile store, so a
//     crash mid-write can't corrupt it;
//   - written owner-only (0600) where the OS honours it, so other local users
//     can't read it;
//   - NEVER returned in full by any read endpoint (see redact()) and NEVER
//     logged.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.FEDDIT_BOT_DATA_DIR
  ? path.resolve(process.env.FEDDIT_BOT_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function empty() {
  return {
    schemaVersion: 2,
    deepseekApiKey: '',
    workerApiKey: '',
    fedditTokens: {},
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = normalize(parsed);
  } catch (err) {
    if (err && err.code === 'ENOENT') cache = empty();
    else throw new Error('Failed to read ' + SECRETS_FILE + ': ' + err.message);
  }
  return cache;
}

function normalize(parsed) {
  const input = parsed && typeof parsed === 'object' ? parsed : {};
  const tokens = input.fedditTokens && typeof input.fedditTokens === 'object' && !Array.isArray(input.fedditTokens)
    ? input.fedditTokens
    : {};
  return {
    ...empty(),
    ...input,
    schemaVersion: 2,
    fedditTokens: { ...tokens },
  };
}

function save(data) {
  ensureDir();
  const tmp = SECRETS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort on filesystems without POSIX perms */ }
  fs.renameSync(tmp, SECRETS_FILE);
  cache = data;
}

// ---- deepseek key -----------------------------------------------------------

function getDeepseekKey() {
  return load().deepseekApiKey || '';
}

function setDeepseekKey(key) {
  const data = { ...load() };
  data.deepseekApiKey = String(key || '');
  save(data);
  return data.deepseekApiKey;
}

function clearDeepseekKey() {
  return setDeepseekKey('');
}

function getWorkerKey() {
  return String(process.env.FEDDIT_WORKER_KEY || load().workerApiKey || '');
}

function setWorkerKey(key) {
  const data = normalize(load());
  data.workerApiKey = String(key || '');
  save(data);
  return data.workerApiKey;
}

// ---- per-profile Feddit bearer tokens --------------------------------------

function getFedditToken(profileId) {
  const id = String(profileId || '');
  if (!id) return '';
  return String((load().fedditTokens || {})[id] || '');
}

function setFedditToken(profileId, token) {
  const id = String(profileId || '');
  if (!id) throw new Error('A profile id is required to store a Feddit token.');
  const data = normalize(load());
  const value = String(token || '');
  if (value) data.fedditTokens[id] = value;
  else delete data.fedditTokens[id];
  save(data);
  return value;
}

function deleteFedditToken(profileId) {
  return setFedditToken(profileId, '');
}

// Import tokens extracted from a legacy profiles.json. Existing protected
// values win so re-running a migration can never overwrite a newer token.
function importFedditTokens(tokens) {
  const incoming = tokens && typeof tokens === 'object' ? tokens : {};
  const data = normalize(load());
  let imported = 0;
  for (const [profileId, rawToken] of Object.entries(incoming)) {
    const id = String(profileId || '');
    const token = String(rawToken || '');
    if (!id || !token || data.fedditTokens[id]) continue;
    data.fedditTokens[id] = token;
    imported++;
  }
  if (imported) save(data);
  return imported;
}

// A safe, non-reversible preview: never reveals enough to use the key. Shows
// only the last 4 chars so a human can tell WHICH key is stored.
function redact(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 4) return '****';
  return 'sk-...' + k.slice(-4);
}

// Everything a read endpoint may expose about the key: presence + a redacted
// preview. The raw key is never part of this.
function publicView() {
  const key = getDeepseekKey();
  return { hasKey: Boolean(key), redacted: redact(key) };
}

module.exports = {
  DATA_DIR,
  SECRETS_FILE,
  empty,
  normalize,
  getDeepseekKey,
  setDeepseekKey,
  clearDeepseekKey,
  getWorkerKey,
  setWorkerKey,
  getFedditToken,
  setFedditToken,
  deleteFedditToken,
  importFedditTokens,
  redact,
  publicView,
};
