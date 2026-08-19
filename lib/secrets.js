'use strict';

// Secret store: data/secrets.json holds the ONE DeepSeek API key shared by all
// deepseek profiles. Kept OUT of profiles.json and the git repo (data/ is
// gitignored). The key is:
//   - written atomically (temp file + rename), like the profile store, so a
//     crash mid-write can't corrupt it;
//   - written owner-only (0600) where the OS honours it, so other local users
//     can't read it;
//   - NEVER returned in full by any read endpoint (see redact()) and NEVER
//     logged.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function empty() {
  return { deepseekApiKey: '' };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = { ...empty(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (err) {
    if (err && err.code === 'ENOENT') cache = empty();
    else throw new Error('Failed to read ' + SECRETS_FILE + ': ' + err.message);
  }
  return cache;
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
  SECRETS_FILE,
  getDeepseekKey,
  setDeepseekKey,
  clearDeepseekKey,
  redact,
  publicView,
};
