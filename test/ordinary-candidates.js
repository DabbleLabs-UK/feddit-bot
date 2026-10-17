'use strict';

const assert = require('node:assert/strict');
const ordinary = require('../lib/ordinary-candidates');
let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function rejects(fn, pattern, message) {
  assert.throws(fn, pattern, message);
  checks++;
}
const candidate = (key) => ({ key, context: 'Unchanged public evidence for ' + key });
const keys = (items) => items.map((item) => item.key);
const sources = {
  roots: ['t3_10', 't3_20', 't3_30', 't3_40'].map(candidate),
  own: ['t1_1', 't1_2', 't1_3'].map(candidate),
  nearby: ['t1_9'].map(candidate),
};
const frozen = JSON.stringify(sources);
eq(ordinary.VERSION, 1, 'ordinary presentation has an independent contract');
eq(ordinary.version(), 0, 'missing contract keeps legacy construction');
eq(ordinary.version(null, 1), 1, 'new admission can explicitly choose current semantics');
for (const value of [2, -1, '1', NaN, false, {}]) {
  rejects(() => ordinary.version(value), { code: 'UNSUPPORTED_ORDINARY_CANDIDATES' }, 'unknown contract fails closed');
}
const first = ordinary.select(sources, ordinary.defaults());
eq(keys(first), ['t3_10', 't1_1', 't3_20'], 'ordinary roots and own-thread fallbacks share three slots');
eq(first[0] === sources.roots[0], true, 'selected candidates preserve original context object identity');
const state = ordinary.record(null, ordinary.receipt(first, 100));
const second = ordinary.select(sources, state);
eq(keys(second), ['t3_30', 't1_2', 't3_40'], 'unseen candidates displace unchanged previously shortlisted candidates');
const next = ordinary.record(state, ordinary.receipt(second, 200));
eq(keys(ordinary.select(sources, next)), ['t3_10', 't1_3', 't3_20'], 'old conversations return rather than being suppressed permanently');
const added = { ...sources, roots: [...sources.roots, candidate('t3_2')] };
eq(keys(ordinary.select(added, next)), ['t3_2', 't1_3', 't3_10'], 'a newly available root gets a chance without target-age ranking');
eq(JSON.stringify(sources), frozen, 'selection and recording do not mutate sources');
eq(keys(ordinary.select({ own: sources.own }, null)), ['t1_1', 't1_2', 't1_3'], 'fallback comments fill slots when roots are absent');
eq(keys(ordinary.select({ roots: [sources.roots[0]], own: [sources.own[0]], nearby: sources.nearby }, null)),
  ['t3_10', 't1_1', 't1_9'], 'nearby comments fill only remaining slots');
eq(keys(ordinary.select({ roots: [sources.roots[0]], own: [sources.roots[0], sources.own[0]], nearby: [sources.own[0]] }, null)),
  ['t3_10', 't1_1'], 'cross-source duplicate identities never occupy two slots');
eq(ordinary.select(sources, null, 100).length, 3, 'callers cannot increase the existing three-slot limit');
eq(ordinary.select(sources, null, 0), [], 'zero available slots select nothing');
eq(ordinary.select({ roots: [null, {}, candidate('reply:t3_1'), candidate('t1_bad')] }, null), [], 'invalid fullnames are not tracked');
eq(ordinary.receipt(first.concat(first), 100), { version: 1, at: 100, keys: ['t3_10', 't1_1', 't3_20'] },
  'receipt contains only bounded public identities and time');
eq(ordinary.record(state, ordinary.receipt(first, 100)), state, 'exact replay is idempotent');
eq(ordinary.record(state, ordinary.receipt(first, 90)), state, 'older replay cannot move presentation timestamps backward');
eq(state.entries.some((entry) => 'considered' in entry || 'replied' in entry), false, 'presentation never invents handled outcomes');
eq(ordinary.normalize({ entries: [null, {}, { key: 't3_1', at: 0 }, { key: 't3_1', at: -1 },
  { key: 't3_1', at: '1' }, { key: 't3_1', at: Infinity }, { key: 't3_' + '1'.repeat(62), at: 1 },
  { key: 't1_5', at: 7 }, { key: 't1_5', at: 9 }, { key: 't1_5', at: 8 }] }),
{ version: 1, entries: [{ key: 't1_5', at: 9 }] }, 'corrupt records drop and duplicates retain latest timestamp');
const excessive = { entries: Array.from({ length: 600 }, (_, i) => ({ key: 't3_' + i, at: i + 1 })).reverse() };
const bounded = ordinary.normalize(excessive);
eq(bounded.entries.length, 512, 'ledger size remains bounded');
eq(bounded.entries[0], { key: 't3_88', at: 89 }, 'oldest timestamps evict regardless of input order');
eq(ordinary.normalize({ entries: excessive.entries.slice().reverse() }), bounded, 'normalization is deterministic');
eq(excessive.entries.length, 600, 'normalization does not mutate persisted input');
for (const invalid of [null, {}, { version: 1, at: 0, keys: [] }, { version: 1, at: 1, keys: ['t1_1', 't1_1'] },
  { version: 1, at: 1, keys: ['bad'] }, { version: 1, at: 1, keys: ['t1_1', 't1_2', 't1_3', 't1_4'] }]) {
  rejects(() => ordinary.record(null, invalid), /receipt/, 'invalid receipts cannot mutate presentation history');
}
rejects(() => ordinary.receipt(first, NaN), /timestamp/, 'invalid clock fails explicitly');
rejects(() => ordinary.normalize({ version: 2, entries: [] }), { code: 'UNSUPPORTED_ORDINARY_CANDIDATES' },
  'newer persisted versions are not silently erased');
console.log('ordinary candidates: ' + checks + ' checks passed');
