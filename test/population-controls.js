'use strict';

const assert = require('node:assert/strict');
const population = require('../lib/population');
const activity = require('../lib/population-activity');

let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }

function seed(overrides = {}) {
  return population.normalizeSeed({
    username: 'control_bot',
    biography: 'A compact test bot.',
    temperament: 'curious',
    interests: ['testing'],
    conversationalStyle: 'specific',
    disagreementStyle: 'calm',
    fictionalBackground: 'Keeps a notebook of odd details.',
    values: ['clarity'],
    communities: ['botlife'],
    initiative: 'balanced',
    abilities: { reply: true, discuss: true, links: false },
    ...overrides,
  });
}

const defaults = population.normalizeCohortConfiguration();
eq(defaults, population.DEFAULT_COHORT_CONFIGURATION,
  'omitted structured controls preserve the default cohort path');
const ordinary = seed();
eq(population.applyCohortConfiguration(ordinary, defaults, 'default'), ordinary,
  'default varied controls do not rewrite generated ability or initiative choices');

const hardReplyOn = population.applyCohortConfiguration(seed({ abilities: {
  reply: false, discuss: true, links: false,
} }), { reply: 'enabled' }, 'reply-on');
eq(hardReplyOn.abilities.reply, true, 'hard reply-enabled is normalised after model output');
population.validateHardSeed(hardReplyOn, { reply: 'enabled' });

const hardReplyOff = population.applyCohortConfiguration(seed(), { reply: 'disabled' }, 'reply-off');
eq(hardReplyOff.abilities.reply, false, 'hard reply-disabled is normalised after model output');
population.validateHardSeed(hardReplyOff, { reply: 'disabled' });

const hardDiscussion = population.applyCohortConfiguration(seed({ abilities: {
  reply: true, discuss: false, links: false,
} }), { discuss: 'enabled' }, 'discussion-on');
eq(hardDiscussion.abilities.discuss, true, 'hard text-discussion ability is obeyed');

const hardLinks = population.applyCohortConfiguration(seed(), { links: 'enabled' }, 'links-on');
eq(hardLinks.abilities.links, true, 'hard article-sharing ability is obeyed');

const hostileOutput = population.applyCohortConfiguration(seed({ abilities: {
  reply: true, discuss: true, links: false,
} }), { reply: 'disabled', discuss: 'disabled', links: 'enabled' }, 'hostile-output');
eq(hostileOutput.abilities, { reply: false, discuss: false, links: true },
  'invalid model choices cannot bypass hard ability constraints');
population.validateHardSeed(hostileOutput, { reply: 'disabled', discuss: 'disabled', links: 'enabled' });

assert.throws(() => population.normalizeCohortConfiguration({
  reply: 'disabled', discuss: 'disabled', links: 'disabled',
}), /cannot disable/i);
checks++;
assert.throws(() => population.normalizeCohortConfiguration({
  reply: 'disabled', balance: 'mostly-replies',
}), /conflicts/i);
checks++;
assert.throws(() => population.normalizeCohortConfiguration({
  discuss: 'disabled', links: 'disabled', balance: 'mostly-posts',
}), /conflicts/i);
checks++;

const softReplies = Array.from({ length: 40 }, (_, index) => population.applyCohortConfiguration(
  seed({ abilities: { reply: false, discuss: true, links: false } }),
  { strength: 'soft', reply: 'enabled' },
  'soft-reply-' + index,
));
ok(softReplies.some((item) => item.abilities.reply), 'soft reply preference biases some generated members');
ok(softReplies.some((item) => !item.abilities.reply), 'soft reply preference retains genuine variation');

const direction = 'Make distinct bots fascinated by municipal mysteries.';
const prompt = population.generationPrompt({
  cohortId: 'cohort-test', slot: 0, attempt: 1, direction,
  configuration: { reply: 'disabled', links: 'enabled', activity: 'quiet' },
});
ok(prompt.includes('Operator creative direction for this cohort: ' + direction),
  'creative direction remains a separate generation input');
ok(prompt.includes('Structured operational controls (separate from creative direction)'),
  'structured requirements are explicit and separate in the model request');
ok(prompt.includes('HARD generation constraints'), 'the model request identifies hard controls as non-overridable');

const seeds = Array.from({ length: 100 }, (_, index) => seed({ username: 'cohort_' + index }));
const varied = activity.assignCohort(seeds, { nowMs: 1, offset: 0, activity: 'varied' });
eq(activity.cohortSummary(varied, { nowMs: 1 }).bands,
  { rare: 52, occasional: 28, regular: 15, active: 5 },
  'default activity retains the existing heavy-tailed ecology');

const quiet = activity.assignCohort(seeds.slice(0, 12), {
  nowMs: 1, offset: 0.42, activity: 'quiet', strength: 'hard',
});
ok(quiet.every((state) => state.band === 'rare'), 'hard quiet maps into the existing rare ecology band');
const occasional = activity.assignCohort(seeds.slice(0, 12), {
  nowMs: 1, offset: 0.42, activity: 'occasional', strength: 'hard',
});
ok(occasional.every((state) => state.band === 'occasional'),
  'hard occasional maps into the existing occasional ecology band');
const active = activity.assignCohort(seeds.slice(0, 12), {
  nowMs: 1, offset: 0.42, activity: 'active', strength: 'hard',
});
ok(active.every((state) => state.band === 'active'), 'hard active maps into the existing active ecology band');
ok(active.every((state) => state.currentDailyOpportunities <= activity.MAX_OPPORTUNITIES_PER_DAY),
  'active cohorts remain within the existing six-live-opportunity ceiling');

const softRegular = activity.assignCohort(seeds.slice(0, 12), {
  nowMs: 1, offset: 0, activity: 'regular', strength: 'soft',
});
ok(softRegular.filter((state) => state.band === 'regular').length >= 8,
  'soft activity preferences bias most members toward the requested band');
ok(new Set(softRegular.map((state) => state.band)).size > 1,
  'soft activity preferences retain ordinary ecology variation');

const mostlyReplies = activity.assignCohort(seeds.slice(0, 12), {
  nowMs: 1, offset: 0.2, balance: 'mostly-replies', strength: 'hard',
});
const balanced = activity.assignCohort(seeds.slice(0, 12), {
  nowMs: 1, offset: 0.2, balance: 'balanced', strength: 'hard',
});
const mostlyPosts = activity.assignCohort(seeds.slice(0, 12), {
  nowMs: 1, offset: 0.2, balance: 'mostly-posts', strength: 'hard',
});
const average = (items) => items.reduce((sum, item) => sum + item.postOpportunityShare, 0) / items.length;
ok(average(mostlyReplies) < average(balanced) && average(balanced) < average(mostlyPosts),
  'balance choices directionally change the existing post and reply clocks');
ok(new Set(mostlyPosts.map((state) => state.postOpportunityShare.toFixed(4))).size > 1,
  'balance is stochastic within bounds rather than an exact quota');
ok(varied.every((state) => Math.abs(state.postOpportunityShare - (1 / 3)) < 1e-12),
  'varied balance preserves the previous one-third post share');

console.log('population structured controls: ' + checks + ' checks passed');
