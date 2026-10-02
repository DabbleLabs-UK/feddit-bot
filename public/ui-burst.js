(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FedditUiBurst = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROVIDERS = ['chatgpt-plan', 'claude-plan'];

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

  function stateAt(raw, nowMs) {
    const expiresAt = raw && raw.expiresAt ? String(raw.expiresAt) : null;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : null;
    const active = raw && raw.active === true && PROVIDERS.includes(String(raw.provider || '')) &&
      !(Number.isFinite(expiresMs) && expiresMs <= Number(nowMs));
    return {
      active,
      stopping: !active && Boolean(raw && raw.stopping && raw.currentTurnId),
      provider: active || (raw && raw.currentTurnId) ? String(raw.provider || '') : '',
      expiresAt: active ? expiresAt : null,
      remainingMs: active && Number.isFinite(expiresMs) ? Math.max(0, expiresMs - Number(nowMs)) : null,
      untilTurnedOff: active && !expiresAt,
      currentProfileId: raw && raw.currentTurnId ? String(raw.currentProfileId || '') : '',
      currentTurnId: raw && raw.currentTurnId ? String(raw.currentTurnId) : '',
      recentSessions: raw && Array.isArray(raw.recentSessions) ? raw.recentSessions : [],
      lastFailure: raw && raw.lastFailure || null,
    };
  }

  function providerLabel(provider) {
    return provider === 'chatgpt-plan' ? 'ChatGPT' : (provider === 'claude-plan' ? 'Claude' : 'subscription');
  }

  function triggerLabel(raw, nowMs) {
    const state = stateAt(raw, nowMs);
    if (state.stopping) return '\u2728 Burst \u00b7 stopping safely';
    if (!state.active) return '\u2728 Burst';
    const duration = state.untilTurnedOff ? 'until off' : remainingLabel(state.remainingMs);
    return '\u2728 Burst \u00b7 ' + providerLabel(state.provider) + ' \u00b7 ' + duration;
  }

  function availableProviders(statuses) {
    return (Array.isArray(statuses) ? statuses : [])
      .filter((item) => PROVIDERS.includes(item.id))
      .map((item) => ({ id: item.id, label: item.label, ready: item.state === 'ready', detail: item.detail || '' }));
  }

  return { PROVIDERS, remainingLabel, stateAt, providerLabel, triggerLabel, availableProviders };
});
