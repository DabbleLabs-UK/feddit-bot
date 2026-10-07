'use strict';

const assert = require('node:assert/strict');
const { create } = require('../public/ui-naturalness');
const { buildSnapshot } = require('../lib/naturalness-metrics');

class Element {
  constructor(tag, document) { this.tag = tag; this.document = document; this.children = []; this.listeners = {}; this.hidden = false; this.open = false; this.textContent = ''; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  focus() { this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { if (this.tag === 'a') this.document.downloads++; if (this.listeners.click) return this.listeners.click({}); }
  remove() {}
}
function documentStub() {
  const doc = { downloads: 0, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } };
  doc.createElement = tag => new Element(tag, doc);
  doc.head = doc.createElement('head'); doc.body = doc.createElement('body');
  doc.defaultView = { Blob, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} } };
  return doc;
}
const flatten = element => [element, ...element.children.flatMap(flatten)];

(async () => {
  const document = documentStub();
  let developer = false, placement = 'desktop', admin = false, calls = [];
  const snapshot = buildSnapshot({ authoritative: { items: [{ key: 'post:1', up: 3, down: 3, total: 6, title: '<script>PUBLIC</script>', votes: [] }] }, now: Date.parse('2026-10-07T12:00:00Z') });
  const controller = create({ document, api: async path => { calls.push(path); return snapshot; }, getDeveloperTools: () => developer, getPlacement: () => placement, getPopulationAdmin: () => admin, toast() {} });
  await controller.refresh(); await controller.open();
  assert.equal(calls.length, 0, 'hidden or developer-disabled never fetches');
  developer = true; placement = 'hosted';
  await controller.open(); assert.equal(calls.length, 0, 'hosted requires population access');
  admin = true;
  const trigger = document.createElement('button'); trigger.focus();
  await controller.open(trigger);
  assert.deepEqual(calls, ['/api/naturalness?hours=24']);
  const dialog = document.body.children.find(element => element.tag === 'dialog');
  assert.equal(dialog.open, true);
  assert.equal(document.downloads, 0, 'no export on load');
  assert.ok(flatten(dialog).some(element => element.textContent.includes('<script>PUBLIC</script>')));
  assert.equal(flatten(dialog).some(element => element.innerHTML !== undefined), false, 'untrusted public content uses text nodes');
  const select = flatten(dialog).find(element => element['aria-label'] === 'Observation window');
  select.value = '168'; await select.listeners.change();
  assert.equal(calls[1], '/api/naturalness?hours=168');
  const download = flatten(dialog).find(element => element.textContent === 'Download JSON');
  download.click(); assert.equal(document.downloads, 1);
  dialog.listeners.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(dialog.open, false); assert.equal(document.activeElement, trigger);
  await controller.refresh(); assert.equal(calls.length, 2);
  await controller.open(trigger); developer = false;
  document.listeners['developer-tools-change']();
  assert.equal(dialog.hidden, true); assert.equal(dialog.open, false);
  const unsavedField = document.createElement('input'); unsavedField.focus();
  controller.close(); document.listeners['developer-tools-change']();
  assert.equal(document.activeElement, unsavedField, 'already-closed lab never steals focus from the editor');
  await controller.refresh(); assert.equal(calls.length, 3);

  developer = true;
  let resolve;
  const slowDocument = documentStub();
  const slow = create({ document: slowDocument, api: () => new Promise(done => { resolve = done; }), getDeveloperTools: () => developer, getPlacement: () => 'desktop', getPopulationAdmin: () => false });
  const pending = slow.open(); slow.close(); resolve(snapshot); await pending;
  assert.equal(slowDocument.body.children.find(element => element.tag === 'dialog').hidden, true, 'late request cannot reopen dialog');
  console.log('naturalness UI: all assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
