'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-first-contact-integration-'));
const previous = process.env.FEDDIT_BOT_DATA_DIR;
process.env.FEDDIT_BOT_DATA_DIR = dataDir;
const { harness, makeProfile, settle, completeJob } = require('./durable-scheduler');
const store = require('../lib/store');
const firstContact = require('../lib/first-contact');
const naturalnessEvidence = require('../lib/naturalness-evidence');
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (a, message) => { assert.ok(a, message); checks++; };
const nil = (items) => JSON.stringify({ choice: 'WAIT', reason: 'No displayed target needs my contribution.',
  votes: items.map(item => ({ id: item.id, direction: 'nil' })) });
function fixture(name, { local = false, votingOnly = false, rehearsal = false } = {}) {
  const p = makeProfile(name, rehearsal);
  Object.assign(p, { provider: local ? 'ollama' : 'dell', canReply: !votingOnly, canVote: true,
    canStartDiscussions: false, postsPerHour: 0, commentsPerHour: votingOnly ? 0 : 1,
    votesPerHour: votingOnly ? 1 : 0, feedSort: 'best' });
  Object.assign(p.sched, { nextPostAt: null, nextCommentAt: votingOnly ? null : 0, nextVoteAt: votingOnly ? 0 : null });
  const id = store.createProfile(p).id;
  if (rehearsal) store.updateSched(id, p.sched, { simulation: true });
  const scoped = Object.create(store);
  scoped.listProfiles = () => store.listProfiles().filter(p => p.id === id);
  const posts = Array.from({ length: 6 }, (_, i) => ({ id: 20 + i, author: 'other', feddit: 'general',
    title: 'Untouched municipal question ' + i, selftext: 'Should the moon need a parking permit?',
    created_utc: 9, independently_assessed: false }));
  const calls = [];
  const h = harness({ profiles: [store.getProfile(id)], store: scoped, placement: local ? 'desktop' : 'hosted',
    feedPosts: () => posts, providerGenerate: async request => {
      calls.push(request);
      const ids = [...request.prompt.matchAll(/\[(V\d+)\]/g)].map(match => ({ id: match[1] }));
      return { text: nil(ids), ms: 1, model: 'fixture', usage: { inputTokens: 10, outputTokens: 10 } };
    } });
  h.feddit.attention = async () => ({ ok: true, data: { cursor: { comments: 104, posts: 0 }, has_more: false,
    events: [101, 102, 103, 104].map(cid => ({ type: 'reply_to_own_comment', event_id: 't1_' + cid,
      source_type: 'comment', comment_id: cid, post_id: 10, community: 'general', author: 'other',
      body: 'An established direct conversation.', created_utc: 9,
      context: { post: { post_id: 10, title: 'An established thread', author: 'other', community: 'general' },
        parent_chain: [{ comment_id: cid + 100, author: 'other', body: 'Earlier useful branch fact.' }] } })) } });
  h.feddit.activeThreads = async () => ({ ok: true, data: { threads: [301, 302, 303].map(cid => ({
    event_id: 'active:t1_' + cid, community: 'general',
    post: { id: cid, title: 'A renewed branch', author: 'other', feddit: 'general', kind: 'text', created_utc: 1 },
    fresh_comment: { id: cid, author: 'other', body: 'New detail in an established thread.', created_utc: 9 },
  })) } });
  return { ...h, id, posts, calls, rehearsal, votingOnly, scoped };
}
async function admit(h, runtime = h.scheduler()) {
  await runtime.runTick(); await settle(12);
  let turn = h.turnStore.activeForProfile(h.id);
  for (let step = 0; turn && !turn.generations.length && turn.status !== 'blocked' && step < 100; step++) {
    await settle(2);
    turn = h.turnStore.get(turn.id);
  }
  ok(turn, 'one mocked durable opportunity admitted: ' + JSON.stringify(h.logs));
  return turn;
}
async function finish(h, runtime, turn, response) {
  const construction = turn.checkpoints['hosted-decision-construction'];
  const snapshot = turn.checkpoints['opportunity-candidates'];
  const items = snapshot.voteCandidates.filter(v => construction.voteIds.includes(v.id));
  completeJob(h.queue, turn.generations[0].jobId, response || nil(items));
  runtime.reconcileDurableTurns(); await settle(12);
  return h.turnStore.get(turn.id);
}
function due(h) {
  h.advance(1000);
  store.updateSched(h.id, h.votingOnly ? { nextVoteAt: 0 } : { nextCommentAt: 0 }, { simulation: h.rehearsal });
}
async function run() {
  store.updateSettings({ paused: false });
  {
    const h = fixture('shared-first-read');
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const snap = turn.checkpoints['opportunity-candidates'], packed = turn.checkpoints['hosted-decision-construction'];
      eq(turn.input.firstContactVersion, 2, 'new ordinary turn freezes reader-scoped first-look contract');
      eq(turn.input.ordinaryCandidateVersion, 1, 'turnover-v1 remains frozen alongside first contact');
      eq(snap.firstContactKey, 't3_20', 'first eligible unassessed root enters one lane');
      eq(snap.candidates.filter(c => c.candidateGroup === 'ordinary').length, 3, 'ordinary cap remains three');
      eq(snap.candidates.filter(c => c.candidateGroup === 'attention').length, 4, 'all four direct candidates remain');
      eq(snap.candidates.filter(c => c.candidateGroup === 'renewed').length, 3, 'all three renewed candidates remain');
      eq(snap.voteCandidates.length, 8, 'vote cap remains eight despite many branch ancestors');
      const root = snap.candidates.find(c => c.target.key === 't3_20');
      ok(packed.candidateIds.includes(root.id), 'actual model reply offer includes untouched root');
      const vote = snap.voteCandidates.find(v => v.targetType === 'post' && v.targetId === 20);
      ok(packed.voteIds.includes(vote.id), 'actual model voting offer includes untouched root');
      eq(snap.firstContactVoteKey, 't3_21', 'second distinct root shares the existing vote slate');
      const secondVote = snap.voteCandidates.find(v => v.targetType === 'post' && v.targetId === 21);
      eq(secondVote.sourceCandidateId, null, 'additional ballot never invents a reply candidate identity');
      eq(secondVote.socialContext, '', 'additional ballot does not add social retrieval');
      eq(secondVote.memoryContext, '', 'additional ballot does not add memory retrieval');
      eq(snap.firstContactVoteReceipt.keys, ['t3_21'], 'additional presentation has a separate bounded receipt');
      ok(packed.voteIds.includes(secondVote.id), 'second root can reach actual model voting offer');
      const frozen = JSON.stringify(turn.generations[0].request);
      const restart = h.restartRuntime();
      restart.scheduler.reconcileDurableTurns(); await settle(12);
      eq(JSON.stringify(restart.turnStore.get(turn.id).generations[0].request), frozen, 'restart retains exact frozen request');
      const final = await finish(h, runtime, h.turnStore.get(turn.id));
      eq(final.status, 'completed', 'explicit WAIT/NIL completes normally');
      eq(final.generations.length, 1, 'no extra inference added');
      eq(h.writes, [], 'WAIT/NIL never forces publication or votes');
      ok(store.getOrdinaryCandidateState(h.id).assessed.some(e => e.key === 't3_20'), 'valid actual root offer recorded as assessed');
      eq(store.hasReplied(h.id, 't3_20'), false, 'assessment does not fake a published reply');
      const receipt = JSON.stringify(store.getOrdinaryCandidateState(h.id));
      runtime.reconcileDurableTurns(); await settle(12);
      eq(JSON.stringify(store.getOrdinaryCandidateState(h.id)), receipt, 'completed replay cannot advance receipts twice');
      due(h);
      const next = await admit(h, runtime);
      ok(next.checkpoints['opportunity-candidates'].firstContactKey !== 't3_20', 'assessed root no longer consumes the special lane');
    } finally { h.cleanup(); }
  }
  for (const votingOnly of [true, false]) {
    const h = fixture('local-' + votingOnly, { local: true, votingOnly, rehearsal: votingOnly });
    try {
      await h.scheduler().runTick();
      eq(h.calls.length, 1, 'desktop path uses one existing decision inference');
      ok(h.calls[0].prompt.includes('municipal question'), 'desktop model sees ordinary root alongside continuity');
      ok(h.calls[0].prompt.includes('Municipal') || h.calls[0].prompt.includes('TITLE: Untouched'), 'root content present in vote/read prompt');
      eq(h.writes, [], 'desktop WAIT/NIL cannot publish');
      ok(store.getOrdinaryCandidateState(h.id, { simulation: h.rehearsal }).assessed?.some(e => e.key === 't3_20'),
        'desktop assessment persists under the correct mode');
      eq(store.getOrdinaryCandidateState(h.id, { simulation: !h.rehearsal }).assessed, undefined, 'opposite mode remains unchanged');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('deferred-first-read');
    h.posts[0].selftext = '42? 43! 44? 45! '.repeat(300);
    store.updateProfile(h.id, { persona: 'Specific, thoughtful and sharply observant. '.repeat(80) });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const snap = turn.checkpoints['opportunity-candidates'], packed = turn.checkpoints['hosted-decision-construction'];
      const target = snap.candidates.find(c => c.target.key === 't3_20');
      ok(packed.deferredCandidateIds.includes(target.id), 'large whole first-contact action deferred under pressure');
      await finish(h, runtime, turn);
      ok(!(store.getOrdinaryCandidateState(h.id).assessed || []).some(e => e.key === 't3_20'), 'unoffered root remains unassessed');
      due(h);
      const next = await admit(h, runtime);
      ok(next.checkpoints['opportunity-candidates'].firstContactKey !== 't3_20', 'deferred attempt rotates without permanent exclusion');
      eq(store.hasReplied(h.id, 't3_20'), false, 'deferred root is not falsely replied');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('public-assessed');
    h.posts[0].independently_assessed = true;
    delete h.posts[1].independently_assessed;
    try {
      const turn = await admit(h);
      eq(turn.checkpoints['opportunity-candidates'].firstContactKey, 't3_20', 'other-bot engagement cannot retire this bot first look');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('malformed-first-read');
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      completeJob(h.queue, turn.generations[0].jobId, 'No JSON decision.');
      runtime.reconcileDurableTurns(); await settle(12);
      const repair = h.turnStore.get(turn.id).generations[1];
      completeJob(h.queue, repair.jobId, 'Still no decision.');
      runtime.reconcileDurableTurns(); await settle(12);
      const final = h.turnStore.get(turn.id);
      eq(final.status, 'completed', 'technical failure finishes without publication');
      eq(final.result.ok, false, 'invalid primary is not accepted as explicit WAIT');
      eq(store.getOrdinaryCandidateState(h.id).assessed, undefined, 'malformed primary and votes assess no root');
      eq(store.getVoteState(h.id).considered, [], 'malformed votes do not become considered');
      eq(h.writes, [], 'invalid response never forces activity');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('assessment-save-recovery');
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      h.scoped.recordFirstContactAssessment = () => { throw new Error('Fixture atomic persistence failure'); };
      const blocked = await finish(h, runtime, turn);
      eq(blocked.status, 'blocked', 'failed assessment save holds durable turn before any publication');
      eq(store.getOrdinaryCandidateState(h.id).assessed, undefined, 'failed save does not fake cached assessment');
      delete h.scoped.recordFirstContactAssessment;
      runtime.reconcileDurableTurns(); await settle(12);
      const final = h.turnStore.get(turn.id);
      eq(final.status, 'completed', 'safe receipt replay restores progress after storage recovery');
      eq(final.generations.length, 1, 'receipt recovery reuses inference rather than repeating it');
      ok(store.getOrdinaryCandidateState(h.id).assessed.some(e => e.key === 't3_20'), 'frozen assessment receipt persists on recovery');
      eq(h.writes, [], 'recovery does not duplicate any publication');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('legacy-contract');
    try {
      const turn = h.turnStore.create({ profileId: h.id, profile: store.getProfile(h.id), rehearsal: false,
        trigger: 'scheduled', input: { mode: 'capabilities', decisionContractVersion: 2, continuationVersion: 2,
          ordinaryCandidateVersion: 1, hostedDecisionBudgetVersion: 2, choices: [{ key: 'reply' }] } }).turn;
      const runtime = h.scheduler();
      runtime.reconcileDurableTurns(); await settle(12);
      const running = h.turnStore.get(turn.id);
      eq(running.checkpoints['opportunity-candidates'].firstContactKey, undefined, 'missing legacy first-contact version does not enroll an existing turn');
      await finish(h, runtime, running);
      eq(store.getOrdinaryCandidateState(h.id).assessed, undefined, 'legacy replay never invents an assessment receipt');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('independent-reader');
    h.posts.forEach(post => { post.independently_assessed = true; });
    try {
      store.recordFirstContactAssessment(h.id, { version: 2, at: 1, keys: ['t3_20', 't3_21'] });
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const snap = turn.checkpoints['opportunity-candidates'];
      eq(snap.firstContactKey, 't3_22', 'local receipts, not public engagement, select this bot first look');
      eq(snap.firstContactVoteKey, 't3_23', 'second read comes from already fetched eligible roots');
      eq(snap.candidates.some(c => c.target?.key === 't3_23'), false, 'second ballot does not create another action candidate');
      const second = snap.voteCandidates.find(v => v.targetId === 23 && v.targetType === 'post');
      eq(second.sourceCandidateId, null, 'vote-only root has no fictional C reference');
      ok(!snap.observationCandidates.some(c => c.target?.key === 't3_23'), 'vote-only root adds no social or memory observation');
      const observed = naturalnessEvidence.offeredItems(snap).find(item => item.targetType === 'post' && item.targetId === 23);
      eq(observed.community, 'general', 'lightweight vote-only root preserves public community metadata');
      eq(observed.createdAt, 9000, 'lightweight vote-only root preserves public creation time');
      await finish(h, runtime, turn);
      ok(store.getOrdinaryCandidateState(h.id).assessed.some(e => e.key === 't3_23'), 'explicit NIL retires a vote-only first look');
      due(h);
      const next = await admit(h, runtime);
      ok(next.checkpoints['opportunity-candidates'].firstContactKey !== 't3_23', 'same bot does not repeat a valid NIL first look');
      const other = fixture('other-independent-reader');
      other.posts.forEach(post => { post.independently_assessed = true; });
      try {
        const independent = await admit(other);
        eq(independent.checkpoints['opportunity-candidates'].firstContactKey, 't3_20', 'Bot A assessments never retire Bot B local claim');
      } finally { other.cleanup(); }
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('missing-vote-only-read');
    try {
      store.recordFirstContactAssessment(h.id, { version: 2, at: 1, keys: ['t3_20', 't3_21'] });
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const snap = turn.checkpoints['opportunity-candidates'];
      const second = snap.voteCandidates.find(v => 't3_' + v.targetId === snap.firstContactVoteKey);
      const response = JSON.stringify({ choice: 'WAIT', reason: 'Nothing needs an additional contribution.',
        votes: snap.voteCandidates.filter(v => v.id !== second.id).map(v => ({ id: v.id, direction: 'nil' })) });
      let final = await finish(h, runtime, turn, response);
      if (final.generations.length > 1 && final.status !== 'completed') {
        completeJob(h.queue, final.generations.at(-1).jobId, response);
        runtime.reconcileDurableTurns(); await settle(12);
        final = h.turnStore.get(turn.id);
      }
      eq(final.status, 'completed', 'valid primary with unresolved vote finishes under existing partial semantics');
      ok(store.getOrdinaryCandidateState(h.id).assessed.some(e => e.key === snap.firstContactKey), 'valid WAIT retires actual primary root offer');
      ok(!store.getOrdinaryCandidateState(h.id).assessed.some(e => e.key === snap.firstContactVoteKey), 'valid WAIT cannot retire missing vote-only root');
      ok(!store.getVoteState(h.id).considered.includes('post:' + second.targetId), 'missing second ballot remains unresolved');
      eq(h.writes, [], 'partial WAIT and NIL handling never forces a publication');
    } finally { h.cleanup(); }
  }
  for (const remaining of [0, 1]) {
    const h = fixture('allowance-' + remaining);
    h.feddit.voteAllowance = async () => ({ ok: true, data: { vote_allowance: { limited: true, remaining } } });
    try {
      const turn = await admit(h), snap = turn.checkpoints['opportunity-candidates'];
      eq(snap.voteCandidates.length, remaining, 'server allowance remains authoritative');
      eq(snap.firstContactVoteKey, undefined, 'unavailable second ballot has no frozen key');
      eq(snap.firstContactVoteReceipt, undefined, 'unavailable second ballot has no presentation receipt');
      if (remaining) eq(snap.voteCandidates[0].targetId, 20, 'primary root keeps the sole allowed ballot');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('token-deferred-vote-only');
    h.posts[3].selftext = '42? 43! 44? 45! '.repeat(300);
    store.updateProfile(h.id, { persona: 'Specific, thoughtful and sharply observant. '.repeat(80) });
    try {
      store.recordFirstContactAssessment(h.id, { version: 2, at: 1, keys: ['t3_20', 't3_21'] });
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const snap = turn.checkpoints['opportunity-candidates'], packed = turn.checkpoints['hosted-decision-construction'];
      eq(snap.firstContactVoteKey, 't3_23', 'oversized secondary root still receives a bounded slate presentation');
      eq(snap.candidates.some(c => c.target?.key === 't3_23'), false, 'oversized ballot does not become full reply context');
      const secondary = snap.voteCandidates.find(v => v.targetId === 23 && v.targetType === 'post');
      ok(packed.deferredVoteIds.includes(secondary.id), 'token-tight second ballot is deferred whole');
      ok(packed.candidateIds.includes(snap.candidates.find(c => c.target?.key === snap.firstContactKey).id),
        'fitting primary first look survives the oversized optional ballot');
      await finish(h, runtime, turn);
      eq(h.turnStore.get(turn.id).generations.length, 1, 'deferred optional ballot causes no extra inference');
      ok(!store.getOrdinaryCandidateState(h.id).assessed.some(e => e.key === 't3_23'), 'unoffered vote-only root remains locally unassessed');
      ok(!store.getVoteState(h.id).considered.includes('post:23'), 'deferred ballot never becomes considered');
      ok(store.getOrdinaryCandidateState(h.id).entries.some(e => e.key === 't3_23'), 'deferred ballot rotates presentation without consuming assessment');
      eq(h.writes, [], 'deferral and valid WAIT/NIL never publish');
      eq(firstContact.select([{ key: 't3_23', kind: 'post', candidateType: 'ordinary_post' }],
        store.getOrdinaryCandidateState(h.id), store.getVoteState(h.id), 2).key, 't3_23',
      'unassessed secondary root remains eligible for later first-look rotation');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('frozen-v1');
    h.posts[0].independently_assessed = true;
    delete h.posts[1].independently_assessed;
    try {
      const turn = h.turnStore.create({ profileId: h.id, profile: store.getProfile(h.id), rehearsal: false,
        trigger: 'scheduled', input: { mode: 'capabilities', decisionContractVersion: 2, continuationVersion: 2,
          ordinaryCandidateVersion: 1, hostedDecisionBudgetVersion: 2, firstContactVersion: 1,
          choices: [{ key: 'reply' }] } }).turn;
      const runtime = h.scheduler();
      runtime.reconcileDurableTurns(); await settle(12);
      const frozen = h.turnStore.get(turn.id), snap = frozen.checkpoints['opportunity-candidates'];
      eq(snap.firstContactKey, 't3_22', 'frozen v1 retains exact known-false public assessment predicate');
      eq(snap.firstContactVoteKey, undefined, 'frozen v1 never grows a second priority ballot');
      eq(snap.firstContactVoteReceipt, undefined, 'frozen v1 never gains new presentation state');
      const request = JSON.stringify(frozen.generations[0].request);
      const restart = h.restartRuntime();
      restart.scheduler.reconcileDurableTurns(); await settle(12);
      eq(JSON.stringify(restart.turnStore.get(turn.id).generations[0].request), request, 'frozen v1 restart replays exact old request bytes');
      const final = await finish(h, runtime, h.turnStore.get(turn.id));
      eq(final.checkpoints['first-contact-assessment'].version, 1, 'legacy v1 handling freezes a v1 receipt');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('missing-frozen-store');
    try {
      h.scoped.recordFirstContactAssessment = undefined;
      const turn = h.turnStore.create({ profileId: h.id, profile: store.getProfile(h.id), rehearsal: false,
        trigger: 'scheduled', input: { mode: 'capabilities', firstContactVersion: 1, choices: [{ key: 'reply' }] } }).turn;
      h.scheduler().reconcileDurableTurns(); await settle(12);
      eq(h.turnStore.get(turn.id).status, 'blocked', 'missing storage for a frozen v1 contract holds instead of silently falling back');
      eq(h.turnStore.get(turn.id).generations.length, 0, 'missing bookkeeping prevents inference safely');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('unknown-contract');
    try {
      const turn = h.turnStore.create({ profileId: h.id, profile: store.getProfile(h.id), rehearsal: false,
        trigger: 'scheduled', input: { mode: 'capabilities', firstContactVersion: 99, choices: [{ key: 'reply' }] } }).turn;
      h.scheduler().reconcileDurableTurns(); await settle(12);
      eq(h.turnStore.get(turn.id).status, 'blocked', 'unknown future contract blocks safely before inference');
      eq(h.turnStore.get(turn.id).generations.length, 0, 'unknown contract sends no inference');
    } finally { h.cleanup(); }
  }
  console.log('first contact scheduler: ' + checks + ' checks passed');
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  if (previous === undefined) delete process.env.FEDDIT_BOT_DATA_DIR; else process.env.FEDDIT_BOT_DATA_DIR = previous;
  fs.rmSync(dataDir, { recursive: true, force: true });
});
