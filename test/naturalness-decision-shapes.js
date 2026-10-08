'use strict';

// Synthetic frozen shapes from the hosted audit, never real prompts or reasons.
// These protect diagnostic distinctions in the historical parser. Version-2
// production correctness and no-salvage behavior are covered separately.
// Pure modules only: no store, scheduler, transport, model or publication calls.
const assert = require('node:assert/strict');
const candidates = require('../lib/action-candidates');
const evidence = require('../lib/naturalness-evidence');
const menu = [{ id: 'C1', candidateType: 'ordinary_post' }, { id: 'C2', candidateType: 'ordinary_post' }];
const slate = [
  { id: 'V1', targetType: 'post', targetId: 1 },
  { id: 'V2', targetType: 'comment', targetId: 2 },
];
const offered = slate.map(v => ({ key: v.targetType + ':' + v.targetId, targetType: v.targetType, targetId: v.targetId }));
const valid = JSON.stringify({ choice: 'C2', reason: 'This item fits.', votes: [
  { id: 'V1', direction: 'up', reason: 'This explanation is specific and useful.' },
  { id: 'V2', direction: 'nil', reason: '' },
] });
const before = JSON.stringify({ menu, slate, offered });
let checks = 0;
function eq(actual, expected) { assert.deepEqual(actual, expected); checks++; }
function observe(text) {
  const parsed = candidates.parseDecision(text, menu, { voteCandidates: slate, decisionContractVersion: 1 });
  return evidence.decisionItems(text, offered, slate, parsed.votes);
}
for (const text of [
  valid + '|im_end|>',
  valid + '\nV1: up\nV2: nil',
  'Here is the decision:\n' + valid,
  valid.slice(1),
  valid.slice(0, -1),
  valid.replace('"votes":', 'votes:'),
  'C1 is unsuitable; choose C2.',
  'C1',
  'WAIT',
]) {
  const items = observe(text);
  eq(items.map(i => i.decisionKind), ['invalid', 'invalid']);
  eq(items.every(i => i.decisionKind !== 'explicit'), true);
}
eq(observe(valid).map(i => [i.decisionKind, i.direction]), [['explicit', 'up'], ['explicit', 'nil']]);
eq(observe('```json\n' + valid + '\n```').map(i => i.decisionKind), ['explicit', 'explicit']);
eq(observe('{"choice":"C1"}').map(i => i.decisionKind), ['missing', 'missing']);
eq(observe('{"choice":"WAIT","votes":[]}').map(i => i.decisionKind), ['missing', 'missing']);
eq(observe('{"choice":"C1","votes":"bad"}').map(i => i.decisionKind), ['missing', 'missing']);
eq(observe('{"choice":"C1","votes":[{"id":"V1","direction":"up","reason":"Clear and fair"}]}').map(i => i.decisionKind), ['invalid', 'missing']);
eq(observe('{"choice":"C1","votes":[{"id":"V1","direction":"up","reason":"Specific explanation"},{"id":"V2","direction":"nil"}]}').map(i => i.decisionKind), ['invalid', 'explicit']);
eq(observe('{"choice":"WAIT","votes":[{"id":"V1","direction":"nil"},{"id":"V2","direction":"nil"}]}').map(i => i.decisionKind), ['explicit', 'explicit']);
eq(JSON.stringify({ menu, slate, offered }), before);
console.log('naturalness decision shapes: ' + checks + ' checks passed (offline; zero inference or state writes)');
