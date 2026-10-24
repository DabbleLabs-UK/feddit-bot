'use strict';
const assert = require('node:assert/strict');
const scope = require('../lib/theme-scope');
const context = require('../lib/theme-context');
const interest = require('../lib/theme-interest');
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (a, message) => { assert.ok(a, message); checks++; };
const rejects = (fn, code) => { assert.throws(fn, error => error.code === code); checks++; };
const selected = { version: 1, communities: ['shittyaskfeddit'] };
const at = 100000;
function root(id, feddit = 'shittyaskfeddit') {
  const body = 'Municipal parking permits require lunar paperwork.';
  return { id: 'C' + id, kind: 'reply', salience: 0.4, context: 'Lunar parking permits\n' + body,
    target: { key: 't3_' + id, postId: id, author: 'other', feddit,
      replyBranch: { post: { title: 'Lunar parking permits', body } } },
    voteItems: [{ targetType: 'post', targetId: id }] };
}
function vote(id) { return { id: 'V' + id, targetType: 'post', targetId: id, author: 'other', content: root(id).context }; }
function handled(candidates, ballots = []) {
  return { valid: true, candidates, voteCandidates: ballots,
    votes: ballots.map(ballot => ({ id: ballot.id, decisionKind: 'explicit', status: 'considered', direction: 'nil' })) };
}
eq(scope.parseConfig(), [], 'missing config disables new scoped admissions');
eq(scope.parseConfig('  '), [], 'empty config does not enable all communities');
eq(scope.parseConfig(' ShittyAskFeddit,bookclub '), ['shittyaskfeddit', 'bookclub'], 'config normalizes explicit names');
for (const value of ['*', 'general,', '/f/general', 'general,GENERAL', 'general\nbookclub', 'x'.repeat(513), 3,
  Array.from({ length: 9 }, (_, i) => 'f' + i).join(',')]) rejects(() => scope.parseConfig(value), 'THEME_SCOPE_CONFIG');
eq(scope.normalizeScope(), null, 'absent frozen scope preserves legacy replay');
eq(scope.normalizeScope(null), null, 'null frozen scope preserves legacy replay');
for (const value of [{ version: 2, communities: ['shittyaskfeddit'] }, { version: 1, communities: [] },
  { version: 1, communities: ['ShittyAskFeddit'] }, { version: 1, communities: ['*'] },
  { version: 1, communities: ['general', 'general'] }, { ...selected, extra: true }, [], true]) {
  rejects(() => scope.normalizeScope(value), 'UNSUPPORTED_THEME_SCOPE');
}
const frozen = scope.normalizeScope(selected);
selected.communities.push('bookclub');
eq(frozen.communities, ['shittyaskfeddit'], 'scope owns a cloned list');
ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.communities), 'scope and names are immutable');
eq(scope.normalizeScope(JSON.parse(JSON.stringify(frozen))), frozen, 'scope survives restart JSON roundtrip');
eq(scope.allows(frozen, 'shittyaskfeddit'), true, 'exact community allowed');
for (const name of ['shittyaskfeddit-extra', 'notshittyaskfeddit', 'ShittyAskFeddit', '', undefined, '*']) {
  eq(scope.allows(frozen, name), false, 'unproven or nonexact name denied');
}
eq(scope.allows(null, 'bookclub'), true, 'legacy unscoped operations retain old behaviour');
const a = root(20);
const b = root(21, 'bookclub');
const first = context.decorate({ candidates: [a, b] }, undefined, at, 'first', frozen);
eq(first.themeInterestContext.scope, frozen, 'frozen operation carries the scope');
eq(context.exposure(first, handled([a, b]), 'reader').map(item => item.sourceKey), ['t3_20'], 'only canary encounters generate receipts');
const state = interest.record(undefined, context.exposure(first, handled([a, b]), 'reader'));
const decorated = context.decorate({ candidates: [a, b] }, state, at + 1, 'next', frozen);
ok(decorated.candidates[0].themeInterest, 'allowed community retains selected-writing summary');
eq(decorated.candidates[1].themeInterest, undefined, 'identical words in other community have no cue');
eq(decorated.candidates.map(item => context.hint(item)), ['', ''], 'mixed menu has no decision cues');
eq(decorated.candidates.map(item => [item.id, item.salience]), [a, b].map(item => [item.id, item.salience]), 'scope changes neither order nor salience');
const allowed = context.decorate({ candidates: [a] }, state, at + 1, 'allowed', frozen);
ok(context.hint(allowed.candidates[0]), 'single-community allowed menu can show bounded cue');
const unrelated = context.decorate({ candidates: [b] }, state, at + 1, 'unrelated', frozen);
eq(context.exposure(unrelated, handled([b]), 'reader'), [], 'noncanary creates no exposure');
eq(unrelated.candidates[0], b, 'noncanary candidate presentation unchanged');
const foreignState = interest.record(undefined, context.exposure(context.decorate({ candidates: [b] }, undefined, at, 'foreign'), handled([b]), 'reader'));
eq(context.decorate({ candidates: [a] }, foreignState, at + 1, 'isolated', frozen).candidates[0].themeInterest,
  undefined, 'matching lexical receipts in a different community cannot supply familiarity');
eq(context.decorate({ candidates: [{ ...b, themeInterest: { version: 1, offeredHint: true, summary: 'Stale hint' } }] },
  state, at + 1, 'stale', frozen).candidates[0].themeInterest, undefined, 'scoped redecorating cannot leak a stale foreign cue');
const ballot = vote(20);
eq(context.decisionMenuAllowed(first, [a], [ballot], frozen), true, 'allowed retained menu proves ballot origin');
eq(context.decisionMenuAllowed(first, [a, b], [ballot], frozen), false, 'mixed action menu denied');
eq(context.decisionMenuAllowed(first, [a], [vote(21)], frozen), false, 'mixed ballot menu denied');
eq(context.decisionMenuAllowed(first, [a], [vote(99)], frozen), false, 'unknown ballot source denied');
eq(context.decisionMenuAllowed(first, [{}], [], frozen), false, 'unknown action source denied');
eq(context.decisionMenuAllowed(first, [], [], frozen), false, 'empty menu cannot produce decision hints');
eq(context.decisionMenuAllowed(first, [a], [null], frozen), false, 'malformed ballot source denied');
eq(context.decisionMenuAllowed(first, [], [ballot], frozen), true, 'voting-only allowed menu remains scoped');
const second = { themeSource: { feddit: 'shittyaskfeddit', postId: 22 }, voteItems: root(22).voteItems };
const withSecond = { ...first, observationCandidates: [second] };
eq(context.decisionMenuAllowed(withSecond, [a], [vote(22)], frozen), true, 'second vote-only root proves scope via themeSource');
eq(context.exposure(withSecond, handled([], [vote(20), vote(21), vote(22)]), 'reader').map(item => item.sourceKey),
  ['t3_20', 't3_22'], 'all independently valid ballot sources respect frozen scope');
const conflicting = { ...withSecond, observationCandidates: [second, { ...second, themeSource: { feddit: 'bookclub', postId: 22 } }] };
eq(context.decisionMenuAllowed(conflicting, [a], [vote(22)], frozen), false, 'contradictory community provenance fails closed');
eq(context.exposure(conflicting, handled([], [vote(22)]), 'reader'), [], 'ambiguous ballot cannot fabricate scoped receipt');
const operation = { at, operationId: 'own', scope: frozen };
const item = { ...context.subject(a), author: 'self' };
eq(context.participation(operation, item).length, 1, 'confirmed canary own use recorded');
eq(context.participation(operation, { ...item, community: 'bookclub' }), [], 'noncanary own use not recorded');
const privateRoot = 'r3_' + 'a'.repeat(64);
eq(context.participation(operation, { ...item, sourceKey: privateRoot, threadKey: privateRoot }).length, 1,
  'rehearsal own use can retain the same community boundary');
eq(context.participation(operation, { ...item, sourceKey: privateRoot, threadKey: privateRoot, community: 'bookclub' }), [],
  'private rehearsal identity cannot evade community boundary');
rejects(() => context.exposure({ ...first, themeInterestContext: { ...first.themeInterestContext, scope: { version: 9 } } }, handled([a]), 'reader'),
  'UNSUPPORTED_THEME_SCOPE');
rejects(() => context.participation({ ...operation, scope: { version: 9 } }, item), 'UNSUPPORTED_THEME_SCOPE');
const legacy = context.decorate({ candidates: [a, b] }, state, at + 1, 'legacy');
eq(Object.hasOwn(legacy.themeInterestContext, 'scope'), false, 'legacy serialization receives no added field');
eq(context.exposure(legacy, handled([a, b]), 'reader').length, 2, 'unscoped legacy receipts exactly preserve all communities');
eq(context.decisionMenuAllowed(first, [a, b], [vote(99)], null), true, 'legacy decisions retain prior cue eligibility');
console.log('theme scope: ' + checks + ' checks passed');
