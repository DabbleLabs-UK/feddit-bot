'use strict';

const assert = require('node:assert/strict');
const ui = require('../public/ui-speed');

const now = Date.parse('2026-10-02T10:00:00.000Z');
const active = { multiplier: 5, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 8_043_000).toISOString() };

assert.equal(ui.triggerLabel({}, now), '\u26a1 Speed');
assert.equal(ui.triggerLabel(active, now), '\u26a1 5\u00d7 \u00b7 2h 14m 3s');
assert.equal(ui.triggerLabel(active, now + 3_000), '\u26a1 5\u00d7 \u00b7 2h 14m 0s');
assert.equal(ui.stateAt(active, now + 8_043_000).active, false, 'expired state renders as inactive without stale countdown');
assert.deepEqual(ui.MULTIPLIERS, [1, 2, 5, 10, 25, 50, 100]);

console.log('ui-speed: all checks passed');
