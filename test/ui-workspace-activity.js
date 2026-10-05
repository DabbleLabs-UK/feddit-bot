'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ui = require('../public/ui-workspace-activity');

const groups = [{ id: 'g1', name: 'Cohort' }, { id: 'empty', name: 'Empty group' }];
const profiles = [
  { id: 'a', groupId: 'g1', dryRun: false, botOrigin: 'system' },
  { id: 'b', groupId: 'g1', dryRun: true, botOrigin: 'user' },
  { id: 'c', groupId: 'missing', dryRun: false },
  { id: 'd' },
];
const original = JSON.stringify({ groups, profiles });
const rows = ui.sidebarGroups(profiles, groups);
assert.deepEqual(rows.map((row) => [row.id, row.profiles.length, row.live, row.rehearsal]), [
  ['g1', 2, 1, 1], ['empty', 0, 0, 0], ['', 2, 1, 1],
]);
assert.equal(rows[0].profiles[0].botOrigin, 'system');
assert.equal(rows[0].profiles[1].botOrigin, 'user');
assert.equal(JSON.stringify({ groups, profiles }), original, 'grouping does not mutate profiles or origin');
let stored = null;
const storage = { getItem: () => stored, setItem: (key, value) => { stored = value; } };
ui.setCollapsed('g1', true, storage);
assert.equal(ui.isCollapsed('g1', storage), true);
ui.setCollapsed('', true, storage);
ui.setCollapsed('g1', false, storage);
assert.equal(ui.isCollapsed('g1', storage), false);
assert.equal(ui.isCollapsed('', storage), true);
stored = 'invalid JSON';
assert.doesNotThrow(() => ui.isCollapsed('g1', storage));
assert.doesNotThrow(() => ui.setCollapsed('g1', true, { getItem() { throw Error('private'); }, setItem() { throw Error('private'); } }));

assert.equal(ui.forecastPath({}), '/api/activity-forecast?mode=live&zeroCadence=all');
assert.equal(ui.forecastPath({ mode: 'rehearsal', groupId: '', type: 'vote', zeroCadence: 'only' }), '/api/activity-forecast?mode=rehearsal&zeroCadence=only&groupId=&type=vote');
assert.match(ui.forecastPath({ mode: 'all', groupId: 'group&x' }), /groupId=group%26x/);
const now = Date.parse('2026-10-05T12:00:00Z');
assert.match(ui.dueLabel({ at: now - 1 }, now), /Due now.*capacity/);
assert.equal(ui.dueLabel({ at: now + 13 * 60000 }, now), 'In 13m');
assert.match(ui.dueLabel({ at: now - 1, backoffUntil: now + 60000 }, now), /^Backoff until/);
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const data = {
  upcoming: [{ profileId: 'a"', botName: '<Bot>', groupName: '<Group>', type: 'text', at: now - 1, mode: 'live' }],
  activeNoCadence: [{ profileId: 'b', botName: 'Idle', mode: 'live' }],
  projections: Object.fromEntries(['1h', '24h', '7d'].map((key) => [key, { total: 3.5, botCount: 2, groupCount: 1, byType: { text: 1, article: 0.5, reply: 1, vote: 1 }, groups: [{ id: 'g1', name: '<Group>', total: 3.5, botCount: 2 }] }])),
  hourlyBuckets: [{ startAt: now, endAt: now + 3600000, total: 0 }],
  dailyBuckets: [{ startAt: now, endAt: now + 86400000, total: 3.5 }],
  assumptions: ['<safe>'],
};
const rendered = ui.forecastHtml(data, esc, now);
assert.match(rendered, /Projected opportunities/);
for (const title of ['Next 1 hour', 'Next 24 hours', 'Next 7 days', 'Hourly - next 24 hours', 'Daily - next 7 days']) assert.ok(rendered.includes(title));
assert.match(rendered, /Active but no cadence: 1/);
assert.match(rendered, /Due now - awaiting scheduler or capacity/);
assert.match(rendered, /&lt;Bot&gt;/);
assert.match(rendered, /data-forecast-profile="a&quot;"/);
assert.doesNotMatch(rendered, /<Bot>|<Group>|<safe>|NaN|Infinity/);
assert.match(rendered, /Burst, manual and unpredictable event-driven work are excluded/);
assert.match(ui.forecastHtml({}, esc, now), /No stored scheduled opportunity matches/);
assert.match(ui.forecastHtml({ schedulerPaused: true }, esc, now), /workspace scheduler is paused/);
assert.match(ui.forecastHtml({ paused: true }, esc, now), /potential activity after resuming/);

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui-workspace-activity.js'), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
assert.doesNotThrow(() => new vm.Script(inline), 'shared browser script remains syntactically valid');
assert.match(html, /<script src="\/ui-workspace-activity.js"><\/script>/);
assert.match(html, /id="forecastMode"[\s\S]*?<option value="live">LIVE<\/option>/);
assert.match(source, /await selectProfile\(button.dataset.forecastProfile\)/, 'bot navigation uses the dirty-editor guard');
assert.doesNotMatch(source, /collectForm|captureEditorBaseline|renderEditor|saveProfile|guardUnsavedChanges/, 'overview and group changes do not touch unsaved editor data');
assert.match(source, /profileId: find\('groupBot'\).value/, 'new groups use the selected bot ownership scope');
assert.match(source, /api\(path, \{ method, body \}\)/);
assert.match(source, /await loadProfiles\(\)/);
assert.match(html, /groupId: latest.groupId/);
assert.match(html, /hasScheduledCadence: latest.hasScheduledCadence/);
assert.match(html, /p.hasScheduledCadence === false \? 'no scheduled cadence' : 'awaiting scheduler'/);
assert.match(html, /Capabilities show what a bot can do, not how often it is scheduled/);
assert.match(html, /Abilities describe what this bot can do/);

async function controllerChecks() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', innerHTML: '', textContent: '', open: true, disabled: false, options: [],
      setAttribute() {}, addEventListener() {}, querySelectorAll: () => [],
      querySelector: () => element(id + '-button'),
    });
    return elements.get(id);
  }
  const state = { groups: [], profiles: [{ id: 'a', referenceName: 'Bot' }], selected: 'a', dirty: true, editing: { persona: 'Unsaved draft' } };
  const before = JSON.stringify(state.editing);
  const requests = [];
  let reloads = 0;
  let openedBot = null;
  const botLink = { dataset: { forecastProfile: 'a' } };
  element('forecastContent').querySelectorAll = () => [botLink];
  const controller = ui.createController({
    document: { getElementById: element }, getState: () => state, esc,
    api: async (url, options) => { requests.push({ url, options }); return { ...data, generatedAt: now }; },
    loadProfiles: async () => { reloads++; },
    selectProfile: async (id) => { openedBot = id; return false; },
    openDialog: (dialog) => { dialog.open = true; }, closeDialog: (dialog) => { dialog.open = false; },
  });
  element('forecastMode').value = 'live';
  element('forecastGroup').value = '*';
  await controller.refreshForecast();
  assert.equal(requests[0].url, '/api/activity-forecast?mode=live&zeroCadence=all');
  assert.equal(reloads, 0, 'opening forecast does not reload or save a profile');
  assert.equal(JSON.stringify(state.editing), before);
  assert.equal(state.dirty, true);
  await botLink.onclick();
  assert.equal(openedBot, 'a', 'forecast bot link delegates navigation to the guarded selector');
  assert.equal(element('activityForecastDialog').open, false);
  element('groupBot').value = 'a';
  element('groupDestination').value = 'g1';
  await element('assignGroupForm').onsubmit({ preventDefault() {} });
  assert.deepEqual(requests[1], { url: '/api/profiles/a/group', options: { method: 'PUT', body: { groupId: 'g1' } } });
  assert.equal(reloads, 1);
  assert.equal(JSON.stringify(state.editing), before, 'assignment leaves the unsaved editor intact');
  assert.equal(state.dirty, true);
  element('newGroupName').value = ' New cohort ';
  element('groupBot').value = 'a';
  await element('createGroupForm').onsubmit({ preventDefault() {} });
  assert.deepEqual(requests[2], { url: '/api/groups', options: { method: 'POST', body: { name: 'New cohort', profileId: 'a' } } });
  assert.equal(element('newGroupName').value, '');
}

controllerChecks().then(() => console.log('ui-workspace-activity: all checks passed')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
