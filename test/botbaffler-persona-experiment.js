'use strict';
const assert = require('node:assert/strict');
const { plans, CLARIFICATION, TARGETS, hash } = require('../bin/compare-botbaffler-persona');
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
