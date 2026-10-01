'use strict';

const assert = require('node:assert/strict');
const placement = require('../public/ui-placement');

const desktop = placement.editorVariant('desktop', { botOrigin: 'user' });
const hosted = placement.editorVariant('hosted', { botOrigin: 'user' });
const population = placement.editorVariant('hosted', { botOrigin: 'system' });

assert.deepEqual(desktop.commonFeatures, hosted.commonFeatures,
  'hosted and desktop use the same common bot-editor feature set');
for (const feature of [
  'run-status', 'collapsible-cards', 'dirty-save', 'floating-save',
  'save-feedback', 'developer-tools-gating', 'activity-layout',
]) {
  assert.ok(desktop.commonFeatures.includes(feature));
}
assert.equal(desktop.showProviderSelector, true);
assert.equal(desktop.showLocalModelControls, true);
assert.equal(desktop.showHostedWorkerControls, false);
assert.equal(hosted.showProviderSelector, false);
assert.equal(hosted.showLocalModelControls, false);
assert.equal(hosted.showHostedWorkerControls, true);
assert.equal(hosted.showCadenceRates, false, 'ordinary hosted cadence remains managed');
assert.equal(population.showCadenceRates, true, 'operator-managed population cadence remains editable');

console.log('ui-placement: all checks passed');
