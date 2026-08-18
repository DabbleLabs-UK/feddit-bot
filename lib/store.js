'use strict';

// Persistence layer: data/profiles.json holds all bot profiles including
// their Feddit bearer tokens. This file is gitignored and created on first
// run. Writes are atomic (write tmp, rename over the real file) so a crash
// mid-write can never leave a truncated/corrupt JSON on the CIFS share.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'profiles.json');

// ---- shape / defaults -------------------------------------------------------

const DEFAULT_MODEL = 'hf.co/mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF:Q5_K_M';

// A single profile IS one registered Feddit bot identity. Feddit has no user
// accounts; registration returns a bearer token that authorises writes, so N
// profiles means N independent registrations, each with its own token.
function profileDefaults() {
  return {
    id: null,                 // assigned on create
    displayName: '',          // human-facing label in the UI
    fedditUsername: '',       // the username registered on Feddit
    token: '',                // bearer token (shown ONCE at register time)
    persona: '',              // system prompt describing who this bot is
    toneNotes: '',            // extra tone/style guidance appended to the system prompt
    readFeddits: [],          // sub-feddit names this bot reads
    postFeddits: [],          // sub-feddit names this bot posts/comments to
    mode: 'both',             // 'post' | 'comment' | 'both'
    postsPerHour: 0,          // cadence: submissions per hour
    commentsPerHour: 0,       // cadence: comments per hour
    model: DEFAULT_MODEL,     // ollama model; default reuses Cy's resident weights
    temperature: 0.8,
    numPredict: 200,          // keep small so we do not hog the single ollama slot
    enabled: false,           // scheduler (future) only acts on enabled profiles
    createdAt: null,
    activity: [],             // recent activity log entries (most-recent last)
  };
}

function emptyData() {
  return { profiles: [] };
}

// ---- id generation ----------------------------------------------------------

function newId() {
  // Short, url-safe, collision-resistant enough for a handful of profiles.
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ---- load / save ------------------------------------------------------------

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) throw new Error('bad shape');
    // Backfill any newly-added default fields onto older records.
    parsed.profiles = parsed.profiles.map((p) => ({ ...profileDefaults(), ...p }));
    cache = parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      cache = emptyData();
    } else {
      throw new Error('Failed to read ' + DATA_FILE + ': ' + err.message);
    }
  }
  return cache;
}

function save(data) {
  ensureDir();
  const tmp = DATA_FILE + '.tmp';
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, DATA_FILE); // atomic replace on the same filesystem
  cache = data;
}

// ---- profile CRUD -----------------------------------------------------------

function listProfiles() {
  return load().profiles;
}

function getProfile(id) {
  return load().profiles.find((p) => p.id === id) || null;
}

function createProfile(patch) {
  const data = load();
  const p = { ...profileDefaults(), ...(patch || {}) };
  p.id = newId();
  p.createdAt = new Date().toISOString();
  data.profiles.push(p);
  save(data);
  return p;
}

function updateProfile(id, patch) {
  const data = load();
  const idx = data.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  // id/createdAt are immutable; everything else can be patched.
  const merged = { ...data.profiles[idx], ...(patch || {}) };
  merged.id = data.profiles[idx].id;
  merged.createdAt = data.profiles[idx].createdAt;
  data.profiles[idx] = merged;
  save(data);
  return merged;
}

function deleteProfile(id) {
  const data = load();
  const before = data.profiles.length;
  data.profiles = data.profiles.filter((p) => p.id !== id);
  if (data.profiles.length === before) return false;
  save(data);
  return true;
}

// Append a bounded activity log entry to a profile.
function logActivity(id, entry) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  if (!Array.isArray(p.activity)) p.activity = [];
  p.activity.push({ at: new Date().toISOString(), ...entry });
  if (p.activity.length > 50) p.activity = p.activity.slice(-50);
  save(data);
  return p;
}

module.exports = {
  DATA_FILE,
  DEFAULT_MODEL,
  profileDefaults,
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  logActivity,
};
