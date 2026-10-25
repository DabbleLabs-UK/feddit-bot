'use strict';

const assert = require('node:assert/strict');
const motif = require('../lib/theme-motif');
const theme = require('../lib/theme-interest');
const context = require('../lib/theme-context');
const { replay } = require('../bin/replay-theme-motif');
const fixture = require('./fixtures/theme-motif-glopspray.json');
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (value, message) => { assert.ok(value, message); checks++; };
const at = 1800000000000;
const hour = 60 * 60 * 1000;
const scope = { version: 1, communities: ['shittyaskfeddit'] };
const seed = 'A GLOPSPRAY lands beside the toaster. Nobody knows why a GLOPSPRAY demands a permit.';
const subject = { community: 'shittyaskfeddit', text: 'I submitted my glop spray for the inspection.' };
function candidate(id, text, community = 'shittyaskfeddit') {
  return { id: 'C' + id, kind: 'reply', context: text, salience: 0.4,
    target: { key: 't3_' + id, postId: id, author: 'other', feddit: community, replyBranch: { post: { body: text } } },
    voteItems: [{ targetType: 'post', targetId: id }] };
}
function decorate(state, texts, time = at, version = 2, operation = 'offer') {
  return context.decorate({ candidates: texts.map((text, index) => candidate(index + 1, text)), voteCandidates: [] },
    state, time, operation, scope, version);
}
function encounter(state, texts, time = at, operation = 'offer') {
  const snapshot = decorate(state, texts, time, 2, operation);
  return theme.record(state, context.exposure(snapshot, { valid: true, candidates: snapshot.candidates, votes: [] }, 'reader'));
}
function view(state, time = at, target = subject) {
  return theme.describe(state, target, { at: time, identity: motif.snapshot(theme.normalize(state), time) });
}

eq(motif.VERSION, 2, 'new identity is independently versioned');
eq(motif.extract(seed), ['glopspray'], 'repeated distinctive uppercase naming in mixed prose introduces one local motif');
for (const variant of ['GLOPSPRAY sounds expensive.', 'glopspray suddenly became minister.',
  '(GlOpSpRaY), apparently.', 'glop spray', 'GLOP-SPRAY', 'glop_spray', 'glop - spray']) {
  eq(motif.extract(variant, ['glopspray']), ['glopspray'], 'known local names survive conservative formatting: ' + variant);
}
for (const text of ['glop spray', 'a spray of glop', 'a glop, spray the counter', 'spray glop',
  'GLOPSPRAY', 'We saw GLOPSPRAY nearby and decided to leave.',
  'IMPORTANT rules apply here and IMPORTANT instructions must be read.',
  'PASSWORD is required here and PASSWORD should not be shared.',
  'A COMMITTEE was consulted but the COMMITTEE did not make any decision.',
  'The DEPARTMENT discussed a policy and the DEPARTMENT rejected all objections.',
  'We teach ECONOMICS to students while ECONOMICS remains an ordinary subject.',
  'GLOPSPRAY GLOPSPRAY PLEASE READ THIS ENTIRE PARAGRAPH NOW',
  'A common phrase about the ordinary kitchen counter and a kitchen counter.',
  'https://example.invalid/GLOPSPRAY/GLOPSPRAY', '@GLOPSPRAY @GLOPSPRAY',
  '<script>GLOPSPRAY GLOPSPRAY</script> ordinary mixed prose has no name',
  '<img title="GLOPSPRAY GLOPSPRAY"> ordinary mixed prose has no name']) {
  eq(motif.extract(text), [], 'ordinary wording, weak naming and hidden metadata do not invent anchors: ' + text);
}
for (const text of ['glop, spray', 'glop. spray', 'glop\nspray', 'glop spraying', 'glop sprayer', 'glopsprays',
  'anti-glopsprayer', 'glop/spray', 'glopsprayish', 'glop very spray']) {
  eq(motif.extract(text, ['glopspray']), [], 'no fuzzy, clause-crossing or substring alias: ' + text);
}
eq(motif.extract('x'.repeat(1200) + seed), [], 'text input remains bounded');
eq(motif.extract(seed + ' A SPROONIFY lands here while SPROONIFY insists on breakfast.'), ['glopspray', 'sproonify'],
  'different distinctive names stay distinct');

const learned = encounter(undefined, [seed]);
eq(learned.events[0].motifs, ['glopspray'], 'actual handled public encounter records identity');
eq(view(learned).independentSources, 1, 'split alias uses previously encountered local identity');
eq(view(undefined).known, false, 'another bot has no invented familiarity');
eq(motif.local(motif.snapshot(learned, at), 'another_community'), [], 'anchors do not cross community');
eq(view(learned, at, { ...subject, community: 'another_community' }).known, false, 'state cannot leak across communities');
eq(view(theme.normalize()).known, false, 'separate rehearsal state remains empty');
eq(motif.snapshot(learned, at - 1).anchors, [], 'future receipts cannot seed a frozen identity');

const pending = decorate(undefined, [seed, subject.text]);
eq(pending.themeInterestContext.identity.anchors, [], 'gathering does not learn a name');
const onlyAlias = context.exposure(pending, { valid: true, candidates: [pending.candidates[1]], votes: [] }, 'reader');
eq(onlyAlias.flatMap(item => item.motifs), [], 'deferred naming source cannot teach an offered alias');
const neither = context.exposure(pending, { valid: false, candidates: pending.candidates, votes: [] }, 'reader');
eq(neither, [], 'invalid primary does not seed names or exposure');
const foreign = candidate(20, seed, 'outside_canary');
const scoped = context.decorate({ candidates: [foreign], voteCandidates: [] }, undefined, at, 'foreign', scope, 2);
eq(context.exposure(scoped, { valid: true, candidates: scoped.candidates, votes: [] }, 'reader'), [],
  'handled non-canary content cannot teach a name');
const ballot = { id: 'V1', targetType: 'post', targetId: 1, author: 'other', content: seed };
const nil = { id: 'V1', decisionKind: 'explicit', status: 'considered', direction: 'nil' };
const nilReceipts = context.exposure(pending, { valid: false, candidates: [], votes: [nil], voteCandidates: [ballot] }, 'reader');
eq(nilReceipts[0].motifs, ['glopspray'], 'independently valid explicit NIL can teach actual offered naming evidence');
eq(context.exposure(pending, { valid: false, candidates: [], votes: [{ ...nil, status: 'unresolved' }], voteCandidates: [ballot] }, 'reader'), [],
  'unresolved voting cannot teach a name');
const both = context.exposure(pending, { valid: true, candidates: pending.candidates, votes: [] }, 'reader');
eq(both.map(item => item.motifs), [['glopspray'], ['glopspray']], 'actual simultaneous handled root and alias share naming evidence');
const frozen = JSON.parse(JSON.stringify(pending));
encounter(undefined, [seed], at + 1, 'late');
eq(context.exposure(frozen, { valid: true, candidates: [frozen.candidates[1]], votes: [] }, 'reader'), onlyAlias,
  'later knowledge cannot reinterpret an earlier frozen turn');

const legacyOffer = decorate(undefined, [seed], at, 1, 'legacy');
const legacyReceipts = context.exposure(legacyOffer, { valid: true, candidates: legacyOffer.candidates, votes: [] }, 'reader');
ok(!('identityVersion' in legacyReceipts[0]) && !('motifs' in legacyReceipts[0]), 'legacy receipt shape stays exact');
const legacyState = theme.record(undefined, legacyReceipts);
const oldView = theme.describe(legacyState, { community: 'shittyaskfeddit', text: seed }, { at });
eq(context.exposure(JSON.parse(JSON.stringify(legacyOffer)), { valid: true, candidates: legacyOffer.candidates, votes: [] }, 'reader'),
  legacyReceipts, 'legacy frozen reconstruction remains exact');
eq(theme.describe(JSON.parse(JSON.stringify(legacyState)), { community: 'shittyaskfeddit', text: seed }, { at }), oldView,
  'legacy replay retains its old numeric semantics');
eq(view(legacyState).known, false, 'legacy adjacent pairs are not silently converted into new history');

const operation = { at: at + 1, operationId: 'publish', scope, identity: motif.snapshot(learned, at) };
const own = context.participation(operation, { sourceKey: 't1_90', threadKey: 't3_1', author: 'reader',
  community: 'shittyaskfeddit', text: subject.text });
eq(own[0].motifs, ['glopspray'], 'own publication reuses actually known identity');
let used = theme.record(learned, own);
used = theme.record(used, context.participation({ ...operation, at: at + 2, operationId: 'publish-again' },
  { sourceKey: 't1_91', threadKey: 't3_1', author: 'reader', community: 'shittyaskfeddit', text: 'The GLOPSPRAY has rejected my form.' }));
eq(view(used, at + 2).uses, 2, 'different sentences and spellings accumulate own participation against one identity');
ok(view(used, at + 2).satiation > view(learned).satiation, 'own participation increases unchanged satiation');
const initial = view(used, at + 2);
const decayed = view(used, at + 24 * hour + 2);
ok(decayed.familiarity < initial.familiarity && decayed.satiation < initial.satiation, 'existing decay remains active');
const expectedFamiliarity = 1 - Math.exp(-Math.pow(0.5, (at + 12 * hour - at) / (12 * hour)) / 3);
ok(Math.abs(view(learned, at + 12 * hour).familiarity - expectedFamiliarity) < 1e-12, '12-hour familiarity half-life is unchanged');
const expectedSatiation = 1 - Math.exp(-0.04 * 0.5);
ok(Math.abs(view(learned, at + 24 * hour).satiation - expectedSatiation) < 1e-12, '24-hour satiation half-life is unchanged');
const expiredAt = at + 8 * 24 * hour;
eq(view(used, expiredAt).known, false, 'expired identities do not remain immortal');
const revived = encounter(used, [seed], expiredAt, 'revival');
ok(view(revived, expiredAt).familiarity > 0 && view(revived, expiredAt).satiation < initial.satiation,
  'new actual encounter can revive interest after existing retention expires');
eq(theme.normalize(JSON.parse(JSON.stringify(used))), used, 'new bounded identity survives JSON restart exactly');
eq(theme.record(used, own), used, 'same frozen participation replay is idempotent');
let bounded = theme.normalize();
for (let i = 0; i < 100; i++) bounded = theme.record(bounded, [{ ...learned.events[0],
  id: 'bounded-' + i, at: at + i, sourceKey: 't1_' + (1000 + i) }]);
eq(bounded.events.length, 96, 'stable motif identity does not grow the existing receipt bound');
eq(motif.snapshot(bounded, at + 100).anchors, [{ community: 'shittyaskfeddit', motif: 'glopspray' }],
  'many observations reuse one bounded local anchor');
assert.throws(() => motif.normalize({ version: 2, anchors: [{ community: 'shittyaskfeddit', motif: 'glopspray' },
  { community: 'shittyaskfeddit', motif: 'glopspray' }] }), error => error.code === 'THEME_INTEREST_BOOKKEEPING_PENDING'); checks++;
assert.throws(() => theme.record(learned, [{ ...learned.events[0], identityVersion: 3 }]),
  error => error.code === 'THEME_INTEREST_BOOKKEEPING_PENDING'); checks++;
const candidates = [candidate(10, seed), candidate(11, 'An entirely different subject with a mundane question.')];
const decorated = context.decorate({ candidates, voteCandidates: [] }, used, at + 3, 'next', scope, 2);
eq(decorated.candidates.map(item => [item.id, item.salience, item.context, item.target]),
  candidates.map(item => [item.id, item.salience, item.context, item.target]), 'identity cannot change order, target, salience or context');
ok(!('priority' in view(used, at + 3)) && !('eligible' in view(used, at + 3)), 'identity has no scheduling or eligibility authority');

const result = replay();
eq(result.sources, 8, 'retained fixture contains only eight public episode sources');
eq(result.receipts, 24, 'retained fixture preserves all 24 actual episode receipt times');
eq(result.correctedIdentities, ['glopspray'], 'all safe retained episode variants resolve to one identity');
eq(result.oldIdentities.length, 8, 'legacy features fragment the distinctive motif into eight pair identities');
eq(result.bots.fedditfoolish.final.corrected.uses, 2, 'retained repeated own use accumulates');
ok(result.bots.fedditfoolish.final.corrected.familiarity !== result.bots.porcelain_oracle_bot.final.corrected.familiarity,
  'retained different bot histories stay genuinely different');
eq(result.thresholdReachability.established.sort(), ['fedditfoolish', 'porcelain_oracle_bot', 'splurf_sommelier_bot'].sort(),
  'unchanged established threshold becomes reachable within retained waves');
eq(result.thresholdReachability.elevated, [], 'retained actual participation does not yet cross unchanged elevated threshold');
ok(result.bots.fedditfoolish.final.corrected.satiation > 0.49,
  'same motif own participation accumulates close to unchanged satiation threshold without lowering it');
eq(result.thresholdReachability.repeated, [], 'identity repair does not lower unchanged repeated-own-use threshold');
for (const source of fixture.sources) {
  eq(motif.extract(source.text, ['glopspray']), ['glopspray'], 'public retained source has no unrelated corrected identity: ' + source.key);
}
console.log('theme-motif: ' + checks + ' checks passed');
