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
      return { ok: true, status: 200, data: {} };
    },
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
      await h.scheduler().runTick();
      await settle();
      eq(h.queue.capacity().queued, 1,
        'repeated scheduler ticks cannot build a synthetic backlog while admission is closed');
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
      const jobId = turn.generations[0].jobId;
      completeJob(h.queue, jobId, 'A durable title\n\nA durable body.');

      h.profiles[0].dryRun = false;
      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      const finished = restarted.turnStore.get(turn.id);
      eq(finished.status, 'completed', 'a completed queue result resumes and completes after scheduler recreation');
      eq(h.writes.length, 0, 'the turn keeps its frozen rehearsal mode even if the profile changes after restart');
      eq(queueJobs(h.queueFile).length, 1, 'the completed generation is reused rather than regenerated');
      eq(h.profiles[0].activity.filter((entry) => entry.dryRun).length, 1, 'post-generation rehearsal handling runs once');
      eq(h.profiles[0].hostedOnboardingTurnsCompleted, 1,
        'one useful completed scheduled DELL turn consumes one onboarding opportunity');

      const anotherRestart = h.restartRuntime();
      anotherRestart.scheduler.reconcileDurableTurns();
      await settle();
      eq(queueJobs(h.queueFile).length, 1, 'a terminal turn remains terminal across another restart');
      eq(h.profiles[0].activity.filter((entry) => entry.dryRun).length, 1, 'terminal reconciliation does not duplicate activity');
      eq(h.profiles[0].hostedOnboardingTurnsCompleted, 1,
        'restart reconciliation never consumes the same onboarding opportunity twice');
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
      completeJob(h.queue, turn.generations[0].jobId, 'Live durable title\n\nLive durable body.');

      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 1, 'a live durable turn publishes once after its result arrives');
      eq(restarted.turnStore.get(turn.id).status, 'completed', 'the live turn reaches a terminal completed state');

      h.restartRuntime().scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 1, 'a completed live turn is never published again after restart');
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
      completeJob(h.queue, turn.generations[0].jobId, 'Uncertain title\n\nUncertain body.');
      h.turnStore.publication(turn.id, { state: 'attempting', attemptingAt: h.now() });

      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 0, 'an interrupted publication boundary is not retried after restart');
      eq(restarted.turnStore.get(turn.id).status, 'publication-uncertain', 'the residual no-idempotency edge is explicit and terminal');
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
      completeJob(h.queue, turn.generations[0].jobId, 'Network boundary title\n\nNetwork boundary body.');

      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 1, 'a live write is attempted once when Feddit never returns a response');
      eq(restarted.turnStore.get(turn.id).status, 'publication-uncertain', 'a missing Feddit response records the publication boundary as uncertain');

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
      completeJob(h.queue, turn.generations[0].jobId, 'Saved response title\n\nSaved response body.');
      h.turnStore.publication(turn.id, {
        kind: 'post',
        state: 'response-received',
        response: { ok: true, status: 200, data: { post: { data: { id: 777 } } } },
        responseReceivedAt: h.now(),
      });

      const restarted = h.restartRuntime();
      restarted.scheduler.reconcileDurableTurns();
      await settle();
      eq(h.writes.length, 0, 'a stored successful publication response is reused without another Feddit write');
      eq(restarted.turnStore.get(turn.id).status, 'completed', 'post-publication finalisation resumes after restart');
      eq(h.profiles[0].activity.filter((entry) => entry.postId === 777).length, 1, 'the stored publication result is applied to local history once');
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
      eq(recovered.generations[0].request.prompt.includes('posting a NEW thread'), true, 'missing-job recovery preserves the original generation request');

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

  console.log('durable scheduler: ' + checks + ' checks passed');
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
