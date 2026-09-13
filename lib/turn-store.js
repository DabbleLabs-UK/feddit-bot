'use strict';

// Durable logical turns for hosted bots. Inference jobs remain in jobs.json;
// this store records why each job exists and what must happen after it finishes.
// Writes are atomic so a runner restart can reconcile an incomplete turn without
// relying on the JavaScript promise which originally created it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const TERMINAL = new Set(['completed', 'failed', 'publication-uncertain']);
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TERMINAL_CAP = 1000;
const EVENT_CAP = 100;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createTurnStore(options = {}) {
  const file = path.resolve(options.file || path.join(__dirname, '..', 'data', 'turns.json'));
  const now = options.now || Date.now;
  const random = options.random || null;
  let cache = null;

  function empty() {
    return { version: VERSION, turns: [] };
  }

  function ensureDir() {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = {
        ...empty(),
        ...(parsed && typeof parsed === 'object' ? parsed : {}),
        version: VERSION,
        turns: Array.isArray(parsed && parsed.turns) ? parsed.turns : [],
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') cache = empty();
      else throw new Error('Failed to read durable turns: ' + error.message);
    }
    return cache;
  }

  function prune(data) {
    const cutoff = now() - TERMINAL_RETENTION_MS;
    const active = data.turns.filter((turn) => !TERMINAL.has(turn.status));
    const terminal = data.turns
      .filter((turn) => TERMINAL.has(turn.status) && Number(turn.finishedAt || turn.updatedAt || 0) >= cutoff)
      .sort((a, b) => Number(b.finishedAt || b.updatedAt || 0) - Number(a.finishedAt || a.updatedAt || 0))
      .slice(0, TERMINAL_CAP);
    data.turns = active.concat(terminal);
  }

  function save(data) {
    ensureDir();
    prune(data);
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, file);
    cache = data;
  }

  function newId() {
    if (random) return 't_' + now().toString(36) + random().toString(36).slice(2, 10);
    return 't_' + crypto.randomBytes(16).toString('hex');
  }

  function publicTurn(turn) {
    return turn ? clone(turn) : null;
  }

  function activeForProfile(profileId) {
    const id = String(profileId || '');
    if (!id) return null;
    const turns = load().turns
      .filter((turn) => turn.profileId === id && !TERMINAL.has(turn.status))
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    return publicTurn(turns[0] || null);
  }

  function create(input = {}) {
    const data = load();
    const existing = activeForProfile(input.profileId);
    if (existing) return { turn: existing, created: false };
    const at = now();
    const turn = {
      id: newId(),
      profileId: String(input.profileId || ''),
      botName: String(input.botName || ''),
      status: 'created',
      stage: 'preparing',
      rehearsal: input.rehearsal !== false,
      trigger: String(input.trigger || 'scheduled'),
      input: clone(input.input || {}),
      profile: clone(input.profile || {}),
      checkpoints: {},
      generations: [],
      publication: null,
      events: [{ at, state: 'created', note: 'Logical turn created.' }],
      result: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    };
    if (!turn.profileId) throw new Error('profileId is required for a durable turn.');
    data.turns.push(turn);
    save(data);
    return { turn: publicTurn(turn), created: true };
  }

  function get(turnId) {
    const turn = load().turns.find((item) => item.id === String(turnId));
    return publicTurn(turn || null);
  }

  function listActive() {
    return load().turns
      .filter((turn) => !TERMINAL.has(turn.status))
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
      .map(publicTurn);
  }

  function update(turnId, patch = {}) {
    const data = load();
    const turn = data.turns.find((item) => item.id === String(turnId));
    if (!turn) return null;
    Object.assign(turn, clone(patch));
    turn.updatedAt = now();
    if (TERMINAL.has(turn.status) && !turn.finishedAt) turn.finishedAt = turn.updatedAt;
    save(data);
    return publicTurn(turn);
  }

  function event(turnId, state, note = '') {
    const data = load();
    const turn = data.turns.find((item) => item.id === String(turnId));
    if (!turn) return null;
    if (!Array.isArray(turn.events)) turn.events = [];
    turn.events.push({ at: now(), state: String(state || ''), note: String(note || '').slice(0, 500) });
    if (turn.events.length > EVENT_CAP) turn.events = turn.events.slice(-EVENT_CAP);
    turn.status = String(state || turn.status);
    turn.updatedAt = now();
    if (TERMINAL.has(turn.status) && !turn.finishedAt) turn.finishedAt = turn.updatedAt;
    save(data);
    return publicTurn(turn);
  }

  function setCheckpoint(turnId, key, value) {
    const data = load();
    const turn = data.turns.find((item) => item.id === String(turnId));
    if (!turn) return null;
    if (!turn.checkpoints || typeof turn.checkpoints !== 'object') turn.checkpoints = {};
    turn.checkpoints[String(key)] = clone(value);
    turn.updatedAt = now();
    save(data);
    return clone(turn.checkpoints[String(key)]);
  }

  function generation(turnId, index, patch = {}) {
    const data = load();
    const turn = data.turns.find((item) => item.id === String(turnId));
    if (!turn) return null;
    if (!Array.isArray(turn.generations)) turn.generations = [];
    const n = Math.max(0, Number(index) || 0);
    turn.generations[n] = { ...(turn.generations[n] || {}), ...clone(patch), index: n };
    turn.updatedAt = now();
    save(data);
    return clone(turn.generations[n]);
  }

  function publication(turnId, patch = {}) {
    const data = load();
    const turn = data.turns.find((item) => item.id === String(turnId));
    if (!turn) return null;
    turn.publication = { ...(turn.publication || {}), ...clone(patch) };
    turn.updatedAt = now();
    save(data);
    return clone(turn.publication);
  }

  function markOnce(turnId, key) {
    const data = load();
    const turn = data.turns.find((item) => item.id === String(turnId));
    if (!turn) return false;
    if (!turn.once || typeof turn.once !== 'object') turn.once = {};
    const name = String(key);
    if (turn.once[name]) return false;
    turn.once[name] = now();
    turn.updatedAt = now();
    save(data);
    return true;
  }

  function resetForTests() {
    cache = null;
  }

  return {
    file,
    create,
    get,
    update,
    event,
    setCheckpoint,
    generation,
    publication,
    markOnce,
    activeForProfile,
    listActive,
    resetForTests,
  };
}

module.exports = {
  VERSION,
  TERMINAL_RETENTION_MS,
  TERMINAL_CAP,
  createTurnStore,
};
