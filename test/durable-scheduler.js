'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createQueue } = require('../lib/job-queue');
const { createDellProvider } = require('../lib/providers/dell');
const { createScheduler } = require('../lib/scheduler');
const { createTurnStore } = require('../lib/turn-store');
const hostedPolicy = require('../lib/hosted-policy');
const populationActivity = require('../lib/population-activity');
const socialRelationships = require('../lib/social-relationships');
const autobiographicalMemory = require('../lib/autobiographical-memory');
const rehearsalObservability = require('../lib/rehearsal-observability');

let checks = 0;
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) await flush();
}

function makeProfile(id, dryRun) {
  return {
    id,
    ownerId: 'owner-' + id,
    botOrigin: 'user',
    hostedActivatedAt: new Date(0).toISOString(),
    hostedOnboardingTurnsCompleted: 0,
    tempName: id,
    fedditUsername: id,
    token: 'secret-' + id,
    provider: 'dell',
    model: 'test-model',
    persona: 'A test persona for ' + id + '.',
    toneNotes: '',
    temperature: 0.8,
    numPredict: 200,
    enabled: true,
    dryRun,
    canReply: false,
    canStartDiscussions: true,
    canShareLinks: false,
    postsPerHour: 1,
    articlePostsPerHour: 0,
    commentsPerHour: 0,
    postFeddits: ['general'],
    readFeddits: ['general'],
    communityMode: 'home',
    probation: { onProbation: false, checkedAt: 1 },
    sched: {
      nextPostAt: 0,
      nextArticleAt: null,
      nextCommentAt: null,
      sentPosts: [],
      sentComments: [],
      backoffUntil: 0,
    },
    activity: [],
    repliedTo: [],
    voteState: { considered: [] },
    attentionState: { cursor: { comments: 0, posts: 0 }, seenEventIds: [] },
    socialState: socialRelationships.defaults(),
    memoryState: autobiographicalMemory.defaults(),
    spendDaily: {},
    spendDays: [],
  };
}

function makeStore(profiles, now) {
  const settings = {
    paused: false,
    dryRun: true,
    monthlyCapUsd: 5,
    pricing: {},
    threadReplies: {},
  };
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return {
    DEFAULT_MODEL: 'test-model',
    schedDefaults: () => ({
      nextPostAt: null,
      nextArticleAt: null,
      nextCommentAt: null,
      sentPosts: [],
      sentComments: [],
      backoffUntil: 0,
    }),
    referenceName: (profile) => profile.fedditUsername || profile.tempName || profile.id,
    getSettings: () => settings,
    getProfile: (id) => byId.get(id) || null,
    listProfiles: () => [...byId.values()],
    hasReplied(id, key, options = {}) {
      const profile = byId.get(id);
      const parent = options.simulation && profile && profile.simulationState ? profile.simulationState : profile;
      return !!(parent && Array.isArray(parent.repliedTo) && parent.repliedTo.includes(key));
    },
    recordReplied(id, key, options = {}) {
      const profile = byId.get(id);
      const parent = options.simulation && profile && profile.simulationState ? profile.simulationState : profile;
      if (!parent) return null;
      parent.repliedTo = Array.isArray(parent.repliedTo) ? parent.repliedTo : [];
      if (!parent.repliedTo.includes(key)) parent.repliedTo.push(key);
      return parent.repliedTo;
    },
    getVoteState(id, options = {}) {
      const profile = byId.get(id);
      const parent = options.simulation && profile && profile.simulationState ? profile.simulationState : profile;
      return structuredClone(parent && parent.voteState || { considered: [] });
    },
    recordVoteDecisions(id, decisions, options = {}) {
      const profile = byId.get(id);
      if (!profile) return null;
      if (options.simulation && !profile.simulationState) profile.simulationState = {};
      const parent = options.simulation ? profile.simulationState : profile;
      parent.voteState = parent.voteState || { considered: [] };
      for (const vote of decisions || []) {
        const key = vote.targetType + ':' + vote.targetId;
        if (!parent.voteState.considered.includes(key)) parent.voteState.considered.push(key);
      }
      return structuredClone(parent.voteState);
    },
    getAttentionState(id, options = {}) {
      const profile = byId.get(id);
      const parent = options.simulation && profile && profile.simulationState ? profile.simulationState : profile;
      return structuredClone(parent && parent.attentionState || { cursor: { comments: 0, posts: 0 }, seenEventIds: [] });
    },
    recordAttentionScan(id, scan, options = {}) {
      const profile = byId.get(id);
      const parent = options.simulation && profile && profile.simulationState ? profile.simulationState : profile;
      if (!parent) return null;
      parent.attentionState = structuredClone(scan || { cursor: { comments: 0, posts: 0 }, seenEventIds: [] });
      return parent.attentionState;
    },
    getSocialState(id, options = {}) {
      const profile = byId.get(id);
      const parent = options.simulation && profile && profile.simulationState ? profile.simulationState : profile;
      return socialRelationships.normalize(parent && parent.socialState, now());
    },
    recordSocialEvent(id, event, options = {}) {
      const profile = byId.get(id);
      const parent = options.simulation && profile && profile.simulationState ? profile.simulationState : profile;
      if (!parent) return null;
      const result = socialRelationships.recordEvent(parent.socialState, event, Number(options.nowMs) || now());
      parent.socialState = result.state;
      return { counted: result.counted, relationship: result.relationship };
    },
    getMemoryState(id, options = {}) {
      const profile = byId.get(id);
      const parent = options.simulation && profile && profile.simulationState
        ? profile.simulationState
        : (options.simulation ? null : profile);
      return autobiographicalMemory.normalize(parent && parent.memoryState, Number(options.nowMs) || now());
    },
    recordMemoryEvent(id, event, options = {}) {
      const profile = byId.get(id);
      if (!profile) return null;
      if (options.simulation && !profile.simulationState) {
        profile.simulationState = {
          sched: {}, repliedTo: [], postedNews: [], newsDomainDaily: {}, newsDomainDays: [],
          threadReplies: {}, threadOrder: [], memoryState: autobiographicalMemory.defaults(),
        };
      }
      const parent = options.simulation ? profile.simulationState : profile;
      const result = autobiographicalMemory.recordEvent(parent.memoryState, event, {
        nowMs: Number(options.nowMs) || now(),
        ownerText: [profile.persona, profile.toneNotes].filter(Boolean).join('\n'),
      });
      parent.memoryState = result.state;
      return { counted: result.counted, episode: result.episode, claims: result.claims, conflicts: result.conflicts };
    },
    getThreadReplyCount(postId, options = {}) {
      const profileId = options.profileId;
      const profile = profileId ? byId.get(profileId) : null;
      const threadState = options.simulation && profile && profile.simulationState
        ? profile.simulationState
        : settings;
      return Number(threadState.threadReplies && threadState.threadReplies[String(postId)]) || 0;
    },
    bumpThreadReply(postId, options = {}) {
      const profileId = options.profileId;
      const profile = profileId ? byId.get(profileId) : null;
      const threadState = options.simulation && profile && profile.simulationState
        ? profile.simulationState
        : settings;
      threadState.threadReplies = threadState.threadReplies || {};
      const key = String(postId);
      threadState.threadReplies[key] = (Number(threadState.threadReplies[key]) || 0) + 1;
      return threadState.threadReplies[key];
    },
    updateSched(id, patch, options = {}) {
      const profile = byId.get(id);
      if (!profile) return null;
      if (options.simulation) {
        profile.simulationState = profile.simulationState || {
          sched: {}, repliedTo: [], postedNews: [], newsDomainDaily: {}, newsDomainDays: [],
          threadReplies: {}, threadOrder: [],
        };
        profile.simulationState.sched = { ...this.schedDefaults(), ...profile.simulationState.sched, ...patch };
        return profile.simulationState.sched;
      }
      profile.sched = { ...this.schedDefaults(), ...profile.sched, ...patch };
      return profile.sched;
    },
    setProbation(id, patch) {
      const profile = byId.get(id);
      profile.probation = { ...(profile.probation || {}), ...patch };
      return profile.probation;
    },
    logActivity(id, entry) {
      const profile = byId.get(id);
      profile.activity.push({ at: new Date(now()).toISOString(), ...entry });
      return profile;
    },
    recordSpend(id, entry) {
      const profile = byId.get(id);
      profile.spendDays.push(entry);
      return entry;
    },
    recordHostedTurnCompletion(id) {
      const profile = byId.get(id);
      profile.hostedOnboardingTurnsCompleted =
        (Number(profile.hostedOnboardingTurnsCompleted) || 0) + 1;
      return profile.hostedOnboardingTurnsCompleted;
    },
    recordSimulationTelemetry(id, event) {
      const profile = byId.get(id);
      if (!profile) return null;
      profile.simulationState = profile.simulationState || {};
      profile.simulationState.telemetry = rehearsalObservability.record(
        profile.simulationState.telemetry,
        event,
      );
      return structuredClone(profile.simulationState.telemetry);
    },
    getPopulationActivity(id, options = {}) {
      const profile = byId.get(id);
      if (!profile || profile.botOrigin !== 'system') return null;
      const parent = options.simulation && profile.simulationState
        ? profile.simulationState
        : profile;
      return populationActivity.normalizeState(parent && parent.populationActivity, {
        nowMs: Number(options.nowMs) || now(),
        seed: profile.populationSeed || {},
        quantile: populationActivity.stableUnit(profile.id),
      });
    },
    updatePopulationActivity(id, state, options = {}) {
      const profile = byId.get(id);
      if (!profile || profile.botOrigin !== 'system') return null;
      const normalized = populationActivity.normalizeState(state, {
        nowMs: Number(options.nowMs) || now(),
        seed: profile.populationSeed || {},
        quantile: populationActivity.stableUnit(profile.id),
      });
      if (options.simulation) {
        profile.simulationState = profile.simulationState || {
          sched: {}, repliedTo: [], postedNews: [], newsDomainDaily: {}, newsDomainDays: [],
          threadReplies: {}, threadOrder: [],
        };
        profile.simulationState.populationActivity = normalized;
      } else {
        profile.populationActivity = normalized;
      }
      return structuredClone(normalized);
    },
    runnerSpend: () => ({ monthUsd: 0, dayUsd: 0 }),
  };
}

function queueJobs(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).jobs;
}

function completeJob(queue, jobId, text) {
  const claimed = queue.claim('worker-test', { model: 'test-model' });
  eq(claimed.id, jobId, 'the expected durable generation job was claimed');
  queue.complete(jobId, 'worker-test', {
    text,
    provider: 'ollama',
    model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
    ms: 50,
  });
}

function chooseFirstCandidate(queue, turn) {
  completeJob(queue, turn.generations[0].jobId, JSON.stringify({
    choice: 'C1',
    reason: 'The available discussion fits this bot right now.',
  }));
}

async function queueContentGeneration(runtime, turnId) {
  runtime.scheduler.reconcileDurableTurns();
  await settle();
  const turn = runtime.turnStore.get(turnId);
  eq(turn.generations.length, 2, 'the stored candidate decision resumes into one content generation');
  return turn.generations[1];
}

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-durable-scheduler-'));
  let current = 10_000;
  let sequence = 0;
  const now = () => current;
  const profiles = options.profiles || [makeProfile('bot-a', true)];
  const store = makeStore(profiles, now);
  const queueFile = path.join(dir, 'jobs.json');
  const turnFile = path.join(dir, 'turns.json');
  const queue = createQueue({
    file: queueFile,
    now,
    random: () => (++sequence) / 1000,
  });
  const turnStore = createTurnStore({
    file: turnFile,
    now,
    random: () => (++sequence) / 1000,
  });
  const dell = createDellProvider(queue, { now });
  const providers = {
    enqueueDell: dell.enqueue,
    generate: options.providerGenerate || (async () => { throw new Error('scheduled DELL turns must not use the blocking provider path'); }),
    ollamaBusy: () => false,
  };
  const writes = [];
  const logs = [];
  const feddit = {
    submit: async (request) => {
      writes.push({ type: 'submit', request });
      if (options.submitResponse) return options.submitResponse(request, writes);
      return { ok: true, status: 200, data: { post: { data: { id: 900 + writes.length } } } };
    },
    comment: async (request) => {
      writes.push({ type: 'comment', request });
      if (options.commentResponse) return options.commentResponse(request);
      return { ok: true, status: 200, data: { comment: { data: { id: 1000 + writes.length } } } };
    },
    voteAllowance: async () => ({
      ok: true,
      status: 200,
      data: { vote_allowance: { limited: true, limit: 15, used: 0, remaining: 15, on_probation: false } },
    }),
    vote: async (request) => {
      writes.push({ type: 'vote', request });
      if (options.voteResponse) return options.voteResponse(request);
      return { ok: true, status: 200, data: { score: 1 } };
    },
    attention: async () => ({
      ok: true, status: 200,
      data: { cursor: { comments: 0, posts: 0 }, has_more: false, events: [] },
    }),
    feddit: async () => ({
      ok: true, status: 200,
      data: { data: { children: (typeof options.feedPosts === 'function' ? options.feedPosts() :
        (Array.isArray(options.feedPosts) ? options.feedPosts : [])).map((post) => ({ data: post })) } },
    }),
    comments: async () => ({ ok: true, status: 200, data: { comments: [] } }),
  };
  const about = {
    fetchAbout: async () => ({ name: 'general', over_18: false, post_format: 'any', rules: [] }),
  };
  function scheduler() {
    return createScheduler({
      store,
      providers,
      feddit,
      about,
      jobQueue: queue,
      turnStore,
      now,
      random: () => 0.5,
      queueAllocationFor: options.queueAllocationFor,
      admitHostedTurn: options.admitHostedTurn,
      log: (message) => logs.push(message),
    });
  }
  function restartRuntime() {
    const restartedQueue = createQueue({
      file: queueFile,
      now,
      random: () => (++sequence) / 1000,
    });
    const restartedTurns = createTurnStore({
      file: turnFile,
      now,
      random: () => (++sequence) / 1000,
    });
    const restartedDell = createDellProvider(restartedQueue, { now });
    const restartedProviders = {
      enqueueDell: restartedDell.enqueue,
      generate: options.providerGenerate || (async () => { throw new Error('scheduled DELL turns must not use the blocking provider path'); }),
      ollamaBusy: () => false,
    };
    const restartedScheduler = createScheduler({
      store,
      providers: restartedProviders,
      feddit,
      about,
      jobQueue: restartedQueue,
      turnStore: restartedTurns,
      now,
      random: () => 0.5,
      queueAllocationFor: options.queueAllocationFor,
      admitHostedTurn: options.admitHostedTurn,
      log: (message) => logs.push(message),
    });
    return {
      queue: restartedQueue,
      turnStore: restartedTurns,
      scheduler: restartedScheduler,
    };
  }
  return {
    dir,
    now,
    advance: (ms) => { current += Number(ms) || 0; },
    profiles,
    store,
    queue,
    queueFile,
    turnStore,
    turnFile,
    providers,
    feddit,
    writes,
    logs,
    scheduler,
    restartRuntime,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function votingHarness(id, count) {
  const voter = makeProfile(id, false);
  Object.assign(voter, { canReply: true, canStartDiscussions: false, postsPerHour: 0, commentsPerHour: 1 });
  Object.assign(voter.sched, { nextPostAt: null, nextCommentAt: 0 });
  return harness({ profiles: [voter], feedPosts: Array.from({ length: count }, (_, index) => ({
    id: 73 + index, feddit: 'general', author: 'carol', title: 'A visible item ' + index,
    selftext: 'A specific public contribution worth considering.', created_utc: 9,
  })) });
}

async function run() {
  // Decision contract versions are frozen with the logical turn, not inferred
  // from the latest parser when old generations resume after a restart.
  for (const version of [undefined, 1]) {
    for (const boundary of ['initial', 'repair', 'content']) {
      const h = votingHarness('legacy-' + version + '-' + boundary, 1);
      try {
        h.profiles[0].voteState.considered = ['post:old-history'];
        const initial = h.scheduler();
        await initial.runTick();
        await settle();
        const turn = h.turnStore.activeForProfile(h.profiles[0].id);
        const input = { ...turn.input };
        if (version === undefined) delete input.decisionContractVersion;
        else input.decisionContractVersion = version;
        h.turnStore.update(turn.id, { input });
        let runtime = { queue: h.queue, turnStore: h.turnStore, scheduler: initial };
        if (boundary === 'initial') runtime = h.restartRuntime();
        completeJob(runtime.queue, turn.generations[0].jobId,
          boundary === 'repair' ? 'No recognizable decision.' : 'C1 because this item is worth answering.');
        runtime.scheduler.reconcileDurableTurns();
        await settle();
        if (boundary === 'repair') {
          runtime = h.restartRuntime();
          const repair = runtime.turnStore.get(turn.id).generations[1];
          completeJob(runtime.queue, repair.jobId, 'C1 because the repaired choice fits.');
          runtime.scheduler.reconcileDurableTurns();
          await settle();
        }
        if (boundary === 'content') runtime = h.restartRuntime();
        const pending = runtime.turnStore.get(turn.id);
        const expectedCalls = boundary === 'repair' ? 3 : 2;
        eq(pending.generations.length, expectedCalls, 'legacy replay retains its generation sequence at ' + boundary);
        completeJob(runtime.queue, pending.generations[expectedCalls - 1].jobId, 'A durable legacy reply.');
        runtime.scheduler.reconcileDurableTurns();
        await settle();
        eq(runtime.turnStore.get(turn.id).status, 'completed', 'legacy token-choice replay completes at ' + boundary);
        eq(h.profiles[0].voteState.considered, ['post:old-history', 'post:73'], 'legacy considered history is not reinterpreted');
        eq(h.writes.filter((write) => write.type === 'vote').length, 0, 'legacy missing vote retains its original nil effect');
        eq(h.writes.filter((write) => write.type === 'comment').length, 1, 'legacy reply reaches the mocked endpoint once');
        h.restartRuntime().scheduler.reconcileDurableTurns();
        await settle();
        eq(h.writes.length, 1, 'legacy terminal restart cannot repeat effects');
      } finally {
        h.cleanup();
      }
    }
  }

  for (const unresolvedKind of ['missing', 'invalid']) {
    const h = votingHarness('contract-v2-partial-votes-' + unresolvedKind, 3);
    const voter = h.profiles[0];
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile(voter.id);
      eq(turn.input.decisionContractVersion, 2, 'new turns freeze decision contract version two');
      const slate = turn.checkpoints['opportunity-candidates'].voteCandidates;
      eq(slate.length, 3, 'partial decision fixture respects the three-target H14 bound');
      completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({
        choice: 'C1', reason: 'This concrete discussion is worth answering.', votes: [
          { id: slate[0].id, direction: 'up', reason: 'The contribution is concrete and useful.' },
          { id: slate[1].id, direction: 'nil', reason: 'I have no strong reaction to this contribution.' },
          ...(unresolvedKind === 'invalid'
            ? [{ id: slate[2].id, direction: 'sideways', reason: 'This is not a supported voting direction.' }]
            : []),
        ],
      }));
      const restarted = h.restartRuntime();
      const content = await queueContentGeneration(restarted, turn.id);
      eq(restarted.turnStore.get(turn.id).generations.length, 2, 'missing votes do not create an extra repair');
      eq(h.writes.filter((write) => write.type === 'vote').length, 1, 'valid vote effect completes before content suspension');
      const afterVote = h.restartRuntime();
      completeJob(afterVote.queue, content.jobId, 'A valid reply with independent unresolved vote siblings.');
      afterVote.scheduler.reconcileDurableTurns();
      await settle();
      const finished = afterVote.turnStore.get(turn.id);
      eq(finished.status, 'completed', 'valid main action survives unresolved ancillary decisions');
      eq(h.writes.filter((write) => write.type === 'vote').length, 1, 'only the valid positive vote reaches the endpoint');
      eq(h.writes.filter((write) => write.type === 'comment').length, 1, 'valid reply executes once');
      const key = (vote) => vote.targetType + ':' + vote.targetId;
      eq(voter.voteState.considered, slate.slice(0, 2).map(key), 'only valid vote and explicit abstention become considered');
      const unresolved = finished.checkpoints['opportunity-decision'].votes.filter((vote) => vote.status === 'unresolved');
      eq(unresolved.map((vote) => vote.decisionKind), [unresolvedKind], 'technical vote classifications remain distinct');
      ok(unresolved.every((vote) => vote.direction === null && vote.error && vote.error.length <= 500),
        'unresolved votes have no invented direction and bounded diagnostics');
      const after = h.restartRuntime();
      after.scheduler.reconcileDurableTurns();
      await after.scheduler.runTick();
      await settle();
      eq(queueJobs(h.queueFile).length, 2, 'restart creates no immediate retry or catch-up generation');
      eq(h.writes.length, 2, 'restart never repeats accepted effects');
      ok(voter.sched.nextCommentAt > h.now(), 'ordinary comment cadence advances');
      h.advance(voter.sched.nextCommentAt - h.now() + 1);
      await after.scheduler.runTick();
      await settle();
      const future = after.turnStore.activeForProfile(voter.id);
      ok(future && future.id !== turn.id, 'later natural opportunity remains available');
      const offeredAgain = future.checkpoints['opportunity-candidates'].voteCandidates.map(key);
      eq(offeredAgain.sort(), slate.slice(2).map(key).sort(), 'unresolved targets remain eligible on the later natural opportunity');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = votingHarness('contract-v2-pinned-votes', 2);
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile(h.profiles[0].id);
      const slate = turn.checkpoints['opportunity-candidates'].voteCandidates;
      completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({
        choice: 'UNKNOWN', reason: 'The primary choice is invalid.',
        votes: [{ id: slate[0].id, direction: 'up', reason: 'The original valid reason must remain pinned.' }],
      }));
      initial.reconcileDurableTurns();
      await settle();
      const restarted = h.restartRuntime();
      const repair = restarted.turnStore.get(turn.id).generations[1];
      completeJob(restarted.queue, repair.jobId, JSON.stringify({
        choice: 'C1', reason: 'The repaired primary choice is valid.', votes: [
          { id: slate[0].id, direction: 'down', reason: 'This later contradiction must not replace the valid first vote.' },
          { id: slate[1].id, direction: 'nil', reason: 'The missing vote is now an explicit abstention.' },
        ],
      }));
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      const content = restarted.turnStore.get(turn.id).generations[2];
      completeJob(restarted.queue, content.jobId, 'A reply after one bounded primary repair.');
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      const finished = restarted.turnStore.get(turn.id);
      const recordedVotes = h.profiles[0].activity.find((entry) => entry.kind === 'vote').votes;
      eq(recordedVotes.map((vote) => vote.direction), ['up', 'nil'], 'repair fills unresolved votes without rerolling valid votes');
      eq(recordedVotes[0].reason, 'The original valid reason must remain pinned.', 'repair retains the first valid reason');
      eq(finished.generations.length, 3, 'restart retains exactly decision, repair and content');
      eq(h.writes.filter((write) => write.type === 'vote').length, 1, 'pinned vote executes once');
    } finally {
      h.cleanup();
    }
  }

  for (const explicitNil of [false, true]) {
    const h = votingHarness('voting-only-unresolved-' + explicitNil, 1);
    const voter = h.profiles[0];
    Object.assign(voter, { canReply: false, canVote: true, commentsPerHour: 0, votesPerHour: 1 });
    Object.assign(voter.sched, { nextCommentAt: null, nextVoteAt: 0 });
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile(voter.id);
      const slate = turn.checkpoints['opportunity-candidates'].voteCandidates;
      completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({
        choice: 'WAIT', reason: 'There is no primary publication in this voting-only turn.',
        votes: explicitNil ? [{ id: slate[0].id, direction: 'nil', reason: 'This item does not provoke a voting reaction.' }] : [],
      }));
      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      const finished = restarted.turnStore.get(turn.id);
      eq(finished.result.action, 'vote', 'voting-only result remains a voting opportunity');
      eq(finished.result.ok, explicitNil, 'only explicit abstention is a successful zero-action voting result');
      eq(finished.result.waited, explicitNil, 'missing votes are not relabeled as a deliberate WAIT');
      eq(voter.voteState.considered, explicitNil ? ['post:73'] : [], 'voting-only considered state excludes technical omissions');
      eq(h.writes.length, 0, 'missing and nil votes cause no endpoint writes');
      ok(voter.sched.nextVoteAt > h.now(), 'voting cadence advances for successful abstention and technical omission');
      await restarted.scheduler.runTick();
      await settle();
      eq(queueJobs(h.queueFile).length, 1, 'unresolved voting-only components do not trigger immediate retries or repair');
    } finally {
      h.cleanup();
    }
  }

  for (const simulation of [false, true]) {
    const h = votingHarness('system-partial-vote-' + simulation, 2);
    const voter = h.profiles[0];
    Object.assign(voter, {
      botOrigin: 'system', ownerId: null, dryRun: simulation, enabled: !simulation,
      canReply: false, canVote: true, commentsPerHour: 0, votesPerHour: 1,
      populationCadenceMode: 'custom',
      populationSeed: { initiative: 'balanced', persistence: 'steady' },
    });
    Object.assign(voter.sched, { nextCommentAt: null, nextVoteAt: 0 });
    voter.populationActivity = populationActivity.initialState(voter.populationSeed, { nowMs: h.now(), quantile: 0.5 });
    const originalLiveSchedule = structuredClone(voter.sched);
    try {
      const initial = h.scheduler();
      let turn;
      if (simulation) {
        const dueAt = initial.rehearsalNextAt(voter.id, h.now());
        const started = await initial.runAcceleratedRehearsalOpportunity(voter.id, {
          runId: 'partial-vote-rehearsal', virtualNowMs: Math.max(h.now(), dueAt),
        });
        await settle();
        turn = h.turnStore.get(started.turnId);
      } else {
        await initial.runTick();
        await settle();
        turn = h.turnStore.activeForProfile(voter.id);
      }
      ok(turn, 'system voting opportunity creates one durable turn');
      const slate = turn.checkpoints['opportunity-candidates'].voteCandidates;
      eq(slate.length, 2, 'partial system voting fixture exposes two targets');
      completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({
        choice: 'WAIT', reason: 'Voting only, with one valid positive reaction.',
        votes: [{ id: slate[0].id, direction: 'up', reason: 'This concrete observation deserves a positive reaction.' }],
      }));
      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      const finished = restarted.turnStore.get(turn.id);
      eq(finished.result.ok, false, 'missing sibling remains a technical partial failure');
      eq(finished.result.waited, false, 'partial voting success is not an invented WAIT');
      eq(finished.result.visibleActions, 1, 'accepted vote remains a visible action despite unresolved sibling');
      eq(finished.result.unresolvedVoteCount, 1, 'partial failure remains separately visible');
      const state = simulation ? voter.simulationState : voter;
      eq(state.populationActivity.recentVisibleActions.length, 1, 'population ecology records the actual accepted vote');
      eq(state.voteState.considered, [slate[0].targetType + ':' + slate[0].targetId], 'only valid sibling becomes considered');
      eq(h.writes.filter((write) => write.type === 'vote').length, simulation ? 0 : 1, 'rehearsal stays isolated from the vote endpoint');
      if (simulation) {
        const events = voter.simulationState.telemetry.events;
        eq(events.length, 1, 'partial rehearsal has one durable observability event');
        eq(events[0].outcome, 'action', 'rehearsal records visible action independently of partial technical failure');
        ok(/unresolved/i.test(events[0].reason), 'rehearsal reason retains unresolved technical failure information');
        eq(events[0].decisionFailure, true, 'partial rehearsal retains a structured technical failure flag');
        const summary = rehearsalObservability.summarize([voter], { runId: 'partial-vote-rehearsal' });
        eq(summary.actions, 1, 'rehearsal summary counts the accepted partial action');
        eq(summary.failures, 1, 'rehearsal summary also counts the unresolved technical decision');
        eq(voter.sched, originalLiveSchedule, 'rehearsal leaves live deadlines unchanged');
      }
      h.restartRuntime().scheduler.reconcileDurableTurns();
      await settle();
      eq(state.populationActivity.recentVisibleActions.length, 1, 'restart cannot double-count the accepted partial action');
      eq(queueJobs(h.queueFile).length, 1, 'partial vote restart creates no retry generation');
      eq(h.writes.length, simulation ? 0 : 1, 'partial vote restart cannot duplicate the endpoint effect');
    } finally {
      h.cleanup();
    }
  }

  for (const version of [2, 99]) {
    const profile = makeProfile('invalid-primary-' + version, false);
    const h = harness({ profiles: [profile] });
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile(profile.id);
      h.turnStore.update(turn.id, { input: { ...turn.input, decisionContractVersion: version } });
      completeJob(h.queue, turn.generations[0].jobId, 'C1 hidden in prose is not a complete structured decision.');
      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      if (version === 2) {
        const repair = restarted.turnStore.get(turn.id).generations[1];
        ok(repair, 'invalid primary gets one bounded repair');
        completeJob(restarted.queue, repair.jobId, 'Still not a structured decision, despite mentioning C1.');
        restarted.scheduler.reconcileDurableTurns();
        await settle();
      }
      const failed = restarted.turnStore.get(turn.id);
      if (version === 2) {
        eq(failed.result && failed.result.ok, false, 'technical contract failure is not reported as successful WAIT');
        eq(failed.result && failed.result.action, 'failed', 'technical decision failure is explicit');
      } else {
        eq(failed.status, 'blocked', 'unsupported future contract stays blocked for a compatible runtime');
        ok(/decision.*contract|contract.*version/i.test(failed.error), 'unsupported contract has a clear diagnostic');
      }
      eq(h.writes.length, 0, 'invalid or unsupported contract causes no public effect');
      eq(profile.voteState.considered, [], 'invalid contract cannot alter considered state');
      if (version === 2) {
        ok(profile.sched.nextPostAt > h.now(), 'invalid primary advances cadence rather than retrying immediately');
        await restarted.scheduler.runTick();
        await settle();
        eq(queueJobs(h.queueFile).length, 2, 'failed repair creates no immediate model retry');
      } else {
        eq(failed.generations.length, 1, 'unsupported contract fails before repair or content');
        await restarted.scheduler.runTick();
        await settle();
        eq(restarted.turnStore.activeForProfile(profile.id).id, turn.id, 'unsupported contract retains its existing active logical turn');
        eq(queueJobs(h.queueFile).length, 1, 'unsupported contract does not create a replacement generation');
        eq(h.writes.length, 0, 'rechecking unsupported contract cannot publish');
      }
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({
      profiles: [makeProfile('bot-a', true), makeProfile('bot-b', true)],
      queueAllocationFor: hostedPolicy.processingFor,
    });
    try {
      const firstScheduler = h.scheduler();
      const tick = await firstScheduler.runTick();
      await settle();
      eq(tick.acted, 2, 'one scheduler tick hands off every due hosted profile');
      eq(h.turnStore.listActive().length, 2, 'two hosted logical turns can be in progress together');
      eq(h.queue.capacity().queued, 2, 'both hosted generations reached the durable queue');
      const queued = queueJobs(h.queueFile);
      const queuedA = queued.find((job) => job.profileId === 'bot-a');
      eq(queuedA.ownerKey, 'owner-bot-a', 'durable jobs use the real private workspace owner key');
      eq(queuedA.allocationClass, 'user', 'user-created durable work enters the user allocation class');
      eq(queuedA.onboarding, true, 'new user-created durable work carries onboarding priority');
      eq(queuedA.priority, 'normal', 'candidate salience does not promote scheduled work to interactive priority');
      const queuedTurnA = h.turnStore.activeForProfile('bot-a');
      ok(queuedTurnA.generations[0].request.prompt.includes('real things available now') &&
        queuedTurnA.generations[0].request.prompt.includes('WAIT'),
        'the first durable generation chooses from real candidates and can wait');

      const secondTick = await firstScheduler.runTick();
      await settle();
      ok(secondTick.skipped !== 'reentrant', 'a later scheduler tick is free while DELL work is outstanding');
      eq(queueJobs(h.queueFile).length, 2, 'an active logical turn prevents duplicate jobs for the same profiles');
    } finally {
      h.cleanup();
    }
  }

  {
    const system = makeProfile('system-bot', true);
    system.botOrigin = 'system';
    system.ownerId = null;
    const user = makeProfile('user-bot', true);
    const h = harness({
      profiles: [system, user],
      admitHostedTurn: (profile) => profile.botOrigin === 'system'
        ? { admit: false, reason: 'synthetic-yields-to-shared-capacity' }
        : { admit: true, reason: 'user-created' },
    });
    try {
      await h.scheduler().runTick();
      await settle();
      eq(h.turnStore.listActive().length, 1,
        'turn admission allows the due user bot without creating a synthetic turn');
      eq(h.turnStore.activeForProfile('system-bot'), null,
        'system population yields before durable turn creation under congestion');
      eq(h.queue.capacity().queued, 1, 'only user-created work reaches the DELL queue');
      ok(system.simulationState.sched.nextPostAt > h.now(),
        'a missed synthetic opportunity is rescheduled instead of remaining overdue');
      eq(system.simulationState.populationActivity.recentCapacitySkips.length, 1,
        'capacity pressure is recorded once for operator observability');
      await h.scheduler().runTick();
      await settle();
      eq(h.queue.capacity().queued, 1,
        'repeated scheduler ticks cannot build a synthetic backlog while admission is closed');
      eq(system.simulationState.populationActivity.recentCapacitySkips.length, 1,
        'the rescheduled opportunity is not repeatedly counted as a capacity skip');
    } finally {
      h.cleanup();
    }
  }

  {
    const custom = makeProfile('custom-system-cadence', false);
    custom.botOrigin = 'system';
    custom.ownerId = null;
    custom.populationCadenceMode = 'custom';
    custom.postsPerHour = 2;
    custom.commentsPerHour = 0;
    custom.populationActivity = populationActivity.initialState({}, {
      nowMs: 10_000,
      quantile: 0.2,
    });
    custom.populationActivity.recentOpportunities = [1000, 2000, 3000, 4000, 5000, 6000];
    const h = harness({
      profiles: [custom],
      admitHostedTurn: () => ({ admit: true, reason: 'spare-capacity' }),
    });
    try {
      const runtime = h.scheduler();
      for (let index = 0; index < 19; index++) {
        await runtime.runTick();
        await settle();
        const turn = h.turnStore.activeForProfile(custom.id);
        ok(turn, 'custom population cadence creates opportunity ' + (index + 1) + ' beyond the ecology ceiling');
        completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({
          choice: 'WAIT',
          reason: 'Nothing available is suitable for this test opportunity.',
        }));
        runtime.reconcileDurableTurns();
        await settle();
        const finished = h.turnStore.get(turn.id);
        eq(finished.status, 'completed', 'custom opportunity ' + (index + 1) + ' reaches a durable terminal state');
        eq(finished.result.action, 'wait', 'WAIT remains a normal custom-cadence outcome');
        eq(custom.sched.nextPostAt, h.now() + 30 * 60 * 1000,
          'WAIT schedules one later custom opportunity without an immediate retry');
        h.advance(custom.sched.nextPostAt - h.now());
      }
      ok(custom.populationActivity.recentOpportunities.length > populationActivity.MAX_OPPORTUNITIES_PER_DAY,
        'custom population cadence exceeds the ecology 24-opportunity history ceiling');

      h.advance(5 * 60 * 60 * 1000);
      await runtime.runTick();
      await settle();
      const lateTurn = h.turnStore.activeForProfile(custom.id);
      ok(lateTurn, 'one overdue custom opportunity is created after scheduler starvation');
      completeJob(h.queue, lateTurn.generations[0].jobId, JSON.stringify({
        choice: 'WAIT',
        reason: 'The late opportunity still has no suitable item.',
      }));
      runtime.reconcileDurableTurns();
      await settle();
      eq(custom.sched.nextPostAt, h.now() + 30 * 60 * 1000,
        'scheduler starvation does not trigger catch-up bursts for custom cadence');
    } finally {
      h.cleanup();
    }
  }

  {
    const custom = makeProfile('custom-system-yield', false);
    custom.botOrigin = 'system';
    custom.ownerId = null;
    custom.populationCadenceMode = 'custom';
    custom.postsPerHour = 1;
    custom.commentsPerHour = 0;
    custom.populationActivity = populationActivity.initialState({}, {
      nowMs: 10_000,
      quantile: 0.2,
    });
    custom.populationActivity.recentOpportunities = [1000, 2000, 3000, 4000, 5000, 6000];
    const h = harness({
      profiles: [custom],
      admitHostedTurn: () => ({
        admit: false,
        reason: 'synthetic-yields-to-shared-capacity',
      }),
    });
    try {
      await h.scheduler().runTick();
      await settle();
      eq(h.turnStore.listActive().length, 0,
        'custom population cadence still yields before using occupied hosted capacity');
      eq(custom.populationActivity.recentCapacitySkips.length, 1,
        'custom capacity pressure remains observable');
      eq(custom.sched.nextPostAt, h.now() + 60 * 60 * 1000,
        'custom capacity yield follows the configured cadence instead of the ecology 24-per-day wait');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({ profiles: [makeProfile('rehearsal-bot', true)] });
    try {
      const beforeRestart = h.scheduler();
      await beforeRestart.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('rehearsal-bot');
      chooseFirstCandidate(h.queue, turn);

      h.profiles[0].dryRun = false;
      const restarted = h.restartRuntime();
      const content = await queueContentGeneration(restarted, turn.id);
      completeJob(restarted.queue, content.jobId, 'A durable title\n\nA durable body.');
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      const finished = restarted.turnStore.get(turn.id);
      eq(finished.status, 'completed', 'a completed queue result resumes and completes after scheduler recreation');
      eq(h.writes.length, 0, 'the turn keeps its frozen rehearsal mode even if the profile changes after restart');
      eq(queueJobs(h.queueFile).length, 2, 'the completed decision and content generations are reused rather than regenerated');
      eq(h.profiles[0].activity.filter((entry) => entry.dryRun).length, 1, 'post-generation rehearsal handling runs once');
      eq(h.profiles[0].hostedOnboardingTurnsCompleted, 1,
        'one useful completed scheduled DELL turn consumes one onboarding opportunity');

      const anotherRestart = h.restartRuntime();
      anotherRestart.scheduler.reconcileDurableTurns();
      await settle();
      eq(queueJobs(h.queueFile).length, 2, 'a terminal turn remains terminal across another restart');
      eq(h.profiles[0].activity.filter((entry) => entry.dryRun).length, 1, 'terminal reconciliation does not duplicate activity');
      eq(h.profiles[0].hostedOnboardingTurnsCompleted, 1,
        'restart reconciliation never consumes the same onboarding opportunity twice');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({ profiles: [makeProfile('slow-decision-bot', false)] });
    try {
      await h.scheduler().runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('slow-decision-bot');
      chooseFirstCandidate(h.queue, turn);

      // Hosted inference commonly crosses one or more human-readable recency
      // boundaries before the runner resumes the turn.
      h.advance(2 * 60 * 1000);
      const restarted = h.restartRuntime();
      const content = await queueContentGeneration(restarted, turn.id);
      completeJob(restarted.queue, content.jobId, 'A stable title\n\nA stable body.');
      restarted.scheduler.reconcileDurableTurns();
      await settle();

      eq(restarted.turnStore.get(turn.id).status, 'completed',
        'elapsed time during hosted generation cannot invalidate durable candidate replay');
      eq(h.writes.length, 1,
        'a slow hosted candidate decision still reaches one live publication');
      ok(!h.profiles[0].activity.some((entry) => String(entry.note || '').includes('replay did not reproduce')),
        'elapsed time is never recorded as a personality WAIT');
    } finally {
      h.cleanup();
    }
  }

  {
    const profile = makeProfile('mismatched-decision-bot', false);
    const h = harness({ profiles: [profile] });
    try {
      await h.scheduler().runTick();
      await settle();
      const turn = h.turnStore.activeForProfile(profile.id);
      h.turnStore.generation(turn.id, 0, { signature: 'deliberately-wrong-signature' });
      chooseFirstCandidate(h.queue, turn);

      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(restarted.turnStore.get(turn.id).status, 'failed',
        'a genuine replay mismatch remains an infrastructure failure');
      eq(profile.sched.nextPostAt, 0,
        'an infrastructure failure does not postpone the due opportunity');
      ok(!profile.activity.some((entry) => String(entry.note || '').startsWith('WAIT:')),
        'an infrastructure failure is not presented as a personality decision');

      await restarted.scheduler.runTick();
      await settle();
      const retry = restarted.turnStore.activeForProfile(profile.id);
      ok(retry && retry.id !== turn.id,
        'the next scheduler tick creates a fresh retry for the still-due opportunity');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({ profiles: [makeProfile('claimed-bot', true)] });
    try {
      await h.scheduler().runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('claimed-bot');
      const claimed = h.queue.claim('worker-claimed', { model: 'test-model' });
      eq(claimed.id, turn.generations[0].jobId, 'the claimed recovery test keeps the turn linked to its original job');

      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(restarted.queue.get(claimed.id).status, 'claimed', 'a non-expired claimed job remains owned by its worker after restart');
      eq(restarted.turnStore.get(turn.id).status, 'generating', 'the logical turn reports that DELL is generating its claimed job');
      eq(queueJobs(h.queueFile).length, 1, 'claimed-job reconciliation does not enqueue a duplicate generation');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({ profiles: [makeProfile('retry-bot', true)] });
    try {
      await h.scheduler().runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('retry-bot');
      const claimed = h.queue.claim('worker-retry', { model: 'test-model' });
      h.queue.fail(claimed.id, 'worker-retry', 'temporary worker failure', true);

      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      const job = restarted.queue.get(claimed.id);
      eq(job.status, 'queued', 'a retryable DELL failure leaves the same durable job queued');
      eq(restarted.turnStore.get(turn.id).status, 'waiting', 'the logical turn returns to waiting while its job retries');
      eq(queueJobs(h.queueFile).length, 1, 'retryable failure recovery does not create a second job');
      ok(job.lastError.includes('temporary worker failure'), 'the queue retains the retry reason for observability');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({ profiles: [makeProfile('live-bot', false)] });
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('live-bot');
      chooseFirstCandidate(h.queue, turn);

      const restarted = h.restartRuntime();
      const content = await queueContentGeneration(restarted, turn.id);
      completeJob(restarted.queue, content.jobId, 'Live durable title\n\nLive durable body.');
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 1, 'a live durable turn publishes once after its result arrives');
      eq(restarted.turnStore.get(turn.id).status, 'completed', 'the live turn reaches a terminal completed state');
      eq(h.profiles[0].memoryState.episodes.length, 1,
        'a successfully published discussion becomes one live autobiographical episode');

      h.restartRuntime().scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 1, 'a completed live turn is never published again after restart');
      eq(h.profiles[0].memoryState.episodes.length, 1,
        'durable replay cannot double-count a successfully published episode');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({ profiles: [makeProfile('uncertain-bot', false)] });
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('uncertain-bot');
      chooseFirstCandidate(h.queue, turn);

      const restarted = h.restartRuntime();
      const content = await queueContentGeneration(restarted, turn.id);
      completeJob(restarted.queue, content.jobId, 'Uncertain title\n\nUncertain body.');
      restarted.turnStore.publication(turn.id, { state: 'attempting', attemptingAt: h.now() });
      const afterPublicationRestart = h.restartRuntime();
      afterPublicationRestart.scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 0, 'an interrupted publication boundary is not retried after restart');
      eq(afterPublicationRestart.turnStore.get(turn.id).status, 'publication-uncertain', 'the residual no-idempotency edge is explicit and terminal');
      eq(h.profiles[0].memoryState.episodes.length, 0,
        'an uncertain publication boundary creates no false autobiographical episode');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({ profiles: [makeProfile('network-uncertain-bot', false)] });
    try {
      h.feddit.submit = async (request) => {
        h.writes.push({ type: 'submit', request });
        throw new Error('connection ended before a response arrived');
      };
      await h.scheduler().runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('network-uncertain-bot');
      chooseFirstCandidate(h.queue, turn);

      const restarted = h.restartRuntime();
      const content = await queueContentGeneration(restarted, turn.id);
      completeJob(restarted.queue, content.jobId, 'Network boundary title\n\nNetwork boundary body.');
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 1, 'a live write is attempted once when Feddit never returns a response');
      eq(restarted.turnStore.get(turn.id).status, 'publication-uncertain', 'a missing Feddit response records the publication boundary as uncertain');
      eq(h.profiles[0].memoryState.episodes.length, 0,
        'an ambiguous network publication creates no autobiographical episode');

      h.restartRuntime().scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 1, 'an ambiguous network publication is not retried after another restart');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({ profiles: [makeProfile('response-saved-bot', false)] });
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('response-saved-bot');
      chooseFirstCandidate(h.queue, turn);
      const restarted = h.restartRuntime();
      const content = await queueContentGeneration(restarted, turn.id);
      completeJob(restarted.queue, content.jobId, 'Saved response title\n\nSaved response body.');
      restarted.turnStore.publication(turn.id, {
        kind: 'post',
        state: 'response-received',
        response: { ok: true, status: 200, data: { post: { data: { id: 777 } } } },
        responseReceivedAt: h.now(),
      });

      const afterResponseRestart = h.restartRuntime();
      afterResponseRestart.scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 0, 'a stored successful publication response is reused without another Feddit write');
      eq(afterResponseRestart.turnStore.get(turn.id).status, 'completed', 'post-publication finalisation resumes after restart');
      eq(h.profiles[0].activity.filter((entry) => entry.postId === 777).length, 1, 'the stored publication result is applied to local history once');
      eq(h.profiles[0].memoryState.episodes.length, 1,
        'a stored successful publication response creates one autobiographical episode');

      h.restartRuntime().scheduler.reconcileDurableTurns();
      await settle();
      eq(h.profiles[0].memoryState.episodes.length, 1,
        'post-publication finalisation replay cannot duplicate the episode');
    } finally {
      h.cleanup();
    }
  }

  {
    const voter = makeProfile('restart-safe-voter', false);
    voter.canReply = true;
    voter.canStartDiscussions = false;
    voter.postsPerHour = 0;
    voter.commentsPerHour = 1;
    voter.sched.nextPostAt = null;
    voter.sched.nextCommentAt = 0;
    const h = harness({
      profiles: [voter],
      feedPosts: [{
        id: 73, feddit: 'general', author: 'carol', title: 'A visible item',
        selftext: 'A specific public contribution worth considering.', created_utc: 9,
      }],
      voteResponse: async () => { throw new Error('connection ended before a vote response arrived'); },
    });
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile(voter.id);
      completeJob(h.queue, turn.generations[0].jobId, JSON.stringify({
        choice: 'C1',
        reason: 'The visible discussion is worth answering.',
        votes: [{ id: 'V1', direction: 'up', reason: 'The contribution is concrete and useful.' }],
      }));
      initial.reconcileDurableTurns();
      await settle();
      eq(h.writes.filter((write) => write.type === 'vote').length, 1,
        'an ambiguous live vote is attempted exactly once before restart');
      const afterAttempt = h.turnStore.get(turn.id);
      eq(afterAttempt.checkpoints['vote-effect-post:73'].state, 'uncertain',
        'the no-response vote boundary is immediately and durably marked uncertain');

      const restarted = h.restartRuntime();
      const content = await queueContentGeneration(restarted, turn.id);
      completeJob(restarted.queue, content.jobId, 'A reply that still proceeds after the ancillary vote failure.');
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.filter((write) => write.type === 'vote').length, 1,
        'restart recovery does not submit an ambiguous vote a second time');
      eq(restarted.turnStore.get(turn.id).checkpoints['vote-effect-post:73'].state, 'uncertain',
        'restart recovery records the ambiguous vote as uncertain instead of retrying');
      eq(h.writes.filter((write) => write.type === 'comment').length, 1,
        'an ambiguous ancillary vote does not block the selected main reply');
      eq(voter.voteState.considered, ['post:73'],
        'the viewed item remains considered once across durable replay');
    } finally {
      h.cleanup();
    }
  }

  {
    const social = makeProfile('social-live-bot', false);
    social.canReply = true;
    social.canStartDiscussions = false;
    social.postsPerHour = 0;
    social.commentsPerHour = 1;
    social.sched.nextPostAt = null;
    social.sched.nextCommentAt = 0;
    social.memoryState = autobiographicalMemory.recordEvent(social.memoryState, {
      id: 'seed-alice-camera',
      direction: 'incoming',
      kind: 'reply-to-bot',
      account: 'alice',
      threadKey: 't3_42',
      community: 'general',
      importance: 2,
      meaningful: true,
      summary: '@alice previously discussed repairing an analogue camera with the bot.',
    }, { nowMs: 9_000 }).state;
    const h = harness({
      profiles: [social],
      feedPosts: [{
        id: 42, feddit: 'general', author: 'alice', title: 'A real discussion',
        selftext: 'A public message worth answering.', created_utc: 9,
      }],
    });
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('social-live-bot');
      chooseFirstCandidate(h.queue, turn);
      const restarted = h.restartRuntime();
      const content = await queueContentGeneration(restarted, turn.id);
      ok(restarted.queue.get(content.jobId, true).payload.prompt.includes('RELEVANT AUTOBIOGRAPHICAL MEMORY'),
        'bounded relevant memory reaches reply generation context');
      completeJob(restarted.queue, content.jobId, 'A successful public reply.');
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.filter((write) => write.type === 'comment').length, 1,
        'the live social test publishes exactly one reply');
      eq(social.socialState.relationships.alice.outgoingCount, 1,
        'a successful public reply records one asymmetric outgoing interaction');
      eq(social.memoryState.episodes.length, 2,
        'the confirmed public reply adds one episode beside the seeded memory');

      h.restartRuntime().scheduler.reconcileDurableTurns();
      await settle();
      eq(social.socialState.relationships.alice.outgoingCount, 1,
        'durable restart finalisation cannot count the same relationship event twice');
      eq(social.memoryState.episodes.length, 2,
        'durable restart finalisation cannot count the same reply episode twice');
    } finally {
      h.cleanup();
    }
  }

  {
    const failedSocial = makeProfile('social-failed-bot', false);
    failedSocial.canReply = true;
    failedSocial.canStartDiscussions = false;
    failedSocial.postsPerHour = 0;
    failedSocial.commentsPerHour = 1;
    failedSocial.sched.nextPostAt = null;
    failedSocial.sched.nextCommentAt = 0;
    const h = harness({
      profiles: [failedSocial],
      feedPosts: [{
        id: 52, feddit: 'general', author: 'bob', title: 'Another real discussion',
        selftext: 'A public message whose reply will fail.', created_utc: 9,
      }],
      commentResponse: async () => ({ ok: false, status: 500, error: 'deliberate write failure' }),
    });
    try {
      await h.scheduler().runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('social-failed-bot');
      chooseFirstCandidate(h.queue, turn);
      const restarted = h.restartRuntime();
      const content = await queueContentGeneration(restarted, turn.id);
      completeJob(restarted.queue, content.jobId, 'A reply that will not be published.');
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(Object.keys(failedSocial.socialState.relationships).length, 0,
        'a failed public write creates no outgoing relationship event');
      eq(failedSocial.memoryState.episodes.length, 0,
        'a failed public write creates no outgoing autobiographical episode');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({ profiles: [makeProfile('missing-job-bot', true)] });
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('missing-job-bot');
      const originalJobId = turn.generations[0].jobId;
      const raw = JSON.parse(fs.readFileSync(h.queueFile, 'utf8'));
      raw.jobs = [];
      fs.writeFileSync(h.queueFile, JSON.stringify(raw, null, 2), 'utf8');
      h.queue.resetForTests();

      h.scheduler().reconcileDurableTurns();
      await settle();
      const recovered = h.turnStore.get(turn.id);
      ok(recovered.generations[0].jobId !== originalJobId, 'a genuinely missing queue job is re-enqueued');
      eq(h.queue.capacity().queued, 1, 'missing-job recovery creates exactly one replacement job');
      eq(recovered.generations[0].request.prompt.includes('real things available now'), true, 'missing-job recovery preserves the original candidate-decision request');

      const missingAgain = JSON.parse(fs.readFileSync(h.queueFile, 'utf8'));
      missingAgain.jobs = [];
      fs.writeFileSync(h.queueFile, JSON.stringify(missingAgain, null, 2), 'utf8');
      h.queue.resetForTests();
      h.scheduler().reconcileDurableTurns();
      await settle();
      const stopped = h.turnStore.get(turn.id);
      eq(stopped.status, 'failed', 'a second missing queue record stops safely instead of creating unlimited replacement work');
      eq(h.queue.capacity().queued, 0, 'no second replacement generation is queued for an inconsistent turn');
    } finally {
      h.cleanup();
    }
  }

  {
    const h = harness({ profiles: [makeProfile('failed-job-bot', true)] });
    try {
      const initial = h.scheduler();
      await initial.runTick();
      await settle();
      const turn = h.turnStore.activeForProfile('failed-job-bot');
      const claimed = h.queue.claim('worker-fail', { model: 'test-model' });
      eq(claimed.id, turn.generations[0].jobId, 'the failed test claims the logical turn job');
      h.queue.fail(claimed.id, 'worker-fail', 'deliberate terminal failure', false);

      h.scheduler().reconcileDurableTurns();
      await settle();
      const failed = h.turnStore.get(turn.id);
      eq(failed.status, 'failed', 'a terminal queue failure makes the logical turn terminal failed');
      ok(failed.error.includes('deliberate terminal failure'), 'the durable turn retains the worker failure reason');
    } finally {
      h.cleanup();
    }
  }

  {
    const profile = makeProfile('split-cadence-system-bot', true);
    profile.botOrigin = 'system';
    profile.ownerId = null;
    profile.enabled = false;
    profile.canReply = true;
    profile.commentsPerHour = 1;
    profile.populationSeed = { initiative: 'balanced', persistence: 'steady' };
    profile.populationActivity = populationActivity.initialState(profile.populationSeed, {
      nowMs: 10_000,
      quantile: 0.5,
    });
    profile.simulationState = {
      sched: {
        nextPostAt: null,
        nextCommentAt: null,
        sentPosts: [],
        sentComments: [],
        backoffUntil: 0,
      },
      populationActivity: populationActivity.rehearsalFromLive(profile.populationActivity, {
        nowMs: 10_000,
        random: () => 0.5,
      }),
    };
    const h = harness({ profiles: [profile] });
    try {
      h.scheduler().rehearsalNextAt(profile.id, h.now());
      const schedule = profile.simulationState.sched;
      const postDelay = schedule.nextPostAt - h.now();
      const commentDelay = schedule.nextCommentAt - h.now();
      ok(postDelay > commentDelay,
        'a dual-capability system bot receives a slower post clock than comment clock: ' +
        JSON.stringify({ postDelay, commentDelay, schedule }));
      ok(Math.abs(postDelay / commentDelay - 2) < 1e-9,
        'the scheduler wires one-third post and two-thirds comment shares into one ecology rate');
    } finally {
      h.cleanup();
    }
  }

  {
    const profile = makeProfile('accelerated-system-bot', true);
    profile.botOrigin = 'system';
    profile.ownerId = null;
    profile.enabled = false;
    profile.populationSeed = { initiative: 'balanced', persistence: 'steady' };
    profile.populationActivity = populationActivity.initialState(profile.populationSeed, {
      nowMs: 10_000,
      quantile: 0.5,
    });
    const h = harness({ profiles: [profile] });
    try {
      const accelerated = h.scheduler();
      const dueAt = accelerated.rehearsalNextAt(profile.id, h.now());
      ok(Number.isFinite(dueAt) && dueAt >= 0,
        'accelerated rehearsal asks the ordinary cadence stack for the next virtual opportunity');
      const virtualNowMs = Math.max(h.now(), dueAt);
      const handedOff = await accelerated.runAcceleratedRehearsalOpportunity(profile.id, {
        runId: 'bounded-run',
        virtualNowMs,
      });
      await settle();
      ok(handedOff.handedOff && handedOff.turnId,
        'accelerated rehearsal creates one durable hosted turn through the ordinary scheduler path');
      const turn = h.turnStore.get(handedOff.turnId);
      eq(turn.trigger, 'accelerated-rehearsal', 'the durable turn records its bounded rehearsal trigger');
      eq(turn.input.virtualNowMs, virtualNowMs, 'the durable turn freezes its private virtual instant');
      eq(turn.input.rehearsalRunId, 'bounded-run', 'the durable turn carries the bounded run identity');
      eq(turn.rehearsal, true, 'the accelerated durable turn remains non-publishing');
      chooseFirstCandidate(h.queue, turn);
      const content = await queueContentGeneration({
        scheduler: accelerated,
        turnStore: h.turnStore,
      }, turn.id);
      completeJob(h.queue, content.jobId, 'A simulated title\n\nA simulated body.');
      accelerated.reconcileDurableTurns();
      await settle();
      eq(h.turnStore.get(turn.id).status, 'completed', 'accelerated durable work reaches a terminal state normally');
      eq(h.writes.length, 0, 'accelerated rehearsal never crosses the LIVE Feddit write boundary');
      eq(profile.hostedOnboardingTurnsCompleted, 0,
        'synthetic accelerated work never consumes user-created onboarding priority');
      const events = profile.simulationState.telemetry.events;
      eq(events.length, 1, 'one structured observability event is recorded for the opportunity');
      eq(events[0].runId, 'bounded-run', 'structured evidence remains attached to the correct rehearsal run');
      ok(!('prompt' in events[0]) && !('reasoning' in events[0]),
        'accelerated telemetry contains no prompts or hidden reasoning');
      eq(profile.sched.nextPostAt, 0, 'accelerated cadence never mutates the LIVE scheduler state');
    } finally {
      h.cleanup();
    }
  }

  {
    const profile = makeProfile('accelerated-capacity-yield', true);
    profile.botOrigin = 'system';
    profile.ownerId = null;
    profile.enabled = false;
    profile.populationSeed = { initiative: 'balanced', persistence: 'steady' };
    profile.populationActivity = populationActivity.initialState(profile.populationSeed, {
      nowMs: 10_000,
      quantile: 0.5,
    });
    const h = harness({
      profiles: [profile],
      admitHostedTurn: () => ({
        admit: false,
        reason: 'synthetic-yields-to-shared-capacity',
      }),
    });
    try {
      const accelerated = h.scheduler();
      const dueAt = accelerated.rehearsalNextAt(profile.id, h.now());
      const result = await accelerated.runAcceleratedRehearsalOpportunity(profile.id, {
        runId: 'capacity-run',
        virtualNowMs: Math.max(h.now(), dueAt),
      });
      eq(result.skipped, 'capacity-yield',
        'accelerated rehearsal reports a capacity yield before creating durable work');
      eq(h.turnStore.listActive().length, 0,
        'a capacity yield creates no durable turn');
      eq(h.queue.capacity().queued, 0,
        'a capacity yield creates no hosted generation job');
      const events = profile.simulationState.telemetry.events;
      eq(events.length, 1,
        'capacity yield telemetry is recorded outside a durable turn scope');
      eq(events[0].runId, 'capacity-run',
        'capacity yield telemetry remains attached to the accelerated run');
      eq(events[0].outcome, 'capacity-skip',
        'capacity yield telemetry records the capacity-skip outcome');
    } finally {
      h.cleanup();
    }
  }

  {
    const profile = makeProfile('burst-bundle', false);
    profile.provider = 'ollama';
    profile.canReply = true;
    profile.canStartDiscussions = true;
    profile.postsPerHour = 0.25;
    profile.commentsPerHour = 0.5;
    profile.sched.nextPostAt = 111_111;
    profile.sched.nextCommentAt = 222_222;
    let generations = 0;
    const h = harness({
      profiles: [profile],
      feedPosts: [{
        id: 301, feddit: 'general', author: 'alice', title: 'A live discussion',
        selftext: 'A concrete thought worth answering.', created_utc: 9,
      }],
      providerGenerate: async (request) => {
        generations++;
        eq(request.providerOverride, 'chatgpt-plan',
          'Burst routes the one inference only through the explicitly selected subscription');
        return {
          provider: 'chatgpt-plan', model: 'subscription-test',
          text: JSON.stringify({
            reason: 'A reply followed by a small new discussion fits.',
            actions: [
              { candidate: 'C1', text: 'A concise reply to the existing discussion.', reason: 'It is relevant.' },
              { candidate: 'C2', title: 'A related new thought', body: 'A short opening.', reason: 'It follows naturally.' },
            ],
            votes: [],
          }),
          usage: { inputTokens: 20, outputTokens: 20, cachedInputTokens: 0 }, ms: 10,
        };
      },
    });
    try {
      const runtime = h.scheduler();
      const started = runtime.startBurstSession(profile.id, 'chatgpt-plan');
      ok(started.turnId, 'a Burst session is represented by one durable turn');
      await settle(12);
      const finished = h.turnStore.get(started.turnId);
      eq(finished.status, 'completed', 'the ordered Burst bundle reaches a durable terminal state');
      eq(generations, 1, 'the complete ordered action bundle uses exactly one model inference');
      eq(h.writes.map((write) => write.type), ['comment', 'submit'],
        'multiple selected actions execute in the model-defined order');
      eq(finished.result.actions.length, 2, 'both confirmed actions are retained in the session result');
      eq(profile.postsPerHour, 0.25, 'Burst does not mutate stored text-post cadence');
      eq(profile.commentsPerHour, 0.5, 'Burst does not mutate stored reply cadence');
      eq(profile.sched.nextPostAt, 111_111, 'Burst does not move the ordinary next-post deadline');
      eq(profile.sched.nextCommentAt, 222_222, 'Burst does not move the ordinary next-reply deadline');

      h.restartRuntime().scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.map((write) => write.type), ['comment', 'submit'],
        'terminal Burst replay cannot duplicate durable publications');
    } finally {
      h.cleanup();
    }
  }

  {
    const profile = makeProfile('burst-partial-failure', false);
    profile.canReply = true;
    profile.canStartDiscussions = true;
    const h = harness({
      profiles: [profile],
      feedPosts: [{
        id: 401, feddit: 'general', author: 'bob', title: 'A changing discussion',
        selftext: 'The first write will fail.', created_utc: 9,
      }],
      commentResponse: async () => ({ ok: false, status: 500, error: 'deliberate write failure' }),
      providerGenerate: async () => ({
        provider: 'claude-plan', model: 'subscription-test',
        text: JSON.stringify({
          reason: 'Try the reply first, then a discussion only if it succeeds.',
          actions: [
            { candidate: 'C1', text: 'This write will fail.', reason: 'Relevant reply.' },
            { candidate: 'C2', title: 'Must not run', body: 'Later assumption.', reason: 'Only after reply.' },
          ],
          votes: [],
        }),
        usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, ms: 10,
      }),
    });
    try {
      const runtime = h.scheduler();
      const started = runtime.startBurstSession(profile.id, 'claude-plan');
      await settle(12);
      const finished = h.turnStore.get(started.turnId);
      eq(finished.status, 'completed', 'a handled action failure produces a durable terminal session');
      eq(h.writes.map((write) => write.type), ['comment'],
        'a hard action failure stops later ordered actions whose assumptions may be stale');
      eq(finished.result.actions.length, 1, 'unattempted later actions are not reported as committed');
    } finally {
      h.cleanup();
    }
  }

  for (const conflicting of [false, true]) {
    const profile = makeProfile('burst-duplicate-votes-' + conflicting, false);
    profile.canReply = true;
    profile.canStartDiscussions = false;
    profile.postsPerHour = 0;
    profile.commentsPerHour = 1;
    const h = harness({
      profiles: [profile],
      feedPosts: [{
        id: 401, feddit: 'general', author: 'alice', title: 'A voteable discussion',
        selftext: 'One visible discussion for a bounded Burst reply and vote.', created_utc: 10,
      }],
      providerGenerate: async () => ({
        provider: 'claude-plan', model: 'subscription-test',
        text: JSON.stringify({
          reason: 'One reply and one secondary vote fit.',
          actions: [{ candidate: 'C1', text: 'A concise bounded reply.', reason: 'It is relevant.' }],
          votes: Array.from({ length: 20 }, (_, index) => ({
            id: 'V1', direction: 'up', reason: 'The first valid vote reason remains ' + (conflicting ? index : 0) + '.',
          })),
        }),
        usage: { inputTokens: 20, outputTokens: 20, cachedInputTokens: 0 }, ms: 10,
      }),
    });
    try {
      const runtime = h.scheduler();
      const started = runtime.startBurstSession(profile.id, 'claude-plan');
      await settle(12);
      const finished = h.turnStore.get(started.turnId);
      eq(finished.status, 'completed', 'duplicate Burst votes do not prevent durable completion');
      eq(finished.result.votes.length, 1, 'only one unique offered vote reaches the durable result');
      if (conflicting) {
        eq(finished.result.votes[0].status, 'unresolved', 'conflicting duplicate reasons remain an unresolved technical decision');
        eq(finished.result.votes[0].direction, null, 'ambiguous duplicate vote has no invented direction');
        eq(profile.voteState.considered, [], 'conflicting duplicates never suppress later opportunities');
      } else {
        eq(finished.result.votes[0].reason, 'The first valid vote reason remains 0.',
          'identical duplicates retain their original decision reason');
      }
      eq(h.writes.filter((write) => write.type === 'vote').length, conflicting ? 0 : 1,
        'duplicate IDs never produce repeated or ambiguous downstream votes');
      eq(h.writes.filter((write) => write.type === 'comment').length, 1,
        'valid independent Burst main action remains intact');
    } finally {
      h.cleanup();
    }
  }

  {
    const profile = makeProfile('burst-wait', false);
    let generations = 0;
    const h = harness({
      profiles: [profile],
      providerGenerate: async () => {
        generations++;
        return {
          provider: 'chatgpt-plan', model: 'subscription-test',
          text: '{"wait":true,"reason":"Nothing is worth doing right now.","actions":[],"votes":[]}',
          usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0 }, ms: 5,
        };
      },
    });
    try {
      const runtime = h.scheduler();
      const started = runtime.startBurstSession(profile.id, 'chatgpt-plan');
      await settle(12);
      const finished = h.turnStore.get(started.turnId);
      eq(generations, 1, 'WAIT is decided by the same single session inference');
      eq(finished.result.action, 'wait', 'WAIT remains an explicit successful no-action outcome');
      eq(h.writes.length, 0, 'WAIT creates no publication');
      eq(profile.sched.nextPostAt, 0, 'WAIT incurs no ordinary cadence debt or reschedule');
    } finally {
      h.cleanup();
    }
  }

  {
    const worldPosts = [];
    const first = makeProfile('burst-world-first', false);
    first.canReply = false;
    first.canStartDiscussions = true;
    const later = makeProfile('burst-world-later', false);
    later.canReply = true;
    later.canStartDiscussions = false;
    const h = harness({
      profiles: [first, later],
      feedPosts: () => worldPosts,
      submitResponse: async (request) => {
        worldPosts.push({
          id: 501, feddit: request.feddit, author: first.fedditUsername,
          title: request.title, selftext: request.text, created_utc: 10,
        });
        return { ok: true, status: 200, data: { post: { data: { id: 501 } } } };
      },
      providerGenerate: async (request) => ({
        provider: 'chatgpt-plan', model: 'subscription-test',
        text: request.profileId === first.id
          ? '{"reason":"Start a thread.","actions":[{"candidate":"C1","title":"Fresh shared state","body":"Visible to the next bot.","reason":"Fits."}],"votes":[]}'
          : '{"reason":"The new post is visible.","actions":[{"candidate":"C1","text":"I can see and answer this new post.","reason":"It just appeared."}],"votes":[]}',
        usage: { inputTokens: 8, outputTokens: 8, cachedInputTokens: 0 }, ms: 5,
      }),
    });
    try {
      const runtime = h.scheduler();
      const firstTurn = runtime.startBurstSession(first.id, 'chatgpt-plan');
      await settle(12);
      eq(h.turnStore.get(firstTurn.turnId).status, 'completed', 'the earlier bot commits before another session starts');
      const laterInspection = await runtime.inspectBurstCandidates();
      const laterView = laterInspection.find((entry) => entry.profileId === later.id);
      ok(laterView.candidates.some((candidate) => candidate.candidateType === 'ordinary_post'),
        'a later bot candidate scan observes the earlier bot publication from shared state');
      const laterTurn = runtime.startBurstSession(later.id, 'chatgpt-plan');
      await settle(12);
      eq(h.turnStore.get(laterTurn.turnId).status, 'completed', 'the later bot can act on refreshed shared state');
      eq(h.writes.map((write) => write.type), ['submit', 'comment'],
        'sessions remain sequential and the later action targets the refreshed world');
    } finally {
      h.cleanup();
    }
  }

  console.log('durable scheduler: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
