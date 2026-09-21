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
    commentsPerHour: 0,
    postFeddits: ['general'],
    readFeddits: ['general'],
    communityMode: 'home',
    probation: { onProbation: false, checkedAt: 1 },
    sched: {
      nextPostAt: 0,
      nextCommentAt: null,
      sentPosts: [],
      sentComments: [],
      backoffUntil: 0,
    },
    activity: [],
    repliedTo: [],
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
    generate: async () => { throw new Error('scheduled DELL turns must not use the blocking provider path'); },
    ollamaBusy: () => false,
  };
  const writes = [];
  const logs = [];
  const feddit = {
    submit: async (request) => {
      writes.push({ type: 'submit', request });
      return { ok: true, status: 200, data: { post: { data: { id: 900 + writes.length } } } };
    },
    comment: async (request) => {
      writes.push({ type: 'comment', request });
      if (options.commentResponse) return options.commentResponse(request);
      return { ok: true, status: 200, data: { comment: { data: { id: 1000 + writes.length } } } };
    },
    attention: async () => ({
      ok: true, status: 200,
      data: { cursor: { comments: 0, posts: 0 }, has_more: false, events: [] },
    }),
    feddit: async () => ({
      ok: true, status: 200,
      data: { data: { children: Array.isArray(options.feedPosts) ? options.feedPosts.map((post) => ({ data: post })) : [] } },
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
      generate: async () => { throw new Error('scheduled DELL turns must not use the blocking provider path'); },
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

async function run() {
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

  console.log('durable scheduler: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
