(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FedditUiSpeed = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MULTIPLIERS = [1, 2, 5, 10, 25, 50, 100];

  function stateAt(raw, nowMs) {
    const now = Number(nowMs);
    const multiplier = MULTIPLIERS.includes(Number(raw && raw.multiplier))
      ? Number(raw.multiplier)
      : 1;
    const expiresAt = raw && raw.expiresAt ? String(raw.expiresAt) : null;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : null;
    const active = multiplier > 1 && !(Number.isFinite(expiresMs) && expiresMs <= now);
    return {
      active,
      multiplier: active ? multiplier : 1,
      expiresAt: active ? expiresAt : null,
      remainingMs: active && Number.isFinite(expiresMs) ? Math.max(0, expiresMs - now) : null,
      untilTurnedOff: active && !expiresAt,
    };
  }

  function remainingLabel(milliseconds) {
    let seconds = Math.max(0, Math.ceil((Number(milliseconds) || 0) / 1000));
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;
    const parts = [];
    if (hours) parts.push(hours + 'h');
    if (hours || minutes) parts.push(minutes + 'm');
    parts.push(seconds + 's');
    return parts.join(' ');
  }

  function triggerLabel(raw, nowMs) {
    const state = stateAt(raw, nowMs);
    if (!state.active) return '\u26a1 Speed';
    const duration = state.untilTurnedOff ? 'until off' : remainingLabel(state.remainingMs);
    return '\u26a1 ' + state.multiplier + '\u00d7 \u00b7 ' + duration;
  }

  return { MULTIPLIERS, stateAt, remainingLabel, triggerLabel };
});
