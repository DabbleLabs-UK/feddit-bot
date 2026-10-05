'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
const render = html.slice(html.indexOf('function renderList()'), html.indexOf('function runStatePresentation'));
const rows = [];
const createElement = () => ({
  className: '', innerHTML: '', querySelector: () => ({}),
  get classList() { return { add: (...names) => { this.className += ' ' + names.join(' '); }, toggle() {} }; },
});
let collapsed = false;
const profiles = [{ id: 'a', botOrigin: 'user' }, { id: 'b', botOrigin: 'system' }];
const state = { profiles, groups: [], selected: 'b' };
const sandbox = {
  state, document: { createElement },
  $: (selector) => selector === '#plist' ? { set innerHTML(value) { rows.length = 0; }, appendChild: (row) => rows.push(row) } : createElement(),
  workspaceActivityUi: { sidebarGroups: () => [
    { id: 'named', name: 'Named', profiles, live: 0, rehearsal: 2 },
    { id: '', name: 'Ungrouped', profiles: [{ id: 'root' }], live: 0, rehearsal: 1 },
  ], isCollapsed: (id) => id === 'named' && collapsed },
  esc: String, capabilitySummary: () => '', sentenceCase: String, fmtNext: () => '',
};
vm.createContext(sandbox);
vm.runInContext(render + '\nrenderList();', sandbox);
const has = (row, name) => row.className.split(/\s+/).includes(name);
assert.equal(rows.filter((row) => has(row, 'workspace-group-child')).length, 4, 'two origin headings and two bots share a rail');
assert.equal(rows.filter((row) => has(row, 'workspace-group-bot')).length, 2);
assert.equal(rows.filter((row) => has(row, 'workspace-group-last')).length, 1, 'last branch is across origin subgroups');
assert.ok(has(rows[4], 'active') && has(rows[4], 'workspace-group-last'));
assert.ok(!has(rows[0], 'workspace-group-child'), 'named header stays at root');
assert.ok(rows.slice(5).every((row) => !has(row, 'workspace-group-child')), 'ungrouped stays at root');
collapsed = true;
vm.runInContext('renderList()', sandbox);
assert.equal(rows.filter((row) => has(row, 'workspace-group-child')).length, 0);
assert.equal(rows.length, 4, 'collapsed header plus unchanged ungrouped header/origin/bot');
console.log('ui-group-hierarchy: 8 checks passed');
