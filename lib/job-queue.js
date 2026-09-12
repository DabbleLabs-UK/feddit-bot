'use strict';

// Durable pull queue for shared inference. The public runner owns this file;
// DELL makes authenticated outbound requests to claim work, so no DELL port is
// exposed. Priority describes the human need, not the originating application:
// previews/first outputs/postcards are interactive, scheduled Feddit work is
// normal, and ambient Cy work is background. Aging prevents starvation.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const PRIORITY = { background: 100, normal: 200, interactive: 300 };
const AGING_STEP_MS = 30 * 60 * 1000;
const AGING_POINTS = 25;
const AGING_CAP = 225;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const WORKER_ONLINE_MS = 90 * 1000;
const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_CAP = 1000;

function cleanPriority(value) {
  return Object.prototype.hasOwnProperty.call(PRIORITY, value) ? value : 'normal';
}

function effectiveScore(job, at) {
  const age = Math.max(0, at - Number(job.createdAt || at));
  const aging = Math.min(AGING_CAP, Math.floor(age / AGING_STEP_MS) * AGING_POINTS);
  return PRIORITY[cleanPriority(job.priority)] + aging;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[idx];
}

function createQueue(options = {}) {
  const file = path.resolve(options.file || path.join(__dirname, '..', 'data', 'jobs.json'));
  const now = options.now || Date.now;
  const random = options.random || null;
  let cache = null;

  function empty() {
    return { version: VERSION, jobs: [], workers: {}, lastOwnerByPriority: {} };
  }

  function ensureDir() {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = {
        ...empty(),
        ...(parsed && typeof parsed === 'object' ? parsed : {}),
        jobs: Array.isArray(parsed && parsed.jobs) ? parsed.jobs : [],
        workers: parsed && parsed.workers && typeof parsed.workers === 'object' ? parsed.workers : {},
        lastOwnerByPriority: parsed && parsed.lastOwnerByPriority && typeof parsed.lastOwnerByPriority === 'object'
          ? parsed.lastOwnerByPriority
          : {},
      };
    } catch (err) {
      if (err && err.code === 'ENOENT') cache = empty();
      else throw new Error('Failed to read inference queue: ' + err.message);
    }
    recoverExpired(cache);
    return cache;
  }

  function save(data) {
    ensureDir();
    prune(data);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    cache = data;
  }

  function newId() {
    if (random) return 'j_' + now().toString(36) + random().toString(36).slice(2, 10);
    return 'j_' + crypto.randomBytes(16).toString('hex');
  }

  function recoverExpired(data) {
    const at = now();
    let changed = false;
    for (const job of data.jobs) {
      if (job.status !== 'claimed' || Number(job.leaseUntil || 0) > at) continue;
      job.status = 'queued';
      job.workerId = null;
      job.leaseUntil = null;
      job.lastError = 'Worker lease expired; returned to the queue.';
      changed = true;
    }
    if (changed) save(data);
  }

  function prune(data) {
    const active = data.jobs.filter((job) => job.status === 'queued' || job.status === 'claimed');
    const terminal = data.jobs
      .filter((job) => job.status !== 'queued' && job.status !== 'claimed')
      .sort((a, b) => Number(b.finishedAt || 0) - Number(a.finishedAt || 0))
      .slice(0, TERMINAL_CAP);
    data.jobs = active.concat(terminal);
  }

  function enqueue(input = {}) {
    const data = load();
    const at = now();
    const dedupeKey = String(input.dedupeKey || '').slice(0, 200);
    if (dedupeKey) {
      const existing = data.jobs.find((item) =>
        item.dedupeKey === dedupeKey && (item.status === 'queued' || item.status === 'claimed'));
      if (existing) return publicJob(existing, true);
    }
    const job = {
      id: newId(),
      source: String(input.source || 'feddit'),
      kind: String(input.kind || 'generation'),
      ownerKey: String(input.ownerKey || input.profileId || 'anonymous'),
      profileId: input.profileId ? String(input.profileId) : null,
      dedupeKey: dedupeKey || null,
      priority: cleanPriority(input.priority),
      status: 'queued',
      createdAt: at,
      notBefore: Math.max(at, Number(input.notBefore) || at),
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(10, Number(input.maxAttempts) || 3)),
      payload: structuredClone(input.payload || {}),
      workerId: null,
      leaseUntil: null,
      startedAt: null,
      finishedAt: null,
      result: null,
      lastError: null,
    };
    data.jobs.push(job);
    save(data);
    return publicJob(job, true);
  }

  function heartbeat(workerId, details = {}) {
    const id = String(workerId || '').trim();
    if (!id) throw new Error('workerId is required');
    const data = load();
    data.workers[id] = {
      id,
      lastSeenAt: now(),
      model: String(details.model || ''),
      busy: details.busy === true,
      version: String(details.version || ''),
    };
    save(data);
    return data.workers[id];
  }

  function claim(workerId, details = {}) {
    const id = String(workerId || '').trim();
    if (!id) throw new Error('workerId is required');
    const data = load();
    recoverExpired(data);
    heartbeatInData(data, id, details);
    const at = now();
    const available = data.jobs.filter((job) => job.status === 'queued' && Number(job.notBefore || 0) <= at);
    available.sort((a, b) => effectiveScore(b, at) - effectiveScore(a, at) || Number(a.createdAt) - Number(b.createdAt));
    if (!available.length) {
      save(data);
      return null;
    }

    const topScore = effectiveScore(available[0], at);
    const top = available.filter((job) => effectiveScore(job, at) === topScore);
    const band = cleanPriority(top[0].priority);
    const lastOwner = data.lastOwnerByPriority[band];
    const job = top.find((item) => item.ownerKey !== lastOwner) || top[0];
    job.status = 'claimed';
    job.workerId = id;
    job.attempts = Number(job.attempts || 0) + 1;
    job.startedAt = job.startedAt || at;
    job.claimedAt = at;
    job.leaseUntil = at + (Number(details.leaseMs) || DEFAULT_LEASE_MS);
    data.lastOwnerByPriority[band] = job.ownerKey;
    save(data);
    return publicJob(job, true);
  }

  function heartbeatInData(data, workerId, details) {
    data.workers[workerId] = {
      id: workerId,
      lastSeenAt: now(),
      model: String(details.model || ''),
      busy: details.busy === true,
      version: String(details.version || ''),
    };
  }

  function renew(jobId, workerId, leaseMs = DEFAULT_LEASE_MS) {
    const data = load();
    const job = requireClaim(data, String(jobId), String(workerId));
    job.leaseUntil = now() + Math.max(30 * 1000, Number(leaseMs) || DEFAULT_LEASE_MS);
    heartbeatInData(data, String(workerId), { busy: true });
    save(data);
    return publicJob(job, false);
  }

  function requireClaim(data, jobId, workerId) {
    const job = data.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error('No such inference job.');
    if (job.status !== 'claimed' || job.workerId !== workerId) {
      throw new Error('This worker does not hold the job lease.');
    }
    return job;
  }

  function complete(jobId, workerId, result) {
    const data = load();
    const job = requireClaim(data, String(jobId), String(workerId));
    job.status = 'completed';
    job.result = structuredClone(result || {});
    job.finishedAt = now();
    job.leaseUntil = null;
    save(data);
    return publicJob(job, false);
  }

  function fail(jobId, workerId, message, retryable = true) {
    const data = load();
    const job = requireClaim(data, String(jobId), String(workerId));
    job.lastError = String(message || 'Worker failed the job.');
    job.workerId = null;
    job.leaseUntil = null;
    if (retryable && job.attempts < job.maxAttempts) {
      job.status = 'queued';
      job.notBefore = now() + Math.min(5 * 60 * 1000, job.attempts * 30 * 1000);
    } else {
      job.status = 'failed';
      job.finishedAt = now();
    }
    save(data);
    return publicJob(job, false);
  }

  function get(jobId, includePayload = false) {
    const job = load().jobs.find((item) => item.id === String(jobId));
    return job ? publicJob(job, includePayload) : null;
  }

  function publicJob(job, includePayload) {
    const out = { ...job };
    if (!includePayload) delete out.payload;
    return structuredClone(out);
  }

  function probabilityWithin(data, horizonMs, priority = null) {
    const at = now();
    const eligible = data.jobs.filter((job) => {
      const createdAt = Number(job.createdAt || 0);
      return createdAt >= at - HISTORY_MS
        && createdAt <= at - horizonMs
        && (priority == null || cleanPriority(job.priority) === priority);
    });
    if (!eligible.length) return { observed: 0, total: 0, fraction: null };
    const observed = eligible.filter((job) => job.status === 'completed' && Number(job.finishedAt) - Number(job.createdAt) <= horizonMs).length;
    return { observed, total: eligible.length, fraction: observed / eligible.length };
  }

  function likelihoodText(observation, online) {
    if (!online) {
      return {
        level: 'unavailable',
        text: 'DELL is not currently checking in, so no hosted turn can be promised.',
      };
    }
    if (observation.fraction == null) {
      return {
        level: 'unknown',
        text: 'There is not enough recent history yet to estimate the chance of a hosted turn today.',
      };
    }
    const early = observation.total < 5 ? ' This is an early estimate from only ' + observation.total + ' eligible job(s).' : '';
    if (observation.fraction >= 0.8) {
      return { level: 'good', text: 'Recent history suggests a good chance of a hosted turn today.' + early };
    }
    if (observation.fraction >= 0.5) {
      return { level: 'mixed', text: 'Recent history suggests a roughly even chance of a hosted turn today.' + early };
    }
    return { level: 'low', text: 'Recent history suggests a low chance of a hosted turn today.' + early };
  }

  function capacity() {
    const data = load();
    const at = now();
    const workers = Object.values(data.workers || {});
    const online = workers.filter((worker) => at - Number(worker.lastSeenAt || 0) <= WORKER_ONLINE_MS);
    const queued = data.jobs.filter((job) => job.status === 'queued');
    const claimed = data.jobs.filter((job) => job.status === 'claimed');
    const recentCompleted = data.jobs.filter((job) => job.status === 'completed' && at - Number(job.finishedAt || 0) <= HISTORY_MS);
    const serviceTimes = recentCompleted
      .map((job) => Number(job.finishedAt || 0) - Number(job.claimedAt || job.startedAt || 0))
      .filter((ms) => ms > 0);
    const medianServiceMs = percentile(serviceTimes, 0.5);
    const workerCount = Math.max(1, online.length);
    const estimatedWaitMs = online.length && medianServiceMs != null
      ? Math.max(0, Math.ceil((queued.length + claimed.length) / workerCount) * medianServiceMs)
      : null;
    const scheduledWithinDay = probabilityWithin(data, 24 * 60 * 60 * 1000, 'normal');
    return {
      online: online.length > 0,
      onlineWorkers: online.length,
      lastWorkerSeenAt: workers.length ? Math.max(...workers.map((worker) => Number(worker.lastSeenAt || 0))) : null,
      queued: queued.length,
      running: claimed.length,
      byPriority: {
        interactive: queued.filter((job) => job.priority === 'interactive').length,
        normal: queued.filter((job) => job.priority === 'normal').length,
        background: queued.filter((job) => job.priority === 'background').length,
      },
      completedLastSevenDays: recentCompleted.length,
      medianServiceMs,
      estimatedWaitMs,
      likelihood: {
        withinHour: probabilityWithin(data, 60 * 60 * 1000),
        withinSixHours: probabilityWithin(data, 6 * 60 * 60 * 1000),
        withinDay: probabilityWithin(data, 24 * 60 * 60 * 1000),
        scheduledBotWithinDay: scheduledWithinDay,
      },
      today: likelihoodText(scheduledWithinDay, online.length > 0),
      evidenceWindowDays: 7,
      priorityPolicy: {
        interactive: 'Previews, first outputs, and postcards go first.',
        normal: 'Scheduled Feddit bot posts and comments use normal priority.',
        background: 'Ambient Cy work waits behind active requests.',
        aging: 'Waiting work gradually gains priority so it cannot be starved forever.',
      },
      desktopAlternative: 'A desktop bot skips the shared queue, so its turn is normally all but instant. Finishing still depends on the computer and model.',
    };
  }

  function resetForTests() { cache = null; }

  return { file, enqueue, heartbeat, claim, renew, complete, fail, get, capacity, resetForTests };
}

module.exports = {
  VERSION,
  PRIORITY,
  AGING_STEP_MS,
  DEFAULT_LEASE_MS,
  WORKER_ONLINE_MS,
  cleanPriority,
  effectiveScore,
  createQueue,
};
