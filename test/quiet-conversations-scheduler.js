'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-quiet-scheduler-'));
const previousDataDir = process.env.FEDDIT_BOT_DATA_DIR;
process.env.FEDDIT_BOT_DATA_DIR = dataDir;
const { harness, makeProfile, settle, completeJob } = require('./durable-scheduler');
const store = require('../lib/store');
const quiet = require('../lib/quiet-conversations');

let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (actual, message) => { assert.ok(actual, message); checks++; };
const wait = JSON.stringify({ choice: 'WAIT', reason: 'None of these conversations needs my contribution.' });
const startAt = Date.UTC(2026, 9, 22, 12);

function fixture(name, options = {}) {
  const source = makeProfile(name, options.rehearsal === true);
  Object.assign(source, { provider: options.provider || 'dell', canReply: true, canVote: false,
    canStartDiscussions: true, postsPerHour: 1, commentsPerHour: 1, votesPerHour: 0 });
  Object.assign(source.sched, { nextPostAt: startAt + 10 * 3600000,
    nextCommentAt: startAt + 11 * 3600000, nextVoteAt: null });
  const id = store.createProfile(source).id;
  store.updateSched(id, source.sched);
  const scoped = Object.create(store);
  scoped.listProfiles = () => store.listProfiles().filter(item => item.id === id);
  const dependency = {};
  const calls = [];
  let comments = options.comments == null ? 2 : options.comments;
  let responseOk = true;
  const posts = [20, 21, 22, 23].map(postId => ({ id: postId, author: 'other', feddit: 'general',
    title: 'A public conversation ' + postId, selftext: 'Does the town hall need a window for the moon?',
    created_utc: startAt / 1000 - 60, independently_assessed: false }));
  const h = harness({ profiles: [store.getProfile(id)], store: scoped, placement: options.placement || 'hosted',
    quietConversations: options.noController ? null : dependency,
    quietLocalCapacity: options.quietLocalCapacity, feedPosts: () => posts,
    admitHostedTurn: options.admitHostedTurn,
    providerGenerate: async request => {
      calls.push(request);
      return { text: wait, ms: 1, model: 'fixture', usage: { inputTokens: 10, outputTokens: 10 } };
    } });
  h.advance(startAt - h.now());
  const ledgerFile = path.join(h.dir, 'quiet.json');
  const controller = () => quiet.createQuietConversations({ file: ledgerFile, now: h.now, enabled: true,
    populationAware: options.populationAware === true,
    request: async () => ({ ok: responseOk, data: {
      schemaVersion: 1, source: 'feddit-current-votes', generatedAt: new Date(h.now()).toISOString(),
      window: { hours: 1, since: new Date(h.now() - 3600000).toISOString(), until: new Date(h.now()).toISOString() },
      coverage: { sampleTruncated: false, nsfwIncluded: false },
      items: Array.from({ length: comments }, (_, index) => ({ key: 'comment:' + (100 + index),
        targetType: 'comment', targetId: 100 + index, postId: 20,
        createdAt: new Date(h.now() - 1000).toISOString() })) } }) });
  if (!options.noController) Object.assign(dependency, controller());
  store.updateSettings({ paused: false, burst: {} });
  h.queue.heartbeat('worker-test', { busy: false });
  return { ...h, id, scoped, calls, posts, dependency, ledgerFile,
    setComments: count => { comments = count; }, setResponseOk: value => { responseOk = value; },
    reloadController: () => Object.assign(dependency, controller()),
    profile: () => store.getProfile(id),
    refreshWorker: () => h.queue.heartbeat('worker-test', { busy: false }) };
}

async function tick(h, runtime) {
  const result = await runtime.runTick();
  await settle(16);
  return result;
}
async function admitted(h, runtime = h.scheduler()) {
  await tick(h, runtime);
  let turn = h.turnStore.activeForProfile(h.id);
  for (let index = 0; turn && !turn.generations.length && turn.status !== 'blocked' && index < 100; index++) {
    await settle(2);
    turn = h.turnStore.get(turn.id);
  }
  ok(turn && turn.generations.length, 'quiet opportunity reaches the existing durable decision path: ' + JSON.stringify(h.logs));
  return turn;
}
async function finishWait(h, runtime, turn, queue = h.queue, turnStore = h.turnStore) {
  completeJob(queue, turn.generations[0].jobId, wait);
  runtime.reconcileDurableTurns();
  await settle(16);
  return turnStore.get(turn.id);
}
function deadlines(h) {
  const p = h.profile();
  return { nextPostAt: p.sched.nextPostAt, nextArticleAt: p.sched.nextArticleAt,
    nextCommentAt: p.sched.nextCommentAt, nextVoteAt: p.sched.nextVoteAt,
    postsPerHour: p.postsPerHour, articlePostsPerHour: p.articlePostsPerHour,
    commentsPerHour: p.commentsPerHour, votesPerHour: p.votesPerHour };
}

async function run() {
  {
    const h = fixture('population-local', { populationAware: true, provider: 'ollama', placement: 'desktop',
      quietLocalCapacity: () => true });
    try {
      store.updateProfile(h.id, { activity: [{ at: new Date(h.now() - 1000).toISOString(),
        kind: 'decision', ok: true, dryRun: false, assessmentCandidates: 1 }] });
      h.providers.ollama = { generationActivity: () => ({ active: null,
        recent: [1, 2, 3, 4].map(index => ({ startedAt: h.now() - index * 60000 - 30000,
          finishedAt: h.now() - index * 60000, status: 'completed', prompt: 'MUST NOT REACH POLICY' })) }) };
      const before = deadlines(h);
      await tick(h, h.scheduler());
      eq(h.dependency.peek().modes.live[0].version, 2, 'desktop reads existing local timing snapshot for scaled admission');
      eq(h.calls.length, 1, 'local scaled opportunity performs only its ordinary decision inference');
      eq(h.writes, [], 'local model can freely WAIT without publication');
      eq(deadlines(h), before, 'scaled desktop admission preserves ordinary deadlines');
      eq(JSON.stringify(h.dependency.peek()).includes('MUST NOT REACH'), false, 'local adapter discards all non-timing diagnostic fields');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('population-empty-menu', { populationAware: true, provider: 'ollama', placement: 'desktop',
      quietLocalCapacity: () => true });
    try {
      h.posts.splice(0);
      await tick(h, h.scheduler());
      eq(h.calls.length, 0, 'no-target WAIT adds no model call');
      const waitActivity = h.profile().activity.findLast(entry => entry.kind === 'decision');
      eq(waitActivity.assessmentCandidates, 0, 'no-target WAIT cannot inflate future participating population');
      eq(h.writes, [], 'empty menu does not manufacture conversation');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('population-replay', { populationAware: true });
    try {
      store.updateProfile(h.id, { activity: [{ at: new Date(h.now() - 1000).toISOString(),
        kind: 'decision', ok: true, dryRun: false, assessmentCandidates: 1 }] });
      let reads = 0;
      h.queue.quietCapacitySamples = () => {
        reads++;
        return [1, 2, 3, 4].map(index => ({ startedAt: h.now() - index * 60000 - 30000,
          finishedAt: h.now() - index * 60000, status: 'completed' }));
      };
      const before = deadlines(h), runtime = h.scheduler(), turn = await admitted(h, runtime);
      eq(turn.input.quietConversation.version, 2, 'explicit population flag freezes v2 on new extras');
      eq(turn.input.quietConversation.signal.policy.activeProfiles, 1, 'actual eligible participation feeds the controller');
      eq(turn.input.quietConversation.signal.policy.gapMs, 3600000, 'small active population receives a bounded slower extra lane');
      eq(reads, 1, 'capacity evidence is read only for the enabled population extension');
      const restarted = h.restartRuntime();
      const final = await finishWait(h, restarted.scheduler, turn, restarted.queue, restarted.turnStore);
      eq(final.status, 'completed', 'frozen v2 extra replays through the real durable scheduler');
      eq(final.generations.length, 1, 'replay does not duplicate inference after handover');
      eq(h.writes, [], 'v2 valid WAIT still publishes nothing');
      eq(deadlines(h), before, 'v2 extra preserves cadence and deadlines');
      const waitActivity = h.profile().activity.findLast(entry => entry.kind === 'decision');
      ok(waitActivity.assessmentCandidates > 0, 'a genuine WAIT records bounded actual-offer evidence');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('fixed-no-scaling-read');
    try {
      h.queue.quietCapacitySamples = () => { throw new Error('default policy must not inspect scaling data'); };
      const turn = await admitted(h);
      eq(turn.input.quietConversation.version, 1, 'default fixed controller ignores population and capacity history');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('quiet-wait');
    try {
      const before = deadlines(h), runtime = h.scheduler(), turn = await admitted(h, runtime);
      eq(turn.trigger, 'quiet-conversation', 'extra admission is explicitly attributable');
      eq(turn.input.quietConversation.version, 1, 'quiet selection freezes a versioned descriptor');
      eq(turn.input.quietConversation.profileId, h.id, 'descriptor binds the selected stable profile');
      eq(turn.input.firstContactVersion, 2, 'per-bot first-look remains v2');
      eq(turn.input.ordinaryCandidateVersion, 1, 'ordinary turnover remains v1');
      eq(turn.input.choices.map(item => item.key), ['reply'], 'extra opportunity never creates a new-root choice');
      const snapshot = turn.checkpoints['opportunity-candidates'];
      ok(snapshot.candidates.some(item => item.target?.key === 't3_20'), 'fresh roots remain reply candidates');
      const job = h.queue.get(turn.generations[0].jobId);
      eq(job.priority, 'background', 'extra hosted inference uses spare background priority');
      eq(job.allocationClass, 'synthetic', 'extra user-bot work cannot claim scheduled-user allocation');
      const final = await finishWait(h, runtime, turn);
      eq(final.status, 'completed', 'valid WAIT completes durably');
      eq(final.result.action, 'wait', 'model remains free to decline every candidate');
      eq(final.generations.length, 1, 'WAIT does not provoke another inference');
      eq(h.writes, [], 'WAIT does not guarantee any public action');
      eq(deadlines(h), before, 'quiet WAIT leaves stored rates and normal deadlines unchanged');
      const receipt = JSON.stringify(h.dependency.peek());
      await tick(h, runtime);
      eq(h.turnStore.listActive().length, 0, 'global/profile cooldown prevents immediate repeated extras');
      eq(JSON.stringify(h.dependency.peek()), receipt, 'suppressed tick does not consume another admission');
      h.advance(quiet.GLOBAL_GAP_MS); h.refreshWorker();
      await tick(h, runtime);
      eq(h.turnStore.listActive().length, 0, 'one bot remains bounded for an hour despite global capacity');
      h.advance(quiet.PROFILE_GAP_MS - quiet.GLOBAL_GAP_MS); h.refreshWorker();
      const second = await admitted(h, runtime);
      ok(second.id !== turn.id, 'a later quiet opportunity can be admitted without catch-up');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('quiet-publish');
    try {
      const before = deadlines(h), runtime = h.scheduler(), turn = await admitted(h, runtime);
      const candidate = turn.checkpoints['opportunity-candidates'].candidates.find(item => item.action === 'comment');
      ok(candidate, 'existing target supplies a normal comment candidate');
      completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({ choice: candidate.id,
        reason: 'The moon-window discussion fits the character and invites a concrete continuation.' }));
      runtime.reconcileDurableTurns(); await settle(16);
      const writing = h.turnStore.get(turn.id);
      eq(writing.generations.length, 2, 'chosen reply uses the existing single writing phase');
      completeJob(h.queue, writing.generations[1].jobId, 'Only if the moon applies for a municipal viewing permit.');
      runtime.reconcileDurableTurns(); await settle(16);
      eq(h.turnStore.get(turn.id).status, 'completed', 'normal durable publication completes');
      eq(h.writes.filter(item => item.type === 'comment').length, 1, 'only one chosen reply is published');
      eq(h.writes.filter(item => item.type === 'submit').length, 0, 'quiet assistance cannot create an isolated root');
      eq(deadlines(h), before, 'successful extra reply does not rewrite cadence or deadlines');
      eq(h.dependency.peek().modes.live[0].postId, candidate.target.postId, 'chosen thread is durably recorded for the quiet-only cap');
    } finally { h.cleanup(); }
  }
  for (const populationAware of [false, true]) for (const reason of ['healthy', 'unknown', 'paused', 'rehearsal', 'disabled', 'offline', 'capacity', 'local-busy',
    'payg', 'default-off', 'backoff', 'zero-reply-rate', 'reply-disabled']) {
    const h = fixture('suppressed-' + reason, { populationAware, comments: reason === 'healthy' ? 9 : 2,
      rehearsal: reason === 'rehearsal', provider: reason === 'payg' ? 'deepseek' : 'dell',
      noController: reason === 'default-off',
      admitHostedTurn: reason === 'capacity' ? () => ({ admit: false, reason: 'fixture-capacity' }) : undefined });
    try {
      if (reason === 'unknown') h.setResponseOk(false);
      if (reason === 'paused') store.updateSettings({ paused: true });
      if (reason === 'disabled') store.updateProfile(h.id, { enabled: false });
      if (reason === 'offline') h.advance(10 * 60000);
      if (reason === 'local-busy') h.providers.ollamaBusy = () => true;
      if (reason === 'backoff') store.updateSched(h.id, { backoffUntil: h.now() + 3600000 });
      if (reason === 'zero-reply-rate') store.updateProfile(h.id, { commentsPerHour: 0 });
      if (reason === 'reply-disabled') store.updateProfile(h.id, { canReply: false });
      await tick(h, h.scheduler());
      eq(h.turnStore.listActive().length, 0, reason + ' suppresses extra admissions');
      eq(h.calls.length, 0, reason + ' does not invoke any direct provider');
      eq(h.writes, [], reason + ' does not fabricate public activity');
    } finally { h.cleanup(); store.updateSettings({ paused: false }); }
  }
  {
    const h = fixture('normal-due');
    try {
      store.updateSched(h.id, { nextPostAt: h.now() });
      const turn = await admitted(h);
      eq(turn.trigger, 'scheduled', 'ordinary due work is admitted before quiet assistance');
      eq(turn.input.quietConversation, undefined, 'ordinary work does not receive a quiet descriptor');
      eq(h.dependency.peek().modes.live, [], 'normal opportunity never consumes quiet allowance');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('queued-interactive');
    try {
      h.queue.enqueue({ profileId: 'manual-profile', priority: 'interactive', allocationClass: 'interactive',
        request: { prompt: 'A fixture manual request.', model: 'test-model' } });
      await tick(h, h.scheduler());
      eq(h.turnStore.listActive().length, 0, 'waiting interactive work suppresses every extra admission');
      eq(h.queue.capacity().queued, 1, 'quiet assistance cannot create work ahead of manual queue');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('new-manual-priority');
    try {
      const turn = await admitted(h);
      const manual = h.queue.enqueue({ profileId: 'later-manual', priority: 'interactive', allocationClass: 'interactive',
        payload: { request: { prompt: 'A fixture manual request.', model: 'test-model' } } });
      eq(h.queue.claim('worker-test').id, manual.id, 'interactive work arriving later still wins over queued quiet work');
      eq(h.queue.get(turn.generations[0].jobId).status, 'queued', 'lower-priority quiet request is not inferred prematurely');
    } finally { h.cleanup(); }
  }
  for (const change of ['pause', 'due', 'manual']) {
    const h = fixture('signal-race-' + change);
    try {
      const getSignal = h.dependency.getSignal;
      h.dependency.getSignal = async () => {
        const result = await getSignal();
        if (change === 'pause') store.updateSettings({ paused: true });
        if (change === 'due') store.updateSched(h.id, { nextCommentAt: h.now() });
        if (change === 'manual') h.queue.enqueue({ profileId: 'racing-manual', priority: 'interactive',
          payload: { request: { prompt: 'A racing fixture request.' } } });
        return result;
      };
      await tick(h, h.scheduler());
      eq(h.turnStore.listActive().length, 0, 'capacity/pause is rechecked after public evidence read: ' + change);
      eq(h.dependency.peek().modes.live, [], 'racing higher-priority state consumes no quiet reservation: ' + change);
    } finally { h.cleanup(); store.updateSettings({ paused: false }); }
  }
  {
    const h = fixture('quiet-restart');
    try {
      const turn = await admitted(h), original = JSON.stringify(turn.generations[0].request);
      const receipt = JSON.stringify(turn.input.quietConversation);
      h.reloadController();
      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns(); await settle(16);
      eq(JSON.stringify(restarted.turnStore.get(turn.id).generations[0].request), original, 'restart reconstructs the exact frozen request');
      eq(JSON.stringify(restarted.turnStore.get(turn.id).input.quietConversation), receipt, 'restart preserves original quiet admission identity');
      eq(restarted.queue.capacity().queued, 1, 'restart reuses the same durable generation rather than duplicating inference');
      store.updateProfile(h.id, { enabled: false });
      const final = await finishWait(h, restarted.scheduler, turn, restarted.queue, restarted.turnStore);
      eq(final.status, 'completed', 'disabling future work does not discard an already-admitted frozen turn');
      eq(h.writes, [], 'replayed WAIT remains non-publishing');
      eq(h.dependency.peek().modes.live.length, 1, 'restart does not reserve the opportunity twice');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('reserve-failure');
    try {
      h.dependency.reserve = () => { throw new Error('Fixture persistence failure'); };
      await tick(h, h.scheduler());
      eq(h.turnStore.listActive().length, 0, 'admission persistence failure creates no durable turn');
      eq(h.queue.capacity().queued, 0, 'admission persistence failure performs zero inference');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('continuity-routes');
    try {
      h.feddit.attention = async () => ({ ok: true, data: { cursor: { comments: 101, posts: 0 }, has_more: false,
        events: [{ type: 'reply_to_own_comment', event_id: 't1_101', source_type: 'comment', comment_id: 101,
          post_id: 50, community: 'general', author: 'other', body: 'The earlier conversation has a direct response.',
          created_utc: startAt / 1000 - 5,
          context: { post: { post_id: 50, title: 'An established branch', author: 'other', community: 'general' },
            parent_chain: [{ comment_id: 100, author: 'other', body: 'A useful previous branch fact.' }] } }] } });
      h.feddit.activeThreads = async () => ({ ok: true, data: { threads: [{ event_id: 'active:t1_301', community: 'general',
        post: { id: 60, title: 'A renewed conversation', author: 'other', feddit: 'general', kind: 'text', created_utc: 1 },
        fresh_comment: { id: 301, author: 'other', body: 'Another useful detail renews this branch.', created_utc: startAt / 1000 - 5 } }] } });
      const turn = await admitted(h);
      const candidates = turn.checkpoints['opportunity-candidates'].candidates;
      ok(candidates.some(item => item.candidateGroup === 'attention'), 'direct attention remains available within quiet replies');
      ok(candidates.some(item => item.candidateGroup === 'renewed'), 'renewed conversations retain their existing route');
      ok(candidates.some(item => item.candidateGroup === 'ordinary'), 'continuity does not remove ordinary root eligibility');
      ok(candidates.length <= 12, 'quiet conversation preserves the established action-menu bound');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('quiet-thread-rotation');
    try {
      const runtime = h.scheduler(), turn = await admitted(h, runtime);
      const selected = turn.checkpoints['opportunity-candidates'].candidates.find(item => item.action === 'comment');
      completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({ choice: selected.id,
        reason: 'This established conversation admits a distinct additional observation.' }));
      runtime.reconcileDurableTurns(); await settle(16);
      const writing = h.turnStore.get(turn.id);
      completeJob(h.queue, writing.generations[1].jobId, 'The permit can only be approved by the municipal moon.');
      runtime.reconcileDurableTurns(); await settle(16);
      const other = structuredClone(h.profile());
      other.id = 'unused-initial-profile-id'; other.fedditUsername = 'another-quiet-reader'; other.tempName = 'another-quiet-reader';
      other.repliedTo = []; other.voteState = { considered: [] }; other.sched.sentComments = [];
      const secondId = store.createProfile(other).id;
      h.scoped.listProfiles = () => [store.getProfile(h.id), store.getProfile(secondId)];
      h.advance(quiet.GLOBAL_GAP_MS); h.refreshWorker();
      await tick(h, runtime);
      let next = h.turnStore.activeForProfile(secondId);
      for (let index = 0; next && !next.generations.length && index < 100; index++) {
        await settle(2); next = h.turnStore.get(next.id);
      }
      ok(next && next.generations.length, 'a different bot can use later spare capacity');
      ok(next.input.quietConversation.excludedThreadIds.includes(selected.target.postId), 'quiet admission freezes the recent thread exclusion');
      ok(next.checkpoints['opportunity-candidates'].candidates.every(item => item.target?.postId !== selected.target.postId),
        'recently chosen quiet thread cannot monopolize the next extra menu');
      store.updateSched(h.id, { nextCommentAt: h.now() });
      await tick(h, runtime);
      const ordinary = h.turnStore.activeForProfile(h.id);
      ok(ordinary && ordinary.trigger === 'scheduled', 'quiet thread hold does not block normal scheduled continuation');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('local-idle', { provider: 'ollama', placement: 'desktop', quietLocalCapacity: () => true });
    try {
      const before = deadlines(h);
      await tick(h, h.scheduler());
      eq(h.calls.length, 1, 'idle desktop uses one normal decision inference');
      eq(h.calls[0].priorityClass, 'synthetic', 'desktop quiet request yields to normal/manual shared inference');
      eq(h.writes, [], 'desktop remains free to WAIT without publishing');
      eq(deadlines(h), before, 'desktop quiet decision preserves ordinary cadence');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('local-unknown-capacity', { provider: 'ollama', placement: 'desktop', quietLocalCapacity: () => false });
    try {
      await tick(h, h.scheduler());
      eq(h.calls.length, 0, 'unknown shared local capacity cannot be treated as spare capacity');
      eq(h.dependency.peek().modes.live, [], 'unavailable local capacity consumes no admission');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('local-burst-exclusion', { provider: 'ollama', placement: 'desktop', quietLocalCapacity: () => true });
    try {
      let rejectInference;
      h.providers.generate = () => new Promise((resolve, reject) => { rejectInference = reject; });
      const runtime = h.scheduler(), pendingTick = runtime.runTick();
      for (let index = 0; !rejectInference && index < 100; index++) await settle(2);
      ok(rejectInference, 'local quiet decision is safely held in a mocked in-flight provider');
      eq(runtime.isProfileBusy(h.id), true, 'accepted local quiet work owns existing profile busy state');
      eq(runtime.startBurstSession(h.id, 'claude-plan').skipped, 'profile-busy', 'Burst cannot overlap an admitted quiet decision for the same bot');
      rejectInference(new Error('Fixture inference failure'));
      await pendingTick; await settle(16);
      eq(runtime.isProfileBusy(h.id), false, 'local quiet inference failure clears authoritative busy state');
      eq(h.turnStore.listActive().length, 0, 'blocked Burst start created no competing durable turn');
      eq(h.writes, [], 'failed local decision does not publish');
    } finally { h.cleanup(); }
  }
  for (const stopping of [false, true]) {
    const h = fixture('burst-blocks-quiet-' + stopping);
    try {
      store.updateSettings({ burst: { active: !stopping, provider: 'claude-plan',
        startedAt: new Date(h.now()).toISOString(), currentTurnId: stopping ? 't_draining_burst' : null } });
      await tick(h, h.scheduler());
      eq(h.turnStore.listActive().length, 0, (stopping ? 'draining' : 'active') + ' Burst suppresses spare quiet admission');
      eq(h.dependency.peek().modes.live, [], 'Burst reservation does not consume quiet allowance');
      eq(h.writes, [], 'Burst suppression is non-publishing');
    } finally { h.cleanup(); store.updateSettings({ burst: {} }); }
  }
  {
    const h = fixture('unsupported-contract');
    try {
      const turn = await admitted(h);
      h.turnStore.update(turn.id, { input: { ...turn.input, quietConversation: { ...turn.input.quietConversation, version: 999 } } });
      const restarted = h.restartRuntime();
      completeJob(restarted.queue, turn.generations[0].jobId, wait);
      restarted.scheduler.reconcileDurableTurns(); await settle(16);
      const blocked = restarted.turnStore.get(turn.id);
      eq(blocked.status, 'blocked', 'unknown frozen quiet contract fails closed during replay');
      ok(blocked.error.includes('Unsupported'), 'unknown contract reports an explicit compatibility error');
      eq(blocked.generations.length, 1, 'unknown contract cannot append a replacement inference');
      eq(h.writes, [], 'unknown contract cannot reach publication');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('invalid-profile-binding');
    try {
      const turn = await admitted(h);
      h.turnStore.update(turn.id, { input: { ...turn.input,
        quietConversation: { ...turn.input.quietConversation, profileId: 'p_different_profile' } } });
      const restarted = h.restartRuntime();
      completeJob(restarted.queue, turn.generations[0].jobId, wait);
      restarted.scheduler.reconcileDurableTurns(); await settle(16);
      const blocked = restarted.turnStore.get(turn.id);
      eq(blocked.status, 'blocked', 'quiet receipt for a different profile cannot resume this turn');
      ok(blocked.error.includes('does not match'), 'mismatched receipt has an explicit integrity error');
      eq(blocked.generations.length, 1, 'mismatched receipt cannot start more inference');
      eq(h.writes, [], 'mismatched receipt cannot publish');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('quiet-target-bookkeeping');
    try {
      const runtime = h.scheduler(), turn = await admitted(h, runtime);
      const candidate = turn.checkpoints['opportunity-candidates'].candidates.find(item => item.action === 'comment');
      h.dependency.recordTarget = () => {
        const error = new Error('Fixture quiet target persistence failure');
        error.code = 'QUIET_CONVERSATION_BOOKKEEPING_PENDING';
        throw error;
      };
      completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({ choice: candidate.id,
        reason: 'This concrete continuation has a valid reason to take part.' }));
      runtime.reconcileDurableTurns(); await settle(16);
      eq(h.turnStore.get(turn.id).status, 'blocked', 'failed thread receipt holds the durable turn for recovery');
      eq(h.turnStore.get(turn.id).generations.length, 1, 'failed receipt cannot start content inference');
      eq(h.writes, [], 'failed thread receipt cannot publish an unbounded reply');
      h.reloadController();
      runtime.reconcileDurableTurns(); await settle(16);
      eq(h.turnStore.get(turn.id).generations.length, 2, 'receipt recovery resumes the same selected decision into writing');
      eq(h.dependency.peek().modes.live.length, 1, 'receipt recovery never reserves a second opportunity');
    } finally { h.cleanup(); }
  }
  {
    const h = fixture('recede');
    try {
      const runtime = h.scheduler(), turn = await admitted(h, runtime);
      await finishWait(h, runtime, turn);
      h.advance(quiet.PROFILE_GAP_MS); h.refreshWorker(); h.setComments(9);
      await tick(h, runtime);
      eq(h.turnStore.listActive().length, 0, 'healthy public conversation automatically stops the extra opportunities');
      eq(h.dependency.peek().modes.live.length, 1, 'healthy signal does not reserve future extra work');
    } finally { h.cleanup(); }
  }
  console.log('quiet-conversations-scheduler: ' + checks + ' checks passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (previousDataDir === undefined) delete process.env.FEDDIT_BOT_DATA_DIR;
  else process.env.FEDDIT_BOT_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});
