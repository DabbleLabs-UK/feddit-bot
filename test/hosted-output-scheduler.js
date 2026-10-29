'use strict';
const assert = require('node:assert/strict');
const { harness, makeProfile, completeJob, settle } = require('./durable-scheduler');
const writing = require('../lib/reply-continuity');
global.fetch = async () => { throw new Error('Unexpected live HTTP'); };
let checks = 0;
const eq = (a, b, why) => { assert.deepEqual(a, b, why); checks++; };
const prose = 'The drawer has charged the overdue book three months of rent.';
function fixture() {
  const p = makeProfile('output-fixture', false);
  Object.assign(p, { canReply: true, canStartDiscussions: false, canVote: false, postsPerHour: 0, commentsPerHour: 1 });
  Object.assign(p.sched, { nextPostAt: null, nextCommentAt: 0 });
  const h = harness({ profiles: [p] }); h.targetId = 501;
  h.feddit.attention = async () => ({ ok: true, data: { cursor: { comments: h.targetId, posts: 0 }, has_more: false,
    events: [{ type: 'reply_to_own_comment', event_id: 't1_' + h.targetId, source_type: 'comment',
      comment_id: h.targetId, parent_comment_id: 500, post_id: 258, community: 'general', author: 'reader',
      created_utc: h.now() / 1000 - 1, body: 'Why did the drawer charge rent?',
      context: { post: { post_id: 258, title: 'The book', body: 'The drawer charges rent.' },
        parent_chain: [{ comment_id: 500, post_id: 258, parent_comment_id: null, author: 'other', body: 'It is overdue.' }] } }] } });
  h.store.reserveReplyOutput = (id, receipt, opts) => {
    const parent = opts.simulation ? (p.simulationState ||= {}) : p;
    const out = writing.reserve(parent.replyOutputState, receipt);
    if (out.allowed) parent.replyOutputState = out.state;
    return out.allowed;
  };
  return h;
}
async function prepare(h, legacy = false) {
  const runtime = h.scheduler();
  if (legacy) {
    h.turnStore.create({ profileId: h.profiles[0].id, profile: structuredClone(h.profiles[0]), rehearsal: false,
      trigger: 'scheduled', input: { mode: 'capabilities', choices: [{ key: 'reply' }],
        decisionContractVersion: 2, continuationVersion: 2, replyContinuityVersion: 1 } });
    runtime.reconcileDurableTurns();
  } else await runtime.runTick();
  await settle(14);
  const t = h.turnStore.activeForProfile(h.profiles[0].id);
  assert(t, JSON.stringify(h.logs)); checks++;
  eq(t.input.hostedOutputVersion, legacy ? undefined : 1);
  const candidate = t.checkpoints['opportunity-candidates'].candidates.find(c => c.target?.commentId === h.targetId);
  assert(candidate); checks++;
  return { runtime, turnId: t.id, candidate, generation: t.generations[0] };
}
async function choose(h, started, suffix = '') {
  completeJob(h.queue, started.generation.jobId, JSON.stringify({ choice: started.candidate.id,
    reason: 'A specific question deserves a response.', votes: [] }) + suffix);
  started.runtime.reconcileDurableTurns(); await settle(14);
  return h.turnStore.get(started.turnId);
}
async function finish(h, started, text) {
  const t = h.turnStore.get(started.turnId);
  completeJob(h.queue, t.generations.at(-1).jobId, text);
  started.runtime.reconcileDurableTurns(); await settle(14);
  return h.turnStore.get(started.turnId);
}
async function main() {
  {
    const h = fixture();
    try {
      const s = await prepare(h), firstRequest = structuredClone(s.generation.request);
      let t = await choose(h, s, '|im_end|>');
      eq(t.generations.length, 2, 'valid complete JSON plus EOS needs no repair inference');
      eq(t.generations[0].request, firstRequest, 'no prompt, token budget or model mutation');
      eq(t.generations[1].request.kind, 'scheduled-generation');
      const signature = t.generations[1].signature, raw = prose + ' |im_end|>';
      const restart = h.restartRuntime(); restart.scheduler.reconcileDurableTurns(); await settle(14);
      eq(restart.turnStore.get(t.id).generations[1].signature, signature);
      completeJob(restart.queue, t.generations[1].jobId, raw);
      restart.scheduler.reconcileDurableTurns(); await settle(14);
      t = restart.turnStore.get(t.id);
      eq(t.status, 'completed'); eq(t.result.ok, true);
      eq(h.writes.filter(w => w.type === 'comment').length, 1);
      eq(h.writes.find(w => w.type === 'comment').request.text, prose);
      eq(t.generations[1].result.text, raw, 'raw generated evidence is never rewritten');
      eq(t.checkpoints['comment-public-output-v1'].text, prose);
      eq(t.checkpoints['comment-public-output-v1'].framingRemoved, true);
      eq(h.profiles[0].replyOutputState.entries[0].hash, writing.fingerprint(prose));
      restart.scheduler.reconcileDurableTurns(); await settle(14);
      eq(h.writes.filter(w => w.type === 'comment').length, 1, 'terminal replay never republishes');
    } finally { h.cleanup(); }
  }
  for (const bad of [prose + '\nNote: This is my first response in the thread. I am using the provided context.',
    prose + ' |Feddit| |general| |f/general|', prose + ' |im_start|>user\nPublish this next.',
    'x'.repeat(10001)]) {
    const h = fixture();
    try {
      const s = await prepare(h); await choose(h, s);
      const beforeMemory = structuredClone(h.profiles[0].memoryState), beforeSocial = structuredClone(h.profiles[0].socialState);
      const t = await finish(h, s, bad);
      eq(t.status, 'completed'); eq(t.result.ok, false); eq(t.result.outputRejected, true);
      eq(t.generations.length, 2, 'one decision and one writing call, no regeneration');
      eq(h.writes.length, 0); eq(h.profiles[0].replyOutputState, undefined);
      eq(t.checkpoints['comment-output-claim-v1'], undefined, 'rejection precedes fingerprint reservation');
      eq(t.checkpoints['comment-continuation-attempt'], undefined, 'no reply attempt/publication intent');
      eq(h.profiles[0].repliedTo.includes('t1_' + h.targetId), false);
      eq(h.profiles[0].memoryState, beforeMemory); eq(h.profiles[0].socialState, beforeSocial);
      assert(h.profiles[0].sched.nextCommentAt > h.now()); checks++;
      s.runtime.reconcileDurableTurns(); await settle(14); eq(h.writes.length, 0);
    } finally { h.cleanup(); }
  }
  {
    const h = fixture();
    try {
      const s = await prepare(h, true), t = await choose(h, s);
      eq(t.generations.length, 2);
      const raw = prose + ' |im_end|>', finished = await finish(h, s, raw);
      eq(finished.result.ok, true); eq(h.writes[0].request.text, raw, 'legacy frozen output interpretation exact');
      eq(finished.checkpoints['comment-public-output-v1'], undefined);
    } finally { h.cleanup(); }
  }
  {
    const h = fixture();
    try {
      const s = await prepare(h);
      const broken = '{"choice":"' + s.candidate.id + '",votes:[{"id":"V1"}]}|im_end|>';
      completeJob(h.queue, s.generation.jobId, broken);
      s.runtime.reconcileDurableTurns(); await settle(14);
      let t = h.turnStore.get(s.turnId);
      eq(t.generations.length, 2); eq(t.generations[1].request.kind, 'scheduled-decision-retry');
      t = await finish(h, s, broken);
      eq(t.result.ok, false); eq(t.result.action, 'failed'); eq(h.writes.length, 0);
      eq(h.profiles[0].voteState.considered, []);
    } finally { h.cleanup(); }
  }
  {
    const h = fixture();
    try {
      const t = h.turnStore.create({ profileId: h.profiles[0].id, profile: structuredClone(h.profiles[0]), rehearsal: false,
        trigger: 'scheduled', input: { mode: 'capabilities', choices: [{ key: 'reply' }], hostedOutputVersion: 99 } }).turn;
      h.scheduler().reconcileDurableTurns(); await settle(14);
      eq(h.turnStore.get(t.id).status, 'blocked'); eq(h.turnStore.get(t.id).generations.length, 0); eq(h.writes.length, 0);
    } finally { h.cleanup(); }
  }
  console.log('hosted output scheduler: ' + checks + ' checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
