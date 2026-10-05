'use strict';

const scheduler = require('./scheduler');
const hostedPolicy = require('./hosted-policy');
const populationActivity = require('./population-activity');
const speed = require('./speed');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TYPES = Object.freeze(['text', 'article', 'reply', 'vote']);
const FIELDS = { text: 'nextPostAt', article: 'nextArticleAt', reply: 'nextCommentAt', vote: 'nextVoteAt' };
const RATE_FIELDS = { text: 'postsPerHour', article: 'articlePostsPerHour', reply: 'commentsPerHour', vote: 'votesPerHour' };

function counts() {
  return { text: 0, article: 0, reply: 0, vote: 0 };
}

function total(byType) {
  return TYPES.reduce((sum, type) => sum + byType[type], 0);
}

function add(target, source) {
  for (const type of TYPES) target[type] += source[type];
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeFilters(raw = {}) {
  return {
    mode: ['live', 'rehearsal', 'all'].includes(raw.mode) ? raw.mode : 'live',
    groupId: raw.groupId == null || raw.groupId === 'all' ? null : String(raw.groupId),
    type: TYPES.includes(raw.type) ? raw.type : 'all',
    zeroCadence: ['only', 'exclude'].includes(raw.zeroCadence) ? raw.zeroCadence : 'all',
  };
}

function populationState(profile, rehearsal, nowMs) {
  if (profile.botOrigin !== 'system' || profile.populationCadenceMode === 'custom') return null;
  const options = {
    nowMs,
    seed: profile.populationSeed || {},
    quantile: populationActivity.stableUnit(profile.id || profile.fedditUsername || 'system-bot'),
    random: () => 0.5,
  };
  const live = populationActivity.normalizeState(profile.populationActivity, options);
  if (!rehearsal) return live;
  return populationActivity.normalizeState(profile.simulationState && profile.simulationState.populationActivity, {
    ...options,
    fallback: populationActivity.rehearsalFromLive(live, options),
  });
}

function ratesFor(entry, at, options) {
  const { profile, capability: c, legacy, ecology } = entry;
  let configured = profile;
  if (options.placement === 'hosted' && profile.botOrigin !== 'system') {
    const ownerAt = typeof options.ownerActivityAt === 'function'
      ? options.ownerActivityAt(profile) : options.ownerActivityAt;
    const context = { ownerLastActiveAt: timestamp(ownerAt) == null ? null : new Date(timestamp(ownerAt)).toISOString() };
    configured = hostedPolicy.ratesForDailyTurns(profile, hostedPolicy.allocationFor(profile, at, context).dailyTurns);
  }
  const rates = Object.fromEntries(TYPES.map((type) => [type, positive(configured[RATE_FIELDS[type]])]));
  if (ecology) {
    rates.text = scheduler.populationRate(profile, 'post', ecology);
    rates.article = scheduler.populationRate(profile, 'article', ecology);
    rates.reply = scheduler.populationRate(profile, 'comment', ecology);
    rates.vote = scheduler.populationRate(profile, 'vote', ecology);
  }
  const ceiling = scheduler.ceilingsFor(profile);
  rates.text = (legacy ? c.canPost : c.canStartDiscussions) ? Math.min(rates.text, ceiling.postsPerHour) : 0;
  rates.article = !legacy && c.canShareLinks ? Math.min(rates.article, ceiling.postsPerHour) : 0;
  rates.reply = c.canComment ? Math.min(rates.reply, ceiling.commentsPerHour) : 0;
  rates.vote = !legacy && c.canVote ? rates.vote : 0;
  if (legacy && profile.botType === 'news') {
    rates.article = rates.text;
    rates.text = 0;
  }
  return rates;
}

function expectedRates(entry, at, options) {
  const rates = ratesFor(entry, at, options);
  if (entry.ecology) {
    const scale = entry.rehearsal ? populationActivity.REHEARSAL_TIME_SCALE : 1;
    const parent = entry.rehearsal ? entry.profile.simulationState : entry.profile;
    const momentum = populationActivity.recentThreadMomentum(parent && parent.socialState, at);
    for (const type of TYPES) {
      if (!rates[type]) continue;
      // Mean of the scheduler's bounded exponential spacing. Keep the current
      // ecology snapshot; future random drift and conversations are unknowable.
      const share = Math.max(0.0001, Math.min(1, rates[type] * 24 / entry.ecology.currentDailyOpportunities));
      const daily = Math.max(populationActivity.MIN_DAILY,
        Math.min(rates[type] * 24 * scale * momentum, populationActivity.MAX_DAILY * share * scale));
      const mean = DAY_MS / daily;
      const minimum = (entry.rehearsal ? 8 : 45) * 60 * 1000;
      const maximum = (entry.rehearsal ? 5 : 21) * DAY_MS;
      const expectedDelay = minimum + mean * (Math.exp(-minimum / mean) - Math.exp(-maximum / mean));
      rates[type] = HOUR_MS / expectedDelay;
    }
  }
  const multiplier = speed.inspect(entry.speedState, at).effectiveMultiplier;
  for (const type of TYPES) rates[type] *= multiplier;
  return rates;
}

function describe(entry) {
  return {
    profileId: entry.profile.id,
    botName: String(entry.profile.fedditUsername || entry.profile.refName || entry.profile.id || ''),
    groupId: entry.groupId,
    groupName: entry.groupName,
    mode: entry.rehearsal ? 'rehearsal' : 'live',
  };
}

// The caller supplies owner-scoped profiles/groups. No store, provider or clock
// state is changed. Missing timers stay missing; projections never seed them.
function buildActivityForecast(options = {}) {
  const nowMs = options.nowMs == null ? Date.now() : Number(options.nowMs);
  if (!Number.isFinite(nowMs)) throw new Error('The activity forecast requires a valid time.');
  const filters = normalizeFilters(options.filters);
  const groupNames = new Map((Array.isArray(options.groups) ? options.groups : [])
    .filter((group) => group && group.id).map((group) => [String(group.id), String(group.name || group.id)]));
  const entries = [];
  for (const profile of Array.isArray(options.profiles) ? options.profiles : []) {
    if (!profile || profile.enabled !== true ||
        profile.populationArchivedAt || profile.archivedAt || profile.deletedAt) continue;
    const rehearsal = scheduler.isDryRun(profile, options.settings || {});
    if (filters.mode !== 'all' && rehearsal !== (filters.mode === 'rehearsal')) continue;
    const groupId = groupNames.has(String(profile.groupId || '')) ? String(profile.groupId) : '';
    if (filters.groupId !== null && filters.groupId !== groupId) continue;
    const entry = {
      profile, rehearsal, groupId, groupName: groupNames.get(groupId) || 'Ungrouped',
      capability: scheduler.caps(profile), legacy: !scheduler.hasIndependentCapabilities(profile),
      ecology: populationState(profile, rehearsal, nowMs),
      speedState: typeof options.speedState === 'function' ? options.speedState(profile) : options.speedState,
      schedule: (rehearsal ? profile.simulationState && profile.simulationState.sched : profile.sched) || {},
      contributions: { '1h': 0, '24h': 0, '7d': 0 },
    };
    entry.rates = ratesFor(entry, nowMs, options);
    entry.zeroCadence = total(entry.rates) === 0;
    if (!(profile.token || profile.hasToken === true) && (rehearsal || !entry.zeroCadence)) continue;
    if (filters.zeroCadence === 'only' && !entry.zeroCadence) continue;
    if (filters.zeroCadence === 'exclude' && entry.zeroCadence) continue;
    if (filters.type !== 'all' && !entry.zeroCadence && entry.rates[filters.type] === 0) continue;
    entries.push(entry);
  }

  const upcoming = [];
  for (const entry of entries) {
    for (const type of TYPES) {
      if (!entry.rates[type] || (filters.type !== 'all' && type !== filters.type)) continue;
      const field = entry.legacy && type === 'article' ? 'nextPostAt' : FIELDS[type];
      const at = timestamp(entry.schedule[field]);
      if (at == null) continue;
      upcoming.push({
        ...describe(entry), type, at, atIso: new Date(at).toISOString(),
        overdue: at <= nowMs,
        backoffUntil: timestamp(entry.schedule.backoffUntil),
        source: 'persisted-schedule',
      });
    }
  }
  upcoming.sort((a, b) => a.at - b.at || String(a.profileId).localeCompare(String(b.profileId)) || a.type.localeCompare(b.type));

  const groupRows = new Map();
  for (const entry of entries) {
    if (!groupRows.has(entry.groupId)) groupRows.set(entry.groupId, {
      id: entry.groupId, name: entry.groupName, botCount: 0,
      projections: { '1h': counts(), '24h': counts(), '7d': counts() },
    });
    groupRows.get(entry.groupId).botCount++;
  }
  const hourly = [];
  for (let hour = 0; hour < 168; hour++) {
    const startAt = nowMs + hour * HOUR_MS;
    const endAt = startAt + HOUR_MS;
    const byType = counts();
    for (const entry of entries) {
      const boundaries = [startAt, endAt];
      const expiry = timestamp(speed.inspect(entry.speedState, nowMs).expiresAt);
      if (expiry > startAt && expiry < endAt) boundaries.push(expiry);
      if (options.placement === 'hosted' && entry.profile.botOrigin !== 'system') {
        const ownerAt = typeof options.ownerActivityAt === 'function'
          ? options.ownerActivityAt(entry.profile) : options.ownerActivityAt;
        const allocation = hostedPolicy.allocationFor(entry.profile, startAt, {
          ownerLastActiveAt: timestamp(ownerAt) == null ? null : new Date(timestamp(ownerAt)).toISOString(),
        });
        if (allocation.boostEndsAt > startAt && allocation.boostEndsAt < endAt) boundaries.push(allocation.boostEndsAt);
      }
      boundaries.sort((a, b) => a - b);
      const contribution = counts();
      for (let index = 1; index < boundaries.length; index++) {
        const at = boundaries[index - 1];
        const rates = expectedRates(entry, at, options);
        const duration = (boundaries[index] - at) / HOUR_MS;
        for (const type of TYPES) {
          if (filters.type === 'all' || filters.type === type) contribution[type] += rates[type] * duration;
        }
      }
      add(byType, contribution);
      const projections = groupRows.get(entry.groupId).projections;
      if (hour === 0) {
        add(projections['1h'], contribution);
        entry.contributions['1h'] += total(contribution);
      }
      if (hour < 24) {
        add(projections['24h'], contribution);
        entry.contributions['24h'] += total(contribution);
      }
      add(projections['7d'], contribution);
      entry.contributions['7d'] += total(contribution);
    }
    hourly.push({ startAt, endAt, total: total(byType), byType });
  }
  const groups = Array.from(groupRows.values()).map((group) => ({
    ...group,
    projections: Object.fromEntries(Object.entries(group.projections)
      .map(([key, byType]) => [key, {
        total: total(byType), byType,
        botCount: entries.filter((entry) => entry.groupId === group.id && entry.contributions[key] > 0).length,
      }])),
  }));
  const groupCount = groups.filter((group) => group.id).length;
  const projections = Object.fromEntries(['1h', '24h', '7d'].map((key) => {
    const byType = counts();
    for (const group of groups) add(byType, group.projections[key].byType);
    return [key, {
      total: total(byType), byType,
      botCount: entries.filter((entry) => entry.contributions[key] > 0).length,
      groupCount: groups.filter((group) => group.id && group.projections[key].total > 0).length,
      groups: groups.map((group) => ({ id: group.id, name: group.name, ...group.projections[key] })),
    }];
  }));
  const dailyBuckets = Array.from({ length: 7 }, (_, day) => {
    const byType = counts();
    for (const bucket of hourly.slice(day * 24, (day + 1) * 24)) add(byType, bucket.byType);
    return { startAt: nowMs + day * DAY_MS, endAt: nowMs + (day + 1) * DAY_MS, total: total(byType), byType };
  });
  return {
    generatedAt: nowMs, filters, botCount: entries.length, groupCount,
    paused: Boolean(options.settings && options.settings.paused),
    projections, groups, hourlyBuckets: hourly.slice(0, 24), dailyBuckets, upcoming,
    activeNoCadence: entries.filter((entry) => entry.zeroCadence).map(describe),
    assumptions: [
      ...(options.settings && options.settings.paused
        ? ['Runner is paused. Projections show configured activity after resuming; no automatic work will run while paused.'] : []),
      'Projections estimate scheduled opportunities, not guaranteed posts, replies or individual votes.',
      'Upcoming times are saved scheduler deadlines; overdue work, backoff and queue delays can postpone execution.',
      'Random spacing, WAIT decisions, available content, shared compute and server limits affect actual activity.',
      'Ecology uses its current activity snapshot and bounded random spacing; future drift and conversations are unknown.',
      'Timed Speed ends at its saved expiry; until-off Speed is assumed to remain on. Hosted boosts end on their saved dates.',
      'Manual actions, Burst sessions and accelerated rehearsal runs are excluded. Charts use rolling windows from the forecast time.',
    ],
  };
}

module.exports = { buildActivityForecast, TYPES };
