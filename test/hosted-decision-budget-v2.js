'use strict';

const assert = require('node:assert/strict');
const budget = require('../lib/hosted-decision-budget');
const tokenizer = require('../lib/hosted-tokenizer');
const actions = require('../lib/action-candidates');
const receipt = require('../lib/discovery-receipt');
const votes = require('../lib/voting');

let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function candidate(id, type = 'ordinary_post', repeats = 3) {
  return { id, candidateType: type, context: ('Complete real context for ' + id + '. ').repeat(repeats),
    target: { key: 't1_' + id.slice(1) } };
}
function vote(id, repeats = 3) {
  return { id, targetType: 'comment', targetId: Number(id.slice(1)), author: 'fixture',
    label: 'Complete target ' + id, content: ('Complete real voting context for ' + id + '. ').repeat(repeats) };
}
function fixture(candidates, voteCandidates = []) {
  return { model: tokenizer.MODEL, system: '', decisionAt: 100000, decisionContractVersion: 2,
    candidates, voteCandidates, voteAllowance: { remaining: 10 } };
}
function selected(input, packed) {
  return { candidates: input.candidates.filter((item) => packed.candidateIds.includes(item.id)),
    votes: input.voteCandidates.filter((item) => packed.voteIds.includes(item.id)) };
}
function measures(input, candidates = input.candidates, votes = input.voteCandidates) {
  const options = { voteCandidates: votes, voteAllowance: input.voteAllowance, decisionContractVersion: 2, hostedConstructionVersion: 2 };
  const reserve = 640;
  return [actions.prompt(candidates, input.decisionAt, options), actions.repairPrompt(candidates, input.decisionAt, options)]
    .map((prompt) => budget.measure(input.system, prompt, reserve, 2));
}
function fits(input, candidates, votes) { return measures(input, candidates, votes).every(budget.fits); }
function pressure(input, predicate) {
  for (let i = 0; i <= 600; i += 5) {
    const adjusted = { ...input, system: 'Required intact persona detail. '.repeat(i) };
    if (predicate(adjusted)) return adjusted;
  }
  throw new Error('Fixture could not establish the requested exact-token pressure.');
}
function verify(input, packed) {
  check(!packed.failure, 'a complete fitting slate was constructed');
  const offered = selected(input, packed);
  const options = { voteCandidates: offered.votes, voteAllowance: input.voteAllowance, decisionContractVersion: 2, hostedConstructionVersion: 2 };
  equal(packed.prompt, actions.prompt(offered.candidates, input.decisionAt, options), 'initial serialization retains complete original blocks and ordering');
  equal(packed.repair, actions.repairPrompt(offered.candidates, input.decisionAt, options), 'repair uses the identical intact selected slate');
  equal(packed.budget, budget.measure(input.system, packed.prompt, packed.numPredict, 2), 'initial token count and hash are exact');
  equal(packed.repairBudget, budget.measure(input.system, packed.repair, packed.numPredict, 2), 'repair token count and hash are exact');
  check(budget.fits(packed.budget) && budget.fits(packed.repairBudget), 'both requests retain full output and safety reserves');
  equal(budget.verifyRequest({ model: input.model, system: input.system, prompt: packed.prompt,
    numPredict: packed.numPredict, budget: packed.budget }, { num_ctx: 3072 }), packed.budget, 'worker independently verifies v2');
  equal(budget.verifyRequest({ model: input.model, system: input.system, prompt: packed.repair,
    numPredict: packed.numPredict, budget: packed.repairBudget }, { num_ctx: 3072 }), packed.repairBudget, 'worker independently verifies exact repair request');
  equal([packed.budget.contextTokens, packed.numPredict, packed.budget.safetyTokens], [3072, 640, 64], 'v2 retains production context, output and safety policy');
  equal(packed.candidateIds.concat(packed.deferredCandidateIds).sort(), input.candidates.map((item) => item.id).sort(), 'every action has exactly one offered/deferred outcome');
  equal(packed.voteIds.concat(packed.deferredVoteIds).sort(), input.voteCandidates.map((item) => item.id).sort(), 'every vote has exactly one offered/deferred outcome');
}

function run() {
  equal(budget.VERSION, 2, 'new construction contract is v2');
  for (const version of [0, 1, 2]) equal(budget.version(version), version, 'historical construction version remains recognized');
  assert.throws(() => budget.version(3), /Unsupported/); checks++;

  const small = fixture([candidate('C7'), candidate('C11', 'nested_continuation')], [vote('V8')]);
  const unchanged = budget.construct(small);
  verify(small, unchanged);
  equal(unchanged.candidateIds, ['C7', 'C11'], 'already-fitting actions retain stable nonconsecutive IDs');
  equal(unchanged.voteIds, ['V8'], 'already-fitting votes retain stable IDs');

  const nonPrefix = fixture([candidate('C9')], [vote('V7')]);
  const nonPrefixPacked = budget.construct(nonPrefix);
  verify(nonPrefix, nonPrefixPacked);
  for (const prompt of [nonPrefixPacked.prompt, nonPrefixPacked.repair]) {
    check(prompt.includes('"choice":"C9"') && prompt.includes('"id":"V7"'), 'initial and repair examples use actual retained primary and vote IDs');
    check(!/\b(?:C1|V1|V2)\b/.test(prompt), 'non-prefix slate never instructs the model to choose an absent example ID');
  }
  check(nonPrefixPacked.repair.includes('such as C9'), 'repair names an actual offered stable primary ID');
  const votingOnlyExample = budget.construct(fixture([], [vote('V7')]));
  for (const prompt of [votingOnlyExample.prompt, votingOnlyExample.repair]) {
    check(prompt.includes('"choice":"WAIT"') && prompt.includes('"id":"V7"'), 'voting-only examples use WAIT and actual offered vote IDs');
    check(!/\b(?:C\d+|V1|V2)\b/.test(prompt), 'voting-only initial and repair contain no impossible primary or absent vote example');
  }
  const legacyExample = budget.construct({ ...nonPrefix, constructionVersion: 1 });
  check(legacyExample.prompt.includes('"choice":"C1"') && legacyExample.prompt.includes('"id":"V1"') &&
    legacyExample.prompt.includes('"id":"V2"'), 'frozen v1 serialization retains its historical example bytes');

  const head = candidate('C1', 'nested_continuation', 200);
  head.memory = { relevant: true, prompt: 'Intact mandatory retrieved memory. '.repeat(100) };
  head.social = { summary: 'Intact social evidence. '.repeat(100) };
  const later = candidate('C9', 'ordinary_post');
  const oversizedHead = pressure(fixture([head, later], [vote('V1', 200), vote('V9')]),
    (input) => !fits(input, [head], []) && fits(input, [later], [input.voteCandidates[1]]));
  const original = JSON.stringify(oversizedHead);
  const recovered = budget.construct(oversizedHead);
  verify(oversizedHead, recovered);
  check(recovered.candidateIds.includes('C9') && !recovered.candidateIds.includes('C1'), 'later complete primary bypasses an oversized first primary');
  check(recovered.voteIds.includes('V9') && !recovered.voteIds.includes('V1'), 'later complete vote bypasses an oversized first vote');
  equal(JSON.stringify(oversizedHead), original, 'packing never changes persona, context, IDs or source arrays');
  equal(budget.construct(oversizedHead), recovered, 'identical frozen input has deterministic packing');

  const onlyAction = candidate('C4', 'renewed_thread', 30);
  const costlyVote = vote('V4', 200);
  const noPair = pressure(fixture([onlyAction], [costlyVote]),
    (input) => fits(input, [onlyAction], []) && !fits(input, [onlyAction], [costlyVote]));
  const primary = budget.construct(noPair);
  verify(noPair, primary);
  equal(primary.candidateIds, ['C4'], 'fitting primary is not sacrificed to a mandatory vote pair');
  equal(primary.voteIds, [], 'independent voting may be wholly deferred');
  equal(primary.numPredict, 640, 'deferring all votes does not reduce the frozen voting output reserve');
  check(budget.construct({ ...noPair, constructionVersion: 1 }).failure, 'legacy construction still fails the frozen incompatible pair');

  const votesOnly = pressure(fixture([head], [vote('V9')]),
    (input) => !fits(input, [head], []) && fits(input, [], input.voteCandidates));
  const voting = budget.construct(votesOnly);
  verify(votesOnly, voting);
  equal(voting.candidateIds, [], 'votes remain possible when no primary can fit');
  equal(voting.voteIds, ['V9'], 'fitting voting-only opportunity remains complete');
  check(voting.prompt.includes('voting-only'), 'voting-only response contract is explicit');

  const impossible = budget.construct({ ...small, system: 'Uncut required persona. '.repeat(3000) });
  check(!!impossible.failure && !impossible.prompt, 'genuinely impossible request fails explicitly without an inference prompt');
  const aggregate = fixture(Array.from({ length: 60 }, (_, index) => candidate('C' + (index + 100), 'ordinary_post', 200)));
  const aggregatePacked = budget.construct(aggregate);
  verify(aggregate, aggregatePacked);
  check(aggregatePacked.originalWorkLimitExceeded, 'aggregate over tokenizer work bound remains eligible for whole-block packing');
  equal([aggregatePacked.originalInputTokens, aggregatePacked.originalRepairTokens], [null, null], 'uncountable original menu never receives fabricated exact counts');
  check(aggregatePacked.candidateIds.length > 0 && aggregatePacked.deferredCandidateIds.length > 0,
    'individually fitting blocks survive an uncountable combined menu');
  assert.throws(() => budget.construct({ ...aggregate, constructionVersion: 1 }),
    (error) => error.code === 'HOSTED_TOKENIZER_INPUT_TOO_LARGE'); checks++;

  const hugeVote = { ...vote('V1'), content: 'x'.repeat(132000) };
  const boundedAlternative = fixture([candidate('C9')], [hugeVote, vote('V7')]);
  const alternativePacked = budget.construct(boundedAlternative);
  verify(boundedAlternative, alternativePacked);
  equal(alternativePacked.voteIds, ['V7'], 'a single vote beyond work bound cannot block a later complete fitting vote');
  equal(alternativePacked.deferredVoteIds, ['V1'], 'unmeasurably large vote is deferred intact rather than sliced');
  check(alternativePacked.originalWorkLimitExceeded, 'oversized original vote is recorded without pretending exact token counts');
  const hugeSystem = budget.construct({ ...small, system: 'x'.repeat(132000) });
  check(hugeSystem.failure && !hugeSystem.prompt && hugeSystem.originalWorkLimitExceeded,
    'mandatory system beyond work bound fails explicitly without any inference request');
  equal([hugeSystem.originalInputTokens, hugeSystem.originalRepairTokens, hugeSystem.minimumInputTokens,
    hugeSystem.minimumRepairTokens], [null, null, null, null], 'uncountable impossible requests expose no false measurements');
  for (const input of [{ ...small, system: '\ud800' }, fixture([candidate('C9')], [{ ...vote('V7'), content: '\udc00' }])]) {
    assert.throws(() => budget.construct(input), (error) => error.code === 'HOSTED_TOKENIZER_UNSUPPORTED_UNICODE'); checks++;
  }
  const legacy = budget.construct({ ...small, constructionVersion: 1 });
  equal(legacy.version, 1, 'explicit legacy replay retains v1');
  equal(budget.verifyRequest({ model: small.model, system: small.system, prompt: legacy.prompt,
    numPredict: legacy.numPredict, budget: legacy.budget }, { num_ctx: 3072 }), legacy.budget, 'worker independently verifies frozen v1');
  for (const packed of [legacy, unchanged]) {
    assert.throws(() => budget.verifyRequest({ model: small.model, system: small.system, prompt: packed.prompt,
      numPredict: packed.numPredict, budget: { ...packed.budget, inputTokens: packed.budget.inputTokens - 1 } }, { num_ctx: 3072 }), /budget/); checks++;
    assert.throws(() => budget.verifyRequest({ model: small.model, system: small.system, prompt: packed.prompt,
      numPredict: packed.numPredict, budget: packed.budget }, { num_ctx: 2048 }), /context/); checks++;
  }

  const kinds = ['ordinary_post', 'nested_continuation', 'renewed_thread'];
  const mixed = kinds.map((kind, i) => candidate('C' + (i + 21), kind, 90));
  const narrow = pressure(fixture(mixed), (input) => mixed.every((item) => fits(input, [item], [])) &&
    !fits(input, mixed.slice(0, 2), []) && !fits(input, mixed.slice(1), []) && !fits(input, [mixed[0], mixed[2]], []));
  const exposed = new Set();
  let firstPacked;
  for (let seed = 0; seed < 96; seed++) {
    const input = { ...narrow, decisionAt: 100000 + seed };
    const packed = budget.construct(input);
    check(!packed.failure && packed.candidateIds.length === 1, 'one complete primary fits under pressure');
    const item = mixed.find((candidate) => candidate.id === packed.candidateIds[0]);
    exposed.add(item.candidateType);
    if (!firstPacked) firstPacked = { input, packed };
  }
  equal([...exposed].sort(), kinds.slice().sort(), 'root, nested and renewed classes all receive exposure across frozen turn seeds');
  verify(firstPacked.input, firstPacked.packed);

  const { input, packed } = firstPacked;
  const offered = selected(input, packed).candidates;
  const snapshot = { attentionScan: { startCursor: { comments: 20, posts: 0 }, cursor: { comments: 23, posts: 0 },
    seenEventIds: ['t1_21', 't1_22', 't1_23'], pendingEventIds: ['t1_21', 't1_22', 't1_23'] },
    activeThreadScan: { consideredEventIds: ['active:t1_21', 'active:t1_22', 'active:t1_23'] } };
  const wait = actions.parseDecision('{"choice":"WAIT","reason":"None fits."}', offered, { decisionContractVersion: 2 });
  const handled = receipt.plan(snapshot, { ...wait, candidates: offered });
  equal(handled.activeThreadScan.consideredEventIds, offered.map((item) => 'active:' + item.target.key), 'valid WAIT acknowledges only actually offered discovery');
  const missing = actions.parseDecision('{"choice":"C999","reason":"Not offered."}', offered, { decisionContractVersion: 2 });
  equal(receipt.plan(snapshot, { ...missing, candidates: offered }).activeThreadScan.consideredEventIds, [], 'invalid or missing decisions cannot acknowledge offered or deferred discovery');
  const deferred = input.candidates.find((item) => !packed.candidateIds.includes(item.id));
  check(!actions.parseDecision(JSON.stringify({ choice: deferred.id }), offered, { decisionContractVersion: 2 }).valid,
    'deferred primary cannot become a valid choice through parser matching');

  const partial = actions.parseDecision(JSON.stringify({ choice: 'C999', votes: [
    { id: 'V21', direction: 'nil' }, { id: 'V22', direction: 'invalid' }, { id: 'V999', direction: 'nil' },
  ] }), offered, { decisionContractVersion: 2, voteCandidates: [vote('V21'), vote('V22'), vote('V23')] });
  check(!partial.valid, 'malformed primary remains technical failure beside partial valid votes');
  equal(partial.votes.map((item) => [item.id, item.status]),
    [['V21', 'no-vote'], ['V22', 'unresolved'], ['V23', 'unresolved']], 'explicit abstention survives while invalid, missing and unoffered votes cannot be invented');
  equal(votes.record({}, partial.votes).considered, ['comment:21'], 'only explicit valid offered vote becomes considered');
  equal(receipt.plan(snapshot, { ...partial, candidates: offered }).activeThreadScan.consideredEventIds,
    ['active:t1_21'], 'partial valid vote acknowledges its exact discovery target despite invalid primary');
  const noVote = actions.parseDecision('{"choice":"WAIT","reason":"None fits.","votes":[{"id":"V4","direction":"nil"}]}',
    selected(noPair, primary).candidates, { decisionContractVersion: 2, voteCandidates: [] });
  equal(votes.record({}, noVote.votes).considered, [], 'fully deferred vote target remains unconsidered even if a response mentions it');

  console.log('hosted decision budget v2: ' + checks + ' checks passed');
}
run();
