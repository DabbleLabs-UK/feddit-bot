'use strict';

const assert = require('node:assert/strict');
const policy = require('../lib/quiet-population-policy');
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const at = Date.parse('2026-10-23T12:00:00.000Z');
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function rejects(value, message) { assert.throws(() => policy.validatePolicy(value), /Invalid frozen/); checks++; }
function decision(overrides = {}) {
  return { at: new Date(at - MINUTE).toISOString(), kind: 'decision', ok: true, dryRun: false, assessmentCandidates: 1, ...overrides };
}
function profile(id = 'p_one', overrides = {}) {
  return { id, enabled: true, token: 'PRIVATE-DO-NOT-RETAIN', provider: 'ollama', dryRun: false,
    activity: [decision()], sched: { sentPosts: [], sentComments: [] }, ...overrides };
}
function samples(duration = MINUTE, count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    startedAt: at - (index + 1) * (duration + MINUTE),
    finishedAt: at - (index + 1) * (duration + MINUTE) + duration, status: 'completed',
  }));
}
function select(profiles = [profile()], rows = samples(), observedAt = at) {
  return policy.selectPolicy(profiles, rows, observedAt);
}
function count(size, overrides) { return Array.from({ length: size }, (_, index) => profile('p_' + index, overrides)); }

eq(policy.evaluate(), { kind: 'fallback' }, 'policy is default off');
eq(policy.evaluate({ profiles: 'invalid', samples: 'invalid', at: -1 }), { kind: 'fallback' }, 'disabled policy does not inspect evidence');
eq(policy.evaluate({ enabled: '1', profiles: count(24), samples: samples(), at }), { kind: 'fallback' }, 'truthy string cannot enable policy');
eq(policy.evaluate({ enabled: true, profiles: count(6), samples: samples(), at }), select(count(6)), 'explicit opt-in matches pure selector');

for (const [population, low, high, gapMinutes] of [[1, 3, 5, 60], [2, 3, 5, 60], [3, 3, 5, 30],
  [6, 6, 9, 20], [8, 8, 12, 15], [12, 12, 18, 10], [16, 12, 18, 8], [1000, 12, 18, 8]]) {
  const result = select(count(population));
  eq([result.kind, result.activeProfiles, result.low, result.high, result.gapMs],
    ['scaled', population, low, high, gapMinutes * MINUTE], 'fixed bounded population band ' + population);
}
eq(select([profile(), profile()]).activeProfiles, 1, 'duplicate profile identity is counted once');
eq(select([profile(), ...count(200, { enabled: false })]).activeProfiles, 1, 'inactive configured population has no effect');
for (const override of [{ token: '' }, { provider: 'deepseek' }, { provider: 'chatgpt-plan' }, { dryRun: true }, { activity: [] },
  { activity: [decision({ ok: false })] }, { activity: [decision({ dryRun: true })] },
  { activity: [decision({ dryRun: undefined })] }, { activity: [decision({ kind: 'skip' })] },
  { activity: [decision({ kind: 'preview' })] }, { activity: [decision({ at: new Date(at - 7 * HOUR).toISOString() })] }]) {
  eq(select([profile('p_test', override)]).kind, 'fallback', 'no generic success, failed, inactive, rehearsal or stale work counts');
}
eq(select([profile('p_legacy', { activity: [decision({ assessmentCandidates: undefined })] })]).kind,
  'fallback', 'legacy decision without actual-offer proof does not scale expectations');
eq(select([profile('p_empty_menu', { activity: [decision({ assessmentCandidates: 0 })] })]).kind,
  'fallback', 'empty-menu WAIT without inference is not meaningful participation');
eq(select([profile('p_wait', { activity: [decision({ note: 'WAIT: no useful reply' })] })]).activeProfiles, 1, 'valid explicit WAIT proves actual reading');
const vote = (summary = {}) => decision({ kind: 'vote', voteSummary: { candidates: 2, unresolved: 0, rejected: 0, nil: 2, ...summary } });
eq(select([profile('p_nil', { activity: [vote()] })]).activeProfiles, 1, 'valid NIL assessment proves reading without publication');
for (const summary of [{ candidates: 0 }, { unresolved: 1 }, { rejected: 1 }]) {
  eq(select([profile('p_vote', { activity: [vote(summary)] })]).kind, 'fallback', 'empty or technically unresolved votes cannot inflate participation');
}
eq(select([profile('p_empty', { activity: [decision({ kind: 'vote', voteSummary: { candidates: 0, rejected: 0 } })] })]).kind,
  'fallback', 'actual legacy empty-menu log without unresolved is safe nonparticipation');
for (const name of ['sentPosts', 'sentComments']) {
  eq(select([profile('p_sent', { activity: [], sched: { [name]: [at - MINUTE] } })]).activeProfiles, 1, 'recent confirmed ' + name + ' is usable participation');
  eq(select([profile('p_old', { activity: [], sched: { [name]: [at - HOUR - 1] } })]).kind, 'fallback', 'old rolling counter does not count');
}
eq(select([profile('p_dell', { provider: 'dell' })]).activeProfiles, 1, 'hosted and local free providers share policy');

for (const override of [{ id: '' }, { dryRun: 'false' }, { activity: {} }, { sched: [] },
  { activity: [null] }, { activity: [decision({ at: 'not-time' })] }, { activity: [decision({ at: '1' })] },
  { activity: [decision({ at: new Date(at + 1).toISOString() })] },
  { activity: [decision({ assessmentCandidates: 21 })] }, { activity: [decision({ assessmentCandidates: -1 })] },
  { activity: [decision({ assessmentCandidates: '1' })] },
  { activity: [vote({ candidates: -1 })] }, { activity: [vote({ unresolved: -1 })] }, { activity: [vote({ rejected: '0' })] },
  { sched: { sentPosts: [at + 1] } }, { sched: { sentComments: ['yesterday'] } }, { sched: { sentPosts: -1 } }]) {
  eq(select([profile(), profile('p_bad', override)]).kind, 'blocked', 'malformed/future evidence blocks even alongside healthy participation');
}
eq(select(null).kind, 'blocked', 'missing eligible profile set is not zero population');
eq(select([null]).kind, 'blocked', 'invalid eligible profile is not silently ignored');
eq(select([profile()], samples(), at + 0.5).kind, 'blocked', 'observation timestamp must be safe integer');

for (const rows of [undefined, null, [], samples(MINUTE, 3),
  samples(MINUTE, 4).map((row) => ({ ...row, startedAt: row.startedAt - 7 * HOUR, finishedAt: row.finishedAt - 7 * HOUR }))]) {
  eq(policy.selectPolicy([profile()], rows, at).kind, 'fallback', 'missing, insufficient or stale capacity uses fixed fallback');
}
for (const rows of [{}, samples(MINUTE, 65), [{ startedAt: at - MINUTE, finishedAt: at, status: 'running' }],
  [{ startedAt: at, finishedAt: at, status: 'completed' }], [{ startedAt: at, finishedAt: at - 1, status: 'completed' }],
  [{ startedAt: at - MINUTE, finishedAt: at + 1, status: 'completed' }],
  [{ startedAt: 'old', finishedAt: at, status: 'completed' }], [{ ...samples()[0], prompt: 'never retain' }]]) {
  eq(select([profile()], rows).kind, 'blocked', 'contradictory/malformed capacity does not fall back to stronger admission');
}
const durations = [MINUTE, 2 * MINUTE, 5 * MINUTE, 12 * MINUTE];
const measured = durations.map((duration, index) => ({ startedAt: at - duration - (index + 1) * 1000,
  finishedAt: at - (index + 1) * 1000, status: index === 2 ? 'failed' : 'completed' }));
eq(select(count(24), measured).p75RequestMs, 5 * MINUTE, 'nearest-rank p75 includes failed request cost');
eq(select(count(24), measured).gapMs, 30 * MINUTE, 'measured serial cost includes decision, existing repair and writing headroom');
eq(select(count(24), samples(10 * MINUTE)).gapMs, 60 * MINUTE, 'largest permitted service cost remains bounded');
eq(select(count(24), samples(10 * MINUTE + 1)).kind, 'blocked', 'capacity requiring over one hour cannot admit extras');
eq(select(count(24), samples(1)).gapMs, 8 * MINUTE, 'ample capacity never exceeds hard eight-per-hour bound');
eq(select(count(24), measured), select(count(24), measured.slice().reverse()), 'sample ordering cannot change controller');
eq(select(count(24), samples(1).map((row) => ({ ...row, status: 'failed' }))).kind,
  'blocked', 'fast repeated failures never prove ample usable capacity');
eq(select(count(24), samples().map((row) => ({ ...row,
  startedAt: row.startedAt - HOUR, finishedAt: row.finishedAt - HOUR }))).kind,
  'fallback', 'old successful capacity evidence retains the fixed safe fallback');
const latestFailed = samples(MINUTE).map((row, index) => ({ ...row, status: index === 0 ? 'failed' : 'completed' }));
eq(select(count(24), latestFailed).kind, 'blocked', 'latest failure holds assistance despite previous successes');
const recovered = [...latestFailed, { startedAt: at - 2000, finishedAt: at - 1000, status: 'completed' }];
eq(select(count(24), recovered).kind, 'scaled', 'later completed request positively establishes recovery');
eq(select(count(24), recovered).p75RequestMs, MINUTE, 'recovered capacity still includes failed request durations');
const tiedFailure = [...recovered, { startedAt: at - 1500, finishedAt: at - 1000, status: 'failed' }];
eq(select(count(24), tiedFailure).kind, 'blocked', 'failure wins conservatively on tied terminal timestamps');
eq(select(count(24), [{ startedAt: at - 2000, finishedAt: at - 1000, status: 'failed' }]).kind,
  'blocked', 'failure remains fail-closed before the minimum sample count');
eq(select([], [{ startedAt: at - 2000, finishedAt: at + 1, status: 'completed' }]).kind,
  'blocked', 'zero participation cannot hide contradictory future capacity');
eq(select([], { invalid: true }).kind, 'blocked', 'zero participation cannot hide malformed capacity');
eq(select([], latestFailed).kind, 'blocked', 'zero participation cannot hide failed capacity');
eq(policy.selectPolicy([], undefined, at).kind, 'fallback', 'missing capacity and participation retain safe fixed fallback');
eq(select([], samples()).kind, 'fallback', 'healthy capacity without participation proof retains fixed fallback');
eq(select(count(24)).low > select(count(2)).low, true, 'population drop immediately lowers expectation');
eq(select(count(6)).high - select(count(6)).low, 3, 'separate deterministic thresholds preserve hysteresis band');

const frozen = select(count(12));
eq(policy.validatePolicy(JSON.parse(JSON.stringify(frozen))), frozen, 'frozen policy survives restart roundtrip');
eq(policy.validatePolicy({ ...frozen, privateText: 'must not survive' }), frozen, 'frozen validator retains only content-free fields');
for (const fields of [{ version: 1 }, { kind: 'fallback' }, { activeProfiles: 0 }, { activeProfiles: 3 },
  { sampleCount: 3 }, { sampleCount: 65 }, { sampleAt: -1 }, { p75RequestMs: 0 }, { p75RequestMs: 16 * MINUTE },
  { low: 13 }, { high: 99 }, { gapMs: MINUTE }, { gapMs: frozen.gapMs + 1 }]) {
  rejects({ ...frozen, ...fields }, 'forged frozen policy is rejected');
}
eq(JSON.stringify(frozen).includes('PRIVATE'), false, 'policy contains no tokens or persona/activity prose');
console.log('quiet-population-policy: ' + checks + ' checks passed');
