'use strict';

const MULTIPLIERS = Object.freeze([1, 2, 5, 10, 25, 50, 100]);
const DURATIONS_MS = Object.freeze({
  '30m': 30 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  untilOff: null,
});

function inactiveState() {
  return { multiplier: 1, startedAt: null, expiresAt: null };
}

function validMultiplier(value) {
  const multiplier = Number(value);
  return MULTIPLIERS.includes(multiplier) ? multiplier : 1;
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return inactiveState();
  const multiplier = validMultiplier(raw.multiplier);
  if (multiplier === 1) return inactiveState();
  const started = Date.parse(String(raw.startedAt || ''));
  const expires = raw.expiresAt == null ? NaN : Date.parse(String(raw.expiresAt));
  return {
    multiplier,
    startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null,
    expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
  };
}

function startState(multiplier, duration, nowMs = Date.now()) {
  const selected = Number(multiplier);
  if (!MULTIPLIERS.includes(selected)) {
    const error = new Error('Choose a Speed multiplier of 1x, 2x, 5x, 10x, 25x, 50x, or 100x.');
    error.code = 'INVALID_SPEED_MULTIPLIER';
    throw error;
  }
  if (selected === 1) return inactiveState();
  if (!Object.prototype.hasOwnProperty.call(DURATIONS_MS, duration)) {
    const error = new Error('Choose a Speed duration of 30 minutes, 3 hours, or until turned off.');
    error.code = 'INVALID_SPEED_DURATION';
    throw error;
  }
  const now = Number(nowMs);
  if (!Number.isFinite(now)) throw new Error('Speed requires a valid start time.');
  const durationMs = DURATIONS_MS[duration];
  return {
    multiplier: selected,
    startedAt: new Date(now).toISOString(),
    expiresAt: durationMs == null ? null : new Date(now + durationMs).toISOString(),
  };
}

function inspect(raw, nowMs = Date.now()) {
  const state = normalizeState(raw);
  const now = Number(nowMs);
  const expiresMs = state.expiresAt == null ? null : Date.parse(state.expiresAt);
  const expired = state.multiplier > 1 && expiresMs != null && expiresMs <= now;
  const active = state.multiplier > 1 && !expired;
  return {
    ...state,
    active,
    expired,
    effectiveMultiplier: active ? state.multiplier : 1,
    remainingMs: active && expiresMs != null ? Math.max(0, expiresMs - now) : null,
  };
}

function publicState(raw, nowMs = Date.now()) {
  const state = inspect(raw, nowMs);
  return {
    multiplier: state.effectiveMultiplier,
    active: state.active,
    startedAt: state.active ? state.startedAt : null,
    expiresAt: state.active ? state.expiresAt : null,
    remainingMs: state.remainingMs,
    untilTurnedOff: state.active && state.expiresAt == null,
  };
}

function scaleDelay(delayMs, multiplier) {
  const delay = Math.max(0, Number(delayMs) || 0);
  return delay / validMultiplier(multiplier);
}

function rescaleFutureDeadline(deadlineMs, nowMs, fromMultiplier, toMultiplier) {
  const deadline = Number(deadlineMs);
  const now = Number(nowMs);
  if (!Number.isFinite(deadline) || !Number.isFinite(now) || deadline <= now) return null;
  const from = validMultiplier(fromMultiplier);
  const to = validMultiplier(toMultiplier);
  return now + (deadline - now) * from / to;
}

module.exports = {
  MULTIPLIERS,
  DURATIONS_MS,
  inactiveState,
  normalizeState,
  startState,
  inspect,
  publicState,
  scaleDelay,
  rescaleFutureDeadline,
};
