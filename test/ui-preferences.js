'use strict';

const assert = require('node:assert/strict');
const preferences = require('../public/ui-preferences.js');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

const storage = memoryStorage();
assert.equal(preferences.developerToolsEnabled(storage), false, 'Developer tools default off');
assert.equal(preferences.setDeveloperToolsEnabled(true, storage), true);
assert.equal(preferences.developerToolsEnabled(storage), true, 'enabled preference persists');
assert.equal(preferences.setDeveloperToolsEnabled(false, storage), false);
assert.equal(preferences.developerToolsEnabled(storage), false, 'disabled preference removes the opt-in');
assert.equal(preferences.developerToolsEnabled(memoryStorage({ fedditBotsDeveloperTools: 'true' })), false,
  'only the deliberate current opt-in enables developer tools');
assert.deepEqual(preferences.developerVisibility(false, true), {
  showDeveloperControls: false,
  showTestModeNotice: true,
}, 'a hidden test mode still receives its safety notice');
assert.deepEqual(preferences.developerVisibility(false, false), {
  showDeveloperControls: false,
  showTestModeNotice: false,
});
assert.deepEqual(preferences.developerVisibility(true, true), {
  showDeveloperControls: true,
  showTestModeNotice: false,
}, 'developer mode restores controls instead of replacing state');

console.log('ui-preferences: all checks passed');
