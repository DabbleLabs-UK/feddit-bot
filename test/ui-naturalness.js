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
  const controller = create({ document, api: async path => { calls.push(path); return { ...snapshot, window: { ...snapshot.window, hours: Number(path.split('hours=')[1]) } }; }, getDeveloperTools: () => developer, getPlacement: () => placement, getPopulationAdmin: () => admin, toast() {} });
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

  const reviewDocument = documentStub();
  const reviewCalls = [];
  let reviews = [], releaseSnapshot = null, releaseReview = null, delaySnapshot = false, wrongWindow = false;
  const reviewSnapshot = hours => {
    const base = buildSnapshot({ hours, now: Date.parse('2026-10-08T12:00:00Z') });
    return { ...base, ecology: { window: base.window, overview: { posts: 10, comments: 12, activeBots: 3 },
      coverage: { warnings: ['Public sample only.'] }, anomalies: [], examples: [] },
    reviewer: { available: true, provider: 'chatgpt-plan', model: 'account-model' }, reviews };
  };
  const reviewController = create({ document: reviewDocument, api: async (path, options) => {
    reviewCalls.push({ path, options });
    if (options?.method === 'POST') return new Promise(done => { releaseReview = done; });
    const hours = Number(path.split('hours=')[1]);
    if (delaySnapshot) {
      delaySnapshot = false;
      return new Promise(done => { releaseSnapshot = () => done(reviewSnapshot(hours)); });
    }
    return reviewSnapshot(wrongWindow ? 24 : hours);
  }, getDeveloperTools: () => developer, getPlacement: () => 'desktop', getPopulationAdmin: () => false });
  const elements = () => flatten(reviewDocument.body);
  const reviewButton = () => elements().find(element => element.textContent === 'Review current ecology');
  const statusLine = () => elements().find(element => element.role === 'status');
  const posts = () => reviewCalls.filter(call => call.options?.method === 'POST');
  await reviewController.open();
  await reviewController.refresh();
  reviewController.close();
  await reviewController.open();
  assert.equal(posts().length, 0, 'open, refresh and reopen never start reviews');
  assert.equal(reviewButton().disabled, false);
  assert.ok(elements().some(element => element.textContent === 'Agreement'), 'existing voting agreement remains visible');
  assert.ok(elements().some(element => element.textContent === 'Exposure, timing and order'), 'existing voting exposure remains visible');
  assert.ok(elements().some(element => element.textContent.startsWith('Current ledger:')), 'existing ledger overview remains visible');

  const reviewWindow = elements().find(element => element['aria-label'] === 'Observation window');
  const oldReviewButton = reviewButton();
  delaySnapshot = true;
  reviewWindow.value = '168';
  const changingWindow = reviewWindow.listeners.change();
  assert.equal(oldReviewButton.disabled, true, 'previous-window review disables immediately');
  await oldReviewButton.click();
  assert.equal(posts().length, 0, 'old review handler cannot submit the newly selected hours during loading');
  const classification = elements().find(element => element['aria-label'] === 'Item classification');
  classification.listeners.change();
  assert.equal(reviewButton().disabled, true, 'filter rerender cannot re-enable stale evidence review');
  await reviewButton().click();
  assert.equal(posts().length, 0);
  releaseSnapshot();
  await changingWindow;
  assert.equal(reviewButton().disabled, false);

  const runningReview = reviewButton().click();
  assert.equal(reviewButton().disabled, true);
  await reviewButton().click();
  assert.equal(posts().length, 1, 'concurrent review clicks make exactly one model request');
  assert.deepEqual(posts()[0].options, { method: 'POST', body: { hours: 168, confirm: true } });
  assert.match(statusLine().textContent, /Review running/);
  reviews = [{ id: 'failed', status: 'failed', error: { message: 'The bounded review timed out.' }, packet: {} }];
  releaseReview({ review: reviews[0] });
  await runningReview;
  assert.match(statusLine().textContent, /Review failed or was interrupted/);
  assert.doesNotMatch(statusLine().textContent, /Review completed/);
  assert.ok(elements().some(element => element.textContent === 'The bounded review timed out.'));
  assert.equal(posts().length, 1, 'failed review refresh does not retry');

  const completedReview = reviewButton().click();
  reviews = [{ id: 'completed', status: 'completed', result: { patterns: [] }, packet: {} }];
  releaseReview({ review: reviews[0] });
  await completedReview;
  assert.match(statusLine().textContent, /Review completed for the 168-hour window/);
  assert.equal(posts().length, 2);

  reviews = [{ id: 'pending', status: 'pending', packet: {} }];
  await reviewController.refresh();
  assert.equal(reviewButton().disabled, true, 'pending history prevents a second request');
  await reviewButton().click();
  assert.equal(posts().length, 2, 'handler also guards pending history');

  reviews = [];
  await reviewController.refresh();
  const enabledButton = reviewButton();
  developer = false;
  await enabledButton.click();
  assert.equal(posts().length, 2, 'turning developer tools off guards existing handlers');
  reviewDocument.listeners['developer-tools-change']();
  assert.equal(reviewDocument.body.children.find(element => element.tag === 'dialog').open, false);
  await reviewController.open();
  assert.equal(posts().length, 2);

  developer = true;
  await reviewController.open();
  const mismatchButton = reviewButton();
  wrongWindow = true;
  reviewWindow.value = '720';
  await reviewWindow.listeners.change();
  assert.equal(mismatchButton.disabled, true);
  await mismatchButton.click();
  assert.equal(posts().length, 2, 'mismatched response never enables review');
  assert.match(statusLine().textContent, /Unable to load/);
  console.log('naturalness UI: all assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
