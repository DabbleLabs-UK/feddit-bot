'use strict';
const assert = require('node:assert/strict');
const budget = require('../lib/hosted-decision-budget');
const tokenizer = require('../lib/hosted-tokenizer');
const firstContact = require('../lib/first-contact');
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (a, message) => { assert.ok(a, message); checks++; };
const root = { id: 'C8', candidateType: 'ordinary_post', target: { kind: 'post', key: 't3_99' },
  context: 'A complete untouched question about the municipal moon.' };
const rv = { id: 'V1', targetType: 'post', targetId: 99, author: 'other', label: 'Municipal moon',
  content: root.context };
const context = 'A complete established branch with its meaningful public context. ';
const old = Array.from({ length: 7 }, (_, i) => ({ id: 'C' + (i + 1),
  candidateType: i < 4 ? 'reply_to_own_comment' : 'renewed_thread',
  target: { kind: 'comment', key: 't1_' + (10 + i) }, context: context.repeat(12) }));
const votes = [rv, ...Array.from({ length: 7 }, (_, i) => ({ id: 'V' + (i + 2),
  targetType: 'comment', targetId: i + 10, author: 'other', label: 'Established comment', content: context.repeat(6) }))];
const base = { model: tokenizer.MODEL, system: 'A distinctive fixture persona.', candidates: [...old, root],
  voteCandidates: votes, decisionAt: 100000, decisionContractVersion: 2, constructionVersion: 2 };
const packed = budget.construct({ ...base, firstContactVersion: 1, firstContactKey: 't3_99' });
ok(!packed.failure, 'pressure menu constructs without extra inference');
ok(packed.candidateIds.includes('C8'), 'untouched root survives into the actual reply offer');
ok(packed.voteIds.includes('V1'), 'same untouched root survives into the actual voting offer');
ok(packed.candidateIds.some(id => id !== 'C8'), 'established continuity retains actual choice under representative pressure');
ok(budget.fits(packed.budget) && budget.fits(packed.repairBudget), 'initial and repair exact-token budgets both fit');
eq([packed.budget.contextTokens, packed.numPredict, packed.budget.safetyTokens], [3072, 640, 64], 'limits unchanged');
eq(budget.verifyRequest({ model: base.model, system: base.system, prompt: packed.prompt,
  numPredict: packed.numPredict, budget: packed.budget }, { num_ctx: 3072 }), packed.budget,
  'existing worker token/hash verification accepts the exact request without a policy bypass');
eq(budget.construct({ ...base, firstContactVersion: 0 }), budget.construct(base), 'legacy construction v2 is exact without new contract');
eq(budget.construct({ ...base, constructionVersion: 1, firstContactVersion: 1 }),
  budget.construct({ ...base, constructionVersion: 1 }), 'legacy construction v1 is not reinterpreted');
const huge = { ...root, context: '42? 43! 44? 45! '.repeat(300) };
const deferred = budget.construct({ ...base, system: 'Specific, thoughtful and sharply observant. '.repeat(80), candidates: [...old, huge],
  firstContactVersion: 1, firstContactKey: 't3_99' });
ok(deferred.deferredCandidateIds.includes('C8'), 'an oversized whole root is deferred, never sliced');
ok(!deferred.failure, 'oversized first-contact block cannot prevent other fitting complete candidates');
const offered = base.candidates.filter(c => deferred.candidateIds.includes(c.id));
const handled = firstContact.plan({ valid: true, candidates: offered, votes: [] }, 100000);
ok(!handled.keys.includes('t3_99'), 'deferred root is not assessed merely because primary WAIT was valid');
const onlyVotes = budget.construct({ ...base, candidates: [], firstContactVersion: 1, firstContactKey: 't3_99' });
ok(onlyVotes.voteIds.includes('V1') && !onlyVotes.candidateIds.length, 'voting-only exposure adds no reply action');
const impossible = budget.construct({ ...base, system: context.repeat(800), firstContactVersion: 1,
  firstContactKey: 't3_99' });
ok(!!impossible.failure, 'truly impossible persona/context fails explicitly before inference');
assert.throws(() => budget.construct({ ...base, firstContactVersion: 99 }), /Unsupported/); checks++;
console.log('first contact budget: ' + checks + ' checks passed');
