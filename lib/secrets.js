'use strict';

// Secret store: data/secrets.json holds local service credentials, including
// the shared DeepSeek and FetchLayer API keys, and each profile's Feddit bearer
// token. A token being handed to another runner is staged here too, never in
// profiles.json. Kept OUT of the git repo
// (data/ is gitignored). Secrets are:
//   - written atomically (temp file + rename), like the profile store, so a
//     crash mid-write can't corrupt it;
//   - written owner-only (0600) where the OS honours it, so other local users
//     can't read it;
//   - NEVER returned in full by any read endpoint (see redact()) and NEVER
//     logged.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
    schemaVersion: 5,
    deepseekApiKey: '',
    fetchLayerApiKey: '',
    workerApiKey: '',
    fedditTokens: {},
    handoverFedditTokens: {},
    chatgptPlan: {
      hostId: '',
      activeRegistrationId: '',
      registrations: {},
    },
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
  const rawHandovers = input.handoverFedditTokens && typeof input.handoverFedditTokens === 'object'
    && !Array.isArray(input.handoverFedditTokens)
    ? input.handoverFedditTokens
    : {};
  const handovers = {};
  for (const [profileId, raw] of Object.entries(rawHandovers)) {
    const entry = raw && typeof raw === 'object' ? raw : { token: raw, status: 'ready' };
    const token = String(entry.token || '');
    if (!profileId || !token) continue;
    handovers[profileId] = {
      token,
      status: entry.status === 'ready' ? 'ready' : 'staged',
      createdAt: String(entry.createdAt || ''),
    };
  }
  const rawChatgpt = input.chatgptPlan && typeof input.chatgptPlan === 'object'
    ? input.chatgptPlan
    : {};
  const rawRegistrations = rawChatgpt.registrations && typeof rawChatgpt.registrations === 'object'
    && !Array.isArray(rawChatgpt.registrations)
    ? rawChatgpt.registrations
    : {};
  const registrations = {};
  for (const [registrationId, raw] of Object.entries(rawRegistrations)) {
    if (!registrationId || !raw || typeof raw !== 'object') continue;
    const clientId = String(raw.clientId || '');
    const refreshToken = String(raw.refreshToken || '');
    const accessToken = String(raw.accessToken || '');
    if (!clientId || (!refreshToken && !accessToken)) continue;
    registrations[registrationId] = {
      clientId,
      subject: String(raw.subject || ''),
      email: String(raw.email || ''),
      name: String(raw.name || ''),
      accessToken,
      refreshToken,
      idToken: String(raw.idToken || ''),
      expiresAt: Math.max(0, Number(raw.expiresAt) || 0),
      scopes: Array.isArray(raw.scopes) ? raw.scopes.map(String) : String(raw.scopes || '').split(/\s+/).filter(Boolean),
      models: Array.isArray(raw.models) ? raw.models.map((model) => ({
        id: String(model && (model.id || model.slug) || ''),
        label: String(model && (model.label || model.display_name || model.id || model.slug) || ''),
      })).filter((model) => model.id) : [],
      createdAt: String(raw.createdAt || ''),
      updatedAt: String(raw.updatedAt || ''),
    };
  }
  const activeRegistrationId = registrations[String(rawChatgpt.activeRegistrationId || '')]
    ? String(rawChatgpt.activeRegistrationId)
    : '';
  return {
    ...empty(),
    ...input,
    schemaVersion: 5,
    fetchLayerApiKey: String(input.fetchLayerApiKey || ''),
    fedditTokens: { ...tokens },
    handoverFedditTokens: handovers,
    chatgptPlan: {
      hostId: String(rawChatgpt.hostId || ''),
      activeRegistrationId,
      registrations,
    },
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

// ---- FetchLayer source key -------------------------------------------------

function getFetchLayerKey() {
  return load().fetchLayerApiKey || '';
}

function setFetchLayerKey(key) {
  const data = normalize(load());
  data.fetchLayerApiKey = String(key || '');
  save(data);
  return data.fetchLayerApiKey;
}

function clearFetchLayerKey() {
  return setFetchLayerKey('');
}

function publicFetchLayerView() {
  return { hasKey: Boolean(getFetchLayerKey()) };
}

// ---- ChatGPT plan OAuth registrations --------------------------------------

function ensureChatgptHostId() {
  const data = normalize(load());
  if (!data.chatgptPlan.hostId) {
    data.chatgptPlan.hostId = 'urn:uuid:' + crypto.randomUUID();
    save(data);
  }
  return data.chatgptPlan.hostId;
}

function getChatgptPlan() {
  const value = normalize(load()).chatgptPlan;
  return {
    hostId: value.hostId,
    activeRegistrationId: value.activeRegistrationId,
    registrations: Object.fromEntries(Object.entries(value.registrations).map(([id, registration]) => [id, { ...registration }])),
  };
}

function getActiveChatgptRegistration() {
  const plan = getChatgptPlan();
  const registration = plan.registrations[plan.activeRegistrationId];
  return registration ? { id: plan.activeRegistrationId, ...registration } : null;
}

function saveChatgptRegistration(registrationId, registration, makeActive = true) {
  const id = String(registrationId || '');
  if (!id) throw new Error('A ChatGPT registration id is required.');
  const data = normalize(load());
  const existing = data.chatgptPlan.registrations[id] || {};
  data.chatgptPlan.registrations[id] = {
    ...existing,
    ...registration,
    clientId: String(registration.clientId || existing.clientId || ''),
    subject: String(registration.subject || existing.subject || ''),
    email: String(registration.email || existing.email || ''),
    name: String(registration.name || existing.name || ''),
    accessToken: String(registration.accessToken || existing.accessToken || ''),
    refreshToken: String(registration.refreshToken || existing.refreshToken || ''),
    idToken: String(registration.idToken || existing.idToken || ''),
    expiresAt: Math.max(0, Number(registration.expiresAt != null ? registration.expiresAt : existing.expiresAt) || 0),
    scopes: Array.isArray(registration.scopes) ? registration.scopes.map(String) : (existing.scopes || []),
    models: Array.isArray(registration.models) ? registration.models.map((model) => ({
      id: String(model.id || ''), label: String(model.label || model.id || ''),
    })).filter((model) => model.id) : (existing.models || []),
    createdAt: String(existing.createdAt || registration.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
  if (!data.chatgptPlan.registrations[id].clientId) {
    throw new Error('A ChatGPT OAuth client id is required.');
  }
  if (makeActive) data.chatgptPlan.activeRegistrationId = id;
  save(data);
  return { id, ...data.chatgptPlan.registrations[id] };
}

function setActiveChatgptRegistration(registrationId) {
  const id = String(registrationId || '');
  const data = normalize(load());
  if (id && !data.chatgptPlan.registrations[id]) throw new Error('No such ChatGPT account registration.');
  data.chatgptPlan.activeRegistrationId = id;
  save(data);
  return id;
}

function deleteChatgptRegistration(registrationId) {
  const id = String(registrationId || '');
  const data = normalize(load());
  if (!id || !data.chatgptPlan.registrations[id]) return false;
  delete data.chatgptPlan.registrations[id];
  if (data.chatgptPlan.activeRegistrationId === id) data.chatgptPlan.activeRegistrationId = '';
  save(data);
  return true;
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

// Stage a replacement before asking Feddit to rotate to it. The current token
// deliberately remains active until the server confirms the replacement (or a
// retry proves that it already took effect), so a dropped response cannot lose
// the identity.
function stageFedditHandover(profileId, token) {
  const id = String(profileId || '');
  const value = String(token || '');
  if (!id || !value) throw new Error('A profile id and replacement token are required for handover.');
  const data = normalize(load());
  const current = data.handoverFedditTokens[id];
  if (current && current.token !== value) {
    throw new Error('A different handover is already pending for this profile.');
  }
  data.handoverFedditTokens[id] = current || {
    token: value,
    status: 'staged',
    createdAt: new Date().toISOString(),
  };
  save(data);
  return { ...data.handoverFedditTokens[id] };
}

function getFedditHandover(profileId) {
  const id = String(profileId || '');
  const entry = id ? (load().handoverFedditTokens || {})[id] : null;
  return entry ? { ...entry } : null;
}

// Feddit now recognises the replacement. Removing the old active token and
// marking the staged copy ready happen in one atomic secrets-file write.
function markFedditHandoverReady(profileId, confirmedToken = '') {
  const id = String(profileId || '');
  const data = normalize(load());
  const entry = data.handoverFedditTokens[id];
  if (!entry || !entry.token) throw new Error('No staged handover exists for this profile.');
  const token = String(confirmedToken || entry.token);
  if (!/^feddit_[a-f0-9]{64}$/.test(token)) {
    throw new Error('Feddit did not confirm a valid replacement token.');
  }
  data.handoverFedditTokens[id] = {
    ...entry,
    token,
    status: 'ready',
  };
  delete data.fedditTokens[id];
  save(data);
  return { ...data.handoverFedditTokens[id] };
}

function completeFedditHandover(profileId) {
  const id = String(profileId || '');
  const data = normalize(load());
  if (!id || !data.handoverFedditTokens[id]) return false;
  delete data.handoverFedditTokens[id];
  save(data);
  return true;
}

function deleteProfileSecrets(profileId) {
  const id = String(profileId || '');
  const data = normalize(load());
  delete data.fedditTokens[id];
  delete data.handoverFedditTokens[id];
  save(data);
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

function publicChatgptView() {
  const plan = getChatgptPlan();
  return {
    connected: Boolean(plan.activeRegistrationId && plan.registrations[plan.activeRegistrationId]),
    activeRegistrationId: plan.activeRegistrationId,
    accounts: Object.entries(plan.registrations).map(([id, registration]) => ({
      id,
      email: registration.email,
      name: registration.name,
      models: registration.models,
      expiresAt: registration.expiresAt,
    })),
  };
}

module.exports = {
  DATA_DIR,
  SECRETS_FILE,
  empty,
  normalize,
  getDeepseekKey,
  setDeepseekKey,
  clearDeepseekKey,
  getFetchLayerKey,
  setFetchLayerKey,
  clearFetchLayerKey,
  publicFetchLayerView,
  ensureChatgptHostId,
  getChatgptPlan,
  getActiveChatgptRegistration,
  saveChatgptRegistration,
  setActiveChatgptRegistration,
  deleteChatgptRegistration,
  publicChatgptView,
  getWorkerKey,
  setWorkerKey,
  getFedditToken,
  setFedditToken,
  deleteFedditToken,
  stageFedditHandover,
  getFedditHandover,
  markFedditHandoverReady,
  completeFedditHandover,
  deleteProfileSecrets,
  importFedditTokens,
  redact,
  publicView,
};
