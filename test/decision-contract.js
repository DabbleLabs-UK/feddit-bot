'use strict';

// Offline synthetic decisions only; no live state, models or HTTP endpoints.
const assert = require('node:assert/strict');
const contract = require('../lib/decision-contract');
const voting = require('../lib/voting');
const candidates = require('../lib/action-candidates');
const burst = require('../lib/burst');
const evidence = require('../lib/naturalness-evidence');
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const slate = Array.from({ length: 8 }, (_, i) => ({ id: 'V' + (i + 1),
  targetType: i % 2 ? 'comment' : 'post', targetId: i + 1, label: 'Synthetic item' }));
const menu = Array.from({ length: 4 }, (_, i) => ({ id: 'C' + (i + 1), action: 'comment' }));
const parse = (text) => candidates.parseDecision(text, menu, { voteCandidates: slate });
const explicit = { id: 'V1', direction: 'up', reason: 'The evidence is precise and useful.' };
const base = JSON.stringify({ choice: 'C1', votes: [explicit, { id: 'V2', direction: 'nil' }] });
const before = JSON.stringify({ slate, menu });

eq(contract.version(), 2);
eq(contract.version(undefined, 1), 1);
for (const value of [0, 3, '2', false, {}, []]) {
  assert.throws(() => contract.version(value), { code: 'UNSUPPORTED_DECISION_CONTRACT' }); checks++;
}
for (const text of [base + '|im_end|>', 'Answer: ' + base, base.slice(0, -1),
  'C1', 'WAIT', '1', 'null', '[]', '{"choice":["C1"]}',
  '{"choice":"C1","choice":"WAIT"}',
  '{"choice":"C1","votes":[{"id":"V1","direction":"up","direction":"nil"}]}',
  '{"choice":"C1","votes":[],"vo\\u0074es":[{"id":"V1","direction":"nil"}]}']) {
  const result = parse(text);
  eq(result.valid, false, 'malformed/ambiguous primary is not guessed');
  eq(result.votes.every((vote) => vote.direction === null && vote.status === 'unresolved'), true);
  eq(voting.record({ considered: ['post:99'] }, result.votes).considered, ['post:99']);
}
eq(parse('```json\n' + base + '\n```').valid, true, 'established full-fence wrapper remains supported');
eq(contract.parseObject('{"text":"quoted \\\"key\\\": } ]", "nested":{"x":1},"array":[{"x":2}]}').nested.x, 1);
eq(contract.parseObject('{"x":{"a":1,"a":2}}'), null, 'nested repeated members rejected');

let result = parse(base);
eq(result.votes.map((vote) => vote.decisionKind), ['explicit', 'explicit', ...Array(6).fill('missing')]);
eq(voting.record({ considered: ['post:99'] }, result.votes).considered, ['post:99', 'post:1', 'comment:2']);
eq(result.votes[0].reason, explicit.reason);
eq(result.votes[1].direction, 'nil');
eq(result.votes[1].status, 'no-vote');
for (const raw of [{ id: 'V1' }, { id: 'V1', direction: 'sideways' },
  { id: 'V1', direction: ['nil'] }, { id: 'V1', direction: 'up', reason: 'nice' },
  { id: 'V1', direction: 'down', reason: { text: 'An invented reason is forbidden.' } }]) {
  const vote = parse(JSON.stringify({ choice: 'WAIT', votes: [raw] })).votes[0];
  eq([vote.direction, vote.status, vote.decisionKind], [null, 'unresolved', 'invalid']);
}
result = parse(JSON.stringify({ choice: 'WAIT', votes: Array(20).fill(explicit) }));
eq(result.votes.filter((vote) => vote.decisionKind === 'explicit').length, 1, 'identical duplicates deduplicate');
eq(result.votes[0].reason, explicit.reason);
result = parse(JSON.stringify({ choice: 'WAIT', votes: [explicit,
  { ...explicit, direction: 'down' }, { id: 'V2', direction: 'nil' },
  { id: 'V999', direction: 'nil' }] }));
eq(result.votes[0].decisionKind, 'invalid', 'conflicting duplicate is ambiguous');
eq(result.votes[1].decisionKind, 'explicit', 'independent explicit nil survives');
eq(result.votes.length, 8, 'unknown IDs never extend offered slate');
eq(voting.record({}, result.votes).considered, ['comment:2']);
const repaired = parse(JSON.stringify({ choice: 'C1', votes: slate.map((item) => ({ ...explicit, id: item.id, direction: 'down' })) }));
const merged = voting.retainResolved(parse(base).votes, repaired.votes);
eq(merged.map((vote) => vote.direction), ['up', 'nil', ...Array(6).fill('down')], 'repair cannot reroll validated votes');
eq(merged[0].reason, explicit.reason);
eq(repaired.votes[0].direction, 'down', 'merge does not mutate persisted checkpoints');

const offered = slate.map((item) => ({ ...item, key: voting.targetKey(item) }));
const observed = evidence.decisionItems('not valid JSON', offered, slate, merged);
eq(observed.map((item) => item.decisionKind), Array(8).fill('explicit'), 'merged classifications reflect both attempts');
eq(observed[0].direction, 'up');
eq(evidence.decisionItems('', offered, slate, parse('').votes, { failed: true })[0].decisionKind, 'unknown');

// Retain exact old parse/considered behavior only when the turn is version 1.
const legacy = candidates.parseDecision('C1 in prose', menu, { voteCandidates: slate, decisionContractVersion: 1 });
eq(legacy.valid, true);
eq(legacy.votes.map((vote) => vote.direction), Array(8).fill('nil'));
eq(voting.record({}, legacy.votes).considered.length, 8);
eq(legacy.votes.some((vote) => vote.decisionKind), false);

const actions = menu.map((item) => ({ candidate: item.id, text: 'Bounded synthetic reply.' }));
let plan = burst.parsePlan(JSON.stringify({ actions, votes: Array(20).fill(explicit) }), menu, slate);
eq(plan.actions.length, 3, 'top-level Burst cap unchanged');
eq(plan.votes.filter((vote) => vote.decisionKind === 'explicit').length, 1);
eq(plan.votes.filter((vote) => vote.status === 'unresolved').length, 7);
plan = burst.parsePlan(JSON.stringify({ actions, votes: [{ id: 'V2', direction: 'nil' },
  explicit, { ...explicit, direction: 'down' }, { id: 'V999', direction: 'nil' }] }), menu, slate);
eq(plan.votes.slice(0, 2).map((vote) => [vote.id, vote.direction]), [['V2', 'nil'], ['V1', null]],
  'Burst preserves supplied order but rejects conflicting directions');
eq(voting.record({}, plan.votes).considered, ['comment:2']);
plan = burst.parsePlan(JSON.stringify({ actions, votes: slate.map((item) => ({ ...explicit, id: item.id })) }), menu, slate);
eq(plan.votes.length, 8);
eq(plan.votes.every((vote) => vote.decisionKind === 'explicit'), true, 'maximum unique slate unchanged');
eq(burst.parsePlan(JSON.stringify({ votes: [{ id: 'V1', direction: 'up', reason: 'I like this' }] }), [], slate).votes[0].direction,
  'up', 'existing Burst three-word reason rule retained');
eq(burst.parsePlan('not JSON', menu, slate).votes.every((vote) => vote.direction === null), true);
eq(JSON.stringify({ slate, menu }), before, 'frozen slates and contexts not mutated');
const failedDecision = candidates.publicDecision(parse('not JSON'), [{ candidateType: 'reply_to_own_post' }]);
eq(failedDecision.outcome, 'failed');
eq(failedDecision.selectedLabel, 'Decision failed');
eq(failedDecision.socialDecisionContext, '', 'technical failure is not a social WAIT');
eq(candidates.publicDecision(candidates.parseDecision('not JSON', menu,
  { decisionContractVersion: 1 }), menu).outcome, 'wait', 'legacy public outcome unchanged');
const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
const renderer = html.slice(html.indexOf('function simulationValue('), html.indexOf('function renderSimulationResults('));
const ui = { esc: (value) => String(value) };
require('node:vm').runInNewContext(renderer, ui);
const failedHtml = ui.simulationDecision(failedDecision);
eq(failedHtml.includes('Why the decision failed'), true);
eq(failedHtml.includes('UNRESOLVED'), true);
eq(failedHtml.includes('NO VOTE'), false, 'unresolved is not displayed as abstention');
eq(ui.simulationDecision(candidates.publicDecision(parse(base), menu)).includes('NO VOTE'), true,
  'explicit nil still displays as abstention');
console.log('decision contract: ' + checks + ' checks passed (offline)');
