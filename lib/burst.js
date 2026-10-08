'use strict';
const decisionContract = require('./decision-contract');
const voting = require('./voting');

const PROVIDERS = Object.freeze(['chatgpt-plan', 'claude-plan']);
const DURATIONS_MS = Object.freeze({
  '30m': 30 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  untilOff: null,
});
const MAX_ACTIONS = 3;
const SESSION_GAP_MS = 15 * 1000;
const RECENT_SESSION_CAP = 20;
const FAIRNESS_COOLDOWN_MS = 2 * 60 * 1000;

function inactiveState() {
  return {
    active: false,
    provider: '',
    startedAt: null,
    expiresAt: null,
    nextSessionAt: null,
    currentTurnId: null,
    currentProfileId: null,
    recentBotRuns: {},
    recentSessions: [],
    lastFailure: null,
  };
}

function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const provider = PROVIDERS.includes(String(source.provider || '')) ? String(source.provider) : '';
  const active = source.active === true && !!provider;
  const currentTurnId = source.currentTurnId ? String(source.currentTurnId) : null;
  const started = Date.parse(String(source.startedAt || ''));
  const expires = source.expiresAt == null ? NaN : Date.parse(String(source.expiresAt));
  const next = source.nextSessionAt == null ? NaN : Date.parse(String(source.nextSessionAt));
  const recentBotRuns = {};
  for (const [id, value] of Object.entries(source.recentBotRuns || {})) {
    const at = Number(value);
    if (id && Number.isFinite(at) && at > 0) recentBotRuns[String(id)] = at;
  }
  return {
    active,
    // Keep the selected provider and accepted turn while a stopped/expired
    // Burst drains that one durable session. Stopping never abandons accepted
    // publication work, but no following session will be scheduled.
    provider: active || currentTurnId ? provider : '',
    startedAt: active && Number.isFinite(started) ? new Date(started).toISOString() : null,
    expiresAt: active && Number.isFinite(expires) ? new Date(expires).toISOString() : null,
    nextSessionAt: active && Number.isFinite(next) ? new Date(next).toISOString() : null,
    currentTurnId,
    currentProfileId: currentTurnId && source.currentProfileId ? String(source.currentProfileId) : null,
    recentBotRuns,
    recentSessions: (Array.isArray(source.recentSessions) ? source.recentSessions : [])
      .slice(-RECENT_SESSION_CAP).map((entry) => ({
        at: String(entry && entry.at || ''),
        profileId: String(entry && entry.profileId || ''),
        botName: String(entry && entry.botName || ''),
        turnId: String(entry && entry.turnId || ''),
        outcome: String(entry && entry.outcome || ''),
        actions: Math.max(0, Number(entry && entry.actions) || 0),
        note: String(entry && entry.note || '').slice(0, 500),
      })),
    lastFailure: source.lastFailure && typeof source.lastFailure === 'object' ? {
      at: String(source.lastFailure.at || ''),
      code: String(source.lastFailure.code || ''),
      message: String(source.lastFailure.message || '').slice(0, 500),
    } : null,
  };
}

function startState(provider, duration, nowMs = Date.now(), previous = null) {
  const selected = String(provider || '');
  if (!PROVIDERS.includes(selected)) {
    const error = new Error('Choose a connected ChatGPT plan or Claude subscription for Burst.');
    error.code = 'INVALID_BURST_PROVIDER';
    throw error;
  }
  if (!Object.prototype.hasOwnProperty.call(DURATIONS_MS, duration)) {
    const error = new Error('Choose a Burst duration of 30 minutes, 3 hours, or until turned off.');
    error.code = 'INVALID_BURST_DURATION';
    throw error;
  }
  const at = Number(nowMs);
  const durationMs = DURATIONS_MS[duration];
  const old = normalizeState(previous);
  return {
    ...inactiveState(),
    active: true,
    provider: selected,
    startedAt: new Date(at).toISOString(),
    expiresAt: durationMs == null ? null : new Date(at + durationMs).toISOString(),
    nextSessionAt: new Date(at).toISOString(),
    recentBotRuns: old.recentBotRuns,
    recentSessions: old.recentSessions,
  };
}

function inspect(raw, nowMs = Date.now()) {
  const state = normalizeState(raw);
  const expiresMs = state.expiresAt == null ? null : Date.parse(state.expiresAt);
  const expired = state.active && expiresMs != null && expiresMs <= Number(nowMs);
  return {
    ...state,
    active: state.active && !expired,
    expired,
    remainingMs: state.active && !expired && expiresMs != null
      ? Math.max(0, expiresMs - Number(nowMs)) : null,
  };
}

function publicState(raw, nowMs = Date.now()) {
  const state = inspect(raw, nowMs);
  return {
    active: state.active,
    provider: state.active || state.currentTurnId ? state.provider : '',
    startedAt: state.active ? state.startedAt : null,
    expiresAt: state.active ? state.expiresAt : null,
    remainingMs: state.remainingMs,
    untilTurnedOff: state.active && state.expiresAt == null,
    currentTurnId: state.currentTurnId,
    currentProfileId: state.currentProfileId,
    stopping: !state.active && !!state.currentTurnId,
    nextSessionAt: state.active ? state.nextSessionAt : null,
    recentSessions: state.recentSessions,
    lastFailure: state.lastFailure,
  };
}

function providerReady(status) {
  return !!(status && ['ready'].includes(String(status.state || '')));
}

function candidateWeight(candidate) {
  const type = String(candidate && candidate.candidateType || '');
  if (type === 'reply_to_own_comment') return 120;
  if (type === 'reply_to_own_post') return 110;
  if (type === 'nested_continuation') return 105;
  if (type === 'mention_in_comment' || type === 'mention_in_post') return 100;
  if (type === 'renewed_thread') return 75;
  if (type === 'ordinary_comment') return 45;
  if (type === 'ordinary_post') return 35;
  if (type === 'article') return 25;
  if (type === 'new_discussion') return 15;
  return 10;
}

function scoreInspection(inspection, recentBotRuns = {}, nowMs = Date.now()) {
  const candidates = Array.isArray(inspection && inspection.candidates) ? inspection.candidates : [];
  let score = candidates.reduce((best, candidate) => Math.max(best, candidateWeight(candidate)), 0);
  score += Math.min(30, candidates.length * 3);
  score += Number(inspection && inspection.priorityAdjustment) || 0;
  const lastRun = Number(recentBotRuns[String(inspection && inspection.profileId || '')]) || 0;
  const age = Math.max(0, Number(nowMs) - lastRun);
  if (lastRun && age < FAIRNESS_COOLDOWN_MS) score -= 200;
  else score += Math.min(40, age / 60_000);
  return score;
}

function selectInspection(inspections, recentBotRuns = {}, nowMs = Date.now()) {
  return (Array.isArray(inspections) ? inspections : [])
    .filter((item) => item && item.eligible !== false &&
      Array.isArray(item.candidates) && item.candidates.length > 0)
    .map((item) => ({ ...item, burstScore: scoreInspection(item, recentBotRuns, nowMs) }))
    .sort((a, b) => b.burstScore - a.burstScore || String(a.profileId).localeCompare(String(b.profileId)))[0] || null;
}

function cleanText(value, limit) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function parsePlan(text, candidates, voteCandidates, options = {}) {
  const strict = decisionContract.version(options.decisionContractVersion) >= 2;
  let parsed;
  try {
    const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = strict ? decisionContract.parseObject(text) : JSON.parse(source);
    if (strict && !parsed) throw new Error('Invalid decision object');
  } catch {
    return { valid: false, wait: true, reason: 'The subscription model returned an unreadable Burst plan.', actions: [],
      votes: strict ? voting.parseDecisions(null, voteCandidates, options) : [] };
  }
  const byId = new Map((candidates || []).map((candidate) => [String(candidate.id), candidate]));
  const actions = [];
  const seen = new Set();
  for (const raw of (Array.isArray(parsed.actions) ? parsed.actions : [])) {
    if (actions.length >= MAX_ACTIONS) break;
    const candidateId = String(raw && raw.candidate || '');
    const candidate = byId.get(candidateId);
    if (!candidate || seen.has(candidateId)) continue;
    const content = candidate.action === 'comment'
      ? cleanText(raw.text, 10_000)
      : cleanText(raw.title, 300);
    if (!content) continue;
    const action = { candidateId, action: candidate.action, reason: cleanText(raw.reason, 240) };
    if (candidate.action === 'comment') action.text = content;
    else if (candidate.action === 'post') { action.title = content; action.body = cleanText(raw.body, 40_000); }
    else action.title = content;
    actions.push(action);
    seen.add(candidateId);
  }
  const votesById = new Map((voteCandidates || []).map((vote) => [String(vote.id), vote]));
  const votes = [];
  const seenVotes = new Set();
  for (const raw of (Array.isArray(parsed.votes) ? parsed.votes : [])) {
    const voteId = String(raw && raw.id || '');
    const candidate = votesById.get(voteId);
    if (!candidate || seenVotes.has(voteId)) continue;
    seenVotes.add(voteId);
    const direction = String(raw && raw.direction || 'nil');
    if (!['up', 'down', 'nil'].includes(direction)) continue;
    const reason = direction === 'nil' ? '' : cleanText(raw.reason, 240);
    if (direction !== 'nil' && reason.split(/\s+/).filter(Boolean).length < 3) continue;
    votes.push({ ...candidate, direction, reason, status: direction === 'nil' ? 'no-vote' : 'decided' });
  }
  const wait = parsed.wait === true || actions.length === 0;
  return {
    valid: true,
    wait,
    reason: cleanText(parsed.reason, 500) || (wait ? 'Nothing available felt suitable enough to act on.' : 'A bounded set of actions fit this moment.'),
    actions,
    votes: strict ? voting.parseDecisions(parsed, voteCandidates, { ...options, burst: true }) : votes,
  };
}

function prompt(candidates, voteCandidates) {
  const menu = (candidates || []).map((candidate) =>
    candidate.id + ' [' + candidate.action + ' / ' + candidate.candidateType + ']\n' +
    'WHY IT IS HERE: ' + candidate.structuralReason + '\n' +
    cleanText(candidate.context, 5000) +
    (candidate.social && candidate.social.summary ? '\nSOCIAL CONTEXT: ' + cleanText(candidate.social.summary, 500) : '') +
    (candidate.memory && candidate.memory.prompt ? '\nMEMORY: ' + cleanText(candidate.memory.prompt, 800) : '')
  ).join('\n\n');
  const votes = (voteCandidates || []).map((vote) =>
    vote.id + ' [' + vote.targetType + '] ' + cleanText(vote.label, 240) + '\n' + cleanText(vote.content, 1200)
  ).join('\n\n');
  return 'This is one accelerated Feddit session for one bot. Decide what is genuinely worth doing now. ' +
    'WAIT is normal. Return one JSON object only. You may choose zero to ' + MAX_ACTIONS + ' ordered actions. ' +
    'Use each C-number at most once. For a comment action provide text. For a new discussion provide title and body. ' +
    'For an article provide an original in-character title that is not the publisher headline or a close paraphrase. ' +
    'Do not invent facts beyond the supplied context. Votes are independent secondary reactions and may be up, down or nil.\n\n' +
    'JSON shape: {"wait":false,"reason":"...","actions":[{"candidate":"C1","text":"...","reason":"..."},{"candidate":"C2","title":"...","body":"...","reason":"..."}],"votes":[{"id":"V1","direction":"up|down|nil","reason":"..."}]}\n\n' +
    'ACTION CANDIDATES:\n' + (menu || '(none)') + '\n\nVOTE CANDIDATES:\n' + (votes || '(none)');
}

function createController(options) {
  const store = options.store;
  const scheduler = options.scheduler;
  const providers = options.providers;
  const now = options.now || Date.now;
  const log = options.log || (() => {});
  let running = false;
  let timer = null;

  function get() { return normalizeState(store.getSettings().burst); }
  function set(next) { return store.updateSettings({ burst: normalizeState(next) }).burst; }

  function fail(state, error) {
    const next = {
      ...state,
      active: false,
      currentTurnId: null,
      currentProfileId: null,
      nextSessionAt: null,
      lastFailure: {
        at: new Date(now()).toISOString(),
        code: String(error && error.code || 'BURST_FAILED'),
        message: String(error && error.message || error || 'Burst stopped.'),
      },
    };
    set(next);
    log('Burst stopped: ' + next.lastFailure.message);
    return next;
  }

  async function tick() {
    if (running) return { skipped: 'busy' };
    running = true;
    try {
      let state = inspect(get(), now());
      if (state.currentTurnId) {
        const turn = scheduler.burstTurn(state.currentTurnId);
        if (turn && !['completed', 'failed', 'publication-uncertain'].includes(turn.status)) {
          return { running: true, stopping: !state.active, turnId: turn.id };
        }
        const result = turn && turn.result || {};
        const outcome = turn ? turn.status : 'failed';
        const sessions = state.recentSessions.concat([{
          at: new Date(now()).toISOString(),
          profileId: state.currentProfileId,
          botName: turn && turn.botName || '',
          turnId: state.currentTurnId,
          outcome,
          actions: Array.isArray(result.actions) ? result.actions.length : 0,
          note: turn && (turn.error || result.reason) || 'Burst session ended.',
        }]).slice(-RECENT_SESSION_CAP);
        state = set({
          ...state,
          active: state.active && !state.expired,
          currentTurnId: null,
          currentProfileId: null,
          recentSessions: sessions,
          nextSessionAt: state.active && !state.expired ? new Date(now() + SESSION_GAP_MS).toISOString() : null,
        });
      }
      if (!state.active) {
        if (state.expired) set({ ...state, active: false, currentTurnId: null, currentProfileId: null, nextSessionAt: null });
        return { skipped: state.expired ? 'expired' : 'inactive' };
      }
      const providerStatus = await providers.status(state.provider);
      // A provider occupied by an ordinary generation is healthy but has no
      // capacity for a Burst session yet. Leave Burst active and retry later;
      // the provider's existing single-flight gate remains authoritative.
      if (providerStatus && providerStatus.state === 'busy') {
        return { skipped: 'provider-busy' };
      }
      if (!providerReady(providerStatus)) {
        const error = new Error(providerStatus && providerStatus.detail || 'The selected subscription provider is unavailable.');
        error.code = 'BURST_PROVIDER_' + String(providerStatus && providerStatus.state || 'UNAVAILABLE').toUpperCase().replace(/-/g, '_');
        fail(state, error);
        return { error: error.message };
      }
      const nextMs = Date.parse(String(state.nextSessionAt || ''));
      if (Number.isFinite(nextMs) && nextMs > now()) return { skipped: 'gap' };
      const inspections = await scheduler.inspectBurstCandidates();
      const selected = selectInspection(inspections, state.recentBotRuns, now());
      if (!selected) {
        set({ ...state, nextSessionAt: new Date(now() + SESSION_GAP_MS).toISOString() });
        return { skipped: 'no-eligible-bot' };
      }
      const started = scheduler.startBurstSession(selected.profileId, state.provider);
      if (!started || !started.turnId) return { skipped: started && started.skipped || 'not-started' };
      const recentBotRuns = { ...state.recentBotRuns, [selected.profileId]: now() };
      set({ ...state, currentTurnId: started.turnId, currentProfileId: selected.profileId, recentBotRuns });
      return { started: true, turnId: started.turnId, profileId: selected.profileId };
    } catch (error) {
      fail(get(), error);
      return { error: error.message };
    } finally {
      running = false;
    }
  }

  async function start(provider, duration) {
    const current = inspect(get(), now());
    if (current.active || current.currentTurnId) {
      const error = new Error(current.currentTurnId
        ? 'Burst already has an accepted session. Stop it and let that session finish before starting another.'
        : 'Burst is already active. Stop it before starting a different session.');
      error.code = 'BURST_ALREADY_ACTIVE';
      throw error;
    }
    if (!PROVIDERS.includes(String(provider || ''))) {
      const error = new Error('Choose a connected ChatGPT plan or Claude subscription for Burst.');
      error.code = 'INVALID_BURST_PROVIDER';
      throw error;
    }
    const status = await providers.status(provider);
    if (!providerReady(status)) {
      const error = new Error(status && status.detail || 'The selected subscription provider is unavailable.');
      error.code = 'BURST_PROVIDER_UNAVAILABLE';
      throw error;
    }
    const next = startState(provider, duration, now(), current);
    set(next);
    await tick();
    return publicState(get(), now());
  }

  function stop() {
    const current = get();
    const next = { ...current, active: false, nextSessionAt: null };
    // An already accepted durable turn is allowed to reach its safe terminal
    // state. No new session is scheduled after it completes.
    set(next);
    // Keep polling an accepted session to record its safe terminal result.
    if (current.currentTurnId) tick();
    return publicState(next, now());
  }

  function begin() {
    if (timer) return;
    timer = setInterval(() => { tick(); }, 2000);
    if (timer.unref) timer.unref();
    tick();
  }

  function close() { if (timer) clearInterval(timer); timer = null; }

  return { get, start, stop, tick, begin, close, publicState: () => publicState(get(), now()) };
}

module.exports = {
  PROVIDERS,
  DURATIONS_MS,
  MAX_ACTIONS,
  SESSION_GAP_MS,
  FAIRNESS_COOLDOWN_MS,
  inactiveState,
  normalizeState,
  startState,
  inspect,
  publicState,
  providerReady,
  candidateWeight,
  scoreInspection,
  selectInspection,
  prompt,
  parsePlan,
  createController,
};
