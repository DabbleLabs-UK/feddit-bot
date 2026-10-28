'use strict';

const assert = require('node:assert/strict');
const { replay, candidate, corpus } = require('../bin/replay-theme-phrase');
const oldReplay = require('../bin/replay-theme-motif').replay;
const fixture = require('./fixtures/theme-motif-milt-gable.json');
const glopspray = require('./fixtures/theme-motif-glopspray.json');
const context = require('../lib/theme-context');
const theme = require('../lib/theme-interest');
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const ok = (value, label) => { assert.ok(value, label); checks++; };

const result = replay();
eq(result.sources, 5, 'five actual public source bodies');
eq(result.retainedReceipts, 11, 'exact retained receipt count');
eq(result.generatedReceipts, 11, 'adapter reproduces one receipt per genuine source encounter/use');
eq(new Set(fixture.events.map(e => e.id)).size, 11, 'receipt identities are distinct');
eq(result.readingBots.length, 5, 'five bots genuinely encountered sources');
eq(result.publishingBots.length, 5, 'five bots genuinely published sources');
eq(Object.keys(result.bots).length, 6, 'readers and publishers are not falsely conflated');
eq(result.legacyMotifs, [], 'original v2 detector missed the episode');
eq(replay(fixture, 'Milt Gable', 2).correctedMotifs, [], 'frozen old adapter still misses the phrase');
eq(result.correctedMotifs, ['milt~gable'], 'new detector recognises one stable phrase identity');

const dialup = result.bots.dialup_tavern_bot;
eq(dialup.progression[0].sources, ['t1_2311', 't3_892'], 'only the retained same-time actual handled batch corroborates locally');
eq(dialup.progression[0].motifs, ['milt~gable'], 'two independently authored encountered sources promote');
eq(dialup.progression[0].preEncounterCueCandidates, 0, 'discovery is not retroactive cue delivery');
eq(dialup.progression[0].familiarity, 0.486583, 'unchanged exposure dynamics');
eq(dialup.progression[0].satiation, 0.076884, 'unchanged encounter satiation');
eq(dialup.final.familiarity, 0.478949, 'normal decay before confirmed own publication');
eq(dialup.final.satiation, 0.315529, 'confirmed own participation accrues local satiation');
eq(dialup.final.uses, 1, 'only actual publication receipt counts as own use');
eq(dialup.final.independentAuthors, 2, 'own use is not a third independent encounter');
for (const name of ['tavern_toilet_oracle', 'fedditfoolish', 'fedbot5000', 'botbaffler_999', 'bot_baffle']) {
  eq(result.bots[name].final.known, false, name + ' has no fabricated second external encounter');
  eq(result.bots[name].final.counterfactualCueAvailableAfter, false, name + ' gets no invented cue');
}
for (const text of ['milt gable', 'MILT GABLE', '*Milt* **Gable**', 'Milt-Gable', 'Milt Gable\'s face']) {
  eq(replay(fixture, text).bots.dialup_tavern_bot.final.familiarity, dialup.final.familiarity,
    'learned aliases retain exact progression: ' + text);
}
const before = JSON.stringify(fixture);
replay();
eq(JSON.stringify(fixture), before, 'offline replay never rewrites retained evidence');
ok(!JSON.stringify(fixture).includes('profileId'), 'committed evidence contains no private profile ID');
ok(fixture.sources.every(source => source.text.length <= 1200), 'retained source text fits the actual detector bound without invented clipping');

const state = theme.normalize();
const scope = { version: 1, communities: ['shittyaskfeddit'] };
const snapshot = context.decorate({ candidates: fixture.sources.map(candidate), voteCandidates: [] }, state,
  fixture.events.at(-1).at, 'offline-deferred', scope, 3);
eq(context.exposure(snapshot, { valid: false, candidates: snapshot.candidates, votes: [] }, 'another_bot'), [],
  'mere discovery/deferred candidates produce no exposure receipts');
eq(context.exposure(snapshot, { valid: true, candidates: [], votes: [] }, 'another_bot'), [],
  'unhandled gathered candidates produce no exposure receipts');

const old = oldReplay(glopspray);
const corrected = replay(glopspray, 'GLOPSPRAY');
eq(corrected.sources, 8, 'all retained GLOPSPRAY sources');
eq(corrected.generatedReceipts, 24, 'all retained GLOPSPRAY receipts');
eq(corrected.correctedMotifs, ['glopspray'], 'GLOPSPRAY remains one stable identity');
for (const [bot, prior] of Object.entries(old.bots)) {
  eq(corrected.bots[bot].progression.map(item => ({ exposures: item.exposures, uses: item.uses,
    familiarity: item.familiarity, satiation: item.satiation, summary: item.summary })),
  prior.progression.map(item => item.corrected), 'GLOPSPRAY exact unchanged per-bot progression: ' + bot);
}

const screen = corpus({ posts: [{ id: 1, community: 'shittyaskfeddit', author: 'one', title: '', body: 'A man named Milt Gable arrived.' }],
  comments: [{ id: 2, community: 'shittyaskfeddit', author: 'two', body: 'milt gable left.' }] });
eq(screen.roots, 1, 'corpus screen counts roots separately');
eq(screen.comments, 1, 'corpus screen counts comments separately');
eq(screen.repeatedIndependentNames.find(item => item.name === 'milt~gable').sourceCount, 2,
  'corpus screening finds lowercase reuse without claiming bot encounter');
console.log('theme phrase replay: ' + checks + ' checks passed');
