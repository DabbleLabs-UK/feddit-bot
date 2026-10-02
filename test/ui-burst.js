'use strict';

const assert = require('node:assert/strict');
const ui = require('../public/ui-burst');

const now = Date.parse('2026-10-02T10:00:00.000Z');
const active = {
  active: true,
  provider: 'chatgpt-plan',
  expiresAt: new Date(now + 8_043_000).toISOString(),
  currentTurnId: 'turn-1',
  currentProfileId: 'bot-a',
};

assert.equal(ui.triggerLabel({}, now), '\u2728 Burst');
assert.equal(ui.triggerLabel(active, now), '\u2728 Burst \u00b7 ChatGPT \u00b7 2h 14m 3s');
assert.equal(ui.stateAt(active, now).currentProfileId, 'bot-a');
assert.equal(ui.stateAt(active, now + 8_043_000).active, false, 'expired state has no stale active countdown');
assert.equal(ui.triggerLabel({ ...active, active: false, stopping: true }, now), '\u2728 Burst \u00b7 stopping safely');
assert.deepEqual(ui.availableProviders([
  { id: 'ollama', label: 'Ollama', state: 'ready' },
  { id: 'deepseek', label: 'DeepSeek', state: 'ready' },
  { id: 'chatgpt-plan', label: 'ChatGPT plan', state: 'ready' },
  { id: 'claude-plan', label: 'Claude subscription', state: 'auth-required', detail: 'Sign in.' },
]), [
  { id: 'chatgpt-plan', label: 'ChatGPT plan', ready: true, detail: '' },
  { id: 'claude-plan', label: 'Claude subscription', ready: false, detail: 'Sign in.' },
], 'only subscription-backed providers are offered and unavailable ones are explicit');

console.log('ui-burst: all checks passed');
