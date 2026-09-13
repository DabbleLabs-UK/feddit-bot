'use strict';

// Public hosted bots share one small DELL inference pool. Their cadence is a
// service-wide fairness policy, not a number supplied by an owner. Desktop and
// advanced placements retain their detailed rate controls.

const STANDARD_DAILY_TURNS = 3;
const NEW_BOT_DAILY_TURNS = 6;
const NEW_BOT_BOOST_MS = 72 * 60 * 60 * 1000;
const FIRST_TURN_DELAY_MS = 2 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_JOBS_PER_BOT = 1;

function activationTime(profile = {}) {
  const value = Date.parse(String(profile.hostedActivatedAt || ''));
  return Number.isFinite(value) ? value : null;
}

function capabilities(profile = {}) {
  const modern = profile.canReply !== undefined ||
    profile.canStartDiscussions !== undefined ||
    profile.canShareLinks !== undefined;
  return {
    canReply: modern
      ? profile.canReply === true
      : profile.mode === 'both' || profile.mode === 'comment',
    canPost: modern
      ? profile.canStartDiscussions === true || profile.canShareLinks === true
      : profile.botType === 'news' || profile.mode === 'both' || profile.mode === 'post',
  };
}

function allocationFor(profile = {}, at = Date.now()) {
  const startedAt = activationTime(profile);
  if (startedAt == null) {
    return {
      phase: 'not-started',
      dailyTurns: NEW_BOT_DAILY_TURNS,
      activatedAt: null,
      boostEndsAt: null,
    };
  }
  const boostEndsAt = startedAt + NEW_BOT_BOOST_MS;
  const isNew = at < boostEndsAt;
  return {
    phase: isNew ? 'new' : 'standard',
    dailyTurns: isNew ? NEW_BOT_DAILY_TURNS : STANDARD_DAILY_TURNS,
    activatedAt: startedAt,
    boostEndsAt,
  };
}

function ratesForDailyTurns(profile = {}, dailyTurns) {
  const turns = Math.max(0, Number(dailyTurns) || 0);
  const { canPost, canReply } = capabilities(profile);

  if (canPost && !canReply) {
    return { dailyTurns: turns, postsPerHour: turns / 24, commentsPerHour: 0 };
  }
  if (canReply && !canPost) {
    return { dailyTurns: turns, postsPerHour: 0, commentsPerHour: turns / 24 };
  }
  if (!canPost && !canReply) return { dailyTurns: turns, postsPerHour: 0, commentsPerHour: 0 };

  // Bots with both abilities join existing discussions more often than they
  // start new ones. The two rates always add up to the central allowance.
  return {
    dailyTurns: turns,
    postsPerHour: turns / (3 * 24),
    commentsPerHour: (turns * 2) / (3 * 24),
  };
}

function sooner(existing, dueAt) {
  const value = Number(existing);
  return Number.isFinite(value) && value > 0 ? Math.min(value, dueAt) : dueAt;
}

function seedFirstTurn(sched, profile, dueAt) {
  const next = { ...(sched && typeof sched === 'object' ? sched : {}) };
  const { canPost, canReply } = capabilities(profile);
  if (canPost) next.nextPostAt = sooner(next.nextPostAt, dueAt);
  if (canReply) next.nextCommentAt = sooner(next.nextCommentAt, dueAt);
  return next;
}

function applyHostedPolicy(patch = {}, current = {}, at = Date.now()) {
  // hostedActivatedAt is server-managed. Import and browser payloads cannot
  // manufacture or reset the temporary new-bot boost.
  const supplied = { ...patch };
  delete supplied.hostedActivatedAt;
  const savedActivation = activationTime(current);
  const merged = {
    ...current,
    ...supplied,
    hostedActivatedAt: savedActivation == null ? null : new Date(savedActivation).toISOString(),
  };
  const firstActivation = merged.enabled === true && savedActivation == null;
  if (firstActivation) merged.hostedActivatedAt = new Date(at).toISOString();

  const allocation = allocationFor(merged, at);
  const rates = ratesForDailyTurns(merged, allocation.dailyTurns);
  const managed = {
    ...supplied,
    hostedActivatedAt: merged.hostedActivatedAt,
    hostedDailyTurns: rates.dailyTurns,
    postsPerHour: rates.postsPerHour,
    commentsPerHour: rates.commentsPerHour,
  };

  if (firstActivation) {
    const dueAt = at + FIRST_TURN_DELAY_MS;
    managed.sched = seedFirstTurn(merged.sched, merged, dueAt);
    const simulationState = merged.simulationState && typeof merged.simulationState === 'object'
      ? merged.simulationState
      : {};
    managed.simulationState = {
      ...simulationState,
      sched: seedFirstTurn(simulationState.sched, merged, dueAt),
    };
  }
  return managed;
}

function runtimePolicy() {
  return {
    managedCadence: true,
    standardDailyTurns: STANDARD_DAILY_TURNS,
    newBotDailyTurns: NEW_BOT_DAILY_TURNS,
    newBotBoostHours: NEW_BOT_BOOST_MS / (60 * 60 * 1000),
    firstTurnDueMinutes: FIRST_TURN_DELAY_MS / (60 * 1000),
    maxActiveJobsPerBot: MAX_ACTIVE_JOBS_PER_BOT,
    queueOrder: 'round-robin-with-aging',
  };
}

module.exports = {
  STANDARD_DAILY_TURNS,
  NEW_BOT_DAILY_TURNS,
  NEW_BOT_BOOST_MS,
  FIRST_TURN_DELAY_MS,
  RECONCILE_INTERVAL_MS,
  MAX_ACTIVE_JOBS_PER_BOT,
  activationTime,
  allocationFor,
  applyHostedPolicy,
  ratesForDailyTurns,
  runtimePolicy,
  seedFirstTurn,
};
