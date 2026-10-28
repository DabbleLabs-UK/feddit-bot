'use strict';

const assert = require('node:assert/strict');
const motif = require('../lib/theme-phrase-motif');
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (actual, message) => { assert.ok(actual, message); checks++; };
const throws = callback => { assert.throws(callback, error => error.code === 'THEME_INTEREST_BOOKKEEPING_PENDING'); checks++; };
const at = 1800000000000;
const community = 'shittyaskfeddit';
const empty = { version: 3, anchors: [], pending: [] };
const sample = 'We asked Milt Gable to inspect the municipal soup yesterday.';
const seed = 'A GLOPSPRAY lands beside the toaster. Nobody knows why a GLOPSPRAY demands a permit.';
function exposure(id, author, text = sample, time = at) {
  return { at: time, identityVersion: 3, kind: 'exposure', community, sourceKey: 't1_' + id, author,
    motifs: motif.extract(text), proposals: motif.propose(text) };
}

eq(motif.VERSION, 3, 'phrase discovery is independently versioned');
eq(motif.propose(sample), ['milt~gable'], 'distinctive two-word name is proposed');
eq(motif.extract(sample), [], 'first proposal is not a recognised motif or cue');
eq(motif.propose('We asked MiltGable to inspect the soup yesterday.'), ['milt~gable'], 'camel segmentation agrees with spaced name');
for (const text of ['We asked Milt-Gable to inspect the soup.', 'We asked Milt_Gable to inspect the soup.',
  'We asked (Milt Gable), to inspect the soup.']) {
  eq(motif.propose(text), ['milt~gable'], 'conservative introduction formatting: ' + text);
}
for (const text of ['milt gable', 'MILT GABLE', "Milt Gable's permit", '(milt-gable)', 'Milt_Gable', 'MiltGable', '*Milt* **Gable**']) {
  eq(motif.propose(text, ['milt~gable']), ['milt~gable'], 'pending name accepts conservative alias: ' + text);
  eq(motif.extract(text, ['milt~gable']), ['milt~gable'], 'approved identity stable across alias: ' + text);
}
for (const text of ['milt, gable', 'milt. gable', 'milt\ngable', 'milt/gable', 'milt very gable',
  'anti-milt gable', 'milt gables', 'amilt gable', 'milt gableism', "Milt Gable't", "Milt Gable'something"]) {
  eq(motif.extract(text, ['milt~gable']), [], 'no fuzzy or clause/subword matching: ' + text);
}
for (const text of ['We asked John Smith to inspect the soup today.',
  'The New Policy requires an ordinary signature today.', 'Your New Friend has arrived at the office.',
  'Milt Gable Municipal Soup Inspection', 'Please Read This Important Notice',
  'We asked https://example.invalid/Milt-Gable to inspect the soup.',
  'We asked @MiltGable to inspect the soup.',
  'We asked <span title="Milt Gable">someone</span> to inspect the soup.',
  'We asked <script>Milt Gable</script> someone to inspect the soup.',
  'We asked New York to inspect the soup today.',
  'We asked about Jelly Beans and Star Wars during the meeting.',
  'We asked a Feddit Bot to inspect the soup today.',
  'A Non-Existent Question was written in the ledger today.',
  'We asked Shitty Ask Feddit about the strange soup today.',
  'We asked Unfinished Buildings and Tasting Academy to inspect soup.',
  'Milt Gable Municipal Soup Inspection\nthis body contains ordinary lower case prose.',
  'This Ordinary Capitalised Prose remains entirely uninteresting to everyone.']) {
  eq(motif.propose(text), [], 'generic prose, vocabulary and metadata do not propose: ' + text);
}
eq(motif.propose('x'.repeat(1200) + sample), [], 'input remains bounded');
eq(motif.extract(seed), ['glopspray'], 'legacy repeated distinctive caps stays immediate');
eq(motif.extract('The glop spray failed.', ['glopspray']), ['glopspray'], 'legacy split alias stays intact');
eq(motif.propose(seed), [], 'legacy singleton is not a pending phrase');
eq(motif.extract('Milt Gable spoke to Milt Cable.', ['milt~gable', 'milt~cable']), ['milt~gable', 'milt~cable'],
  'shared name constituent does not collapse identities');
eq(motif.extract('MiltGable', ['milt~gable', 'mil~tgable']), ['milt~gable'], 'camel segmentation cannot alias another segmentation');

const first = exposure(1, 'bot_a');
const one = motif.extend(empty, [first]);
eq(motif.local(one, community), [], 'one source stays pending');
eq(motif.proposed(one, community), ['milt~gable'], 'pending is available only for later actual matching');
eq(motif.extend(one, [first]), one, 'same public source replay cannot promote');
const sameAuthor = motif.extend(one, [exposure(2, 'bot_a')]);
eq(motif.local(sameAuthor, community), [], 'different source by same author cannot promote');
const ownOnly = motif.extend(one, [{ ...exposure(3, 'reader'), kind: 'participation' }]);
eq(motif.local(ownOnly, community), [], 'own publication cannot corroborate a proposal');
eq(ownOnly.pending.length, 2, 'own publication preserves alias evidence without independent readership');
eq(motif.propose('milt-gable', motif.proposed(ownOnly, community)), ['milt~gable'], 'own pending alias survives lower-case reuse');
const onlyOwn = motif.extend(empty, [{ ...exposure(4, 'reader'), kind: 'participation' },
  { ...exposure(5, 'reader'), kind: 'participation' }]);
eq(motif.local(onlyOwn, community), [], 'repeated own publications never approve a phrase');
const rehearsal = motif.extend(empty, [{ ...exposure(6, 'reader'), kind: 'participation', sourceKey: 'r3_' + 'a'.repeat(64) }]);
eq(motif.proposed(rehearsal, community), ['milt~gable'], 'rehearsal own receipt can retain only a local alias');
eq(motif.local(rehearsal, community), [], 'private rehearsal publication never corroborates independent exposure');
const two = motif.extend(one, [exposure(2, 'bot_b')]);
eq(motif.local(two, community), ['milt~gable'], 'two independently authored public encounters approve locally');
eq(motif.local(two, 'other'), [], 'no cross-community anchors');
eq(motif.local(empty, community), [], 'another bot has no invented encounters');
eq(motif.snapshot({ events: [first] }, at), one, 'restart reconstructs first pending source');
eq(motif.snapshot({ events: [first, exposure(2, 'bot_b')] }, at), two, 'restart reconstructs approved phrase');
eq(motif.normalize(JSON.parse(JSON.stringify(two))), two, 'bounded identity survives serialization');
eq(motif.snapshot({ events: [first] }, at - 1), empty, 'future source cannot affect frozen turn');
eq(motif.snapshot({ events: [first] }, at + 8 * 24 * 60 * 60 * 1000), empty, 'retention unchanged');
eq(motif.snapshot({ events: [{ ...first, identityVersion: undefined, features: [['milt', 'gable']] }] }, at), empty,
  'legacy lexical pairs never backfill phrase proposals');
eq(motif.snapshot({ events: [{ ...first, identityVersion: 2, motifs: ['glopspray'] }] }, at).anchors,
  [{ community, motif: 'glopspray' }], 'v2 anchors remain available without reinterpretation');
ok(motif.matches(first, new Set(['milt~gable'])), 'approved subject can account for its original pending encounter');
eq(motif.matches(first, new Set()), false, 'proposal alone cannot establish familiarity');
ok(motif.matches({ identityVersion: 2, motifs: ['glopspray'] }, new Set(['glopspray'])), 'legacy matching preserved');
eq(motif.matches({ features: [['milt', 'gable']] }, new Set(['milt~gable'])), false, 'no legacy adjacent-pair reinterpretation');

const events = Array.from({ length: 96 }, (_, index) => ({ ...exposure(index + 1, 'bot_' + index),
  proposals: ['milt~gable', 'milt~cable', 'milt~table'] }));
const bounded = motif.snapshot({ events }, at);
eq(bounded.pending.length, 288, 'pending cannot exceed three proposals per existing 96 events');
eq(bounded.anchors.length, 3, 'independent counts share bounded stable identities');
throws(() => motif.normalize({ ...empty, unknown: true }));
throws(() => motif.normalize({ version: 2, anchors: [] }));
throws(() => motif.normalize({ ...empty, pending: [one.pending[0], one.pending[0]] }));
throws(() => motif.normalize({ ...empty, pending: [{ ...one.pending[0], sourceKey: 'r3_' + 'a'.repeat(64) }] }));
throws(() => motif.normalize({ ...empty, pending: [{ ...one.pending[0], author: 'Bad Name' }] }));
throws(() => motif.normalize({ ...empty, pending: Array(289).fill(one.pending[0]) }));
throws(() => motif.names(['john~smith']));
throws(() => motif.names(['milt~gable', 'milt~gable']));
throws(() => motif.names(['milt~gable', 'milt~cable', 'milt~table', 'milt~paper']));
throws(() => motif.extend(one, [{ ...first, author: 'changed_author' }]));
throws(() => motif.snapshot({ events: Array(97).fill(first) }, at));
for (const text of ['A fork named Sir Reginald arrived for tea.', 'The cat called Lady Reginald went upstairs.',
  'Our visitor Doctor Broomfield joined the conversation.']) {
  eq(motif.propose(text), [], 'honorific plus a given name is not a distinctive full phrase identity');
}
console.log('theme-phrase-motif: ' + checks + ' checks passed');
