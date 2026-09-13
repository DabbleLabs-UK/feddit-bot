'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AGING_STEP_MS,
  DEFAULT_LEASE_MS,
  createQueue,
  effectiveScore,
} = require('../lib/job-queue');

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-queue-'));
  const file = path.join(dir, 'jobs.json');
  let current = Date.UTC(2026, 8, 12, 12, 0, 0);
  let sequence = 0;
  const queue = createQueue({
    file,
    now: () => current,
    random: () => (++sequence) / 1000,
    ...options,
  });
  return {
    queue,
    file,
    now: () => current,
    advance: (ms) => { current += ms; },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function run() {
  eq(effectiveScore({ priority: 'normal', createdAt: 1000 }, 1000), 200, 'normal base score');
  eq(
    effectiveScore({ priority: 'background', createdAt: 1000 }, 1000 + (5 * AGING_STEP_MS)),
    225,
    'waiting work gains priority',
  );

  {
    const f = fixture();
    try {
      fs.writeFileSync(f.file, JSON.stringify({
        version: 1,
        jobs: [{
          id: 'legacy-job',
          ownerKey: 'legacy-owner',
          profileId: 'legacy-profile',
          priority: 'normal',
          status: 'queued',
          createdAt: f.now(),
          notBefore: f.now(),
          attempts: 0,
          maxAttempts: 3,
          payload: { prompt: 'from version one' },
        }],
        workers: {},
        lastOwnerByPriority: { normal: 'legacy-owner' },
      }, null, 2), 'utf8');
      const migrated = createQueue({ file: f.file, now: f.now, random: () => 0.345678 });
      const claimed = migrated.claim('dell-legacy');
      eq(claimed.id, 'legacy-job', 'a queued version-one job remains claimable');
      eq(claimed.allocationClass, undefined,
        'legacy records remain byte-compatible while their user class is derived at selection time');
      eq(JSON.parse(fs.readFileSync(f.file, 'utf8')).version, 2,
        'saving a legacy queue upgrades the durable envelope version');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const first = f.queue.enqueue({ ownerKey: 'same', dedupeKey: 'operation-1', payload: { prompt: 'one' } });
      const repeated = f.queue.enqueue({ ownerKey: 'same', dedupeKey: 'operation-1', payload: { prompt: 'two' } });
      eq(repeated.id, first.id, 'an active operation is not enqueued twice');
      eq(f.queue.capacity().queued, 1, 'active deduplication leaves one queued job');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const first = f.queue.enqueue({
        ownerKey: 'restart-bot',
        profileId: 'restart-bot',
        dedupeKey: 'restart-operation',
        payload: { prompt: 'durable prompt' },
      });
      f.queue.claim('dell-1');
      f.queue.complete(first.id, 'dell-1', { text: 'durable result' });

      const restarted = createQueue({
        file: f.file,
        now: f.now,
        random: () => 0.987654,
      });
      const survived = restarted.get(first.id);
      eq(survived.status, 'completed', 'a completed DELL job survives a public-runner restart');
      eq(survived.result.text, 'durable result', 'the completed inference result remains durable');

      const repeated = restarted.enqueue({
        ownerKey: 'restart-bot',
        profileId: 'restart-bot',
        dedupeKey: 'restart-operation',
        payload: { prompt: 'durable prompt' },
      });
      ok(repeated.id !== first.id, 'raw queue deduplication remains limited to active jobs; logical turns own terminal result reuse');
      eq(repeated.status, 'queued', 'a direct raw-queue enqueue is a new job once the prior job is terminal');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture({ maxActivePerProfile: 1 });
    try {
      const first = f.queue.enqueue({ ownerKey: 'one-owner', profileId: 'one-bot', payload: { prompt: 'one' } });
      assert.throws(
        () => f.queue.enqueue({ ownerKey: 'one-owner', profileId: 'one-bot', payload: { prompt: 'two' } }),
        (err) => err && err.code === 'QUEUE_PROFILE_LIMIT',
        'one bot cannot accumulate hosted generations',
      );
      checks++;
      eq(f.queue.enqueue({ ownerKey: 'one-owner', profileId: 'another-bot' }).status, 'queued',
        'another bot owned by the same person retains its own in-flight slot');
      f.queue.claim('dell-1');
      f.queue.complete(first.id, 'dell-1', { text: 'finished' });
      eq(f.queue.enqueue({ ownerKey: 'one-owner', profileId: 'one-bot' }).status, 'queued',
        'the bot may queue again after finishing');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      f.queue.enqueue({ ownerKey: 'normal-owner', priority: 'normal', payload: { prompt: 'n' } });
      const interactive = f.queue.enqueue({ ownerKey: 'interactive-owner', priority: 'interactive', payload: { prompt: 'i' } });
      const claimed = f.queue.claim('dell-1', { model: 'local-model' });
      eq(claimed.id, interactive.id, 'interactive work is claimed before normal work');
      eq(claimed.payload.prompt, 'i', 'only a worker claim includes the inference payload');
      eq(f.queue.get(interactive.id).payload, undefined, 'ordinary job reads hide the inference payload');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      eq(f.queue.capacity().today.level, 'unavailable', 'offline worker prevents a hosted promise');
      const job = f.queue.enqueue({ ownerKey: 'history', priority: 'normal' });
      f.queue.claim('dell-1');
      f.advance(2 * 60 * 1000);
      f.queue.complete(job.id, 'dell-1', { text: 'finished' });
      f.advance(25 * 60 * 60 * 1000);
      f.queue.heartbeat('dell-1', { model: 'local-model' });
      const capacity = f.queue.capacity();
      eq(capacity.today.level, 'good', 'observed same-day completions produce a good evidence label');
      eq(capacity.likelihood.scheduledBotWithinDay.fraction, 1, 'scheduled likelihood uses normal-priority history');
      ok(capacity.today.text.includes('early estimate'), 'small samples are labelled as early evidence');
      ok(capacity.desktopAlternative.includes('all but instant'), 'capacity always presents the desktop alternative');
      ok(!capacity.desktopAlternative.includes('Finishing still depends'), 'desktop comparison does not end with a vague qualification');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      eq(f.queue.capacity().current.state, 'offline', 'current capacity starts with an explicit offline state');
      f.queue.heartbeat('dell-1', { model: 'local-model' });
      eq(f.queue.capacity().current.state, 'ready', 'an online worker with an empty queue is explicitly ready');
      const job = f.queue.enqueue({
        profileId: 'visible-bot',
        priority: 'interactive',
        activityAction: 'writing an article title',
      });
      eq(f.queue.capacity().current.state, 'waiting', 'queued work has an explicit waiting state');
      eq(job.waitingPosition, 1, 'a queued job reports its current waiting position');
      eq(job.waitingTotal, 1, 'a queued job reports the waiting queue size');
      eq(f.queue.activeForProfile('visible-bot').activityAction, 'writing an article title', 'the dashboard can explain the active work');
      f.advance(15 * 1000);
      f.queue.claim('dell-1');
      const running = f.queue.activeForProfile('visible-bot');
      eq(running.status, 'claimed', 'profile work reports when DELL has claimed it');
      eq(running.runningMs, 0, 'the running timer begins at claim time');
      eq(f.queue.capacity().current.state, 'working', 'claimed work has an explicit working state');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const first = f.queue.enqueue({ ownerKey: 'owner-a', priority: 'normal' });
      f.queue.enqueue({ ownerKey: 'owner-a', priority: 'normal' });
      const other = f.queue.enqueue({ ownerKey: 'owner-b', priority: 'normal' });
      eq(f.queue.claim('dell-1').id, first.id, 'oldest owner gets the first equal-priority turn');
      f.queue.complete(first.id, 'dell-1', { text: 'one' });
      eq(f.queue.activeForProfile(null), null, 'profile lookup requires a real profile id');
      eq(f.queue.get(other.id).waitingPosition, 1, 'reported queue place follows the same round-robin order as claims');
      eq(f.queue.claim('dell-1').id, other.id, 'round-robin fairness gives another owner the next turn');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      f.queue.enqueue({ ownerKey: 'patient', priority: 'background' });
      f.advance(5 * 60 * 60 * 1000);
      const interactive = f.queue.enqueue({ ownerKey: 'new', priority: 'interactive' });
      eq(f.queue.claim('dell-1').id, interactive.id,
        'aging cannot let old synthetic work cross the interactive class boundary');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const synthetic = f.queue.enqueue({
        ownerKey: 'system-population',
        profileId: 'synthetic-a',
        priority: 'normal',
        allocationClass: 'synthetic',
      });
      f.advance(48 * 60 * 60 * 1000);
      const user = f.queue.enqueue({
        ownerKey: 'human-owner',
        profileId: 'user-a',
        priority: 'normal',
        allocationClass: 'user',
      });
      eq(f.queue.claim('dell-1').id, user.id,
        'established user-created work outranks even very old synthetic work');
      eq(f.queue.get(synthetic.id).allocationClass, 'synthetic',
        'explicit system allocation class persists in the durable queue');
      eq(f.queue.capacity().byAllocationClass.synthetic, 1,
        'capacity reports aggregate system-population waiting work');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      f.queue.enqueue({
        ownerKey: 'owner-a', profileId: 'established', allocationClass: 'user', onboarding: false,
      });
      const newcomer = f.queue.enqueue({
        ownerKey: 'owner-a', profileId: 'newcomer', allocationClass: 'user', onboarding: true,
      });
      eq(f.queue.claim('dell-1').id, newcomer.id,
        'new-bot onboarding wins within the same owner fair share');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const firstProfile = f.queue.enqueue({
        ownerKey: 'one-human', profileId: 'profile-a', allocationClass: 'user',
      });
      const secondProfile = f.queue.enqueue({
        ownerKey: 'one-human', profileId: 'profile-b', allocationClass: 'user',
      });
      eq(f.queue.claim('dell-1').id, firstProfile.id, 'one owner starts with its oldest profile');
      f.queue.complete(firstProfile.id, 'dell-1', { text: 'done' });
      eq(f.queue.claim('dell-1').id, secondProfile.id,
        'profile-level rotation gives another bot of the same owner progress');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const ownerAFirst = f.queue.enqueue({
        ownerKey: 'owner-a', profileId: 'a-new-1', allocationClass: 'user', onboarding: true,
      });
      f.queue.enqueue({
        ownerKey: 'owner-a', profileId: 'a-new-2', allocationClass: 'user', onboarding: true,
      });
      const ownerB = f.queue.enqueue({
        ownerKey: 'owner-b', profileId: 'b-established', allocationClass: 'user', onboarding: false,
      });
      eq(f.queue.claim('dell-1').id, ownerAFirst.id, 'the oldest owner receives the first user turn');
      f.queue.complete(ownerAFirst.id, 'dell-1', { text: 'done' });
      eq(f.queue.claim('dell-1').id, ownerB.id,
        'many onboarding bots do not let one owner take another owner\'s next fair share');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const job = f.queue.enqueue({ ownerKey: 'lease-test' });
      f.queue.claim('dell-1');
      f.advance(DEFAULT_LEASE_MS - 1000);
      f.queue.renew(job.id, 'dell-1');
      f.advance(2000);
      eq(f.queue.claim('dell-2'), null, 'renewed work cannot be claimed by another worker');
      f.advance(DEFAULT_LEASE_MS);
      eq(f.queue.claim('dell-2').id, job.id, 'expired work returns safely to the queue');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const job = f.queue.enqueue({ ownerKey: 'retry-test', maxAttempts: 2 });
      f.queue.claim('dell-1');
      eq(f.queue.fail(job.id, 'dell-1', 'temporary', true).status, 'queued', 'retryable failure is requeued');
      f.advance(31 * 1000);
      f.queue.claim('dell-1');
      eq(f.queue.fail(job.id, 'dell-1', 'again', true).status, 'failed', 'max attempts makes failure terminal');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const job = f.queue.enqueue({ ownerKey: 'history' });
      f.queue.claim('dell-1', { model: 'local-model' });
      f.advance(2 * 60 * 1000);
      f.queue.complete(job.id, 'dell-1', { text: 'finished' });
      f.advance(2 * 60 * 60 * 1000);
      f.queue.heartbeat('dell-1', { model: 'local-model' });
      const capacity = f.queue.capacity();
      eq(capacity.online, true, 'recent heartbeat marks the pool online');
      eq(capacity.medianServiceMs, 2 * 60 * 1000, 'capacity uses observed generation time');
      eq(capacity.likelihood.withinHour, { observed: 1, total: 1, fraction: 1 }, 'likelihood is historical evidence');
      eq(capacity.likelihood.withinSixHours.fraction, null, 'insufficient history is reported, not guessed');
      ok(capacity.today.text.includes('reliability'), 'unknown history is described as reliability evidence, not current availability');
      ok(capacity.desktopAlternative.includes('all but instant'), 'capacity always includes the desktop alternative');
    } finally {
      f.cleanup();
    }
  }

  console.log('job queue: ' + checks + ' checks passed');
}

run();
