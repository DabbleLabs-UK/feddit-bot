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
    enabled: false,           // scheduler only acts on enabled profiles
    createdAt: null,
    activity: [],             // recent activity log entries (most-recent last)
    // ---- scheduler state (managed by lib/scheduler; safe to ignore elsewhere) --
    sched: schedDefaults(),   // cadence timers + rolling send window + backoff
    repliedTo: [],            // feddit fullnames we've replied to ("t3_34"/"t1_140"), FIFO-bounded
  };
}

// Per-profile scheduler bookkeeping. Timestamps are epoch ms.
function schedDefaults() {
  return {
    nextPostAt: null,     // when the next submit is due (null => initialise on first tick)
    nextCommentAt: null,  // when the next reply is due
    backoffUntil: 0,      // skip this profile until this time (set from a 429 reset)
    sentPosts: [],        // our recent post timestamps (rolling 1h) - self rate-limit vs server ceiling
    sentComments: [],     // our recent comment timestamps (rolling 1h)
  };
}

// Global runner settings, honoured live by the scheduler.
function defaultSettings() {
  return {
    paused: false,     // global pause: while true the scheduler acts on nothing
    dryRun: true,      // DRY-RUN default ON: generate + log what it WOULD do, never write
    threadReplies: {}, // postId(string) -> count of THIS RUNNER's replies in that thread (ping-pong cap)
    threadOrder: [],   // postIds in insertion order, for FIFO bounding of threadReplies
  };
}

// Bounds so data/profiles.json can never grow without limit.
const REPLIED_CAP = 500;       // per-profile dedupe keys retained
const THREAD_TRACK_CAP = 500;  // distinct threads whose reply-count we track

function emptyData() {
  return { profiles: [], settings: defaultSettings() };
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
    if (!parsed.settings || typeof parsed.settings !== 'object') {
      parsed.settings = defaultSettings();
    } else {
      parsed.settings = { ...defaultSettings(), ...parsed.settings };
    }
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

// ---- global settings (pause / dry-run) --------------------------------------

function getSettings() {
  const data = load();
  if (!data.settings) { data.settings = defaultSettings(); save(data); }
  return data.settings;
}

function updateSettings(patch) {
  const data = load();
  data.settings = { ...defaultSettings(), ...(data.settings || {}), ...(patch || {}) };
  save(data);
  return data.settings;
}

// ---- scheduler state helpers ------------------------------------------------

// Merge a patch into a profile's scheduler bookkeeping.
function updateSched(id, patch) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  p.sched = { ...schedDefaults(), ...(p.sched || {}), ...(patch || {}) };
  save(data);
  return p.sched;
}

// Has this profile already replied to the given fullname ("t3_.."/"t1_..")?
function hasReplied(id, key) {
  const p = getProfile(id);
  return !!(p && Array.isArray(p.repliedTo) && p.repliedTo.includes(key));
}

// Record that this profile replied to a fullname; FIFO-bounded so it can't grow.
function recordReplied(id, key) {
  const data = load();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return null;
  if (!Array.isArray(p.repliedTo)) p.repliedTo = [];
  if (!p.repliedTo.includes(key)) {
    p.repliedTo.push(key);
    if (p.repliedTo.length > REPLIED_CAP) p.repliedTo = p.repliedTo.slice(-REPLIED_CAP);
  }
  save(data);
  return p.repliedTo;
}

// How many replies THIS RUNNER (any profile) has made in a given post's thread.
function getThreadReplyCount(postId) {
  const s = getSettings();
  return (s.threadReplies && s.threadReplies[String(postId)]) || 0;
}

// Count one more this-runner reply in a thread; FIFO-bounded across threads.
function bumpThreadReply(postId) {
  const data = load();
  const s = data.settings || (data.settings = defaultSettings());
  if (!s.threadReplies) s.threadReplies = {};
  if (!Array.isArray(s.threadOrder)) s.threadOrder = [];
  const key = String(postId);
  if (!(key in s.threadReplies)) s.threadOrder.push(key);
  s.threadReplies[key] = (s.threadReplies[key] || 0) + 1;
  while (s.threadOrder.length > THREAD_TRACK_CAP) {
    const old = s.threadOrder.shift();
    delete s.threadReplies[old];
  }
  save(data);
  return s.threadReplies[key];
}

module.exports = {
  DATA_FILE,
  DEFAULT_MODEL,
  profileDefaults,
  schedDefaults,
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  logActivity,
  getSettings,
  updateSettings,
  updateSched,
  hasReplied,
  recordReplied,
  getThreadReplyCount,
  bumpThreadReply,
};
