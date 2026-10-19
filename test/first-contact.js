'use strict';

const assert = require('node:assert/strict');
const first = require('../lib/first-contact');
const ordinary = require('../lib/ordinary-candidates');
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function rejects(fn, pattern, message) { assert.throws(fn, pattern, message); checks++; }
const root = (id, assessed = false) => ({ key: 't3_' + id, kind: 'post', candidateType: 'ordinary_post',
  independentlyAssessed: assessed, context: 'Complete unchanged root ' + id });
const roots = [root(1), root(2), root(3)];
const fallback = (id) => ({ key: 't1_' + id, kind: 'comment', candidateType: 'reply_to_own_post' });
const keys = (items) => items.map((item) => item.key);
eq(first.version(), 0, 'missing turn version preserves legacy behavior');
eq(first.version(null, 1), 1, 'new admission explicitly selects the first-contact contract');
for (const raw of [2, '1', -1, {}, false, NaN]) {
  rejects(() => first.version(raw), { code: 'UNSUPPORTED_FIRST_CONTACT' }, 'unknown contracts fail closed');
}
eq(first.select(roots), roots[0], 'feed ordering breaks unseen ties');
const presented = ordinary.record(null, ordinary.receipt([roots[0]], 100));
eq(first.select(roots, presented), roots[1], 'shortlisted but deferred root rotates without losing eligibility');
const allPresented = ordinary.record(presented, ordinary.receipt([roots[1], roots[2]], 200));
eq(first.select(roots, allPresented), roots[0], 'deferred roots return in least-recently-shortlisted order');
eq(first.select([root(1, true), { ...root(2), independentlyAssessed: null }, { ...root(3), independentlyAssessed: undefined }]), null,
  'upstream assessment must be known false, never inferred from missing evidence');
eq(first.select(roots, null, { considered: ['post:1'] }), roots[1], 'existing explicit vote consideration prevents repeated assessment');
const menu = [fallback(9), fallback(8), fallback(7)];
const before = JSON.stringify({ roots, menu });
eq(keys(first.inject(menu, roots[0])), ['t3_1', 't1_9', 't1_8'], 'one root replaces a slot rather than increasing total candidates');
eq(first.inject(menu, roots[0])[0].firstContact, true, 'root has a content-free presentation marker');
eq(keys(first.inject([roots[0], fallback(9)], roots[0])), ['t3_1', 't1_9'], 'inject never duplicates a root');
eq(first.inject(menu, roots[0], 0), [], 'zero capacity does not manufacture a lane');
eq(first.inject(menu, roots[0], 100).length, 3, 'first contact never increases ordinary limit');
eq(JSON.stringify({ roots, menu }), before, 'pure presentation does not mutate evidence');
const wait = first.plan({ valid: true, candidates: [{ target: roots[0] }, { target: fallback(9) }], votes: [] }, 300);
eq(wait, { version: 1, at: 300, keys: ['t3_1'] }, 'valid WAIT assesses offered roots without requiring publication');
const state = first.record(allPresented, wait);
eq(state.entries, allPresented.entries, 'assessment does not alter turnover presentation timestamps');
eq(first.select(roots, state), roots[1], 'handled root stops taking first-contact lane');
eq(first.record(state, wait), state, 'durable receipt replay is idempotent');
eq(first.record(state, { ...wait, at: 250 }), state, 'older replay cannot reverse assessment timestamp');
eq(first.plan({ valid: false, candidates: [{ target: roots[1] }], votes: [] }, 300).keys, [],
  'invalid or missing primary decision never assesses offered roots');
const nil = { targetType: 'post', targetId: 2, direction: 'nil', decisionKind: 'explicit', status: 'no-vote' };
eq(first.plan({ valid: false, candidates: [], votes: [nil] }, 400).keys, ['t3_2'],
  'independently valid NIL assesses its root even when primary action is invalid');
eq(first.plan({ valid: true, candidates: [], votes: [] }, 400).keys, [],
  'unoffered roots are absent from receipt even if gathered elsewhere');
eq(first.plan({ valid: true, candidates: Array.from({ length: 30 }, (_, i) => ({ target: root(i + 10) })) }, 400).keys.length,
  20, 'one assessment receipt cannot exceed the existing combined action and vote bounds');
eq(first.plan({ valid: true, candidates: [{ target: roots[1] }], votes: [nil] }, 400).keys, ['t3_2'],
  'a root handled by both reply and voting paths records exactly once');
eq(first.plan({ valid: false, candidates: [], votes: [{ ...nil, decisionKind: 'missing' },
  { ...nil, status: 'unresolved' }, { ...nil, direction: null }, { ...nil, targetType: 'comment' }] }, 400).keys, [],
  'missing malformed unresolved and comment votes cannot assess roots');
const prior = { version: 1, entries: [], assessed: Array.from({ length: 600 }, (_, i) => ({ key: 't3_' + i, at: i + 1 })) };
const bounded = first.record(prior, { version: 1, at: 1000, keys: ['t3_700'] });
eq(bounded.assessed.length, 512, 'assessment storage is bounded');
eq(bounded.assessed.at(-1), { key: 't3_700', at: 1000 }, 'latest confirmed assessment survives bounded eviction');
eq(ordinary.record(state, ordinary.receipt([roots[2]], 500)).assessed, state.assessed,
  'turnover updates preserve first-contact assessment');
eq(ordinary.normalize(null), { version: 1, entries: [] }, 'legacy serialized shape remains unchanged');
eq(first.record(null, { version: 1, at: 100, keys: [] }), { version: 1, entries: [] },
  'empty receipt does not add an assessment field to legacy state');
eq(ordinary.normalize({ entries: [], assessed: [null, {}, { key: 't1_9', at: 1 },
  { key: 't3_1', at: 1 }, { key: 't3_1', at: 2 }] }).assessed, [{ key: 't3_1', at: 2 }],
  'only valid bounded root assessment facts persist');
for (const receipt of [null, {}, { version: 1, at: 0, keys: [] }, { version: 1, at: 1, keys: ['t1_1'] },
  { version: 1, at: 1, keys: ['t3_1', 't3_1'] }, { version: 1, at: 1, keys: Array.from({ length: 21 }, (_, i) => 't3_' + i) }]) {
  rejects(() => first.record(null, receipt), /receipt/, 'malformed receipt is rejected without rewriting state');
}
rejects(() => first.record(null, { version: 2, at: 1, keys: [] }), { code: 'UNSUPPORTED_FIRST_CONTACT' },
  'future receipt versions fail closed');
rejects(() => first.plan({}, NaN), /timestamp/, 'invalid receipt clock fails explicitly');
console.log('first contact: ' + checks + ' checks passed');
