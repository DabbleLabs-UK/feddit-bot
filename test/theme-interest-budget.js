'use strict';
const assert = require('node:assert/strict');
const theme = require('../lib/theme-interest');
const context = require('../lib/theme-context');
const actions = require('../lib/action-candidates');
const budget = require('../lib/hosted-decision-budget');
const tokenizer = require('../lib/hosted-tokenizer');
const branch = require('../lib/reply-branch');
const at = 1800000000000;
const text = 'Zircon lanterns orbit slowly. Zircon lanterns orbit slowly.';
const state = theme.record(undefined, [1, 2, 3].map(n => ({ id: 'seed-' + n,
  at, kind: 'exposure', sourceKey: 't1_' + n, threadKey: 't3_1',
  community: 'fixture_sector', author: 'actor_' + n, features: theme.features(text) })));
const raw = Array.from({ length: 3 }, (_, n) => ({ key: 'reply:t3_' + (10 + n), action: 'comment',
  candidateType: 'ordinary_post', context: 'TITLE: ' + text,
  target: { key: 't3_' + (10 + n), postId: 10 + n, author: 'reader_' + n, feddit: 'fixture_sector',
    replyBranch: branch.forPost({ id: 10 + n, title: text }) } }));
const candidates = actions.bound({ ordinary: raw });
const decorated = context.decorate({ candidates }, state, at, 'fixture');
const system = 'A dry municipal observer. Stay in character.';
const args = { constructionVersion: 2, decisionContractVersion: 2, model: tokenizer.MODEL,
  system, decisionAt: at, voteCandidates: [] };
const before = budget.construct({ ...args, candidates });
const after = budget.construct({ ...args, candidates: decorated.candidates });
assert.deepEqual(after.candidateIds, before.candidateIds);
assert.deepEqual(after.voteIds, before.voteIds);
assert.deepEqual(decorated.candidates.map(c => c.salience), candidates.map(c => c.salience));
assert.equal(decorated.candidates.filter(c => context.hint(c)).length, 2);
assert.ok(after.budget.inputTokens > before.budget.inputTokens);
assert.ok(after.budget.inputTokens - before.budget.inputTokens < 160);
assert.ok(budget.fits(after.budget) && budget.fits(after.repairBudget));
const maxRecords = Array.from({ length: 96 }, (_, n) => ({
  id: 'theme:' + String(n).padStart(64, '0'), at: at + n, kind: 'participation',
  sourceKey: 't1_' + (n + 1), threadKey: 't3_9007199254740991', community: 'a'.repeat(64),
  author: 'a'.repeat(128), features: [0, 1, 2].map(i => ['a'.repeat(47) + i, 'b'.repeat(47) + i]),
}));
let bounded;
for (let n = 0; n < maxRecords.length; n += 32) bounded = theme.record(bounded, maxRecords.slice(n, n + 32));
const bytes = Buffer.byteLength(JSON.stringify(bounded));
assert.ok(bytes < 100 * 1024, 'maximal generated adapter receipts remain below 100 KiB per mode');
assert.equal(bounded.events.length, 96);
console.log('theme interest budget: 9 checks passed; ' + JSON.stringify({
  inputBefore: before.budget.inputTokens, inputAfter: after.budget.inputTokens,
  addedTokens: after.budget.inputTokens - before.budget.inputTokens,
  maximalGeneratedStateBytes: bytes, candidatesBefore: before.candidateIds, candidatesAfter: after.candidateIds,
}));
