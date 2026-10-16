'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQueue, DEFAULT_LEASE_MS } = require('../lib/job-queue');

let checks = 0;
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks++;
}
function ok(value, message) {
  assert.ok(value, message);
  checks++;
}
function rejects(action, message) {
  assert.throws(action, undefined, message);
  checks++;
}
function request(number, extra = {}) {
  return { claimRequestId: 'c_' + number.toString(16).padStart(32, '0'), includeQueueMetadata: false, ...extra };
}
function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-claim-protocol-'));
  const file = path.join(dir, 'jobs.json');
  let at = Date.UTC(2026, 9, 16);
  let sequence = 0;
  const options = { file, now: () => at, random: () => (++sequence) / 1000 };
  try {
    run({
      queue: createQueue(options),
      restart: () => createQueue(options),
      advance: (ms) => { at += ms; },
      stored: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

fixture(({ queue, restart, stored }) => {
  const first = queue.enqueue({ ownerKey: 'first', payload: { prompt: 'private first' } });
  queue.enqueue({ ownerKey: 'second' });
  const claim = queue.claim('worker', request(1));
  eq(claim.id, first.id, 'first request claims the expected job');
  eq(claim.leaseProtocolVersion, 2, 'new protocol freezes its lease contract');
  ok(/^l_[a-f0-9]{32}$/.test(claim.leaseToken), 'lease fence is an opaque random token');
  eq(claim.waitingPosition, undefined, 'worker claim omits expensive queue metadata');
  eq(claim.payload.prompt, 'private first', 'minimal claim still carries the complete payload');
  const sequence = stored().serviceSequence;
  queue.heartbeat('worker', { model: 'verified-model' });
  const reloaded = restart();
  const repeated = reloaded.claim('worker', request(1));
  eq(repeated.id, claim.id, 'lost claim response can be recovered after runner restart');
  eq(repeated.leaseToken, claim.leaseToken, 'claim response replay retains the same fence');
  eq(repeated.attempts, 1, 'claim response replay never creates another inference attempt');
  eq(stored().serviceSequence, sequence, 'claim response replay never consumes fairness again');
  eq(stored().workers.worker.claimReceipt.requestId, request(1).claimRequestId,
    'ordinary heartbeat preserves the durable latest claim receipt');
  eq(reloaded.claim('worker', request(2)), null, 'a fresh request cannot overlap the worker held job');
  eq(reloaded.get(claim.id).attempts, 1, 'blocked overlap does not change existing ownership');
  reloaded.complete(claim.id, 'worker', { text: 'done' }, claim.leaseToken);
  eq(reloaded.claim('worker', request(2)), null, 'the blocked request remains a no-job receipt after completion');
  ok(reloaded.claim('worker', request(3)), 'a genuinely new request may claim the next job');
});

fixture(({ queue, restart, stored, advance }) => {
  const job = queue.enqueue({});
  const claim = queue.claim('worker', request(1));
  const lease = claim.leaseToken;
  rejects(() => queue.renew(job.id, 'worker'), 'v2 renew requires a fence');
  rejects(() => queue.complete(job.id, 'worker', {}), 'v2 completion requires a fence');
  rejects(() => queue.fail(job.id, 'worker', 'bad'), 'v2 failure requires a fence');
  rejects(() => queue.renew(job.id, 'other', DEFAULT_LEASE_MS, lease), 'fence does not replace worker ownership');
  advance(1000);
  const renewed = queue.renew(job.id, 'worker', DEFAULT_LEASE_MS, lease);
  eq(renewed.waitingTotal, undefined, 'lease ACK does not sort unrelated waiting jobs');
  eq(stored().workers.worker.claimReceipt.leaseToken, lease, 'renew heartbeat preserves claim receipt');
  const result = { text: 'result', usage: { output: 12, input: 20 } };
  const completed = queue.complete(job.id, 'worker', result, lease);
  eq(completed.status, 'completed', 'fenced completion persists the result');
  const finishedAt = completed.finishedAt;
  advance(DEFAULT_LEASE_MS);
  const reloaded = restart();
  eq(reloaded.complete(job.id, 'worker', { usage: { input: 20, output: 12 }, text: 'result' }, lease).finishedAt,
    finishedAt, 'lost completion ACK is idempotent across restart and key order');
  eq(reloaded.get(job.id).result, result, 'completion ACK never overwrites the durable result');
  rejects(() => reloaded.complete(job.id, 'worker', { text: 'different' }, lease),
    'conflicting completion cannot replace a committed result');
  rejects(() => reloaded.complete(job.id, 'other', result, lease), 'another worker cannot acknowledge the result');
  rejects(() => reloaded.complete(job.id, 'worker', result, 'l_' + 'f'.repeat(32)),
    'another attempt cannot acknowledge the result');
  eq(reloaded.claim('worker', request(1)), null, 'terminal receipt never allocates another job');
  eq(reloaded.peekStatus(job.id), 'completed', 'cheap scalar status reports a completed job');
  eq(reloaded.peekStatus('missing'), null, 'cheap scalar status reports missing jobs');
});

fixture(({ queue, restart, advance, stored }) => {
  const job = queue.enqueue({ maxAttempts: 3 });
  const first = queue.claim('worker', request(1));
  advance(DEFAULT_LEASE_MS);
  rejects(() => queue.renew(job.id, 'worker', DEFAULT_LEASE_MS, first.leaseToken),
    'an expired v2 lease cannot be resurrected by a late renew');
  rejects(() => queue.complete(job.id, 'worker', {}, first.leaseToken),
    'an expired v2 lease cannot complete before recovery');
  eq(queue.claim('worker', request(1)), null, 'an expired response receipt does not silently reclaim work');
  eq(queue.get(job.id).attempts, 1, 'receipt recovery never increments attempts');
  eq(queue.claim('legacy-worker'), null, 'token-required jobs are not handed to legacy workers');
  const second = queue.claim('worker', request(2));
  eq(second.id, job.id, 'an explicit new request may reclaim expired work');
  eq(second.attempts, 2, 'only actual re-admission increments attempts');
  ok(second.leaseToken !== first.leaseToken, 're-admission rotates the token even for the same worker');
  for (const action of [
    () => queue.renew(job.id, 'worker', DEFAULT_LEASE_MS, first.leaseToken),
    () => queue.complete(job.id, 'worker', {}, first.leaseToken),
    () => queue.fail(job.id, 'worker', 'late failure', true, first.leaseToken),
  ]) rejects(action, 'stale same-worker attempts cannot alter a newer lease');
  eq(stored().jobs[0].leaseToken, second.leaseToken, 'rejected stale writes retain the newer fence');
  const failed = queue.fail(job.id, 'worker', 'bounded failure', true, second.leaseToken);
  eq(failed.status, 'queued', 'fenced retryable failure retains existing queue backoff semantics');
  const notBefore = failed.notBefore;
  advance(1000);
  const reloaded = restart();
  eq(reloaded.fail(job.id, 'worker', 'bounded failure', true, second.leaseToken).notBefore,
    notBefore, 'lost failure ACK does not move the retry deadline');
  rejects(() => reloaded.fail(job.id, 'worker', 'changed failure', true, second.leaseToken),
    'failure receipt rejects changed outcomes');
  rejects(() => reloaded.fail(job.id, 'worker', 'bounded failure', false, second.leaseToken),
    'failure receipt rejects changed retry disposition');
  eq(reloaded.claim('worker', request(2)), null, 'failed claim receipt never re-admits inference');
  advance(61000);
  const third = reloaded.claim('worker', request(3));
  rejects(() => reloaded.fail(job.id, 'worker', 'bounded failure', true, second.leaseToken),
    'an acknowledged old failure cannot alter a reclaimed job');
  const terminal = reloaded.fail(job.id, 'worker', 'final failure', false, third.leaseToken);
  eq(terminal.status, 'failed', 'non-retryable v2 failure is terminal');
  eq(reloaded.fail(job.id, 'worker', 'final failure', false, third.leaseToken).finishedAt,
    terminal.finishedAt, 'terminal failure ACK is idempotent');
});

fixture(({ queue, restart }) => {
  eq(queue.claim('worker', request(1)), null, 'an empty poll persists a no-job receipt');
  const queued = queue.enqueue({});
  eq(restart().claim('worker', request(1)), null, 'a replayed empty poll never claims newly arrived work');
  const claim = queue.claim('worker', request(2));
  eq(claim.id, queued.id, 'next explicit poll may admit newly arrived work');
  for (const value of [null, '', 'c_short', 'c_' + 'A'.repeat(32), 4, {}]) {
    rejects(() => queue.claim('worker', { claimRequestId: value }), 'claim request ID is strictly validated');
  }
});

fixture(({ queue, advance }) => {
  const job = queue.enqueue({});
  const first = queue.claim('first-worker', request(1));
  advance(DEFAULT_LEASE_MS);
  const next = queue.claim('second-worker', request(2));
  eq(next.id, job.id, 'another v2 worker may recover an expired lease');
  eq(queue.claim('first-worker', request(1)), null, 'a reassigned receipt never leaks the new worker lease');
  rejects(() => queue.complete(job.id, 'first-worker', {}, first.leaseToken),
    'the old worker cannot complete reassigned work');
  eq(queue.get(job.id).workerId, 'second-worker', 'rejected stale work preserves the new owner');
});

fixture(({ queue }) => {
  const first = queue.enqueue({ ownerKey: 'first' });
  const claim = queue.claim('legacy-worker');
  eq(claim.id, first.id, 'legacy claim remains supported');
  eq(claim.leaseProtocolVersion, undefined, 'legacy-only claim does not change its frozen contract');
  eq(claim.leaseToken, undefined, 'legacy-only claim requires no new fence');
  eq(claim.waitingTotal, 0, 'legacy claim preserves queue metadata by default');
  eq(queue.renew(first.id, 'legacy-worker').status, 'claimed', 'legacy renew still accepts the old signature');
  eq(queue.complete(first.id, 'legacy-worker', { text: 'legacy' }).status, 'completed',
    'legacy completion still accepts the old signature');
  rejects(() => queue.complete(first.id, 'legacy-worker', { text: 'legacy' }),
    'legacy completion semantics are not silently reinterpreted');
});

fixture(({ queue }) => {
  for (let index = 0; index < 8; index++) queue.enqueue({ ownerKey: 'owner-' + index });
  const original = global.structuredClone;
  global.structuredClone = (value) => {
    assert.ok(!Array.isArray(value && value.jobs), 'worker ACK never clones the entire queue to calculate position');
    return original(value);
  };
  try {
    const job = queue.claim('worker', request(1));
    queue.renew(job.id, 'worker', DEFAULT_LEASE_MS, job.leaseToken);
    eq(queue.peekStatus(job.id), 'claimed', 'scalar polling skips queue-position simulation');
    queue.complete(job.id, 'worker', { text: 'complete' }, job.leaseToken);
    checks++;
  } finally {
    global.structuredClone = original;
  }
});

console.log('job queue claim protocol: ' + checks + ' checks passed');
