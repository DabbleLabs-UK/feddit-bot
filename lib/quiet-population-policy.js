'use strict';

const VERSION = 2;
const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const PARTICIPATION_MS = 6 * HOUR_MS;
const CAPACITY_FRESH_MS = 30 * MINUTE_MS;
const SAMPLE_CAP = 64;
const MIN_SAMPLES = 4;
const MIN_GAP_MS = 8 * MINUTE_MS;
const MAX_GAP_MS = HOUR_MS;

function timestamp(value) { return Number.isSafeInteger(value) && value > 0; }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
function blocked(reason) { return { kind: 'blocked', reason }; }
function fallback() { return { kind: 'fallback' }; }

// These are fixed bounds, not learned targets. Six request durations allow for
// decision, existing repair and writing with nominal half-stream headroom.
// This p75 heuristic does not guarantee an idle fraction or reserve Cy capacity;
// the scheduler's present idle/provider gates remain the admission authority.
function parameters(activeProfiles, p75RequestMs) {
  const low = clamp(activeProfiles, 3, 12);
  const high = Math.ceil(1.5 * low);
  const populationGap = HOUR_MS / clamp(Math.ceil(activeProfiles / 2), 1, 8);
  const requiredGap = Math.max(populationGap, 6 * p75RequestMs);
  return { low, high, gapMs: Math.max(MIN_GAP_MS, Math.ceil(requiredGap / MINUTE_MS) * MINUTE_MS) };
}

function activeCount(profiles, at) {
  if (!Array.isArray(profiles)) return null;
  const active = new Set();
  for (const profile of profiles) {
    if (!object(profile)) return null;
    if (profile.enabled !== true || !profile.token || !['ollama', 'dell'].includes(profile.provider) || profile.dryRun === true) continue;
    if (typeof profile.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(profile.id) ||
        (profile.dryRun !== undefined && typeof profile.dryRun !== 'boolean') ||
        (profile.activity !== undefined && !Array.isArray(profile.activity)) ||
        (profile.sched !== undefined && !object(profile.sched))) return null;
    let participated = false;
    for (const entry of profile.activity || []) {
      if (!object(entry) || typeof entry.at !== 'string') return null;
      const when = Date.parse(entry.at);
      if (!timestamp(when) || new Date(when).toISOString() !== entry.at || when > at) return null;
      if (at - when > PARTICIPATION_MS || entry.ok !== true || entry.dryRun !== false) continue;
      if (entry.kind === 'decision' && entry.assessmentCandidates !== undefined) {
        if (!Number.isSafeInteger(entry.assessmentCandidates) || entry.assessmentCandidates < 0 || entry.assessmentCandidates > 20) return null;
        if (entry.assessmentCandidates > 0) participated = true;
      }
      if (entry.kind === 'vote') {
        const summary = entry.voteSummary;
        if (!object(summary) || !Number.isSafeInteger(summary.candidates) || summary.candidates < 0 ||
            !Number.isSafeInteger(summary.rejected) || summary.rejected < 0 ||
            (summary.unresolved === undefined ? summary.candidates !== 0 :
              !Number.isSafeInteger(summary.unresolved) || summary.unresolved < 0)) return null;
        if (summary.candidates > 0 && summary.unresolved === 0 && summary.rejected === 0) participated = true;
      }
    }
    for (const name of ['sentPosts', 'sentComments']) {
      const values = profile.sched?.[name];
      if (values !== undefined && !Array.isArray(values)) return null;
      for (const when of values || []) {
        if (!timestamp(when) || when > at) return null;
        if (at - when <= HOUR_MS) participated = true;
      }
    }
    if (participated) active.add(profile.id);
  }
  return active.size;
}

function selectPolicy(profiles, samples, at) {
  if (!timestamp(at)) return blocked('invalid-observation-time');
  const activeProfiles = activeCount(profiles, at);
  if (activeProfiles === null) return blocked('invalid-participation-evidence');
  if (activeProfiles === 0) return fallback();
  if (samples == null) return fallback();
  if (!Array.isArray(samples) || samples.length > SAMPLE_CAP) return blocked('invalid-capacity-evidence');
  const recent = [];
  for (const sample of samples) {
    if (!object(sample) || !timestamp(sample.startedAt) || !timestamp(sample.finishedAt) ||
        sample.finishedAt <= sample.startedAt || sample.finishedAt > at ||
        !['completed', 'failed'].includes(sample.status) ||
        Object.keys(sample).some((key) => !['startedAt', 'finishedAt', 'status'].includes(key))) {
      return blocked('invalid-capacity-evidence');
    }
    if (at - sample.finishedAt <= PARTICIPATION_MS) recent.push(sample);
  }
  if (recent.length < MIN_SAMPLES) return fallback();
  const sampleAt = Math.max(...recent.map((sample) => sample.finishedAt));
  if (at - sampleAt > CAPACITY_FRESH_MS) return fallback();
  const durations = recent.map((sample) => sample.finishedAt - sample.startedAt).sort((a, b) => a - b);
  const p75RequestMs = durations[Math.ceil(0.75 * durations.length) - 1];
  const policy = parameters(activeProfiles, p75RequestMs);
  if (policy.gapMs > MAX_GAP_MS) return blocked('insufficient-measured-capacity');
  return { kind: 'scaled', version: VERSION, activeProfiles, sampleCount: recent.length, sampleAt, p75RequestMs, ...policy };
}

function evaluate({ enabled = false, profiles, samples, at = Date.now() } = {}) {
  return enabled === true ? selectPolicy(profiles, samples, at) : fallback();
}

function validatePolicy(raw) {
  if (!object(raw) || raw.kind !== 'scaled' || raw.version !== VERSION ||
      !Number.isSafeInteger(raw.activeProfiles) || raw.activeProfiles < 1 ||
      !Number.isSafeInteger(raw.sampleCount) || raw.sampleCount < MIN_SAMPLES || raw.sampleCount > SAMPLE_CAP ||
      !timestamp(raw.sampleAt) || !Number.isSafeInteger(raw.p75RequestMs) || raw.p75RequestMs <= 0) {
    throw new Error('Invalid frozen quiet-population policy.');
  }
  const policy = parameters(raw.activeProfiles, raw.p75RequestMs);
  if (policy.gapMs > MAX_GAP_MS || raw.low !== policy.low || raw.high !== policy.high || raw.gapMs !== policy.gapMs) {
    throw new Error('Invalid frozen quiet-population policy.');
  }
  return { kind: 'scaled', version: VERSION, activeProfiles: raw.activeProfiles, sampleCount: raw.sampleCount,
    sampleAt: raw.sampleAt, p75RequestMs: raw.p75RequestMs, ...policy };
}

module.exports = { VERSION, PARTICIPATION_MS, CAPACITY_FRESH_MS, SAMPLE_CAP, MIN_SAMPLES,
  MIN_GAP_MS, MAX_GAP_MS, evaluate, selectPolicy, validatePolicy };
