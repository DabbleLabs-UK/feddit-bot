'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const ENTRY_CAP = 128;
const POLL_MS = 5 * 60000;
const GLOBAL_GAP_MS = 15 * 60000;
const PROFILE_GAP_MS = 60 * 60000;
const THREAD_GAP_MS = 30 * 60000;
const HOUR_MS = 60 * 60000;
const DRIFT_MS = 2 * 60000;
const STATE_BYTES = 1024 * 1024;

function failure(message, code = 'QUIET_CONVERSATION_BOOKKEEPING_PENDING') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function version(raw) {
  if (raw !== VERSION) throw failure('Unsupported quiet-conversation contract. No admission was changed.', 'UNSUPPORTED_QUIET_CONVERSATION');
  return raw;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function timestamp(value) { return Number.isSafeInteger(value) && value > 0; }
function profile(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function identity(value) { return typeof value === 'string' && /^q_[a-f0-9]{32}$/.test(value); }
function post(value) { return Number.isSafeInteger(value) && value > 0; }
function empty() { return { version: VERSION, modes: { live: [], rehearsal: [] } }; }
function mode(simulation) { return simulation === true ? 'rehearsal' : 'live'; }

function safeSignal(raw) {
  if (!raw || raw.status !== 'quiet' || raw.quiet !== true || !Number.isInteger(raw.comments) || raw.comments < 0 || raw.comments > 8 ||
      !Number.isInteger(raw.roots) || raw.roots < 0 || raw.roots > 100 || !timestamp(raw.windowSince) ||
      !timestamp(raw.windowUntil) || raw.windowUntil - raw.windowSince !== HOUR_MS || !timestamp(raw.observedAt) ||
      Math.abs(raw.observedAt - raw.windowUntil) > DRIFT_MS) throw failure('A valid quiet public-activity signal is required.');
  return { status: 'quiet', quiet: true, comments: raw.comments, roots: raw.roots,
    windowSince: raw.windowSince, windowUntil: raw.windowUntil, observedAt: raw.observedAt };
}

function descriptor(raw) {
  if (!raw || typeof raw !== 'object') throw failure('A frozen quiet-conversation admission is required.');
  version(raw.version);
  if (!identity(raw.id) || !profile(raw.profileId) || !timestamp(raw.admittedAt) || typeof raw.simulation !== 'boolean' ||
      !Array.isArray(raw.excludedThreadIds) || raw.excludedThreadIds.length > ENTRY_CAP ||
      raw.excludedThreadIds.some((id) => !post(id)) || new Set(raw.excludedThreadIds).size !== raw.excludedThreadIds.length) {
    throw failure('Invalid frozen quiet-conversation admission.');
  }
  return { version: VERSION, id: raw.id, profileId: raw.profileId, admittedAt: raw.admittedAt,
    simulation: raw.simulation, excludedThreadIds: raw.excludedThreadIds.slice(), signal: safeSignal(raw.signal) };
}

function readState(raw) {
  version(raw && raw.version);
  if (!raw.modes || Object.keys(raw).some((key) => !['version', 'modes'].includes(key)) ||
      Object.keys(raw.modes).sort().join(',') !== 'live,rehearsal') throw failure('Invalid quiet-conversation state.');
  const output = empty();
  const seen = new Set();
  for (const name of ['live', 'rehearsal']) {
    const rows = raw.modes[name];
    if (!Array.isArray(rows) || rows.length > ENTRY_CAP) throw failure('Invalid quiet-conversation admission ledger.');
    for (const row of rows) {
      const item = descriptor(row);
      if (seen.has(item.id) || mode(item.simulation) !== name || Object.keys(row).some((key) =>
        !['version', 'id', 'profileId', 'admittedAt', 'simulation', 'excludedThreadIds', 'signal', 'turnId', 'postId', 'selectedAt'].includes(key))) {
        throw failure('Conflicting quiet-conversation admission ledger.');
      }
      seen.add(item.id);
      if (row.turnId != null) {
        if (typeof row.turnId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.turnId)) throw failure('Invalid quiet-conversation durable turn binding.');
        item.turnId = row.turnId;
      }
      if (row.postId != null || row.selectedAt != null) {
        if (!post(row.postId) || !timestamp(row.selectedAt) || row.selectedAt < row.admittedAt) throw failure('Invalid quiet-conversation selected thread.');
        item.postId = row.postId;
        item.selectedAt = row.selectedAt;
      }
      output.modes[name].push(item);
    }
  }
  return output;
}

function publicCounts(data, at) {
  const until = Date.parse(data?.window?.until);
  const since = Date.parse(data?.window?.since);
  const generated = Date.parse(data?.generatedAt);
  if (data?.schemaVersion !== 1 || data?.source !== 'feddit-current-votes' || data?.window?.hours !== 1 ||
      !Number.isFinite(since) || !Number.isFinite(until) || until - since !== HOUR_MS || generated !== until ||
      Math.abs(at - until) > DRIFT_MS || data?.coverage?.sampleTruncated !== false || data?.coverage?.nsfwIncluded !== false ||
      !Array.isArray(data.items) || data.items.length > 100) return null;
  const seen = new Set();
  let comments = 0;
  let roots = 0;
  for (const item of data.items) {
    const created = Date.parse(item?.createdAt);
    if (!item || !['post', 'comment'].includes(item.targetType) || !post(item.targetId) || !post(item.postId) ||
        item.key !== item.targetType + ':' + item.targetId || seen.has(item.key) || !Number.isFinite(created) || created > until ||
        (item.targetType === 'post' && item.targetId !== item.postId)) return null;
    seen.add(item.key);
    // Old content can appear because it received a vote. That is not conversation.
    if (created < since) continue;
    if (item.targetType === 'comment') comments++;
    else roots++;
  }
  return { comments, roots, windowSince: since, windowUntil: until, observedAt: at };
}

function createQuietConversations({ file, request, now = Date.now, enabled = false } = {}) {
  let state = null;
  let blocked = null;
  let cached = null;
  let cachedAt = null;
  let pending = null;
  let lastValid = null;

  function load() {
    if (blocked) throw blocked;
    if (state) return state;
    try {
      if (typeof file !== 'string' || !file) throw failure('Quiet-conversation state file is unavailable.');
      if (!fs.existsSync(file)) state = empty();
      else {
        if (fs.statSync(file).size > STATE_BYTES) throw failure('Quiet-conversation state exceeds its bounded ledger.');
        state = readState(JSON.parse(fs.readFileSync(file, 'utf8')));
      }
      return state;
    } catch (error) {
      blocked = error.code === 'UNSUPPORTED_QUIET_CONVERSATION' ? error : failure('Quiet-conversation bookkeeping is unavailable; no extra admission is allowed.');
      throw blocked;
    }
  }

  function commit(next) {
    if (blocked) throw blocked;
    let temporary;
    try {
      const checked = readState(next);
      const data = JSON.stringify(checked);
      if (Buffer.byteLength(data) > STATE_BYTES) throw failure('Quiet-conversation ledger exceeds its storage bound.');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      temporary = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
      if (process.platform !== 'win32') {
        const directory = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
      state = checked;
    } catch {
      if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Only this attempted write's temporary file. */ } }
      blocked = failure('Quiet-conversation bookkeeping could not be committed. Hold this admission for recovery.');
      throw blocked;
    }
  }

  function unknown(status = 'unknown') {
    return { status, quiet: false, comments: null, roots: null, windowSince: null, windowUntil: null, observedAt: now() };
  }

  async function getSignal() {
    if (!enabled) return unknown('disabled');
    const at = now();
    if (pending) return clone(await pending);
    if (cached && at >= cachedAt && at - cachedAt < POLL_MS) return clone(cached);
    const run = async () => {
      let result = unknown();
      try {
        const response = await request('/evidence.json?window_hours=1&limit=100', { timeoutMs: 4000, maxResponseBytes: 1048576 });
        const counts = response?.ok === true ? publicCounts(response.data, now()) : null;
        if (counts) {
          const recent = !!lastValid && counts.observedAt >= lastValid.observedAt && counts.observedAt - lastValid.observedAt <= 2 * POLL_MS;
          const quiet = counts.comments < 6 || (counts.comments < 9 && recent && lastValid.quiet === true);
          result = { status: quiet ? 'quiet' : 'healthy', quiet, ...counts };
          lastValid = result;
        }
      } catch { /* Unknown coverage never grants extra work or retries. */ }
      cachedAt = now();
      cached = result;
      return result;
    };
    pending = run();
    try { return clone(await pending); } finally { pending = null; }
  }

  function rows(simulation) { return load().modes[mode(simulation)]; }
  function lastAdmissionAt(profileId, { simulation = false } = {}) {
    if (!enabled) return 0;
    return rows(simulation).reduce((latest, row) => row.profileId === profileId ? Math.max(latest, row.admittedAt) : latest, 0);
  }
  function canAdmit(profileId, { simulation = false, at = now() } = {}) {
    if (!enabled || !profile(profileId) || !timestamp(at)) return false;
    const records = rows(simulation);
    const globalAt = records.reduce((latest, row) => Math.max(latest, row.admittedAt), 0);
    const profileAt = lastAdmissionAt(profileId, { simulation });
    return (!globalAt || at - globalAt >= GLOBAL_GAP_MS) && (!profileAt || at - profileAt >= PROFILE_GAP_MS);
  }
  function excludedThreadIds({ simulation = false, at = now() } = {}) {
    if (!enabled) return [];
    return [...new Set(rows(simulation).filter((row) => row.postId && at - row.selectedAt < THREAD_GAP_MS)
      .map((row) => row.postId))].sort((a, b) => a - b);
  }
  function bound(records) {
    return records.sort((a, b) => Math.max(b.admittedAt, b.selectedAt || 0) - Math.max(a.admittedAt, a.selectedAt || 0) || a.id.localeCompare(b.id))
      .slice(0, ENTRY_CAP);
  }
  function reserve(profileId, { simulation = false, signal } = {}) {
    if (!enabled || !canAdmit(profileId, { simulation })) return null;
    const at = now();
    if (!signal || !signal.quiet) return null;
    const checked = safeSignal(signal);
    if (at < checked.observedAt || at - checked.observedAt >= POLL_MS) return null;
    const admission = descriptor({ version: VERSION, id: 'q_' + crypto.randomBytes(16).toString('hex'), profileId,
      admittedAt: at, simulation: simulation === true, excludedThreadIds: excludedThreadIds({ simulation, at }), signal: checked });
    const next = clone(load());
    const name = mode(simulation);
    next.modes[name] = bound(next.modes[name].concat(admission));
    commit(next);
    return clone(admission);
  }
  function ensure(raw, turnId) {
    const admission = descriptor(raw);
    if (turnId != null && (typeof turnId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(turnId))) throw failure('Invalid quiet-conversation durable turn binding.');
    const current = load();
    const name = mode(admission.simulation);
    const existing = [...current.modes.live, ...current.modes.rehearsal].find((row) => row.id === admission.id);
    if (existing && (JSON.stringify(descriptor(existing)) !== JSON.stringify(admission) ||
        (turnId && existing.turnId && existing.turnId !== turnId))) throw failure('Conflicting frozen quiet-conversation admission.');
    if (existing && (!turnId || existing.turnId === turnId)) return clone(existing);
    const next = clone(current);
    const record = next.modes[name].find((row) => row.id === admission.id);
    if (record) record.turnId = turnId;
    else next.modes[name] = bound(next.modes[name].concat({ ...admission, ...(turnId ? { turnId } : {}) }));
    const restored = next.modes[name].find((row) => row.id === admission.id);
    if (!restored) throw failure('Frozen quiet-conversation admission is outside the bounded recovery ledger.');
    commit(next);
    return clone(restored);
  }
  function recordTarget(raw, postId) {
    if (!post(postId)) throw failure('A public thread identity is required.');
    const admission = descriptor(raw);
    if (admission.excludedThreadIds.includes(postId)) throw failure('Selected thread was excluded by the frozen quiet-conversation admission.');
    const existing = ensure(admission);
    if (existing.postId != null) {
      if (existing.postId !== postId) throw failure('A frozen quiet-conversation admission cannot select a different thread.');
      return clone(existing);
    }
    const next = clone(load());
    const name = mode(admission.simulation);
    const record = next.modes[name].find((row) => row.id === admission.id);
    if (!record) throw failure('Quiet-conversation admission is outside the bounded live ledger.');
    record.postId = postId;
    record.selectedAt = Math.max(now(), record.admittedAt);
    next.modes[name] = bound(next.modes[name]);
    commit(next);
    return clone(record);
  }
  function sortProfiles(profiles, { simulation = false } = {}) {
    return (Array.isArray(profiles) ? profiles : []).map((item, order) => ({ item, order,
      at: lastAdmissionAt(item.id, { simulation }) })).sort((a, b) => a.at - b.at || a.order - b.order).map((entry) => entry.item);
  }
  function peek() { return enabled ? clone(load()) : empty(); }
  return { getSignal, canAdmit, reserve, ensure, recordTarget, excludedThreadIds, lastAdmissionAt, sortProfiles, peek };
}

module.exports = { VERSION, ENTRY_CAP, POLL_MS, GLOBAL_GAP_MS, PROFILE_GAP_MS, THREAD_GAP_MS, version, createQuietConversations };
