'use strict';
const assert = require('node:assert/strict');
const { harness, makeProfile, completeJob, settle } = require('./durable-scheduler');
const writing = require('../lib/reply-continuity');
global.fetch = async () => { throw new Error('Unexpected live network'); };
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const output = 'The book is not a reaction: its overdue notice has started charging the drawer rent.';
function fixture(options = {}) {
  const p = makeProfile('continuity-fixture', false);
  Object.assign(p, { canReply: true, canStartDiscussions: false, canVote: false, postsPerHour: 0, commentsPerHour: 1 });
  Object.assign(p.sched, { nextPostAt: null, nextCommentAt: 0 });
  const h = harness({ profiles: [p], ...options });
  h.targetId = 501;
  h.feddit.attention = async () => ({ ok: true, data: { cursor: { comments: h.targetId, posts: 0 }, has_more: false, events: [{
    type: 'reply_to_own_comment', event_id: 't1_' + h.targetId, source_type: 'comment', comment_id: h.targetId,
    parent_comment_id: 500, post_id: 258, community: 'general', author: 'reader', created_utc: h.now() / 1000 - 1,
    body: 'What exactly did the drawer change about the book?', context: { post: { post_id: 258, title: 'The book', body: 'Root background.' },
      parent_chain: [{ comment_id: 500, post_id: 258, parent_comment_id: null, author: 'other', body: 'The drawer started charging rent.' }] },
  }] } });
  h.store.reserveReplyOutput = (id, receipt, opts) => {
    const parent = opts.simulation ? (p.simulationState ||= {}) : p;
    const result = writing.reserve(parent.replyOutputState, receipt);
    if (result.allowed) parent.replyOutputState = result.state;
    return result.allowed;
  };
  return h;
}
async function prepare(h, legacy = false) {
  const runtime = h.scheduler();
  if (legacy) {
    h.turnStore.create({ profileId: h.profiles[0].id, profile: structuredClone(h.profiles[0]), rehearsal: false,
      trigger: 'scheduled', input: { mode: 'capabilities', choices: [{ key: 'reply' }], decisionContractVersion: 2, continuationVersion: 2 } });
    runtime.reconcileDurableTurns();
  } else await runtime.runTick();
  await settle(10);
  const turn = h.turnStore.activeForProfile(h.profiles[0].id);
  assert(turn, JSON.stringify(h.logs)); checks++;
  eq(turn.input.replyContinuityVersion, legacy ? undefined : 1, 'new admission freezes the independent version');
  const candidate = turn.checkpoints['opportunity-candidates'].candidates.find(c => c.target?.commentId === h.targetId);
  assert(candidate); checks++;
  completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({ choice: candidate.id, reason: 'A specific question in this branch.', votes: [] }));
  runtime.reconcileDurableTurns(); await settle(10);
  const active = h.turnStore.get(turn.id), generation = active.generations.at(-1);
  eq(active.generations.length, 2, 'one decision and one writing call only');
  if (legacy) assert.doesNotMatch(generation.request.prompt, /CONTINUE THE EXCHANGE|RECENTLY SAID BY YOU/);
  else {
    assert.match(generation.request.prompt, /CONTINUE THE EXCHANGE/);
    assert.ok(generation.request.prompt.endsWith('What exactly did the drawer change about the book?\n\nYour reply:'));
    eq(generation.request.numPredict, h.profiles[0].numPredict);
    eq(generation.request.model, h.profiles[0].model);
  }
  return { runtime, turnId: turn.id, generation };
}
async function finish(h, started, text = output) {
  completeJob(h.queue, started.generation.jobId, text);
  started.runtime.reconcileDurableTurns(); await settle(10);
  return h.turnStore.get(started.turnId);
}
async function main() {
  {
    const h = fixture();
    try {
      const start = await prepare(h);
      const checkpoint = h.turnStore.get(start.turnId).checkpoints['comment-reply-context-v1'];
      assert(checkpoint.target.replyBranch.complete); checks++;
      h.feddit.comments = async () => { throw new Error('Replay must not rebuild context'); };
      const restarted = h.restartRuntime(); restarted.scheduler.reconcileDurableTurns(); await settle(10);
      eq(restarted.turnStore.get(start.turnId).generations[1].signature, start.generation.signature, 'restart reproduces the exact prompt');
      let turn = await finish(h, start);
      eq(turn.status, 'completed'); eq(h.writes.length, 1);
      eq(h.profiles[0].replyOutputState.entries.length, 1);
      h.advance(2 * 3600000); h.targetId++;
      h.profiles[0].sched.nextCommentAt = 0;
      const second = await prepare(h);
      turn = await finish(h, second);
      eq(turn.result.skipped, 'duplicate-output', 'same prose to a different target is suppressed');
      eq(h.writes.length, 1, 'duplicate never reaches downstream publication');
      eq(turn.generations.length, 2, 'no automatic rewrite/retry');
      assert(!h.profiles[0].repliedTo.includes('t1_' + h.targetId)); checks++;
    } finally { h.cleanup(); }
  }
  {
    const h = fixture();
    try {
      const start = await prepare(h), reserve = h.store.reserveReplyOutput;
      h.store.reserveReplyOutput = () => { throw new Error('fixture atomic save failure'); };
      let turn = await finish(h, start);
      eq(turn.status, 'blocked'); eq(h.writes.length, 0, 'bookkeeping failure holds before HTTP');
      h.store.reserveReplyOutput = reserve;
      const restarted = h.restartRuntime(); restarted.scheduler.reconcileDurableTurns(); await settle(10);
      turn = restarted.turnStore.get(start.turnId);
      eq(turn.status, 'completed'); eq(h.writes.length, 1);
      eq(turn.generations.length, 2, 'safe recovery reuses inference');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture({ commentResponse: async () => { throw new Error('fixture lost publication response'); } });
    try {
      const start = await prepare(h), turn = await finish(h, start);
      eq(turn.status, 'publication-uncertain'); eq(h.writes.length, 1);
      eq(h.profiles[0].replyOutputState.entries.length, 1, 'uncertain response retains the intent fingerprint');
      h.scheduler().reconcileDurableTurns(); await settle(10); eq(h.writes.length, 1, 'no retry on uncertainty');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture();
    try { const start = await prepare(h, true); await finish(h, start); eq(h.writes.length, 1); eq(h.profiles[0].replyOutputState, undefined, 'old turn never adopts new publication semantics'); }
    finally { h.cleanup(); }
  }
  for (const key of ['comment-reply-context-v1', 'comment-output-claim-v1']) {
    const h = fixture();
    try {
      const setter = h.turnStore.setCheckpoint;
      let failed = false;
      h.turnStore.setCheckpoint = (...args) => {
        if (args[1] === key && !failed) { failed = true; throw new Error('fixture checkpoint failure'); }
        return setter(...args);
      };
      const runtime = h.scheduler(); await runtime.runTick(); await settle(10);
      const turn = h.turnStore.activeForProfile(h.profiles[0].id);
      const candidate = turn.checkpoints['opportunity-candidates'].candidates.find(c => c.target?.commentId === h.targetId);
      completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({ choice: candidate.id, reason: 'A relevant branch question.', votes: [] }));
      runtime.reconcileDurableTurns(); await settle(10);
      if (key === 'comment-output-claim-v1') {
        completeJob(h.queue, h.turnStore.get(turn.id).generations[1].jobId, output);
        runtime.reconcileDurableTurns(); await settle(10);
      }
      eq(h.turnStore.get(turn.id).status, 'blocked', key + ' holds safely after failed persistence');
      eq(h.writes.length, 0);
      h.turnStore.setCheckpoint = setter;
      runtime.reconcileDurableTurns(); await settle(10);
      if (key === 'comment-reply-context-v1') {
        completeJob(h.queue, h.turnStore.get(turn.id).generations[1].jobId, output);
        runtime.reconcileDurableTurns(); await settle(10);
      }
      eq(h.turnStore.get(turn.id).status, 'completed');
      eq(h.turnStore.get(turn.id).generations.length, 2, 'checkpoint recovery does not redo inference');
      eq(h.writes.length, 1);
    } finally { h.cleanup(); }
  }
  {
    const enabled = fixture(), legacy = fixture();
    delete legacy.store.reserveReplyOutput;
    try {
      await enabled.scheduler().runTick(); await legacy.scheduler().runTick(); await settle(10);
      const one = enabled.turnStore.activeForProfile(enabled.profiles[0].id), two = legacy.turnStore.activeForProfile(legacy.profiles[0].id);
      eq(one.generations[0].request.prompt, two.generations[0].request.prompt, 'decision prompt, candidates and voting presentation remain unchanged');
      eq(one.generations[0].request.system, two.generations[0].request.system, 'persona is unchanged');
    } finally { enabled.cleanup(); legacy.cleanup(); }
  }
  console.log('reply continuity scheduler: ' + checks + ' checks passed');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
