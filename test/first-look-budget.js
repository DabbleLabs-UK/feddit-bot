'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const budget = require('../lib/hosted-decision-budget');
const tokenizer = require('../lib/hosted-tokenizer');
const actions = require('../lib/action-candidates');
const firstContact = require('../lib/first-contact');

let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (a, message) => { assert.ok(a, message); checks++; };

function fixture(pressure = false) {
  const root = { id: 'C8', candidateType: 'ordinary_post',
    target: { kind: 'post', candidateType: 'ordinary_post', key: 't3_99' },
    context: 'The council has required every moon to submit a parking permit.' };
  const continuity = { id: 'C3', candidateType: 'renewed_thread',
    target: { kind: 'comment', key: 't1_11' }, context: 'The inspector replies: even the moon needs a permit.' };
  const votes = [
    { id: 'V7', targetType: 'post', targetId: 99, author: 'fixture', label: 'Moon parking', content: root.context },
    { id: 'V8', targetType: 'post', targetId: 100, author: 'fixture', label: 'Cloud permit',
      content: 'A cloud has appealed against a parking fine because it was only hovering.' },
    { id: 'V3', targetType: 'comment', targetId: 11, author: 'fixture', label: 'The inspector', content: continuity.context },
  ];
  return { model: tokenizer.MODEL, constructionVersion: budget.VERSION, decisionContractVersion: 2,
    system: 'A distinctive fixture persona with a dry bureaucratic voice.', decisionAt: 100000,
    candidates: pressure ? [
      { id: 'C1', candidateType: 'reply_to_own_comment', target: { kind: 'comment', key: 't1_10' },
        context: 'Intact established conversation context. '.repeat(80),
        memory: { relevant: true, prompt: 'Intact bounded memory, not an instruction. '.repeat(40) } },
      continuity, root,
    ] : [continuity, root],
    voteCandidates: pressure ? [votes[2],
      { id: 'V4', targetType: 'comment', targetId: 10, author: 'fixture', label: 'Established branch',
        content: 'Intact established branch with complete voting context. '.repeat(160) }, votes[0], votes[1]] : votes,
    voteAllowance: { remaining: 8 } };
}

function construct(input, version = 2, extra = {}) {
  return budget.construct({ ...input, firstContactVersion: version,
    firstContactKey: 't3_99', firstContactVoteKey: 't3_100', ...extra });
}

function fits(input, candidates, votes) {
  const options = { voteCandidates: votes, voteAllowance: input.voteAllowance,
    decisionContractVersion: 2, hostedConstructionVersion: 2 };
  return [actions.prompt(candidates, input.decisionAt, options), actions.repairPrompt(candidates, input.decisionAt, options)]
    .every(prompt => budget.fits(budget.measure(input.system, prompt, 640)));
}

function verify(input, packed) {
  ok(!packed.failure, 'packing constructs a request without inference');
  const candidates = input.candidates.filter(item => packed.candidateIds.includes(item.id));
  const votes = input.voteCandidates.filter(item => packed.voteIds.includes(item.id));
  const options = { voteCandidates: votes, voteAllowance: input.voteAllowance,
    decisionContractVersion: 2, hostedConstructionVersion: 2 };
  eq(packed.prompt, actions.prompt(candidates, input.decisionAt, options), 'all offered candidate blocks remain complete and ordered');
  eq(packed.repair, actions.repairPrompt(candidates, input.decisionAt, options), 'repair retains exactly the same complete slate');
  for (const [prompt, measured] of [[packed.prompt, packed.budget], [packed.repair, packed.repairBudget]]) {
    eq(budget.verifyRequest({ model: input.model, system: input.system, prompt, numPredict: 640, budget: measured },
      { num_ctx: 3072 }), measured, 'unchanged worker verifies exact tokens, hash and finite reserves');
    ok(budget.fits(measured), 'initial and repair never overflow');
  }
  eq([packed.budget.contextTokens, packed.numPredict, packed.budget.safetyTokens], [3072, 640, 64], 'context and reserves unchanged');
  eq(packed.candidateIds.concat(packed.deferredCandidateIds).sort(), input.candidates.map(item => item.id).sort(),
    'every original stable action ID is offered or deferred exactly once');
  eq(packed.voteIds.concat(packed.deferredVoteIds).sort(), input.voteCandidates.map(item => item.id).sort(),
    'every original stable vote ID is offered or deferred exactly once');
  ok(packed.voteIds.length <= 8, 'second root consumes existing bounded ballot capacity');
  return { candidates, votes };
}

function run() {
  const small = fixture();
  const full = construct(small);
  verify(small, full);
  eq(full, construct(small, 1), 'already-fitting menus retain their exact prior serialization and tokens');
  ok(full.voteIds.includes('V7') && full.voteIds.includes('V8'), 'two distinct root assessments fit in one request');
  eq(full.candidateIds, ['C3', 'C8'], 'second root adds no reply candidate');
  ok(!full.prompt.includes('sourceCandidateId'), 'vote-only root needs no synthetic action context');
  const pressure = fixture(true);
  const before = JSON.stringify(pressure);
  const packed = construct(pressure);
  const offered = verify(pressure, packed);
  ok(packed.candidateIds.includes('C8') && packed.voteIds.includes('V7'), 'primary complete reply and ballot anchor survive pressure');
  ok(packed.voteIds.includes('V8'), 'optional lightweight second root survives before established voting blocks');
  ok(packed.candidateIds.includes('C3'), 'complete established continuity remains available beside first look');
  eq(JSON.stringify(pressure), before, 'packing changes no persona, evidence, ordering or stable IDs');
  eq(construct(JSON.parse(before)), packed, 'frozen request reconstructs identically after JSON persistence');
  eq(construct(pressure, 2, { firstContactVoteKey: 't3_99' }), construct(pressure, 1),
    'a repeated primary key never creates a second-root packing pass');
  eq(construct(pressure, 2, { firstContactVoteKey: 't3_999' }), construct(pressure, 1),
    'missing secondary key never creates a ballot');

  const competition = fixture(true);
  competition.system += ' Mandatory intact personality fact.'.repeat(110);
  competition.voteCandidates = competition.voteCandidates.map(item => item.id === 'V8'
    ? { ...item, content: 'Complete cloud parking appeal. '.repeat(80) } : item);
  const previousCompetition = construct(competition, 1);
  const nextCompetition = construct(competition);
  verify(competition, nextCompetition);
  ok(previousCompetition.deferredVoteIds.includes('V8'), 'prior packing can displace secondary root behind large established context');
  ok(nextCompetition.voteIds.includes('V8'), 'new packing offers complete secondary ballot before established blocks consume its space');
  ok(nextCompetition.candidateIds.includes('C8') && nextCompetition.voteIds.includes('V7'), 'secondary preference retains the primary pair');
  ok(nextCompetition.candidateIds.includes('C3'), 'secondary preference still permits established renewed continuity');

  const fullSlate = fixture();
  for (let i = 4; i <= 8; i++) fullSlate.voteCandidates.push({ id: 'V' + (10 + i), targetType: 'comment',
    targetId: 10 + i, author: 'fixture', label: 'Another comment', content: 'This complete comment adds a different observation.' });
  const fullSlatePacked = construct(fullSlate);
  verify(fullSlate, fullSlatePacked);
  eq(fullSlatePacked.voteIds.length, 8, 'two root ballots fit within, not beyond, the existing eight-vote slate');

  const wait = actions.parseDecision('{"choice":"WAIT","votes":[]}', offered.candidates,
    { decisionContractVersion: 2, voteCandidates: offered.votes });
  const handled = firstContact.plan({ ...wait, candidates: offered.candidates }, 100000, 2);
  ok(handled.keys.includes('t3_99'), 'valid WAIT assesses actually offered ordinary reply root');
  ok(!handled.keys.includes('t3_100'), 'primary WAIT cannot retire independently unresolved vote-only second root');
  const nil = actions.parseDecision('{"choice":"C999","votes":[{"id":"V8","direction":"nil"}]}', offered.candidates,
    { decisionContractVersion: 2, voteCandidates: offered.votes });
  const partial = firstContact.plan({ ...nil, candidates: offered.candidates }, 100000, 2);
  eq(partial.keys, ['t3_100'], 'explicit independently valid NIL assesses second root despite malformed primary');

  const tight = fixture(true);
  tight.voteCandidates = tight.voteCandidates.map(item => item.id === 'V8'
    ? { ...item, content: '48719? 45192! 39285? 18274! '.repeat(60) } : item);
  const root = tight.candidates.find(item => item.id === 'C8');
  const continuation = tight.candidates.find(item => item.id === 'C3');
  const primary = tight.voteCandidates.find(item => item.id === 'V7');
  const secondary = tight.voteCandidates.find(item => item.id === 'V8');
  const alternative = tight.voteCandidates.find(item => item.id === 'V3');
  let constrained;
  for (let count = 0; count < 150; count++) {
    const input = { ...tight, system: tight.system + ' Required intact personality fact.'.repeat(count) };
    if (fits(input, [continuation, root], [alternative, primary]) && !fits(input, [root], [primary, secondary])) {
      constrained = input;
      break;
    }
  }
  ok(constrained, 'fixture establishes exact-token pressure without modifying candidates');
  const deferred = construct(constrained);
  const retained = verify(constrained, deferred);
  ok(deferred.deferredVoteIds.includes('V8'), 'oversized second ballot is deferred whole, not sliced');
  ok(deferred.candidateIds.includes('C8') && deferred.voteIds.includes('V7'), 'secondary cannot erase selected primary');
  ok(deferred.candidateIds.includes('C3') && deferred.voteIds.includes('V3'), 'secondary cannot block smaller continuity or ballot alternatives');
  const mentionDeferred = actions.parseDecision('{"choice":"WAIT","votes":[{"id":"V8","direction":"nil"}]}',
    retained.candidates, { decisionContractVersion: 2, voteCandidates: retained.votes });
  ok(!firstContact.plan({ ...mentionDeferred, candidates: retained.candidates }, 100000, 2).keys.includes('t3_100'),
    'mentioning a deferred secondary cannot fabricate assessment');
  const onlyVotes = construct({ ...pressure, candidates: [] });
  verify({ ...pressure, candidates: [] }, onlyVotes);
  ok(onlyVotes.voteIds.includes('V7') && onlyVotes.voteIds.includes('V8'), 'voting-only opportunity can retain both complete root ballots');
  const impossible = construct({ ...pressure, system: 'Required complete persona. '.repeat(3000) });
  ok(impossible.failure && !impossible.prompt, 'impossible mandatory context fails explicitly before inference');

  for (const [name, input] of [['small', small], ['pressure', pressure]]) {
    for (const version of [0, 1]) {
      const legacy = construct(input, version);
      const digest = crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
      eq(digest, LEGACY[name][version], 'frozen first-contact ' + version + ' ' + name + ' output matches pre-change bytes');
    }
  }
  const metrics = (result) => ({ original: result.originalInputTokens,
    offered: result.budget.inputTokens, repair: result.repairBudget.inputTokens,
    actions: result.candidateIds, votes: result.voteIds, deferredVotes: result.deferredVoteIds });
  console.log('first look budget fixtures: ' + JSON.stringify({
    small: { before: metrics(construct(small, 1)), after: metrics(full) },
    pressure: { before: metrics(construct(pressure, 1)), after: metrics(packed) },
    competition: { before: metrics(previousCompetition), after: metrics(nextCompetition) },
    tight: { before: metrics(construct(constrained, 1)), after: metrics(deferred) },
  }));
  console.log('first look budget: ' + checks + ' checks passed');
}

// SHA-256 of complete desktop construction results from reviewed base e4c6a4.
const LEGACY = {
  small: {
    0: 'c665a1bdbdd82076d726c502175c055e8cdc5035eee8f6b0d6c083ec853cd654',
    1: '02643ed02f41e9bb286fd3ca68af0b9829688727ff61f6362abf4ad02f82b1d6',
  },
  pressure: {
    0: '3391d93d370b51b86ae09ae213ed125915af4226254a9e4342c59d78aa7c55c4',
    1: 'e00ad4c36b9e531f8c0d1a93b7fe0be495e95aeb29ddba0c310a8718ae4ed629',
  },
};

module.exports = { fixture };
if (require.main === module) run();
