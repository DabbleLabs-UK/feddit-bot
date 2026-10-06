'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
const render = html.slice(html.indexOf('function renderList()'), html.indexOf('function runStatePresentation'));
const ui = require('../public/ui-workspace-activity');
const indicators = html.slice(html.indexOf('function renderLocalWorkingIndicators()'), html.indexOf('// Runner-wide controls:'));
const has = (row, name) => row.className.split(/\s+/).includes(name);
function createElement(tagName = 'div') {
  return {
    tagName: tagName.toUpperCase(), className: '', children: [], attributes: {}, dataset: {}, nodes: [],
    hidden: false, title: '',
    set innerHTML(value) {
      this.markup = value;
      this.children = [];
      this.nodes = [];
      for (const match of value.matchAll(/<(button|span)\b([^>]*)>/g)) {
        const node = createElement(match[1]);
        node.className = (match[2].match(/class="([^"]*)"/) || [])[1] || '';
        node.hidden = /\bhidden\b/.test(match[2]);
        for (const data of match[2].matchAll(/data-([\w-]+)="([^"]*)"/g)) {
          node.dataset[data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = data[2];
        }
        this.nodes.push(node);
      }
    },
    get innerHTML() { return this.markup || ''; },
    appendChild(child) { child.parentNode = this; this.children.push(child); },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll(selector) {
      const matches = (node) => selector === 'button' ? node.tagName === 'BUTTON'
        : selector.startsWith('.') ? has(node, selector.slice(1))
        : Object.hasOwn(node.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()));
      return [...this.nodes, ...this.children].flatMap((node) => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0]; },
    get classList() { return { add: (...names) => { this.className += ' ' + names.join(' '); }, toggle() {} }; },
  };
}
const list = createElement('ul');
let stored = '{}';
const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
const profiles = [
  { id: 'a', groupId: 'named', botOrigin: 'user', referenceName: 'Same name' },
  { id: 'b', groupId: 'named', botOrigin: 'system', referenceName: 'Same name' },
  { id: 'root', groupId: 'deleted', referenceName: 'Root bot' },
  { id: 'unassigned', groupId: '', referenceName: 'Ungrouped bot' },
];
const originalProfiles = JSON.stringify(profiles);
const state = { profiles, groups: [{ id: 'named', name: 'Named' }], selected: 'b',
  localModelActivity: { active: { status: 'running', kind: 'scheduled-reply', profileId: 'b' } } };
const selected = [];
const runChanges = [];
const sandbox = {
  state, document: { createElement, querySelectorAll: (selector) => list.querySelectorAll(selector) },
  $: (selector) => selector === '#plist' ? list : createElement(),
  workspaceActivityUi: { ...ui, isCollapsed: (id) => ui.isCollapsed(id, storage), setCollapsed: (id, value) => ui.setCollapsed(id, value, storage) },
  esc: String, capabilitySummary: () => '', sentenceCase: String, fmtNext: () => '',
  selectProfile: (id) => selected.push(id), setProfileRunState: (...args) => runChanges.push(args),
};
vm.createContext(sandbox);
vm.runInContext(indicators + '\n' + render + '\nrenderList();', sandbox);
assert.equal(list.children.length, 4, 'each root has a header and the same descendant region');
const region = list.children[1];
assert.ok(has(region, 'workspace-group-region'));
const tree = region.children[0];
assert.equal(tree.tagName, 'UL');
assert.equal(tree.attributes['aria-label'], 'Named children');
assert.equal(tree.children.length, 2, 'each origin has its own list item');
for (const [index, label] of ['Your bots', 'Background population'].entries()) {
  const origin = tree.children[index];
  assert.equal(origin.tagName, 'LI');
  assert.ok(has(origin, 'workspace-subgroup'));
  assert.equal(origin.children[0].tagName, 'DIV');
  assert.equal(origin.children[1].tagName, 'UL');
  assert.equal(origin.children[1].attributes['aria-label'], label);
  assert.equal(origin.children[1].children[0].tagName, 'LI');
  assert.ok(has(origin.children[1].children[0], 'workspace-group-bot'));
}
const selectedRow = tree.children[1].children[1].children[0];
assert.ok(has(selectedRow, 'active'));
selectedRow.onclick();
assert.deepEqual(selected, ['b'], 'nested bot selection uses the existing handler');
let stopped = false;
selectedRow.querySelector('.profile-run-button').onclick({ stopPropagation() { stopped = true; } });
assert.equal(stopped, true);
assert.deepEqual(runChanges, [['b', true]]);
const ungroupedRegion = list.children[3];
assert.equal(list.children[2].dataset.depth, '0');
assert.ok(has(ungroupedRegion, 'workspace-group-region'));
const ungroupedTree = ungroupedRegion.children[0];
assert.equal(ungroupedTree.attributes['aria-label'], 'Ungrouped children');
const userSubsection = ungroupedTree.children[0];
assert.equal(userSubsection.className, tree.children[0].className, 'same structural class for both roots');
assert.equal(userSubsection.dataset.depth, '1');
assert.equal(userSubsection.children[1].attributes['aria-label'], 'Your bots');
assert.equal(userSubsection.children[1].children.length, 2);
for (const row of userSubsection.children[1].children) {
  assert.equal(row.dataset.depth, '2');
  assert.ok(has(row, 'workspace-group-child'));
  assert.ok(has(row, 'workspace-group-bot'));
}
assert.equal(list.querySelectorAll('[data-local-working-profile]').filter((badge) => !badge.hidden)[0].dataset.localWorkingProfile, 'b');
assert.equal(list.querySelectorAll('[data-local-working-group]').filter((badge) => !badge.hidden)[0].dataset.localWorkingGroup, 'named');
list.children[0].querySelector('button').onclick();
assert.equal(ui.isCollapsed('named', storage), true);
assert.equal(list.children.length, 3, 'collapse removes only the named subtree');
assert.equal(list.querySelectorAll('.workspace-group-region').length, 1);
assert.match(list.children[0].innerHTML, /aria-expanded="false"/);
assert.equal(list.querySelectorAll('[data-local-working-profile]').length, 2);
assert.equal(list.querySelectorAll('[data-local-working-group]')[0].hidden, false, 'collapsed group still shows active work');
assert.equal(state.selected, 'b');
list.children[1].querySelector('button').onclick();
assert.equal(list.children.length, 2, 'ungrouped also collapses');
assert.equal(list.querySelectorAll('.workspace-group-child').length, 0, 'collapsed roots have no rails or elbows');
list.children[0].querySelector('button').onclick();
assert.equal(list.children.length, 3);
assert.ok(has(list.children[1].children[0].children[1].children[1].children[0], 'active'), 'expansion restores selected styling');
state.localModelActivity = null;
vm.runInContext('renderLocalWorkingIndicators()', sandbox);
assert.ok(list.querySelectorAll('[data-local-working-group]').every((badge) => badge.hidden));
assert.ok(list.querySelectorAll('[data-local-working-profile]').every((badge) => badge.hidden));
assert.equal(JSON.stringify(profiles), originalProfiles, 'rendering/collapse never changes stored membership');
assert.deepEqual(state.groups, [{ id: 'named', name: 'Named' }], 'no persistent Ungrouped group is introduced');
console.log('ui-group-hierarchy: all checks passed');
