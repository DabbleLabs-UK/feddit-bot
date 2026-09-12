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

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-queue-'));
  let current = Date.UTC(2026, 8, 12, 12, 0, 0);
  let sequence = 0;
  const queue = createQueue({
    file: path.join(dir, 'jobs.json'),
    now: () => current,
    random: () => (++sequence) / 1000,
  });
  return {
    queue,
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
      eq(f.queue.claim('dell-1').id, other.id, 'round-robin fairness gives another owner the next turn');
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const background = f.queue.enqueue({ ownerKey: 'patient', priority: 'background' });
      f.advance(5 * 60 * 60 * 1000);
      f.queue.enqueue({ ownerKey: 'new', priority: 'interactive' });
      eq(f.queue.claim('dell-1').id, background.id, 'aging eventually prevents background starvation');
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
      ok(capacity.desktopAlternative.includes('all but instant'), 'capacity always includes the desktop alternative');
    } finally {
      f.cleanup();
    }
  }

  console.log('job queue: ' + checks + ' checks passed');
}

run();
