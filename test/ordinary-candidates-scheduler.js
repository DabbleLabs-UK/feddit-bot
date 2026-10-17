'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-ordinary-scheduler-'));
const previousDataDir = process.env.FEDDIT_BOT_DATA_DIR;
process.env.FEDDIT_BOT_DATA_DIR = dataDir;
const { harness, makeProfile, settle, completeJob } = require('./durable-scheduler');
const ordinary = require('../lib/ordinary-candidates');
const storePath = require.resolve('../lib/store');
const secretsPath = require.resolve('../lib/secrets');
let realStore = require('../lib/store');
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function ok(value, message) { assert.ok(value, message); checks++; }
const wait = JSON.stringify({ choice: 'WAIT', reason: 'No available conversation fits right now.', votes: [] });
const persisted = value => JSON.parse(JSON.stringify(value));
const roots = () => Array.from({ length: 6 }, (_, i) => ({
  id: 20 + i, author: 'other', feddit: 'general', title: 'A distinct public premise ' + i,
  selftext: 'One complete public question.', created_utc: 9,
}));

function fixture(id, options = {}) {
  const profile = makeProfile(id, !!options.rehearsal);
  Object.assign(profile, { canReply: true, canStartDiscussions: false, canVote: false,
    postsPerHour: 0, commentsPerHour: 1, feedSort: 'best', provider: options.local ? 'ollama' : 'dell' });
  Object.assign(profile.sched, { nextPostAt: null, nextCommentAt: 0 });
  id = realStore.createProfile(profile).id;
  if (options.rehearsal) realStore.updateSched(id, { nextCommentAt: 0 }, { simulation: true });
  const scopedStore = Object.create(realStore);
  scopedStore.listProfiles = () => realStore.listProfiles().filter(p => p.id === id);
  scopedStore.getProfile = (profileId) => realStore.getProfile(profileId);
  const posts = [{ id: 10, author: profile.fedditUsername, feddit: 'general', title: 'An older own thread', created_utc: 1 }, ...roots()];
  const requests = [];
  const h = harness({ profiles: [realStore.getProfile(id)], store: scopedStore,
    placement: options.local ? 'desktop' : 'hosted', feedPosts: () => posts,
    providerGenerate: async request => {
      requests.push({ request, receipt: realStore.getOrdinaryCandidateState(id, { simulation: !!options.rehearsal }) });
      return { text: wait, model: 'test', provider: 'ollama', ms: 1,
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 } };
    },
  });
  h.feddit.comments = async postId => ({ ok: true, data: { comments: { data: { children: postId === 10 ? [101, 102, 103].map(cid => ({ data: {
    id: cid, post_id: 10, author: 'other', body: 'A different own-thread comment ' + cid, created_utc: 9,
  } })) : [] } } } });
  return { ...h, id, posts, requests, options, scopedStore };
}

function snapshot(turn) { return turn.checkpoints['opportunity-candidates']; }
function ordinaryKeys(turn) {
  const menu = snapshot(turn);
  return menu.ordinaryCandidateReceipt ? menu.ordinaryCandidateReceipt.keys : menu.candidates
    .filter(c => ['reply_to_own_post', 'ordinary_post', 'ordinary_comment'].includes(c.candidateType))
    .map(c => c.target.key);
}
async function admit(h, runtime = h.scheduler()) {
  await runtime.runTick(); await settle(12);
  const turn = h.turnStore.activeForProfile(h.id);
  ok(turn, 'mocked scheduled opportunity admits one durable turn: ' + JSON.stringify({ logs: h.logs,
    turns: fs.existsSync(h.turnFile) ? JSON.parse(fs.readFileSync(h.turnFile, 'utf8')).turns.map(t => ({ status: t.status, error: t.error })) : [] }));
  return turn;
}
async function finish(h, runtime, turn, text = wait) {
  completeJob(h.queue, turn.generations[0].jobId, text);
  runtime.reconcileDurableTurns(); await settle(12);
  const final = h.turnStore.get(turn.id);
  eq(final.status, 'completed', 'mocked decision completes normally');
  return final;
}
function due(h) {
  h.advance(1000);
  realStore.updateSched(h.id, { nextCommentAt: 0 }, { simulation: !!h.options.rehearsal });
}

async function run() {
  realStore.updateSettings({ paused: false });
  {
    const h = fixture('turnover');
    try {
      const runtime = h.scheduler();
      const first = await admit(h, runtime);
      eq(first.input.ordinaryCandidateVersion, 1, 'new hosted reply turn freezes ordinary contract v1');
      eq(ordinaryKeys(first), ['t3_20', 't1_101', 't3_21'], 'two roots and one fallback share the existing three slots');
      eq(snapshot(first).candidates.length, 3, 'no additional ordinary or total candidates are introduced');
      eq(realStore.getOrdinaryCandidateState(h.id).entries.map(e => e.key).sort(), ordinaryKeys(first).slice().sort(),
        'frozen shortlist is persisted before inference is enqueued');
      const originalAt = snapshot(first).ordinaryCandidateReceipt.at;
      const frozenRequest = persisted(first.generations[0].request);
      const frozenMenu = persisted(snapshot(first));
      delete require.cache[storePath]; realStore = require('../lib/store');
      h.advance(1000);
      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns(); await settle(12);
      eq(restarted.turnStore.get(first.id).generations[0].request, frozenRequest, 'restart preserves exact frozen request');
      eq(snapshot(restarted.turnStore.get(first.id)), frozenMenu, 'restart does not regather or reorder a frozen menu');
      eq(realStore.getOrdinaryCandidateState(h.id).entries.every(e => e.at === originalAt), true,
        'idempotent replay retains original shortlist time rather than refreshing exposure');
      completeJob(restarted.queue, first.generations[0].jobId, wait);
      restarted.scheduler.reconcileDurableTurns(); await settle(12);
      eq(restarted.turnStore.get(first.id).generations.length, 1, 'WAIT uses only the existing single inference');
      eq(h.writes, [], 'WAIT never publishes, votes or registers');
      eq(realStore.getProfile(h.id).repliedTo, [], 'presentation receipt is not reply dedupe');
      eq(realStore.getVoteState(h.id).considered, [], 'presentation receipt is not vote considered-state');
      due(h);
      await restarted.scheduler.runTick(); await settle(12);
      const second = restarted.turnStore.activeForProfile(h.id);
      eq(ordinaryKeys(second), ['t3_22', 't1_102', 't3_23'], 'unchosen unchanged candidates rotate after WAIT and restart');
      completeJob(restarted.queue, second.generations[0].jobId, wait);
      restarted.scheduler.reconcileDurableTurns(); await settle(12);
      h.posts.push({ id: 26, author: 'other', feddit: 'general', title: 'Newly available root', selftext: 'A new complete premise.', created_utc: 10 });
      due(h);
      await restarted.scheduler.runTick(); await settle(12);
      const third = restarted.turnStore.activeForProfile(h.id);
      eq(ordinaryKeys(third), ['t3_24', 't1_103', 't3_25'], 'unseen roots retain configured feed ordering within equal presentation rank');
      completeJob(restarted.queue, third.generations[0].jobId, wait);
      restarted.scheduler.reconcileDurableTurns(); await settle(12);
      due(h);
      await restarted.scheduler.runTick(); await settle(12);
      const fourth = restarted.turnStore.activeForProfile(h.id);
      eq(ordinaryKeys(fourth), ['t3_26', 't1_101', 't3_20'], 'new root enters and established roots remain eligible without an age cutoff');
      eq(h.writes, [], 'multiple exposure rotations do not force engagement');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('routes');
    h.feddit.attention = async () => ({ ok: true, data: { cursor: { comments: 803, posts: 0 }, has_more: false,
      events: [801, 802, 803].map(id => ({ type: 'reply_to_own_comment', event_id: 't1_' + id,
        source_type: 'comment', comment_id: id, post_id: 80, community: 'general', author: 'other',
        body: 'A direct reply ' + id, created_utc: 9, context: { post: { title: 'Direct thread', body: 'A public premise.' } } })) } });
    h.feddit.activeThreads = async () => ({ ok: true, data: { threads: [901, 902, 903].map(id => ({
      event_id: 'active:t1_' + id, community: 'general',
      post: { id: 90 + id, author: 'other', feddit: 'general', title: 'Renewed thread', selftext: 'A premise.', created_utc: 1 },
      fresh_comment: { id, author: 'other', body: 'A new complete continuation.', created_utc: 9 },
    })) } });
    try {
      const turn = await admit(h);
      const menu = snapshot(turn).candidates;
      eq(menu.filter(c => c.target && c.target.attention).length, 3, 'direct attention retains its independent bounded route');
      eq(menu.filter(c => c.candidateType === 'renewed_thread').length, 3, 'renewed threads retain their independent bounded route');
      eq(ordinaryKeys(turn), ['t3_20', 't1_101', 't3_21'], 'attention and renewal do not consume ordinary mixing slots');
      eq(menu.length, 9, 'route limits stay three each and below the twelve-action maximum');
      eq(realStore.getActiveThreadState(h.id).consideredEventIds, [], 'shortlisting does not consume renewed discovery');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('persistence-failure');
    try {
      const runtime = h.scheduler();
      h.scopedStore.recordOrdinaryCandidateShortlist = () => { throw new Error('Injected receipt save failure'); };
      const turn = await admit(h, runtime);
      eq(turn.status, 'blocked', 'receipt save failure holds durable ownership');
      eq(turn.generations.length, 0, 'receipt save failure never starts an inference');
      ok(turn.error.includes('Ordinary shortlist'), 'blocked turn explains bookkeeping failure');
      eq(h.writes, [], 'held receipt cannot publish');
      const original = structuredClone(snapshot(turn));
      delete h.scopedStore.recordOrdinaryCandidateShortlist;
      h.advance(5000);
      runtime.reconcileDurableTurns(); await settle(12);
      const recovered = h.turnStore.get(turn.id);
      eq(snapshot(recovered), original, 'safe save recovery uses the original frozen shortlist');
      eq(recovered.generations.length, 1, 'safe save recovery queues exactly one original inference');
      eq(realStore.getOrdinaryCandidateState(h.id).entries.every(e => e.at === original.ordinaryCandidateReceipt.at), true,
        'delayed receipt recovery retains original exposure timestamp');
    } finally { h.cleanup(); }
  }
  for (const version of [undefined, 99]) {
    const h = fixture('version-' + version);
    try {
      const turn = h.turnStore.create({ profileId: h.id, profile: realStore.getProfile(h.id), rehearsal: false,
        trigger: 'scheduled', input: { mode: 'capabilities', choices: [{ key: 'reply' }], decisionContractVersion: 2,
          continuationVersion: 2, hostedDecisionBudgetVersion: 2, ...(version === undefined ? {} : { ordinaryCandidateVersion: version }) } }).turn;
      const runtime = h.scheduler(); runtime.reconcileDurableTurns(); await settle(12);
      const resumed = h.turnStore.get(turn.id);
      if (version === undefined) {
        eq(ordinaryKeys(resumed), ['t1_101', 't1_102', 't1_103'], 'missing version reconstructs legacy own-first shortlist exactly');
        eq(snapshot(resumed).ordinaryCandidateReceipt, undefined, 'legacy replay never invents presentation state');
        eq(realStore.getOrdinaryCandidateState(h.id), ordinary.defaults(), 'legacy replay leaves new ledger empty');
        const request = persisted(resumed.generations[0].request);
        const restart = h.restartRuntime(); restart.scheduler.reconcileDurableTurns(); await settle(12);
        eq(restart.turnStore.get(turn.id).generations[0].request, request, 'legacy request remains exact across restart');
      } else {
        eq(resumed.status, 'blocked', 'unknown ordinary contract is held, not discarded');
        eq(resumed.generations.length, 0, 'unknown ordinary contract is rejected before inference');
        eq(realStore.getOrdinaryCandidateState(h.id), ordinary.defaults(), 'unknown version cannot mutate ordinary state');
      }
      eq(h.writes, [], 'version compatibility never publishes a fixture');
    } finally { h.cleanup(); }
  }
  for (const rehearsal of [false, true]) {
    const h = fixture('local-' + rehearsal, { local: true, rehearsal });
    try {
      await h.scheduler().runTick(); await settle(12);
      eq(h.requests.length, 1, 'desktop scheduled WAIT still makes exactly one inference: ' + rehearsal + ' ' + h.logs.join(' | '));
      eq(h.requests[0].receipt.entries.map(e => e.key).sort(), ['t1_101', 't3_20', 't3_21'],
        'desktop records the same mixed shortlist before inference');
      eq(realStore.getOrdinaryCandidateState(h.id, { simulation: !rehearsal }), ordinary.defaults(),
        'live/rehearsal presentation histories remain isolated');
      eq(h.writes, [], 'desktop WAIT is nonpublishing in both modes');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('invalid-decision');
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      completeJob(h.queue, turn.generations[0].jobId, 'Not a structured decision.');
      runtime.reconcileDurableTurns(); await settle(12);
      const repair = h.turnStore.get(turn.id).generations[1];
      completeJob(h.queue, repair.jobId, 'Still not a structured decision.');
      runtime.reconcileDurableTurns(); await settle(12);
      const final = h.turnStore.get(turn.id);
      eq(final.result.ok, false, 'malformed primary remains technical failure, not fabricated abstention');
      eq(final.generations.length, 2, 'malformed response uses only the existing single repair');
      eq(realStore.getProfile(h.id).repliedTo, [], 'invalid ordinary decisions never consume reply targets');
      eq(realStore.getVoteState(h.id).considered, [], 'invalid ordinary decisions never fabricate considered votes');
      eq(h.writes, [], 'invalid choice and repair never publish');
      due(h);
      const next = await admit(h, runtime);
      eq(ordinaryKeys(next), ['t3_22', 't1_102', 't3_23'], 'technical failure does not pin unchanged fallback candidates');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('budget-deferral');
    h.posts[1].selftext = Array(500).fill('42? 43! 44? 45!').join(' ');
    realStore.updateProfile(h.id, { persona: Array(80).fill('Specific, thoughtful and sharply observant.').join(' ') });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const construction = turn.checkpoints['hosted-decision-construction'];
      const deferred = snapshot(turn).candidates.filter(c => construction.deferredCandidateIds.includes(c.id));
      ok(deferred.some(c => c.target.key === 't3_20'), 'oversized complete root is deferred by unchanged hosted packing');
      ok(!construction.failure && construction.candidateIds.length > 0, 'alternative complete candidates still construct a bounded request');
      const final = await finish(h, runtime, turn);
      eq(final.result.action, 'wait', 'valid explicit WAIT remains legitimate under budget pressure');
      ok(deferred.every(c => !realStore.hasReplied(h.id, c.target.key)), 'shortlist turnover never marks deferred candidates replied');
      eq(realStore.getActiveThreadState(h.id).consideredEventIds, [], 'ordinary receipt cannot consume renewed discovery');
      eq(h.writes, [], 'budget deferral does not force a reply');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('eligibility');
    h.posts[1].og_status = 'pending';
    h.posts[1].url = 'https://example.invalid/pending';
    realStore.recordReplied(h.id, 't3_21');
    for (let i = 0; i < 3; i++) realStore.bumpThreadReply(22, {
      profileId: h.id, continuationVersion: 2, targetKey: 't1_' + (500 + i), nowMs: h.now(),
    });
    const sorts = [];
    const originalFeed = h.feddit.feddit;
    h.feddit.feddit = async (name, sort, options) => { sorts.push(sort); return originalFeed(name, sort, options); };
    try {
      const turn = await admit(h);
      eq(ordinaryKeys(turn), ['t3_23', 't1_101', 't3_24'], 'pending links, exact dedupe and rolling guard remain authoritative before mixing');
      eq(sorts, ['best'], 'configured best feed is preserved rather than replaced with freshness sorting');
      eq(realStore.hasReplied(h.id, 't3_20'), false, 'metadata-pending link remains unresolved');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('voting-only');
    realStore.updateProfile(h.id, { canReply: false, canVote: true, commentsPerHour: 0, votesPerHour: 1 });
    realStore.updateSched(h.id, { nextCommentAt: null, nextVoteAt: 0 });
    try {
      const turn = await admit(h);
      eq(turn.input.ordinaryCandidateVersion, 0, 'voting-only opportunity freezes legacy ordinary exposure');
      eq(snapshot(turn).ordinaryCandidateReceipt, undefined, 'voting-only opportunity records no turnover receipt');
      eq(snapshot(turn).candidates, [], 'voting-only opportunity cannot gain a reply action');
      eq(snapshot(turn).voteCandidates[0].targetId, 101, 'voting-only slate retains original own-thread-comment evidence');
      eq(realStore.getOrdinaryCandidateState(h.id), ordinary.defaults(), 'voting-only gathering does not mutate reply presentation');
      eq(h.writes, [], 'slate gathering alone never casts votes');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('manual-legacy', { local: true });
    try {
      await h.scheduler().simulateNow(h.id, 'comment');
      eq(h.requests.length, 1, 'manual preview still invokes only its existing decision call');
      eq(h.requests[0].receipt, ordinary.defaults(), 'manual preview does not activate scheduled turnover');
      eq(realStore.getOrdinaryCandidateState(h.id, { simulation: true }), ordinary.defaults(), 'manual preview never changes ordinary history');
      eq(h.writes, [], 'manual WAIT cannot publish');
    } finally { h.cleanup(); }
  }
  console.log('ordinary candidate scheduler: ' + checks + ' checks passed');
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  delete require.cache[storePath];
  delete require.cache[secretsPath];
  if (previousDataDir === undefined) delete process.env.FEDDIT_BOT_DATA_DIR;
  else process.env.FEDDIT_BOT_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});
