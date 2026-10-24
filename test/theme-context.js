'use strict';
const assert = require('node:assert/strict');
const context = require('../lib/theme-context');
const interest = require('../lib/theme-interest');
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (a, message) => { assert.ok(a, message); checks++; };
const at = 100000;
function root(id = 20) {
  const body = 'Municipal parking permits require lunar paperwork.';
  return { id: 'C' + id, kind: 'reply', context: 'TITLE: Lunar parking permits\n' + body,
    salience: 0.4, target: { key: 't3_' + id, postId: id, author: 'other', feddit: 'general',
      replyBranch: { post: { title: 'Lunar parking permits', body } } },
    voteItems: [{ targetType: 'post', targetId: id }] };
}
const original = root();
eq(context.subject(original), { community: 'general', threadKey: 't3_20', sourceKey: 't3_20',
  author: 'other', text: 'Lunar parking permits Municipal parking permits require lunar paperwork.' }, 'visible root facts supply public evidence');
const comment = { id: 'C2', context: 'Earlier root: Secret banana anecdote\nImmediate: Municipal parking permits require lunar paperwork.',
  target: { key: 't1_40', postId: 20, commentId: 40, author: 'commenter', feddit: 'general',
    replyBranch: { target: { body: 'Municipal parking permits require lunar paperwork.' },
      post: { title: 'Secret banana anecdote' } } } };
eq(context.subject(comment).text, comment.target.replyBranch.target.body, 'comment evidence excludes repeated root and ancestors');
eq(context.subject({ ...comment, context: 'x'.repeat(2501) + comment.target.replyBranch.target.body }), null,
  'target beyond existing decision excerpt cannot count as seen');
eq(context.subject({ ...comment, context: comment.target.replyBranch.target.body + '\n' + 'x'.repeat(2600) +
  '\n' + comment.target.replyBranch.target.body }), null,
  'identical target words in visible root cannot impersonate a hidden trailing target');
eq(context.subject({ ...original, context: 'Unknown text only' }), null, 'unseen root cannot fabricate evidence');
eq(context.subject({ ...original, target: { ...original.target, feddit: '' } }), null, 'unknown community fails conservatively');
eq(context.subject({ ...original, target: { ...original.target, author: '' } }), null, 'unknown author fails conservatively');
eq(context.subject({ ...original, target: { ...original.target, key: 'private' } }), null, 'non-public source rejected');
const snapshot = { candidates: [original, root(21), root(22)], observationCandidates: [comment] };
const serialized = JSON.stringify(snapshot);
const fresh = context.decorate(snapshot, undefined, at, 'op');
eq(fresh.candidates, snapshot.candidates, 'unknown evidence does not add candidate hints');
eq(JSON.stringify(snapshot), serialized, 'decoration never mutates source snapshot');
eq(fresh.themeInterestContext, { version: 1, at, operationId: 'op' }, 'context freezes version time and operation identity');
const handled = { valid: true, candidates: [original], votes: [], voteCandidates: [] };
const receipts = context.exposure(fresh, handled, 'self');
eq(receipts.length, 1, 'valid offered primary creates one exposure');
eq(receipts[0].sourceKey, 't3_20', 'receipt binds source identity');
eq(receipts[0].kind, 'exposure', 'exposure is not participation');
ok(receipts[0].features.length > 0, 'receipt keeps bounded lexical features');
eq(context.exposure(fresh, handled, 'OTHER'), [], 'own public content does not count as independent exposure');
eq(context.exposure(fresh, { ...handled, valid: false }, 'self'), [], 'invalid primary cannot count candidate exposure');
eq(context.exposure(fresh, { ...handled, candidates: [] }, 'self'), [], 'deferred candidates do not count');
eq(context.exposure(snapshot, handled, 'self'), [], 'legacy snapshot never produces receipts');
const ballot = { id: 'V1', targetType: 'post', targetId: 20, author: 'other', content: original.context };
const vote = { id: 'V1', decisionKind: 'explicit', status: 'considered', direction: 'nil' };
const independent = { valid: false, candidates: [], votes: [vote], voteCandidates: [ballot] };
eq(context.exposure(fresh, independent, 'self').length, 1, 'independently valid NIL counts even with invalid primary');
eq(context.exposure(fresh, { ...handled, votes: [vote], voteCandidates: [ballot] }, 'self').length, 1,
  'same source seen in action and ballot is merged once');
eq(context.exposure(fresh, { ...independent, votes: [{ ...vote, status: 'unresolved' }] }, 'self'), [],
  'unresolved vote never counts');
eq(context.exposure(fresh, { ...independent, votes: [{ ...vote, decisionKind: 'missing' }] }, 'self'), [],
  'missing vote never counts');
eq(context.exposure(fresh, { ...independent, voteCandidates: [{ ...ballot, id: 'V2' }] }, 'self'), [],
  'unoffered ballot identity cannot count');
eq(context.exposure(fresh, { ...independent, voteCandidates: [{ ...ballot, author: '' }] }, 'self'), [],
  'unknown ballot author safely skips evidence');
eq(context.exposure(fresh, independent, 'self'), context.exposure(fresh, independent, 'self'),
  'frozen operation creates deterministic idempotent receipts');
const state = interest.record(undefined, receipts);
const decorated = context.decorate(snapshot, state, at + 1, 'next');
eq(decorated.candidates.map(c => c.id), snapshot.candidates.map(c => c.id), 'candidate order and IDs unchanged');
eq(decorated.candidates.map(c => c.salience), snapshot.candidates.map(c => c.salience), 'salience unchanged');
eq(decorated.candidates.filter(c => context.hint(c)).length, 2, 'decision has at most two familiarity hints');
ok(decorated.candidates.every(c => c.themeInterest.summary.length <= 160), 'summaries bounded to 160 characters');
ok(!context.hint(decorated.candidates[0]).toLowerCase().includes('lunar'), 'summary does not inject lexical subject keywords');
eq(context.hint(decorated.candidates[2]), '', 'third known candidate has no decision hint');
const participation = context.participation({ operationId: 'publish', at }, { ...context.subject(original), author: 'self' });
eq(participation.length, 1, 'confirmed contribution can generate bounded own-use receipt');
eq(participation[0].kind, 'participation', 'own-use receipt distinct from exposure');
eq(context.participation({ operationId: 'publish', at }, { sourceKey: 'unknown' }), [], 'unknown publication identity cannot create own-use evidence');
const retained = require('./fixtures/reply-continuity-public.json');
const oldReply = retained.comments.find(item => item.id === 1953);
const repeatedReply = retained.comments.find(item => item.id === 1978);
eq(interest.features(oldReply.body), interest.features(repeatedReply.body), 'retained verbatim book anecdote produces the same lexical features');
function retainedCandidate(item) {
  return { id: 'C' + item.id, context: item.body, target: { key: 't1_' + item.id, postId: item.post_id,
    commentId: item.id, author: item.author, feddit: 'bookclub', replyBranch: { target: { body: item.body } } } };
}
const previousOffer = context.decorate({ candidates: [retainedCandidate(oldReply)] }, undefined, at, 'old-book');
const seen = interest.record(undefined, context.exposure(previousOffer,
  { valid: true, candidates: previousOffer.candidates, votes: [] }, 'reader'));
const repeated = context.decorate({ candidates: [retainedCandidate(repeatedReply)] }, seen, at + 1, 'repeat-book');
ok(repeated.candidates[0].themeInterest, 'actual retained repeated phrasing is recognized as known evidence');
const paraphrase = { ...repeatedReply, id: 9999, body: 'A volume evokes emotion while a cupboard seems conscious.' };
const paraphrased = context.decorate({ candidates: [retainedCandidate(paraphrase)] }, seen, at + 1, 'paraphrase-book');
eq(paraphrased.candidates[0].themeInterest, undefined, 'lexical proxy does not claim semantic recognition of synonym paraphrase');
const clipped = retainedCandidate(retained.comments.find(item => item.id === 1963));
clipped.context = oldReply.body + ' x'.repeat(1300) + clipped.context;
eq(context.subject(clipped), null, 'retained ancestor repetition cannot reinforce a clipped-out immediate target');
assert.throws(() => context.exposure({ ...fresh, themeInterestContext: { ...fresh.themeInterestContext, version: 99 } }, handled, 'self'),
  error => error.code === 'UNSUPPORTED_THEME_INTEREST'); checks++;
console.log('theme context: ' + checks + ' checks passed');
