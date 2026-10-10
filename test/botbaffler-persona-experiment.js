'use strict';
const assert = require('node:assert/strict');
const { plans, CLARIFICATION, TRAIT_REVISIONS, revisePersona, TARGETS, hash } = require('../bin/compare-botbaffler-persona');
const tokenizer = { MODEL: 'test-model', countRequest: (system, prompt) => system.length + prompt.length };
const packet = { version: 1, cases: TARGETS.map(target => {
  const request = { model: tokenizer.MODEL, numPredict: 200, temperature: 0.8, system: 'Original persona', prompt: 'Frozen context' };
  return { target, request, requestHash: hash(JSON.stringify(request)), turnId: 'test' };
}) };
const before = JSON.stringify(packet), calls = plans(packet, tokenizer);
assert.equal(calls.length, 8); assert.equal(JSON.stringify(packet), before);
for (let i = 0; i < 4; i++) {
  const pair = calls.slice(i * 2, i * 2 + 2), old = pair.find(c => c.variant === 'old'), clarified = pair.find(c => c.variant === 'clarified');
  assert.equal(old.request.system, 'Original persona');
  assert.equal(clarified.request.system, old.request.system + '\n\n' + CLARIFICATION);
  for (const k of ['prompt', 'temperature', 'numPredict', 'model']) assert.equal(old.request[k], clarified.request[k]);
  assert.equal(pair[0].variant, i % 2 ? 'clarified' : 'old');
}
const changed = structuredClone(packet); changed.cases[0].request.prompt += '!'; assert.throws(() => plans(changed, tokenizer));
const secret = structuredClone(packet); secret.cases[0].request.ownerKey = 'must-not-transfer';
secret.cases[0].requestHash = hash(JSON.stringify(secret.cases[0].request)); assert.throws(() => plans(secret, tokenizer));
assert.throws(() => plans(packet, { ...tokenizer, countRequest: () => 1539 }));
assert.throws(() => plans(packet, { ...tokenizer, MODEL: 'different' }));
console.log('PASS: eight calls, fixed-context pairs, alternating order, only system delta, immutable packet, hash/credential/model/fit guards.');
const original = 'Untouched identity. ' + TRAIT_REVISIONS.map(([before]) => before).join(' ') + '\nTone/style: dry wit, tongue-in-cheek';
const revised = revisePersona(original);
assert.equal(revised, 'Untouched identity. ' + TRAIT_REVISIONS.map(([, after]) => after).join(' ') + '\nTone/style: dry wit, tongue-in-cheek');
assert(!revised.includes(CLARIFICATION));
assert.throws(() => revisePersona(original + TRAIT_REVISIONS[0][0]));
assert.throws(() => revisePersona(original.replace(TRAIT_REVISIONS[0][0], 'Unknown trait.')));
const traitPacket = structuredClone(packet);
for (const item of traitPacket.cases) {
  item.request.system = original;
  item.requestHash = hash(JSON.stringify(item.request));
}
const revisionCalls = plans(traitPacket, { ...tokenizer, countRequest: () => 1000 }, 'revised');
assert.equal(revisionCalls.length, 8);
for (let i = 0; i < 4; i++) {
  const pair = revisionCalls.slice(i * 2, i * 2 + 2);
  const old = pair.find(call => call.variant === 'old'), changed = pair.find(call => call.variant === 'revised');
  assert.equal(old.request.system, original); assert.equal(changed.request.system, revised);
  for (const key of ['prompt', 'model', 'temperature', 'numPredict']) assert.equal(old.request[key], changed.request[key]);
  assert.equal(pair[0].variant, i % 2 ? 'revised' : 'old');
}
assert.throws(() => plans(traitPacket, tokenizer, 'unknown'));
console.log('PASS: six exact trait replacements, unchanged surrounding identity/tone, no appended clarification, unchanged paired context/options, bounded revision mode.');
