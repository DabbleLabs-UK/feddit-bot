'use strict';

// Public hosted bots share one small DELL inference pool. Their cadence is a
// service-wide fairness policy, not a number supplied by an owner. Desktop and
// advanced placements retain their detailed rate controls.

const populationActivity = require('./population-activity');

const STANDARD_DAILY_TURNS = 3;
const NEW_BOT_DAILY_TURNS = 6;
const NEW_BOT_BOOST_MS = 72 * 60 * 60 * 1000;
const OWNER_ACTIVITY_BOOST_MS = 72 * 60 * 60 * 1000;
const FIRST_TURN_DELAY_MS = 2 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_JOBS_PER_BOT = 1;
const ONBOARDING_COMPLETED_TURNS = 5;
const ONBOARDING_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const USER_ORIGIN = 'user';
const SYSTEM_ORIGIN = 'system';

function botOrigin(profile = {}) {
  return profile.botOrigin === SYSTEM_ORIGIN ? SYSTEM_ORIGIN : USER_ORIGIN;
}

function completedOnboardingTurns(profile = {}) {
  return Math.max(0, Math.floor(Number(profile.hostedOnboardingTurnsCompleted) || 0));
}

function activationTime(profile = {}) {
  const value = Date.parse(String(profile.hostedActivatedAt || ''));
  return Number.isFinite(value) ? value : null;
}

function ownerActivityTime(context = {}) {
  const value = Date.parse(String(context.ownerLastActiveAt || ''));
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

function allocationFor(profile = {}, at = Date.now(), context = {}) {
  if (botOrigin(profile) === SYSTEM_ORIGIN) {
    const activity = populationActivity.normalizeState(profile.populationActivity, {
      nowMs: at,
      seed: profile.populationSeed || {},
      quantile: populationActivity.stableUnit(profile.id || profile.fedditUsername || 'system-bot'),
    });
    return {
      phase: 'system-ecology',
      dailyTurns: activity.currentDailyOpportunities,
      activatedAt: activationTime(profile),
      boostEndsAt: null,
      activity,
      processing: processingFor(profile, at),
    };
  }
  const startedAt = activationTime(profile);
  if (startedAt == null) {
    return {
      phase: 'not-started',
      dailyTurns: NEW_BOT_DAILY_TURNS,
      activatedAt: null,
      boostEndsAt: null,
      processing: processingFor(profile, at),
    };
  }
  const initialBoostEndsAt = startedAt + NEW_BOT_BOOST_MS;
  const lastOwnerActivityAt = ownerActivityTime(context);
  const activeOwnerBoostEndsAt = lastOwnerActivityAt == null
    ? null
    : lastOwnerActivityAt + OWNER_ACTIVITY_BOOST_MS;
  const boostEndsAt = Math.max(initialBoostEndsAt, activeOwnerBoostEndsAt || 0);
  const isNew = at < boostEndsAt;
  return {
    phase: isNew ? 'new' : 'standard',
    dailyTurns: isNew ? NEW_BOT_DAILY_TURNS : STANDARD_DAILY_TURNS,
    activatedAt: startedAt,
    boostEndsAt,
    initialBoostEndsAt,
    lastOwnerActivityAt,
    continuedByOwnerActivity: activeOwnerBoostEndsAt != null && activeOwnerBoostEndsAt > initialBoostEndsAt,
    processing: processingFor(profile, at),
  };
}

// Compute allocation is intentionally separate from cadence. User-created bots
// receive a bounded onboarding advantage until they have completed a handful of
// useful scheduled DELL turns. A long-stop prevents a never-used old bot from
// retaining onboarding status forever. System population never receives it.
function processingFor(profile = {}, at = Date.now()) {
  const origin = botOrigin(profile);
  const completedTurns = completedOnboardingTurns(profile);
  const startedAt = activationTime(profile);
  const expiresAt = startedAt == null ? null : startedAt + ONBOARDING_MAX_MS;
  const withinTimeLimit = expiresAt == null || at < expiresAt;
  const onboarding = origin === USER_ORIGIN &&
    completedTurns < ONBOARDING_COMPLETED_TURNS && withinTimeLimit;
  return {
    origin,
    phase: origin === SYSTEM_ORIGIN ? 'system' : (onboarding ? 'onboarding' : 'standard'),
    onboarding,
    completedTurns,
    turnsRemaining: onboarding ? ONBOARDING_COMPLETED_TURNS - completedTurns : 0,
    expiresAt,
    allocationClass: origin === SYSTEM_ORIGIN ? 'synthetic' : 'user',
  };
}

// Synthetic population should make Feddit feel alive only when it is genuinely
// spare work. Refuse to create a new durable turn while DELL is unavailable or
// any work is already waiting/running. Already-created turns are not affected.
function admissionFor(profile = {}, capacity = {}, context = {}) {
  if (botOrigin(profile) !== SYSTEM_ORIGIN) {
    return { admit: true, reason: 'user-created' };
  }
  const busy = capacity.online !== true ||
    Number(capacity.queued || 0) > 0 ||
    Number(capacity.running || 0) > 0 ||
    Number(context.activeSyntheticTurns || 0) > 0;
  return busy
    ? { admit: false, reason: 'synthetic-yields-to-shared-capacity' }
    : { admit: true, reason: 'spare-capacity' };
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

function applyHostedPolicy(patch = {}, current = {}, at = Date.now(), context = {}) {
  // hostedActivatedAt is server-managed. Import and browser payloads cannot
  // manufacture or reset the temporary new-bot boost.
  const supplied = { ...patch };
  delete supplied.hostedActivatedAt;
  delete supplied.botOrigin;
  delete supplied.hostedOnboardingTurnsCompleted;
  delete supplied.populationActivity;
  const savedActivation = activationTime(current);
  const merged = {
    ...current,
    ...supplied,
    botOrigin: botOrigin(current),
    hostedOnboardingTurnsCompleted: completedOnboardingTurns(current),
    hostedActivatedAt: savedActivation == null ? null : new Date(savedActivation).toISOString(),
    populationActivity: botOrigin(current) === SYSTEM_ORIGIN
      ? populationActivity.normalizeState(current.populationActivity, {
        nowMs: at,
        seed: current.populationSeed || {},
        quantile: populationActivity.stableUnit(current.id || current.fedditUsername || 'system-bot'),
      })
      : null,
  };
  const firstActivation = merged.enabled === true && savedActivation == null;
  if (firstActivation) merged.hostedActivatedAt = new Date(at).toISOString();

  const allocation = allocationFor(merged, at, context);
  const rates = ratesForDailyTurns(merged, allocation.dailyTurns);
  const managed = {
    ...supplied,
    botOrigin: merged.botOrigin,
    hostedOnboardingTurnsCompleted: merged.hostedOnboardingTurnsCompleted,
    hostedActivatedAt: merged.hostedActivatedAt,
    populationActivity: merged.populationActivity,
    hostedDailyTurns: rates.dailyTurns,
    postsPerHour: rates.postsPerHour,
    commentsPerHour: rates.commentsPerHour,
  };

  if (firstActivation && merged.botOrigin !== SYSTEM_ORIGIN) {
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
    ownerActivityBoostHours: OWNER_ACTIVITY_BOOST_MS / (60 * 60 * 1000),
    firstTurnDueMinutes: FIRST_TURN_DELAY_MS / (60 * 1000),
    maxActiveJobsPerBot: MAX_ACTIVE_JOBS_PER_BOT,
    onboardingCompletedTurns: ONBOARDING_COMPLETED_TURNS,
    onboardingMaxDays: ONBOARDING_MAX_MS / (24 * 60 * 60 * 1000),
    queueOrder: 'interactive-then-owner-and-profile-fair-share',
    originPolicy: 'User-created work precedes system population; system population is admitted only as spare work.',
  };
}

module.exports = {
  STANDARD_DAILY_TURNS,
  NEW_BOT_DAILY_TURNS,
  NEW_BOT_BOOST_MS,
  OWNER_ACTIVITY_BOOST_MS,
  FIRST_TURN_DELAY_MS,
  RECONCILE_INTERVAL_MS,
  MAX_ACTIVE_JOBS_PER_BOT,
  ONBOARDING_COMPLETED_TURNS,
  ONBOARDING_MAX_MS,
  USER_ORIGIN,
  SYSTEM_ORIGIN,
  botOrigin,
  completedOnboardingTurns,
  activationTime,
  ownerActivityTime,
  allocationFor,
  processingFor,
  admissionFor,
  applyHostedPolicy,
  ratesForDailyTurns,
  runtimePolicy,
  seedFirstTurn,
};
