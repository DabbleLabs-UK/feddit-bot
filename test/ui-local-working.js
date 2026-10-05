'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ui = require('../public/ui-workspace-activity');
const profiles = [
  { id: 'stable-a', groupId: 'one', referenceName: 'Shared name' },
  { id: 'stable-b', groupId: 'two', referenceName: 'Shared name' },
  { id: 'root', groupId: 'deleted', referenceName: 'Ungrouped bot' },
];
const groups = [{ id: 'one', name: 'First' }, { id: 'two', name: 'Second' }];
const snapshot = (overrides = {}) => ({ active: {
  status: 'running', kind: 'scheduled-reply', profileId: 'stable-b', botName: 'Outdated name', action: 'writing a comment', ...overrides,
} });
const original = JSON.stringify(profiles);
for (const kind of ['scheduled-generation', 'scheduled-reply', 'scheduled-vote', 'simulation-now', 'burst-session']) {
  const work = ui.localWork(snapshot({ kind }), profiles);
  assert.equal(work.profileId, 'stable-b');
  assert.equal(work.name, 'Shared name');
  assert.match(work.label, /Local model working - Shared name - writing a comment/);
}
for (const status of ['completed', 'failed', 'cancelled', 'canceled', 'recovered', 'idle', undefined]) {
  assert.equal(ui.localWork(snapshot({ status }), profiles), null, status + ' cannot remain working');
}
for (const value of [null, undefined, {}, { active: null }, { recent: [snapshot().active] }]) {
  assert.equal(ui.localWork(value, profiles), null, 'only live active records create work');
}
assert.equal(ui.localWork(snapshot({ profileId: 'missing', botName: 'Shared name' }), profiles).profileId, null, 'names never substitute for stable IDs');
assert.equal(ui.localWork(snapshot({ profileId: 'STABLE-B' }), profiles).profileId, null, 'IDs match exactly');
assert.equal(ui.localWork(snapshot(), []).profileId, null, 'removed profiles do not receive work');
assert.equal(ui.localWork(snapshot({ action: 'writing bot output' }), profiles).label, 'Local model working - Shared name');
assert.equal(ui.localWork(snapshot({ action: 'x'.repeat(200) }), profiles).action.length, 120);
assert.equal(JSON.stringify(profiles), original, 'deriving work does not change profile state');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = html.slice(html.indexOf('function renderLocalWorkingIndicators()'), html.indexOf('// Runner-wide controls:'));
const profileBadges = profiles.map((profile) => ({ dataset: { localWorkingProfile: profile.id }, hidden: true, title: '' }));
const groupBadges = [...groups, { id: '' }].map((group) => ({ dataset: { localWorkingGroup: group.id }, hidden: true, title: '' }));
const state = { profiles, groups, localModelActivity: snapshot(), placement: 'local' };
const sandbox = {
  state, workspaceActivityUi: ui,
  document: { querySelectorAll: (selector) => selector === '[data-local-working-profile]' ? profileBadges : groupBadges },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
function render(value) {
  state.localModelActivity = value;
  vm.runInContext('renderLocalWorkingIndicators()', sandbox);
}
function expectVisible(profileIds, groupIds) {
  assert.deepEqual(profileBadges.filter((badge) => !badge.hidden).map((badge) => badge.dataset.localWorkingProfile), profileIds);
  assert.deepEqual(groupBadges.filter((badge) => !badge.hidden).map((badge) => badge.dataset.localWorkingGroup), groupIds);
  for (const badge of [...profileBadges, ...groupBadges]) assert.equal(Boolean(badge.title), !badge.hidden, 'stale titles clear with badges');
}
render(snapshot());
expectVisible(['stable-b'], ['two']);
render(snapshot({ profileId: 'stable-a' }));
expectVisible(['stable-a'], ['one']);
render(snapshot({ profileId: 'root' }));
expectVisible(['root'], ['']);
for (const value of [null, { active: null, recent: [snapshot().active] }, ...['completed', 'failed', 'cancelled', 'recovered'].map((status) => snapshot({ status }))]) {
  render(snapshot());
  expectVisible(['stable-b'], ['two']);
  render(value);
  expectVisible([], []);
}
for (const [kind, name] of [
  ['preview', 'Manual preview'],
  ['population-seed', 'Character creation'],
  ['population-community-discovery', 'Character community discovery'],
  ['culture-analyse', 'Importer culture analysis'],
  ['culture-generate', 'Importer character generation'],
  ['culture-repair', 'Non-bot generation'],
  ['unknown', 'Non-bot generation'],
]) {
  const value = snapshot({ kind });
  assert.equal(ui.localWork(value, profiles).profileId, null, kind + ' does not attribute non-bot work to a selected profile');
  assert.equal(ui.localWork(value, profiles).name, name);
  render(snapshot());
  render(value);
  expectVisible([], []);
}
render(snapshot({ profileId: 'missing', botName: 'Shared name' }));
expectVisible([], []);
render(snapshot());
state.placement = 'hosted';
render(snapshot());
expectVisible([], []);
state.placement = 'local';
render(snapshot());
expectVisible(['stable-b'], ['two']);
console.log('ui-local-working: all checks passed');
