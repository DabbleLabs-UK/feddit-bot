'use strict';

const assert = require('node:assert/strict');
const budget = require('../lib/hosted-decision-budget');
const tokenizer = require('../lib/hosted-tokenizer');
const decision = require('../lib/theme-decision');
const context = require('../lib/theme-context');
const interest = require('../lib/theme-interest');
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (a, message) => { assert.ok(a, message); checks++; };
const scope = { version: 1, communities: ['general'] };
const at = 100000;
function fixture(communities = ['general', 'general', 'general']) {
  const candidates = communities.map((community, i) => {
    const body = 'Municipal lunar parking permits require precise paperwork and an official municipal signature.';
    return { id: 'C' + (i + 1), kind: 'reply', candidateType: 'ordinary_post', candidateGroup: 'ordinary',
      context: 'TITLE: Lunar parking permits\n' + body, salience: 0.4,
      target: { key: 't3_' + (20 + i), postId: 20 + i, author: 'other', feddit: community,
        replyBranch: { post: { title: 'Lunar parking permits', body } } },
      voteItems: [{ targetType: 'post', targetId: 20 + i }] };
  });
  const voteCandidates = candidates.map((candidate, i) => ({ id: 'V' + (i + 1), targetType: 'post',
    targetId: candidate.target.postId, author: 'other', content: candidate.context, label: 'Lunar parking permits' }));
  const snapshot = { candidates, voteCandidates };
  const state = interest.record(undefined, [{ id: 'known', at, kind: 'exposure', community: 'general',
    sourceKey: 't3_1', threadKey: 't3_1', author: 'someone',
    features: interest.features(context.subject(candidates[0]).text) }]);
  const decorated = context.decorate(snapshot, state, at + 1, 'scope-fixture', scope);
  return { snapshot: decorated, raw: snapshot, options: { model: tokenizer.MODEL, constructionVersion: 2,
    system: 'A dry municipal observer.', candidates: decorated.candidates, voteCandidates,
    decisionAt: at, decisionContractVersion: 2, firstContactVersion: 2, voteAllowance: { remaining: 10 } } };
}
function baseline(f) { return budget.construct({ ...f.options, candidates: f.raw.candidates }); }
function unchanged(result, plain, message) {
  for (const key of ['prompt', 'repair', 'budget', 'repairBudget', 'candidateIds', 'voteIds',
    'deferredCandidateIds', 'deferredVoteIds', 'numPredict', 'version']) eq(result[key], plain[key], message + ': ' + key);
}
{
  const f = fixture(), before = JSON.stringify(f), plain = baseline(f);
  const packed = decision.construct(f.options, f.snapshot, scope);
  ok(packed.themeHints.included, 'known all-canary slate may add optional bounded cues');
  ok(packed.prompt.includes('OPTIONAL BOT-LOCAL FAMILIARITY'), 'initial prompt contains bounded hint');
  ok(packed.repair.includes('OPTIONAL BOT-LOCAL FAMILIARITY'), 'repair prompt uses the same optional evidence');
  for (const key of ['candidateIds', 'voteIds', 'deferredCandidateIds', 'deferredVoteIds', 'numPredict', 'version']) {
    eq(packed[key], plain[key], 'theme evidence cannot change baseline slate: ' + key);
  }
  ok(budget.fits(packed.budget) && budget.fits(packed.repairBudget), 'actual tokenizer proves both requests fit');
  eq(packed.budget, budget.measure(f.options.system, packed.prompt, packed.numPredict, packed.version),
    'initial token metadata is exact');
  eq(packed.repairBudget, budget.measure(f.options.system, packed.repair, packed.numPredict, packed.version),
    'repair token metadata is exact');
  eq(JSON.stringify(f), before, 'optional construction does not mutate input or candidate order');
}
for (const communities of [['bookclub', 'bookclub'], ['general', 'bookclub'], ['bookclub', 'general']]) {
  const f = fixture(communities), packed = decision.construct(f.options, f.snapshot, scope);
  unchanged(packed, baseline(f), 'non-canary or mixed decision is byte-for-byte released baseline');
  eq(packed.themeHints.included, false, 'non-canary decisions never receive optional cue');
}
{
  const f = fixture(['general']);
  f.options.voteCandidates.push({ id: 'V8', targetType: 'post', targetId: 999, author: 'other', content: 'Unknown community.' });
  f.snapshot.voteCandidates = f.options.voteCandidates;
  unchanged(decision.construct(f.options, f.snapshot, scope), baseline(f), 'unprovable ballot community suppresses all decision hints');
}
{
  const f = fixture();
  const legacy = context.decorate(f.raw, interest.record(undefined, [{ id: 'old', at, kind: 'exposure',
    community: 'general', sourceKey: 't3_1', threadKey: 't3_1', author: 'other',
    features: interest.features(context.subject(f.raw.candidates[0]).text) }]), at, 'legacy');
  const options = { ...f.options, candidates: legacy.candidates };
  eq(decision.construct(options, legacy), budget.construct(options), 'absent frozen scope retains exact reviewed global v1 construction');
  assert.throws(() => decision.construct(options, legacy, { version: 99, communities: ['general'] }),
    error => error.code === 'UNSUPPORTED_THEME_SCOPE'); checks++;
}
{
  const f = fixture(['general']);
  let fitting, left = 0, right = 3000;
  while (left <= right) {
    const count = Math.floor((left + right) / 2);
    const options = { ...f.options, system: 'Municipal '.repeat(count) };
    const plain = budget.construct({ ...options, candidates: f.raw.candidates });
    if (!plain.failure) { fitting = { options, plain }; left = count + 1; } else right = count - 1;
  }
  ok(fitting, 'a real tokenizer boundary fixture exists');
  const packed = decision.construct(fitting.options, f.snapshot, scope);
  eq(packed.themeHints.reason, 'optional-cue-does-not-fit', 'token-tight request omits optional cues rather than repacking');
  unchanged(packed, fitting.plain, 'token-tight cue cannot displace complete baseline blocks');
  ok(budget.fits(packed.budget) && budget.fits(packed.repairBudget), 'unchanged token limits remain authoritative');
  const impossible = decision.construct({ ...f.options, system: 'Mandatory context. '.repeat(4000) }, f.snapshot, scope);
  ok(impossible.failure && !impossible.prompt, 'genuinely impossible request fails without inference');
}
console.log('theme decision scope: ' + checks + ' checks passed');
