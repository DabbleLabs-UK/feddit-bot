'use strict';

// Activity ecology for system-generated hosted bots. This module decides only
// how often a synthetic bot receives an opportunity. It never chooses content,
// retries WAIT, or affects infrastructure queue priority.

const crypto = require('node:crypto');

const VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_DAILY = 0.1;
const MAX_DAILY = 6;
const MAX_OPPORTUNITIES_PER_DAY = 6;
const REHEARSAL_TIME_SCALE = 4;
const DRIFT_MIN_STEP_MS = 6 * HOUR_MS;
const DRIFT_TIME_CONSTANT_MS = 14 * DAY_MS;
const TARGET_MIN_MS = 7 * DAY_MS;
const TARGET_SPREAD_MS = 14 * DAY_MS;

// A deliberately simple heavy tail. Roughly half the population is rare, a
// further 28% is occasional, 15% is regular, and only 5% is conspicuously
// active. Values are opportunity rates, not promised posts.
const BANDS = Object.freeze([
  Object.freeze({ name: 'rare', upper: 0.52, daily: 0.3 }),
  Object.freeze({ name: 'occasional', upper: 0.80, daily: 0.9 }),
  Object.freeze({ name: 'regular', upper: 0.95, daily: 2.2 }),
  Object.freeze({ name: 'active', upper: 1.00, daily: 4.5 }),
]);

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, Number(value) || 0));
}

function unit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return ((n % 1) + 1) % 1;
}

function stableUnit(value) {
  const bytes = crypto.createHash('sha256').update(String(value || '')).digest();
  return bytes.readUInt32BE(0) / 0x100000000;
}

function bandForQuantile(value) {
  const q = unit(value);
  return BANDS.find((band) => q < band.upper) || BANDS[BANDS.length - 1];
}

function seedAdjustment(seed = {}) {
  const sociability = seed.sociability === 'sociable' ? 1.08
    : (seed.sociability === 'reserved' ? 0.92 : 1);
  const initiative = seed.initiative === 'often-initiates' ? 1.06
    : (seed.initiative === 'mostly-responds' ? 0.94 : 1);
  const persistence = seed.persistence === 'persistent' ? 1.04
    : (seed.persistence === 'light' ? 0.96 : 1);
  return clamp(sociability * initiative * persistence, 0.82, 1.18);
}

function cleanTimes(value, cutoff, cap = 96) {
  return (Array.isArray(value) ? value : [])
    .map(Number)
    .filter((at) => Number.isFinite(at) && at > 0 && at >= cutoff)
    .sort((a, b) => a - b)
    .slice(-cap);
}

function initialState(seed = {}, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const random = options.random || Math.random;
  const quantile = Number.isFinite(Number(options.quantile))
    ? unit(options.quantile)
    : stableUnit(JSON.stringify(seed));
  const band = bandForQuantile(quantile);
  const baseline = clamp(band.daily * seedAdjustment(seed), MIN_DAILY, MAX_DAILY);
  return {
    version: VERSION,
    band: band.name,
    quantile,
    baselineDailyOpportunities: baseline,
    currentDailyOpportunities: baseline,
    targetDailyOpportunities: baseline,
    driftUpdatedAt: nowMs,
    nextTargetAt: nowMs + TARGET_MIN_MS + unit(random()) * TARGET_SPREAD_MS,
    recentOpportunities: [],
    recentVisibleActions: [],
    recentCapacitySkips: [],
  };
}

function normalizeState(raw, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const fallback = options.fallback || initialState(options.seed || {}, {
    nowMs,
    quantile: options.quantile,
    random: options.random,
  });
  const source = raw && typeof raw === 'object' ? raw : {};
  const baseline = clamp(
    Number(source.baselineDailyOpportunities) || fallback.baselineDailyOpportunities,
    MIN_DAILY,
    MAX_DAILY,
  );
  const lower = Math.max(MIN_DAILY, baseline * 0.35);
  const upper = Math.min(MAX_DAILY, baseline * 2.5);
  const current = clamp(
    Number(source.currentDailyOpportunities) || fallback.currentDailyOpportunities || baseline,
    lower,
    upper,
  );
  const target = clamp(
    Number(source.targetDailyOpportunities) || fallback.targetDailyOpportunities || baseline,
    lower,
    upper,
  );
  const bandNames = new Set(BANDS.map((band) => band.name));
  const driftUpdatedAt = Math.max(0, Number(source.driftUpdatedAt) || fallback.driftUpdatedAt || nowMs);
  const nextTargetAt = Math.max(
    driftUpdatedAt,
    Number(source.nextTargetAt) || fallback.nextTargetAt || (nowMs + TARGET_MIN_MS),
  );
  return {
    version: VERSION,
    band: bandNames.has(source.band) ? source.band : fallback.band,
    quantile: Number.isFinite(Number(source.quantile)) ? unit(source.quantile) : fallback.quantile,
    baselineDailyOpportunities: baseline,
    currentDailyOpportunities: current,
    targetDailyOpportunities: target,
    driftUpdatedAt,
    nextTargetAt,
    recentOpportunities: cleanTimes(source.recentOpportunities, nowMs - 14 * DAY_MS),
    recentVisibleActions: cleanTimes(source.recentVisibleActions, nowMs - 30 * DAY_MS),
    recentCapacitySkips: cleanTimes(source.recentCapacitySkips, nowMs - 7 * DAY_MS),
  };
}

function assignCohort(seeds, options = {}) {
  const list = Array.isArray(seeds) ? seeds : [];
  if (!list.length) return [];
  const random = options.random || Math.random;
  // Systematic sampling spreads an ordinary cohort across the distribution
  // without forcing every small cohort to contain every band.
  const offset = Number.isFinite(Number(options.offset))
    ? unit(options.offset) / list.length
    : unit(random()) / list.length;
  return list.map((seed, index) => initialState(seed, {
    nowMs: options.nowMs,
    random,
    quantile: unit(offset + index / list.length),
  }));
}

function advanceState(raw, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const random = options.random || Math.random;
  const state = normalizeState(raw, { ...options, nowMs, random });
  const elapsed = Math.max(0, nowMs - state.driftUpdatedAt);
  if (elapsed < DRIFT_MIN_STEP_MS) return state;

  const baseline = state.baselineDailyOpportunities;
  const lower = Math.max(MIN_DAILY, baseline * 0.35);
  const upper = Math.min(MAX_DAILY, baseline * 2.5);
  if (nowMs >= state.nextTargetAt) {
    // New targets remain anchored to this bot's baseline. This permits long
    // quiet or active spells without causing the whole population to converge.
    const multiplier = Math.exp((unit(random()) - 0.5) * 1.0);
    state.targetDailyOpportunities = clamp(baseline * multiplier, lower, upper);
    state.nextTargetAt = nowMs + TARGET_MIN_MS + unit(random()) * TARGET_SPREAD_MS;
  }

  const alpha = 1 - Math.exp(-elapsed / DRIFT_TIME_CONSTANT_MS);
  state.currentDailyOpportunities = clamp(
    state.currentDailyOpportunities +
      (state.targetDailyOpportunities - state.currentDailyOpportunities) * alpha,
    lower,
    upper,
  );
  state.driftUpdatedAt = nowMs;
  return normalizeState(state, { ...options, nowMs, random });
}

function recentThreadMomentum(socialState, nowMs = Date.now()) {
  const relationships = socialState && socialState.relationships && typeof socialState.relationships === 'object'
    ? Object.values(socialState.relationships)
    : [];
  let warm = false;
  for (const relationship of relationships) {
    const events = Array.isArray(relationship && relationship.recentEvents)
      ? relationship.recentEvents
      : [];
    const byThread = new Map();
    for (const event of events) {
      const key = String(event && event.threadKey || '');
      const at = Number(event && event.at) || 0;
      if (!key || !at || nowMs - at > 18 * HOUR_MS) continue;
      const thread = byThread.get(key) || { directions: new Set(), lastAt: 0, count: 0 };
      thread.directions.add(event.direction === 'outgoing' ? 'outgoing' : 'incoming');
      thread.lastAt = Math.max(thread.lastAt, at);
      thread.count++;
      byThread.set(key, thread);
    }
    for (const thread of byThread.values()) {
      if (!thread.directions.has('incoming') || !thread.directions.has('outgoing')) continue;
      if (thread.count >= 6) continue; // satiated exchanges do not accelerate.
      if (nowMs - thread.lastAt <= 6 * HOUR_MS) return 1.25;
      warm = true;
    }
  }
  return warm ? 1.1 : 1;
}

function nextDelayMs(raw, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const random = options.random || Math.random;
  const rehearsal = options.rehearsal === true;
  const state = advanceState(raw, { ...options, nowMs, random });
  const scale = rehearsal ? REHEARSAL_TIME_SCALE : 1;
  const momentum = clamp(Number(options.momentumFactor) || 1, 1, 1.25);
  const rawShare = Number(options.opportunityShare);
  const opportunityShare = Number.isFinite(rawShare) && rawShare > 0
    ? clamp(rawShare, 0, 1)
    : 1;
  const daily = clamp(
    state.currentDailyOpportunities * opportunityShare * scale * momentum,
    MIN_DAILY,
    MAX_DAILY * scale * opportunityShare,
  );
  const recent = cleanTimes(state.recentOpportunities, nowMs - DAY_MS);

  if (!rehearsal && recent.length >= MAX_OPPORTUNITIES_PER_DAY) {
    const wait = Math.max(0, recent[0] + DAY_MS - nowMs);
    return wait + unit(random()) * 30 * 60 * 1000;
  }

  // Exponential spacing is memoryless and visibly less clockwork than a fixed
  // interval plus jitter. Hard bounds prevent both storms and accidental exile.
  const sample = -Math.log(Math.max(1e-9, 1 - unit(random()))) * DAY_MS / daily;
  const minimum = rehearsal ? 8 * 60 * 1000 : 45 * 60 * 1000;
  const maximum = rehearsal ? 5 * DAY_MS : 21 * DAY_MS;
  return clamp(sample, minimum, maximum);
}

function recordOpportunity(raw, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const state = advanceState(raw, options);
  state.recentOpportunities = cleanTimes(
    [...state.recentOpportunities, nowMs],
    nowMs - 14 * DAY_MS,
  );
  return state;
}

function recordOutcome(raw, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const state = advanceState(raw, options);
  if (options.visible === true) {
    state.recentVisibleActions = cleanTimes(
      [...state.recentVisibleActions, nowMs],
      nowMs - 30 * DAY_MS,
    );
  }
  return state;
}

function recordCapacitySkip(raw, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const state = advanceState(raw, options);
  state.recentCapacitySkips = cleanTimes(
    [...state.recentCapacitySkips, nowMs],
    nowMs - 7 * DAY_MS,
  );
  return state;
}

function rehearsalFromLive(raw, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const live = normalizeState(raw, options);
  return normalizeState({
    ...live,
    currentDailyOpportunities: live.baselineDailyOpportunities,
    targetDailyOpportunities: live.baselineDailyOpportunities,
    driftUpdatedAt: nowMs,
    nextTargetAt: nowMs + TARGET_MIN_MS + unit((options.random || Math.random)()) * TARGET_SPREAD_MS,
    recentOpportunities: [],
    recentVisibleActions: [],
    recentCapacitySkips: [],
  }, { ...options, nowMs, fallback: live });
}

function describe(raw, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const state = normalizeState(raw, { ...options, nowMs });
  const ratio = state.currentDailyOpportunities / state.baselineDailyOpportunities;
  const condition = ratio >= 1.35 ? 'unusually active'
    : (ratio <= 0.74 ? 'unusually quiet' : 'near baseline');
  return {
    band: state.band,
    baselineDailyOpportunities: Number(state.baselineDailyOpportunities.toFixed(2)),
    currentDailyOpportunities: Number(state.currentDailyOpportunities.toFixed(2)),
    condition,
    opportunities24h: cleanTimes(state.recentOpportunities, nowMs - DAY_MS).length,
    opportunities7d: cleanTimes(state.recentOpportunities, nowMs - 7 * DAY_MS).length,
    visibleActions7d: cleanTimes(state.recentVisibleActions, nowMs - 7 * DAY_MS).length,
    capacitySkips7d: cleanTimes(state.recentCapacitySkips, nowMs - 7 * DAY_MS).length,
    nextTargetAt: new Date(state.nextTargetAt).toISOString(),
  };
}

function cohortSummary(states, options = {}) {
  const summaries = (Array.isArray(states) ? states : []).filter(Boolean)
    .map((state) => describe(state, options));
  const bands = Object.fromEntries(BANDS.map((band) => [band.name, 0]));
  for (const summary of summaries) bands[summary.band] = (bands[summary.band] || 0) + 1;
  return {
    bots: summaries.length,
    bands,
    opportunities24h: summaries.reduce((sum, item) => sum + item.opportunities24h, 0),
    opportunities7d: summaries.reduce((sum, item) => sum + item.opportunities7d, 0),
    visibleActions7d: summaries.reduce((sum, item) => sum + item.visibleActions7d, 0),
    capacitySkips7d: summaries.reduce((sum, item) => sum + item.capacitySkips7d, 0),
  };
}

module.exports = {
  VERSION,
  HOUR_MS,
  DAY_MS,
  MIN_DAILY,
  MAX_DAILY,
  MAX_OPPORTUNITIES_PER_DAY,
  REHEARSAL_TIME_SCALE,
  DRIFT_MIN_STEP_MS,
  DRIFT_TIME_CONSTANT_MS,
  TARGET_MIN_MS,
  TARGET_SPREAD_MS,
  BANDS,
  stableUnit,
  bandForQuantile,
  seedAdjustment,
  initialState,
  normalizeState,
  assignCohort,
  advanceState,
  recentThreadMomentum,
  nextDelayMs,
  recordOpportunity,
  recordOutcome,
  recordCapacitySkip,
  rehearsalFromLive,
  describe,
  cohortSummary,
};
