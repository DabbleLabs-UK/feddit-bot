'use strict';

const assert = require('node:assert/strict');
const candidates = require('../lib/action-candidates');

let checks = 0;
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function item(key, candidateType, context, createdUtc) {
  return {
    key,
    action: candidateType === 'article' ? 'news' :
      (candidateType === 'new_discussion' ? 'post' : 'comment'),
    candidateType,
    context,
    createdUtc,
  };
}

const menu = candidates.bound({
  attention: [
    item('direct', 'reply_to_own_comment', 'A direct answer to the bot.', 100),
    item('mention', 'mention_in_comment', '@sample was mentioned exactly.', 110),
    item('nested', 'nested_continuation', 'A nearby continuation.', 120),
  ],
  ordinary: [item('ordinary', 'ordinary_post', 'An unrelated but interesting garden post.', 130)],
  articles: [item('article', 'article', 'A real article about public transport.', 140)],
  discussions: [item('discussion', 'new_discussion', 'f/botlife accepts text discussions.', 0)],
});

eq(menu.map((entry) => entry.id), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
  'a mixed real opportunity menu receives stable bounded identifiers');
eq(menu[0].salience.level, 'high', 'a direct reply is marked highly salient');
eq(menu[1].salience.level, 'high', 'an exact mention is marked highly salient');

const prompt = candidates.prompt(menu, 200_000);
ok(prompt.includes('A direct answer to the bot.'), 'the decision prompt contains real direct-reply context');
ok(prompt.includes('An unrelated but interesting garden post.'), 'the decision prompt contains ordinary feed content');
ok(prompt.includes('A real article about public transport.'), 'the decision prompt contains a real article candidate');
ok(prompt.includes('f/botlife accepts text discussions.'), 'the decision prompt contains a real discussion destination');
ok(prompt.includes('Direct replies and exact mentions') && prompt.includes('never require an answer'),
  'the prompt makes highly salient direct attention optional');
ok(prompt.includes('WAIT is a genuine, equally valid choice'), 'WAIT is presented as a first-class choice');
ok(prompt.includes('Do not provide analysis, private reasoning'), 'the prompt requests a short decision rather than chain of thought');

let decision = candidates.parseDecision('{"choice":"C4","reason":"The garden topic fits what I care about."}', menu);
eq(decision.candidate.candidateType, 'ordinary_post',
  'ordinary content may win despite direct replies and mentions being present');
decision = candidates.parseDecision('{"choice":"C5","reason":"The article fits my interests."}', menu);
eq(decision.candidate.candidateType, 'article', 'a real article can be selected from the same menu');
decision = candidates.parseDecision('{"choice":"C6","reason":"I have a relevant opening thought."}', menu);
eq(decision.candidate.candidateType, 'new_discussion', 'a new discussion can be selected from the same menu');
decision = candidates.parseDecision('{"choice":"WAIT","reason":"Nothing feels worth adding to."}', menu);
ok(decision.waited && decision.reason === 'Nothing feels worth adding to.',
  'WAIT preserves a concise deliberate reason');
decision = candidates.parseDecision('unparseable model output', menu);
ok(decision.waited && !decision.valid, 'an invalid selection safely waits instead of forcing publication');

const bounded = candidates.bound({
  attention: Array.from({ length: 10 }, (_, index) => item('a' + index, 'mention_in_post', 'attention ' + index, index)),
  ordinary: Array.from({ length: 10 }, (_, index) => item('o' + index, 'ordinary_post', 'ordinary ' + index, index)),
  articles: Array.from({ length: 10 }, (_, index) => item('n' + index, 'article', 'article ' + index, index)),
  discussions: Array.from({ length: 10 }, (_, index) => item('d' + index, 'new_discussion', 'discussion ' + index, index)),
});
eq(bounded.length, 12, 'the complete multi-source menu has a hard total bound');
eq(bounded.filter((entry) => entry.candidateGroup === 'attention').length, 4,
  'direct-attention input has its own hard bound');
eq(bounded.filter((entry) => entry.candidateGroup === 'ordinary').length, 3,
  'ordinary feed input has its own hard bound');
eq(bounded.filter((entry) => entry.candidateGroup === 'articles').length, 3,
  'article input has its own hard bound');
eq(bounded.filter((entry) => entry.candidateGroup === 'discussions').length, 2,
  'discussion input has its own hard bound');
const largePrompt = candidates.prompt(bounded.map((entry) => ({
  ...entry,
  context: 'x'.repeat(20_000),
})), 200_000);
ok(largePrompt.length < 40_000,
  'the complete decision prompt remains bounded even when every source contains large text');

const summary = candidates.publicDecision(
  candidates.parseDecision('{"choice":"C4","reason":"The ordinary post fits."}', menu),
  menu
);
eq(summary.candidateCount, 6, 'the public decision exposes how many real candidates were considered');
ok(!Object.prototype.hasOwnProperty.call(summary, 'candidate'),
  'the public decision does not expose the internal candidate payload');

console.log('action candidates: ' + checks + ' checks passed');
