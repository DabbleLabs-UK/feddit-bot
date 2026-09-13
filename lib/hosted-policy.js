'use strict';

// Public hosted bots share one small DELL inference pool. Cadence is therefore
// a host policy, not an arbitrary number supplied by the browser. Desktop and
// advanced placements do not use this module and retain their detailed rates.

const DAILY_TURN_CHOICES = Object.freeze([1, 3, 6]);
const DEFAULT_DAILY_TURNS = 1;
const MAX_ACTIVE_JOBS_PER_BOT = 1;

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nearestDailyTurns(value) {
  const requested = nonNegativeNumber(value) || DEFAULT_DAILY_TURNS;
  return DAILY_TURN_CHOICES.reduce((best, choice) => {
    const distance = Math.abs(choice - requested);
    const bestDistance = Math.abs(best - requested);
    return distance < bestDistance ? choice : best;
  }, DAILY_TURN_CHOICES[0]);
}

function dailyTurnsFromRates(profile = {}) {
  return 24 * (
    nonNegativeNumber(profile.postsPerHour) +
    nonNegativeNumber(profile.commentsPerHour)
  );
}

function ratesForDailyTurns(profile = {}, value) {
  const dailyTurns = nearestDailyTurns(value);
  const modern = profile.canReply !== undefined || profile.canStartDiscussions !== undefined || profile.canShareLinks !== undefined;
  const canReply = modern
    ? profile.canReply === true
    : profile.mode === 'both' || profile.mode === 'comment';
  const canPost = modern
    ? profile.canStartDiscussions === true || profile.canShareLinks === true
    : profile.botType === 'news' || profile.mode === 'both' || profile.mode === 'post';

  if (canPost && !canReply) {
    return { dailyTurns, postsPerHour: dailyTurns / 24, commentsPerHour: 0 };
  }
  if (canReply && !canPost) {
    return { dailyTurns, postsPerHour: 0, commentsPerHour: dailyTurns / 24 };
  }
  if (!canPost && !canReply) return { dailyTurns, postsPerHour: 0, commentsPerHour: 0 };

  // Conversational bots default to joining discussions more often than
  // starting them. The two rates together always equal the chosen allowance.
  return {
    dailyTurns,
    postsPerHour: dailyTurns / (3 * 24),
    commentsPerHour: (dailyTurns * 2) / (3 * 24),
  };
}

function applyHostedPolicy(patch = {}, current = {}) {
  const merged = { ...current, ...patch };
  const explicitlyChosen = Object.prototype.hasOwnProperty.call(patch, 'hostedDailyTurns');
  const alreadyManaged = Object.prototype.hasOwnProperty.call(current, 'hostedDailyTurns');
  const requested = explicitlyChosen
    ? patch.hostedDailyTurns
    : (alreadyManaged ? current.hostedDailyTurns : dailyTurnsFromRates(merged));
  const rates = ratesForDailyTurns(merged, requested);
  return {
    ...patch,
    hostedDailyTurns: rates.dailyTurns,
    postsPerHour: rates.postsPerHour,
    commentsPerHour: rates.commentsPerHour,
  };
}

function runtimePolicy() {
  return {
    dailyTurnChoices: DAILY_TURN_CHOICES.slice(),
    defaultDailyTurns: DEFAULT_DAILY_TURNS,
    maxActiveJobsPerBot: MAX_ACTIVE_JOBS_PER_BOT,
  };
}

module.exports = {
  DAILY_TURN_CHOICES,
  DEFAULT_DAILY_TURNS,
  MAX_ACTIVE_JOBS_PER_BOT,
  applyHostedPolicy,
  dailyTurnsFromRates,
  nearestDailyTurns,
  ratesForDailyTurns,
  runtimePolicy,
};
