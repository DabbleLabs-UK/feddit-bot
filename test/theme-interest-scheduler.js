'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-theme-integration-'));
const previous = process.env.FEDDIT_BOT_DATA_DIR;
process.env.FEDDIT_BOT_DATA_DIR = dataDir;
const { harness, makeProfile, settle, completeJob } = require('./durable-scheduler');
const store = require('../lib/store');
const interest = require('../lib/theme-interest');
const quiet = require('../lib/quiet-conversations');
const budget = require('../lib/hosted-decision-budget');
const replyWriting = require('../lib/reply-continuity');
let checks = 0;
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const ok = (a, message) => { assert.ok(a, message); checks++; };
function fixture(name, options = {}) {
  const p = makeProfile(name, !!options.rehearsal);
  Object.assign(p, { tempName: 'fixture_reader', fedditUsername: 'fixture_reader', persona: 'A dry municipal observer.',
    provider: options.local ? 'ollama' : 'dell', canReply: true, canVote: true,
    canStartDiscussions: false, postsPerHour: 0, commentsPerHour: 1, votesPerHour: 0, feedSort: 'best' });
  Object.assign(p.sched, { nextPostAt: null, nextCommentAt: 0, nextVoteAt: null });
  const id = store.createProfile(p).id;
  if (options.rehearsal) store.updateSched(id, p.sched, { simulation: true });
  const scoped = Object.create(store);
  scoped.listProfiles = () => store.listProfiles().filter(p => p.id === id);
  const posts = Array.from({ length: 6 }, (_, i) => ({ id: 20 + i, author: 'other', feddit: 'general',
    title: 'Municipal lunar parking permits ' + i, selftext: 'Lunar parking permits demand municipal paperwork.',
    created_utc: 9, independently_assessed: false }));
  const calls = [];
  const settings = { profiles: [store.getProfile(id)], store: scoped, placement: options.local ? 'desktop' : 'hosted',
    themeInterestEnabled: options.enabled, feedPosts: () => posts, commentResponse: options.commentResponse,
    providerGenerate: async request => { calls.push(request); return { text: waitFromPrompt(request.prompt), ms: 1,
      model: 'fixture', usage: { inputTokens: 10, outputTokens: 10 } }; } };
  const h = harness(settings);
  return { ...h, id, scoped, posts, calls, options, settings };
}
function waitFromPrompt(prompt) {
  return JSON.stringify({ choice: 'WAIT', reason: 'These complete offers need no contribution.',
    votes: [...prompt.matchAll(/\[(V\d+)\]/g)].map(m => ({ id: m[1], direction: 'nil' })) });
}
function wait(turn, selected) {
  const snapshot = turn.checkpoints['opportunity-candidates'];
  const packed = turn.checkpoints['hosted-decision-construction'];
  return JSON.stringify({ choice: selected || 'WAIT', reason: 'The municipal question fits the current conversation.',
    votes: snapshot.voteCandidates.filter(v => packed.voteIds.includes(v.id)).map(v => ({ id: v.id, direction: 'nil' })) });
}
async function admit(h, runtime = h.scheduler()) {
  await runtime.runTick(); await settle(18);
  let turn = h.turnStore.activeForProfile(h.id);
  for (let n = 0; turn && !turn.generations.length && turn.status !== 'blocked' && n < 100; n++) {
    await settle(2); turn = h.turnStore.get(turn.id);
  }
  ok(turn, 'mocked ordinary turn admitted');
  return turn;
}
async function finish(h, runtime, turn, text = wait(turn)) {
  completeJob(h.queue, turn.generations[0].jobId, text);
  runtime.reconcileDurableTurns(); await settle(18);
  return h.turnStore.get(turn.id);
}
function seed(h) {
  store.recordThemeInterest(h.id, [{ id: 'seed', at: 9000, kind: 'exposure', sourceKey: 't3_1', threadKey: 't3_1',
    community: 'general', author: 'someone', features: interest.features(h.posts[0].title + ' ' + h.posts[0].selftext) }],
  { simulation: !!h.options.rehearsal });
}
const evidence = (h, kind) => store.getThemeInterestState(h.id, { simulation: !!h.options.rehearsal }).events
  .filter(event => event.id !== 'seed' && (!kind || event.kind === kind));
async function run() {
  store.updateSettings({ paused: false, dryRun: false });
  let baseline;
  for (const seeded of [false, true]) {
    const h = fixture('off-' + seeded);
    try {
      if (seeded) seed(h);
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const snap = turn.checkpoints['opportunity-candidates'];
      eq(turn.input.themeInterestVersion, 0, 'default-off admission freezes released theme contract');
      eq(snap.themeInterestContext, undefined, 'default-off snapshot has no new context');
      ok(snap.candidates.every(c => !c.themeInterest), 'default-off candidates remain undecorated');
      const prompt = turn.generations[0].request.prompt;
      if (baseline) eq(prompt, baseline, 'even existing theme state cannot alter default-off prompt bytes');
      baseline = prompt;
      await finish(h, runtime, turn);
      eq(evidence(h), [], 'default-off normal decisions write no theme receipts');
      eq(h.writes, [], 'valid WAIT/NIL publishes nothing');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('on-wait', { enabled: true }); seed(h);
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      eq(turn.input.themeInterestVersion, 1, 'explicit flag freezes theme v1 for new ordinary turns');
      eq(turn.input.firstContactVersion, 2, 'first-look v2 unchanged');
      eq(turn.input.ordinaryCandidateVersion, 1, 'turnover-v1 unchanged');
      eq(turn.input.continuationVersion, 2, 'continuation-v2 unchanged');
      const snap = turn.checkpoints['opportunity-candidates'], packed = turn.checkpoints['hosted-decision-construction'];
      eq(snap.candidates.filter(c => c.candidateGroup === 'ordinary').length, 3, 'ordinary candidate limit unchanged');
      ok(snap.voteCandidates.length <= 8, 'existing eight-ballot bound retained');
      ok(turn.generations[0].request.prompt.includes('OPTIONAL BOT-LOCAL FAMILIARITY'), 'known lexical evidence provides bounded decision hints');
      ok(packed.budget.inputTokens + packed.budget.outputTokens + packed.budget.safetyTokens <= 3072,
        'decorated request obeys exact hosted context ceiling');
      const request = JSON.stringify(turn.generations[0].request);
      h.settings.themeInterestEnabled = false;
      const restart = h.restartRuntime();
      restart.scheduler.reconcileDurableTurns(); await settle(12);
      eq(JSON.stringify(restart.turnStore.get(turn.id).generations[0].request), request, 'flag removal cannot reinterpret frozen request after restart');
      const final = await finish(h, runtime, turn);
      eq(final.status, 'completed', 'valid WAIT completes');
      ok(evidence(h, 'exposure').length > 0, 'valid actually offered WAIT records exposure');
      eq(evidence(h, 'participation'), [], 'WAIT does not invent own participation');
      eq(h.writes, [], 'WAIT/NIL remains free of publication');
      const receipts = JSON.stringify(evidence(h));
      runtime.reconcileDurableTurns(); await settle(12);
      eq(JSON.stringify(evidence(h)), receipts, 'completed replay cannot double-count evidence');
      eq(final.generations.length, 1, 'no additional model call');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('invalid', { enabled: true });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const repair = await finish(h, runtime, turn, 'Not a structured decision');
      completeJob(h.queue, repair.generations[1].jobId, 'Still no valid decisions');
      runtime.reconcileDurableTurns(); await settle(18);
      eq(evidence(h), [], 'malformed primary and votes produce no theme evidence');
      eq(h.writes, [], 'malformed decisions publish nothing');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('partial-vote', { enabled: true });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const snap = turn.checkpoints['opportunity-candidates'];
      const packed = turn.checkpoints['hosted-decision-construction'];
      const ballot = snap.voteCandidates.find(v => packed.voteIds.includes(v.id));
      const repair = await finish(h, runtime, turn, JSON.stringify({ choice: 'UNKNOWN', reason: 'Invalid choice is not WAIT.',
        votes: [{ id: ballot.id, direction: 'nil' }] }));
      completeJob(h.queue, repair.generations[1].jobId, 'Still invalid primary');
      runtime.reconcileDurableTurns(); await settle(18);
      const receipts = evidence(h, 'exposure');
      eq(receipts.length, 1, 'invalid primary preserves only independently valid explicit vote exposure');
      eq(receipts[0].sourceKey, 't3_' + ballot.targetId, 'retained NIL is bound to exact offered ballot');
      eq(h.writes, [], 'partial NIL never creates publication');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('deferred', { enabled: true });
    h.posts[0].selftext = '42? 43! 44? 45! '.repeat(300);
    store.updateProfile(h.id, { persona: 'Specific, thoughtful and sharply observant. '.repeat(80), canVote: false });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const snap = turn.checkpoints['opportunity-candidates'], packed = turn.checkpoints['hosted-decision-construction'];
      const root = snap.candidates.find(c => c.target.key === 't3_20');
      ok(packed.deferredCandidateIds.includes(root.id), 'oversized root whole action is deferred');
      ok(packed.budget.inputTokens + packed.budget.outputTokens + packed.budget.safetyTokens <= 3072,
        'tight request still exactly fits unchanged token ceiling');
      await finish(h, runtime, turn);
      eq(evidence(h).filter(e => e.sourceKey === 't3_20'), [], 'wholly unoffered source receives no fabricated evidence');
      eq(evidence(h, 'participation'), [], 'deferred WAIT never counts own use');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('legacy', { enabled: true }); seed(h);
    try {
      const turn = h.turnStore.create({ profileId: h.id, profile: store.getProfile(h.id), rehearsal: false,
        trigger: 'scheduled', input: { mode: 'capabilities', decisionContractVersion: 2, continuationVersion: 2,
          ordinaryCandidateVersion: 1, hostedDecisionBudgetVersion: budget.VERSION, firstContactVersion: 2,
          choices: [{ key: 'reply' }] } }).turn;
      const runtime = h.scheduler();
      runtime.reconcileDurableTurns(); await settle(18);
      const frozen = h.turnStore.get(turn.id);
      ok(frozen.checkpoints['opportunity-candidates'], 'legacy turn constructs its supported menu before checking theme absence');
      eq(frozen.checkpoints['opportunity-candidates'].themeInterestContext, undefined, 'legacy absent version retains exact old snapshot');
      ok(!frozen.generations[0].request.prompt.includes('BOT-LOCAL FAMILIARITY'), 'feature flag cannot reinterpret admitted legacy request');
      await finish(h, runtime, frozen);
      eq(evidence(h), [], 'legacy turn cannot advance new theme state');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('checkpoint-retry', { enabled: true });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const original = h.turnStore.setCheckpoint;
      h.turnStore.setCheckpoint = (id, key, value) => {
        if (key === 'theme-exposure-v1') throw new Error('Fixture checkpoint persistence failure');
        return original(id, key, value);
      };
      const held = await finish(h, runtime, turn);
      eq(held.status, 'blocked', 'failed exposure checkpoint holds before any receipt');
      eq(evidence(h), [], 'checkpoint failure creates no evidence');
      h.turnStore.setCheckpoint = original;
      const restart = h.restartRuntime();
      restart.scheduler.reconcileDurableTurns(); await settle(18);
      eq(restart.turnStore.get(turn.id).status, 'completed', 'checkpoint recovery safely reuses completed decision');
      eq(restart.turnStore.get(turn.id).generations.length, 1, 'checkpoint failure creates no duplicate inference');
      ok(evidence(h).length > 0, 'recovered actual offer records evidence once');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('persist-retry', { enabled: true });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      h.scoped.recordThemeInterest = () => { throw new Error('Fixture atomic theme persistence failure'); };
      const held = await finish(h, runtime, turn);
      eq(held.status, 'blocked', 'failed receipt persistence holds durable turn');
      eq(evidence(h), [], 'failed write does not publish cached evidence');
      eq(h.writes, [], 'failed bookkeeping holds before publication');
      delete h.scoped.recordThemeInterest;
      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns(); await settle(18);
      eq(restarted.turnStore.get(turn.id).status, 'completed', 'persisted checkpoint safely resumes after storage repair');
      ok(evidence(h).length > 0, 'recovery merges frozen receipts outside one-time checkpoint');
      eq(restarted.turnStore.get(turn.id).generations.length, 1, 'bookkeeping recovery never repeats inference');
      const frozen = JSON.stringify(evidence(h));
      restarted.scheduler.reconcileDurableTurns(); await settle(12);
      eq(JSON.stringify(evidence(h)), frozen, 'receipt replay remains idempotent');
    } finally { h.cleanup(); }
  }
  for (const response of ['success', 'failure', 'limited', 'uncertain']) {
    const h = fixture('reply-' + response, { enabled: true, commentResponse: () => {
      if (response === 'uncertain') throw new Error('Fixture lost HTTP acknowledgement');
      if (response === 'failure') return { ok: false, status: 500, error: 'Fixture publication failed' };
      if (response === 'limited') return { ok: false, status: 429, retryAfterSec: 60 };
      return { ok: true, status: 201, data: { comment: { data: { id: 999 } } } };
    } });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const packed = turn.checkpoints['hosted-decision-construction'];
      const writing = await finish(h, runtime, turn, wait(turn, packed.candidateIds[0]));
      eq(writing.generations.length, 2, 'one selected reply creates exactly one writing request');
      completeJob(h.queue, writing.generations[1].jobId, 'Municipal lunar parking permits apparently require a separate permit for the permit office.');
      runtime.reconcileDurableTurns(); await settle(18);
      eq(evidence(h, 'participation').length, response === 'success' ? 1 : 0, 'own use requires confirmed success: ' + response);
      eq(h.writes.length, 1, 'publication attempted only once: ' + response);
      runtime.reconcileDurableTurns(); await settle(12);
      eq(h.writes.length, 1, 'replay cannot duplicate publication: ' + response);
    } finally { h.cleanup(); }
  }
  for (const rehearsal of [false, true]) {
    const h = fixture('local-' + rehearsal, { enabled: true, local: true, rehearsal });
    try {
      await h.scheduler().runTick();
      eq(h.calls.length, 1, 'desktop ordinary path uses one existing decision request');
      ok(evidence(h, 'exposure').length > 0, 'desktop valid offers recorded in selected mode');
      eq(store.getThemeInterestState(h.id, { simulation: !rehearsal }).events, [], 'opposite live/rehearsal ledger remains isolated');
      eq(h.writes, [], 'desktop WAIT/NIL never publishes');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('writing-cue-limit', { enabled: true }); seed(h);
    const measure = budget.measure;
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      let measured = 0;
      budget.measure = (...args) => {
        measured++;
        const measuredBudget = measure(...args);
        return { ...measuredBudget, inputTokens: 3072 };
      };
      const writing = await finish(h, runtime, turn, wait(turn,
        turn.checkpoints['hosted-decision-construction'].candidateIds[0]));
      ok(measured > 0, 'optional writing cue is exactly measured before hosted inference');
      eq(writing.checkpoints['comment-theme-writing-v1'], { included: false }, 'token pressure freezes omission of optional cue only');
      ok(!writing.generations[1].request.prompt.includes('BOT-LOCAL FAMILIARITY'), 'non-fitting optional cue is omitted rather than target trimming');
      ok(writing.generations[1].request.prompt.includes('Lunar parking permits demand municipal paperwork.'), 'actual target survives omission unchanged');
      const request = JSON.stringify(writing.generations[1].request);
      budget.measure = () => { throw new Error('Replay must reuse frozen omission'); };
      const restart = h.restartRuntime();
      restart.scheduler.reconcileDurableTurns(); await settle(12);
      eq(JSON.stringify(restart.turnStore.get(turn.id).generations[1].request), request, 'restart retains exact omitted-cue writing request');
    } finally { budget.measure = measure; h.cleanup(); }
  }
  {
    const h = fixture('participation-recovery', { enabled: true });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const writing = await finish(h, runtime, turn, wait(turn,
        turn.checkpoints['hosted-decision-construction'].candidateIds[0]));
      h.scoped.recordThemeInterest = (id, events, options) => {
        if (events.some(event => event.kind === 'participation')) throw new Error('Fixture own-use persistence failure');
        return store.recordThemeInterest(id, events, options);
      };
      completeJob(h.queue, writing.generations[1].jobId, 'Municipal lunar paperwork requires a parking permit for every absurd filing cabinet.');
      runtime.reconcileDurableTurns(); await settle(18);
      eq(h.turnStore.get(turn.id).status, 'blocked', 'post-publication receipt failure safely holds finalization');
      eq(h.writes.length, 1, 'confirmed public response already persisted once');
      eq(evidence(h, 'participation'), [], 'failed own-use save does not leak into cache');
      delete h.scoped.recordThemeInterest;
      const restart = h.restartRuntime();
      restart.scheduler.reconcileDurableTurns(); await settle(18);
      eq(restart.turnStore.get(turn.id).status, 'completed', 'own-use recovery safely finalizes confirmed publication');
      eq(h.writes.length, 1, 'recovery reuses durable response rather than publishing again');
      eq(evidence(h, 'participation').length, 1, 'recovered participation recorded exactly once');
      eq(restart.turnStore.get(turn.id).generations.length, 2, 'recovery does not regenerate');
    } finally { h.cleanup(); }
  }
  for (const action of ['reply', 'post']) {
    const h = fixture('rehearsal-use-' + action, { enabled: true, rehearsal: true });
    if (action === 'post') {
      store.updateProfile(h.id, { canReply: false, canStartDiscussions: true, postsPerHour: 1, commentsPerHour: 0 });
      store.updateSched(h.id, { nextCommentAt: null, nextPostAt: 0 }, { simulation: true });
    }
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const writing = await finish(h, runtime, turn, wait(turn,
        turn.checkpoints['hosted-decision-construction'].candidateIds[0]));
      completeJob(h.queue, writing.generations[1].jobId, 'Municipal lunar permits\n\nMunicipal lunar parking paperwork requires a permit for every filing cabinet.');
      runtime.reconcileDurableTurns(); await settle(18);
      eq(h.turnStore.get(turn.id).status, 'completed', 'rehearsal writing completes: ' + action);
      eq(evidence(h, 'participation').length, 1, 'rehearsal own-use preserved: ' + action);
      eq(store.getThemeInterestState(h.id).events, [], 'rehearsal own-use never enters live ledger: ' + action);
      eq(h.writes, [], 'rehearsal own-use never creates public evidence: ' + action);
      if (action === 'post') ok(/^r3_[a-f0-9]{64}$/.test(evidence(h, 'participation')[0].sourceKey),
        'rehearsal post has deterministic private identity, not invented public post ID');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('duplicate-own-use', { enabled: true });
    const body = 'Municipal lunar parking permits require a permit for every absurd filing cabinet in the lunar office.';
    store.reserveReplyOutput(h.id, { id: 'older-publication', hash: replyWriting.fingerprint(body), at: 5000 });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      const writing = await finish(h, runtime, turn, wait(turn,
        turn.checkpoints['hosted-decision-construction'].candidateIds[0]));
      completeJob(h.queue, writing.generations[1].jobId, body);
      runtime.reconcileDurableTurns(); await settle(18);
      eq(h.turnStore.get(turn.id).result.skipped, 'duplicate-output', 'existing exact-body guard remains authoritative');
      eq(evidence(h, 'participation'), [], 'blocked duplicate cannot reinforce own-use');
      eq(h.writes, [], 'duplicate guard stays before publication');
      eq(h.turnStore.get(turn.id).generations.length, 2, 'blocked duplicate is not regenerated');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('manual-preview', { enabled: true, local: true }); seed(h);
    try {
      const before = JSON.stringify(store.getThemeInterestState(h.id));
      await h.scheduler().simulateNow(h.id, 'comment');
      eq(h.calls.length, 1, 'manual simulation retains its existing single writing call');
      ok(!h.calls[0].prompt.includes('BOT-LOCAL FAMILIARITY'), 'manual preview does not silently opt into theme contract');
      eq(JSON.stringify(store.getThemeInterestState(h.id)), before, 'manual simulation does not rewrite live theme evidence');
      eq(store.getThemeInterestState(h.id, { simulation: true }).events, [], 'manual simulation creates no opted-in theme receipts');
      eq(h.writes, [], 'manual simulation remains non-publishing');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('direct-routes', { enabled: true });
    h.feddit.attention = async () => ({ ok: true, data: { cursor: { comments: 104, posts: 0 }, has_more: false,
      events: [101, 102, 103, 104].map(cid => ({ type: 'reply_to_own_comment', event_id: 't1_' + cid,
        source_type: 'comment', comment_id: cid, post_id: 10, community: 'general', author: 'other',
        body: 'Municipal parking permits need a lunar signature.', created_utc: 9,
        context: { post: { post_id: 10, title: 'Municipal parking permits', author: 'other', community: 'general' },
          parent_chain: [{ comment_id: cid + 100, author: 'other', body: 'Earlier branch fact.' }] } })) } });
    h.feddit.activeThreads = async () => ({ ok: true, data: { threads: [301, 302, 303].map(cid => ({
      event_id: 'active:t1_' + cid, community: 'general',
      post: { id: cid, title: 'Lunar parking permits', author: 'other', feddit: 'general', kind: 'text', created_utc: 1 },
      fresh_comment: { id: cid, author: 'other', body: 'Municipal paperwork needs a lunar signature.', created_utc: 9 },
    })) } });
    try {
      const turn = await admit(h), snap = turn.checkpoints['opportunity-candidates'];
      eq(snap.candidates.filter(c => c.candidateGroup === 'attention').length, 4, 'direct routes retain all four existing places');
      eq(snap.candidates.filter(c => c.candidateGroup === 'renewed').length, 3, 'renewed routes retain all three existing places');
      eq(snap.candidates.filter(c => c.candidateGroup === 'ordinary').length, 3, 'ordinary slots remain exactly three beside continuity');
      eq(snap.voteCandidates.length, 8, 'all routes still share original maximum eight ballots');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('quiet-theme', { enabled: true });
    h.advance(Date.UTC(2026, 9, 24, 12) - h.now());
    h.posts.forEach(post => { post.created_utc = h.now() / 1000 - 60; });
    const dependency = quiet.createQuietConversations({ file: path.join(h.dir, 'quiet.json'), now: h.now, enabled: true,
      request: async () => ({ ok: true, data: { schemaVersion: 1, source: 'feddit-current-votes',
        generatedAt: new Date(h.now()).toISOString(), window: { hours: 1,
          since: new Date(h.now() - 3600000).toISOString(), until: new Date(h.now()).toISOString() },
        coverage: { sampleTruncated: false, nsfwIncluded: false }, items: [] } }) });
    h.settings.quietConversations = dependency;
    store.updateSched(h.id, { nextCommentAt: h.now() + 12 * 3600000 });
    h.queue.heartbeat('worker-test', { busy: false });
    try {
      const runtime = h.scheduler(), turn = await admit(h, runtime);
      eq(turn.trigger, 'quiet-conversation', 'quiet opportunity uses normal reviewed admission');
      eq(turn.input.themeInterestVersion, 1, 'new quiet turns freeze the same theme contract');
      eq(turn.input.choices.map(c => c.key), ['reply'], 'theme never adds new activity types');
      eq(h.queue.get(turn.generations[0].jobId).priority, 'background', 'theme cannot raise quiet-work infrastructure priority');
      await finish(h, runtime, turn);
      ok(evidence(h).length > 0, 'valid quiet WAIT records only actual exposure');
      eq(h.writes, [], 'quiet theme exposure cannot force publication');
    } finally { h.cleanup(); }
  }
  console.log('theme interest scheduler: ' + checks + ' checks passed');
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  if (previous === undefined) delete process.env.FEDDIT_BOT_DATA_DIR; else process.env.FEDDIT_BOT_DATA_DIR = previous;
  fs.rmSync(dataDir, { recursive: true, force: true });
});
