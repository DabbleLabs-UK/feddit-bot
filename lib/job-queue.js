'use strict';

// Durable pull queue for shared inference. The public runner owns this file;
// DELL makes authenticated outbound requests to claim work, so no DELL port is
// exposed. Priority describes the human need, not the originating application:
// previews/first outputs/postcards are interactive, scheduled Feddit work is
// normal, and ambient/system work is background. Allocation class boundaries
// are strict; aging and owner/profile rotation operate within a class.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 2;
const PRIORITY = { background: 100, normal: 200, interactive: 300 };
const ALLOCATION_CLASS = { synthetic: 100, user: 200, interactive: 300 };
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

function cleanAllocationClass(value, priority = 'normal') {
  if (Object.prototype.hasOwnProperty.call(ALLOCATION_CLASS, value)) return value;
  const fallback = cleanPriority(priority);
  if (fallback === 'interactive') return 'interactive';
  if (fallback === 'background') return 'synthetic';
  return 'user';
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
  const maxActivePerProfile = Math.max(0, Math.floor(Number(
    options.maxActivePerProfile != null ? options.maxActivePerProfile : options.maxActivePerOwner
  ) || 0));
  let cache = null;

  function empty() {
    return {
      version: VERSION,
      jobs: [],
      workers: {},
      serviceSequence: 0,
      ownerServiceByClass: {},
      profileServiceByOwnerClass: {},
    };
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
        version: VERSION,
        jobs: Array.isArray(parsed && parsed.jobs) ? parsed.jobs : [],
        workers: parsed && parsed.workers && typeof parsed.workers === 'object' ? parsed.workers : {},
        ownerServiceByClass: parsed && parsed.ownerServiceByClass && typeof parsed.ownerServiceByClass === 'object'
          ? parsed.ownerServiceByClass
          : {},
        profileServiceByOwnerClass: parsed && parsed.profileServiceByOwnerClass && typeof parsed.profileServiceByOwnerClass === 'object'
          ? parsed.profileServiceByOwnerClass
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

    // Keep the fairness ledger bounded by the same retained history as the
    // jobs it describes. Dropping an owner here only resets its old rotation
    // position after every retained job for that owner has gone away.
    const retainedOwners = new Map();
    const retainedProfiles = new Map();
    for (const job of data.jobs) {
      const allocationClass = cleanAllocationClass(job.allocationClass, job.priority);
      const ownerKey = String(job.ownerKey || job.profileId || 'anonymous');
      const ownerProfileKey = allocationClass + ':' + ownerKey;
      if (!retainedOwners.has(allocationClass)) retainedOwners.set(allocationClass, new Set());
      if (!retainedProfiles.has(ownerProfileKey)) retainedProfiles.set(ownerProfileKey, new Set());
      retainedOwners.get(allocationClass).add(ownerKey);
      retainedProfiles.get(ownerProfileKey).add(jobProfileKey(job));
    }

    for (const [allocationClass, owners] of Object.entries(data.ownerServiceByClass || {})) {
      const allowed = retainedOwners.get(allocationClass) || new Set();
      if (!owners || typeof owners !== 'object') {
        delete data.ownerServiceByClass[allocationClass];
        continue;
      }
      for (const ownerKey of Object.keys(owners)) {
        if (!allowed.has(ownerKey)) delete owners[ownerKey];
      }
      if (!Object.keys(owners).length) delete data.ownerServiceByClass[allocationClass];
    }

    for (const [ownerProfileKey, profiles] of Object.entries(data.profileServiceByOwnerClass || {})) {
      const allowed = retainedProfiles.get(ownerProfileKey) || new Set();
      if (!profiles || typeof profiles !== 'object') {
        delete data.profileServiceByOwnerClass[ownerProfileKey];
        continue;
      }
      for (const profileKey of Object.keys(profiles)) {
        if (!allowed.has(profileKey)) delete profiles[profileKey];
      }
      if (!Object.keys(profiles).length) delete data.profileServiceByOwnerClass[ownerProfileKey];
    }
  }

  function enqueue(input = {}) {
    const data = load();
    const at = now();
    const dedupeKey = String(input.dedupeKey || '').slice(0, 200);
    if (dedupeKey) {
      const existing = data.jobs.find((item) =>
        item.dedupeKey === dedupeKey && (item.status === 'queued' || item.status === 'claimed'));
      if (existing) return publicJob(existing, true, data);
    }
    const ownerKey = String(input.ownerKey || input.profileId || 'anonymous');
    const profileId = input.profileId ? String(input.profileId) : null;
    const activeProfileKey = profileId || ownerKey;
    if (maxActivePerProfile > 0) {
      const activeForProfile = data.jobs.filter((item) =>
        (item.profileId || item.ownerKey) === activeProfileKey &&
        (item.status === 'queued' || item.status === 'claimed')).length;
      if (activeForProfile >= maxActivePerProfile) {
        const err = new Error(
          'This bot already has a hosted generation waiting or running. Let it finish before adding another.',
        );
        err.code = 'QUEUE_PROFILE_LIMIT';
        throw err;
      }
    }
    const priority = cleanPriority(input.priority);
    const job = {
      id: newId(),
      source: String(input.source || 'feddit'),
      kind: String(input.kind || 'generation'),
      activityAction: String(input.activityAction || '').slice(0, 120),
      activityTrigger: String(input.activityTrigger || '').slice(0, 120),
      activityTarget: String(input.activityTarget || '').slice(0, 200),
      ownerKey,
      profileId,
      dedupeKey: dedupeKey || null,
      priority,
      allocationClass: cleanAllocationClass(input.allocationClass, priority),
      onboarding: input.onboarding === true,
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
    return publicJob(job, true, data);
  }

  function serviceValue(map, key) {
    const value = Number(map && map[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function ownerBucket(data, allocationClass) {
    if (!data.ownerServiceByClass[allocationClass] ||
        typeof data.ownerServiceByClass[allocationClass] !== 'object') {
      data.ownerServiceByClass[allocationClass] = {};
    }
    return data.ownerServiceByClass[allocationClass];
  }

  function profileBucket(data, allocationClass, ownerKey) {
    const key = allocationClass + ':' + ownerKey;
    if (!data.profileServiceByOwnerClass[key] ||
        typeof data.profileServiceByOwnerClass[key] !== 'object') {
      data.profileServiceByOwnerClass[key] = {};
    }
    return data.profileServiceByOwnerClass[key];
  }

  function jobProfileKey(job) {
    return String(job.profileId || job.id);
  }

  function bestJob(jobs, at) {
    return jobs.slice().sort((a, b) =>
      effectiveScore(b, at) - effectiveScore(a, at) ||
      Number(a.createdAt || 0) - Number(b.createdAt || 0)
    )[0];
  }

  // Select by strict allocation class, then rotate human owners, then favour
  // onboarding profiles within that owner's fair share, then rotate profiles.
  // This prevents one owner from gaining capacity merely by creating more bots.
  function chooseNext(available, data, at, recordService) {
    if (!available.length) return null;
    const topRank = Math.max(...available.map((job) =>
      ALLOCATION_CLASS[cleanAllocationClass(job.allocationClass, job.priority)]));
    const classJobs = available.filter((job) =>
      ALLOCATION_CLASS[cleanAllocationClass(job.allocationClass, job.priority)] === topRank);
    const allocationClass = cleanAllocationClass(classJobs[0].allocationClass, classJobs[0].priority);
    const byOwner = new Map();
    for (const job of classJobs) {
      const key = String(job.ownerKey || job.profileId || 'anonymous');
      if (!byOwner.has(key)) byOwner.set(key, []);
      byOwner.get(key).push(job);
    }
    const ownerServices = ownerBucket(data, allocationClass);
    const owners = [...byOwner.keys()].sort((a, b) =>
      serviceValue(ownerServices, a) - serviceValue(ownerServices, b) ||
      Number(bestJob(byOwner.get(a), at).createdAt || 0) - Number(bestJob(byOwner.get(b), at).createdAt || 0)
    );
    const ownerKey = owners[0];
    let ownerJobs = byOwner.get(ownerKey);
    if (allocationClass === 'user' && ownerJobs.some((job) => job.onboarding === true)) {
      ownerJobs = ownerJobs.filter((job) => job.onboarding === true);
    }
    const byProfile = new Map();
    for (const job of ownerJobs) {
      const key = jobProfileKey(job);
      if (!byProfile.has(key)) byProfile.set(key, []);
      byProfile.get(key).push(job);
    }
    const profileServices = profileBucket(data, allocationClass, ownerKey);
    const profiles = [...byProfile.keys()].sort((a, b) =>
      serviceValue(profileServices, a) - serviceValue(profileServices, b) ||
      Number(bestJob(byProfile.get(a), at).createdAt || 0) - Number(bestJob(byProfile.get(b), at).createdAt || 0)
    );
    const profileKey = profiles[0];
    const job = bestJob(byProfile.get(profileKey), at);
    if (recordService) {
      data.serviceSequence = Math.max(0, Number(data.serviceSequence) || 0) + 1;
      ownerServices[ownerKey] = data.serviceSequence;
      profileServices[profileKey] = data.serviceSequence;
    }
    return job;
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
    if (!available.length) {
      save(data);
      return null;
    }
    const job = chooseNext(available, data, at, true);
    job.status = 'claimed';
    job.workerId = id;
    job.attempts = Number(job.attempts || 0) + 1;
    job.startedAt = job.startedAt || at;
    job.claimedAt = at;
    job.leaseUntil = at + (Number(details.leaseMs) || DEFAULT_LEASE_MS);
    save(data);
    return publicJob(job, true, data);
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
    return publicJob(job, false, data);
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
    return publicJob(job, false, data);
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
    return publicJob(job, false, data);
  }

  function get(jobId, includePayload = false) {
    const data = load();
    const job = data.jobs.find((item) => item.id === String(jobId));
    return job ? publicJob(job, includePayload, data) : null;
  }

  function orderedWaiting(data, at) {
    const ready = data.jobs.filter((item) => item.status === 'queued' && Number(item.notBefore || 0) <= at);
    const deferred = data.jobs
      .filter((item) => item.status === 'queued' && Number(item.notBefore || 0) > at)
      .sort((a, b) => Number(a.notBefore || 0) - Number(b.notBefore || 0));
    const ordered = [];
    const simulated = structuredClone(data);
    while (ready.length) {
      const next = chooseNext(ready, simulated, at, true);
      ordered.push(next);
      ready.splice(ready.findIndex((item) => item.id === next.id), 1);
    }
    return ordered.concat(deferred);
  }

  function publicJob(job, includePayload, data = null) {
    const out = { ...job };
    if (!includePayload) delete out.payload;
    if (data) {
      const at = now();
      const waiting = orderedWaiting(data, at);
      const running = data.jobs.filter((item) => item.status === 'claimed');
      out.waitingPosition = job.status === 'queued'
        ? Math.max(1, waiting.findIndex((item) => item.id === job.id) + 1)
        : null;
      out.waitingTotal = waiting.length;
      out.runningTotal = running.length;
      out.waitingMs = job.status === 'queued' ? Math.max(0, at - Number(job.createdAt || at)) : null;
      out.runningMs = job.status === 'claimed' ? Math.max(0, at - Number(job.claimedAt || job.startedAt || at)) : null;
    }
    return structuredClone(out);
  }

  function activeForProfile(profileId) {
    const id = String(profileId || '');
    if (!id) return null;
    const data = load();
    const active = data.jobs.filter((job) =>
      job.profileId === id && (job.status === 'queued' || job.status === 'claimed'));
    active.sort((a, b) => {
      if (a.status === 'claimed' && b.status !== 'claimed') return -1;
      if (b.status === 'claimed' && a.status !== 'claimed') return 1;
      return Number(a.createdAt || 0) - Number(b.createdAt || 0);
    });
    return active.length ? publicJob(active[0], false, data) : null;
  }

  function probabilityWithin(data, horizonMs, priority = null, allocationClass = null) {
    const at = now();
    const eligible = data.jobs.filter((job) => {
      const createdAt = Number(job.createdAt || 0);
      return createdAt >= at - HISTORY_MS
        && createdAt <= at - horizonMs
        && (priority == null || cleanPriority(job.priority) === priority)
        && (allocationClass == null || cleanAllocationClass(job.allocationClass, job.priority) === allocationClass);
    });
    if (!eligible.length) return { observed: 0, total: 0, fraction: null };
    const observed = eligible.filter((job) => job.status === 'completed' && Number(job.finishedAt) - Number(job.createdAt) <= horizonMs).length;
    return { observed, total: eligible.length, fraction: observed / eligible.length };
  }

  function likelihoodText(observation, online) {
    if (!online) {
      return {
        level: 'unavailable',
        text: 'The hosted compute pool is not currently available, so no hosted turn can be promised.',
      };
    }
    if (observation.fraction == null) {
      return {
        level: 'unknown',
        text: 'Full-day reliability is not rated yet because there are no scheduled turns old enough to judge over a whole day.',
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
    const scheduledWithinDay = probabilityWithin(data, 24 * 60 * 60 * 1000, 'normal', 'user');
    const currentState = online.length === 0
      ? 'offline'
      : (claimed.length > 0 ? 'working' : (queued.length > 0 ? 'waiting' : 'ready'));
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
      byAllocationClass: {
        interactive: queued.filter((job) => cleanAllocationClass(job.allocationClass, job.priority) === 'interactive').length,
        user: queued.filter((job) => cleanAllocationClass(job.allocationClass, job.priority) === 'user').length,
        synthetic: queued.filter((job) => cleanAllocationClass(job.allocationClass, job.priority) === 'synthetic').length,
      },
      completedLastSevenDays: recentCompleted.length,
      medianServiceMs,
      estimatedWaitMs,
      current: {
        state: currentState,
        oldestWaitingAt: queued.length ? Math.min(...queued.map((job) => Number(job.createdAt || at))) : null,
        oldestRunningAt: claimed.length ? Math.min(...claimed.map((job) => Number(job.claimedAt || job.startedAt || at))) : null,
        completedSampleSize: serviceTimes.length,
      },
      likelihood: {
        withinHour: probabilityWithin(data, 60 * 60 * 1000),
        withinSixHours: probabilityWithin(data, 6 * 60 * 60 * 1000),
        withinDay: probabilityWithin(data, 24 * 60 * 60 * 1000),
        scheduledBotWithinDay: scheduledWithinDay,
      },
      today: likelihoodText(scheduledWithinDay, online.length > 0),
      evidenceWindowDays: 7,
      priorityPolicy: {
        interactive: 'Previews, pressed-now simulations, first outputs, and postcards go first.',
        user: 'User-created bots share capacity by owner, then by bot. New bots receive a bounded onboarding advantage inside their owner share.',
        synthetic: 'System population is spare work and waits behind user-created work.',
        aging: 'Waiting age helps within a class but never lets synthetic work jump ahead of user work.',
      },
      desktopAlternative: 'A desktop bot skips the shared queue, so its turn is normally all but instant.',
    };
  }

  function resetForTests() { cache = null; }

  return { file, enqueue, heartbeat, claim, renew, complete, fail, get, activeForProfile, capacity, resetForTests };
}

module.exports = {
  VERSION,
  PRIORITY,
  ALLOCATION_CLASS,
  AGING_STEP_MS,
  DEFAULT_LEASE_MS,
  WORKER_ONLINE_MS,
  cleanPriority,
  cleanAllocationClass,
  effectiveScore,
  createQueue,
};
