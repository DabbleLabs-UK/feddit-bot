'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const quiet = require('../lib/quiet-conversations');
const policy = require('../lib/quiet-population-policy');
const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const { createQuietConversations, POLL_MS, ENTRY_CAP } = quiet;
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function rejects(fn, message) { assert.throws(fn, message); checks++; }

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-quiet-population-controller-'));
  let at = Date.parse('2026-10-23T12:00:00Z');
  const initialAt = at;
  let sequence = 0;
  const iso = (value) => new Date(value).toISOString();
  const profiles = (count) => Array.from({ length: count }, (_, index) => ({
    id: 'p_' + index, enabled: true, token: 'SECRET_MUST_NOT_PERSIST', provider: 'dell', dryRun: false,
    personality: 'PRIVATE_PERSONALITY_MUST_NOT_PERSIST',
    activity: [{ kind: 'decision', ok: true, dryRun: false, assessmentCandidates: 1, at: iso(at - MINUTE_MS) }],
  }));
  const samples = (duration = MINUTE_MS) => Array.from({ length: 4 }, (_, index) => ({
    startedAt: at - (index + 1) * duration, finishedAt: at - index * duration, status: 'completed',
  }));
  const context = (count = 12, duration = MINUTE_MS) => ({ profiles: profiles(count), samples: samples(duration) });
  const snapshot = (comments = 0) => ({ schemaVersion: 1, source: 'feddit-current-votes', generatedAt: iso(at),
    window: { hours: 1, since: iso(at - HOUR_MS), until: iso(at) },
    coverage: { sampleTruncated: false, nsfwIncluded: false },
    items: Array.from({ length: comments }, (_, index) => ({ key: 'comment:' + (index + 1), targetType: 'comment',
      targetId: index + 1, postId: 99, createdAt: iso(at - MINUTE_MS),
      title: 'PUBLIC_TEXT_MUST_NOT_PERSIST', author: 'PUBLIC_AUTHOR_MUST_NOT_PERSIST' })),
  });
  const create = (options = {}) => createQuietConversations({
    file: path.join(directory, 'state-' + (++sequence) + '.json'), enabled: true, populationAware: true,
    now: () => at, request: async () => ({ ok: true, data: snapshot() }), ...options,
  });
  try {
    let comments = 11;
    const legacy = create({ populationAware: false, request: async () => ({ ok: true, data: snapshot(comments) }) });
    eq(legacy.populationAware, false, 'population flag remains explicitly disabled');
    eq((await legacy.getSignal(context(30))).quiet, false, 'disabled feature retains six/nine thresholds');
    const omittedFlag = createQuietConversations({ file: path.join(directory, 'omitted.json'), enabled: true,
      now: () => at, request: async () => ({ ok: true, data: snapshot() }) });
    const legacySignal = await omittedFlag.getSignal(context(30));
    eq(omittedFlag.populationAware, false, 'omitted population flag is default off');
    eq(Object.hasOwn(legacySignal, 'policy'), false, 'legacy signal shape is unchanged');
    const legacyAdmission = omittedFlag.reserve('p_legacy', { signal: legacySignal });
    eq(legacyAdmission.version, 1, 'default admissions freeze exact released contract');
    eq(omittedFlag.peek().version, 1, 'default storage fence stays version one');
    at += 10 * MINUTE_MS;
    const upgrade = create({ file: path.join(directory, 'omitted.json') });
    const fasterSignal = await upgrade.getSignal(context(30));
    eq(upgrade.canAdmit('p_other', { signal: fasterSignal }), false, 'upgrade never shortens a frozen legacy fifteen-minute hold');

    at = initialAt;
    let reads = 0;
    const scaled = create({ request: async () => { reads++; return { ok: true, data: snapshot(comments) }; } });
    let signal = await scaled.getSignal(context(12));
    eq(signal.quiet, true, 'eleven comments is quiet for twelve recently participating bots');
    eq([signal.policy.low, signal.policy.high, signal.policy.gapMs], [12, 18, 10 * MINUTE_MS], 'scaled thresholds and gap are explicit');
    eq(reads, 1, 'one bounded public evidence read');
    at += POLL_MS;
    comments = 17;
    signal = await scaled.getSignal(context(12));
    eq(signal.quiet, true, 'hysteresis retains quiet state below upper threshold');
    at += POLL_MS;
    comments = 18;
    eq((await scaled.getSignal(context(12))).quiet, false, 'upper threshold disables assistance');
    at += POLL_MS;
    comments = 17;
    eq((await scaled.getSignal(context(12))).quiet, false, 'falling below upper threshold does not immediately reenable');
    at += POLL_MS;
    comments = 11;
    eq((await scaled.getSignal(context(12))).quiet, true, 'lower threshold reenters quiet state');
    const beforeDropReads = reads;
    const dropped = await scaled.getSignal(context(2));
    eq(dropped.quiet, false, 'sudden population drop cannot retain larger-population hysteresis');
    eq([dropped.policy.low, dropped.policy.high, dropped.policy.gapMs], [3, 5, HOUR_MS], 'small population has bounded conservative thresholds');
    eq(reads, beforeDropReads, 'population drop is noticed even while public evidence is cached');
    const regained = await scaled.getSignal(context(12));
    eq(regained.quiet, true, 'current evidence is reevaluated without modifying public data');

    at = initialAt;
    let cachedReads = 0;
    const independentlyFresh = create({ request: async () => {
      cachedReads++;
      return { ok: true, data: snapshot() };
    } });
    const originalPublic = await independentlyFresh.getSignal(context(12));
    at += MINUTE_MS;
    const newerCapacity = samples().map((sample, index) => ({ ...sample,
      startedAt: initialAt - index * MINUTE_MS - MINUTE_MS / 2,
      finishedAt: initialAt - index * MINUTE_MS + MINUTE_MS / 2 }));
    const concurrentSignal = await independentlyFresh.getSignal({ profiles: profiles(12), samples: newerCapacity });
    eq(cachedReads, 1, 'new completion evidence reuses still-fresh public activity rather than refetching');
    eq(concurrentSignal.observedAt, originalPublic.observedAt, 'capacity refresh never relabels the public evidence observation time');
    eq(concurrentSignal.policy.sampleAt, initialAt + MINUTE_MS / 2, 'capacity may finish after independently cached public observation');
    const coherent = independentlyFresh.reserve('p_independent_clocks', { signal: concurrentSignal });
    eq(!!coherent, true, 'independently fresh public and capacity evidence permits scaled admission');
    eq(coherent.signal.observedAt, initialAt, 'frozen receipt preserves original public observation time');
    eq(coherent.signal.policy.sampleAt <= coherent.admittedAt, true, 'frozen capacity completion cannot be later than admission');
    rejects(() => independentlyFresh.ensure({ ...coherent, signal: { ...coherent.signal,
      policy: { ...coherent.signal.policy, sampleAt: coherent.admittedAt + 1 } } }), 'future capacity evidence cannot be replayed');

    at = initialAt;
    const fallback = create();
    for (const capacity of [undefined, [], samples().slice(0, 3), samples().map((sample) => ({ ...sample,
      startedAt: sample.startedAt - 31 * MINUTE_MS, finishedAt: sample.finishedAt - 31 * MINUTE_MS }))]) {
      const value = await fallback.getSignal({ profiles: profiles(12), samples: capacity });
      eq(value.quiet, true, 'missing or insufficient recent capacity falls back to fixed quiet policy');
      eq(Object.hasOwn(value, 'policy'), false, 'fallback does not claim verified scaled capacity');
    }
    const malformed = await fallback.getSignal({ profiles: profiles(12), samples: [{ startedAt: at, finishedAt: at - 1, status: 'completed' }] });
    eq([malformed.status, malformed.quiet], ['population-unavailable', false], 'contradictory capacity fails closed rather than using fallback');
    const unavailable = await fallback.getSignal({ profiles: profiles(0), samples: samples() });
    eq(unavailable.quiet, true, 'cold start falls back to fixed quiet behavior');
    eq(Object.hasOwn(unavailable, 'policy'), false, 'missing participation proof cannot claim a scaled population');
    const legacyActivity = profiles(30).map((profile) => ({ ...profile,
      activity: profile.activity.map(({ assessmentCandidates, ...entry }) => entry) }));
    const unproven = await fallback.getSignal({ profiles: legacyActivity, samples: samples() });
    eq(Object.hasOwn(unproven, 'policy'), false, 'legacy generic decision success does not prove actual model assessment');
    const emptyMenus = profiles(30).map((profile) => ({ ...profile,
      activity: profile.activity.map((entry) => ({ ...entry, assessmentCandidates: 0 })) }));
    const noOffer = await fallback.getSignal({ profiles: emptyMenus, samples: samples() });
    eq(Object.hasOwn(noOffer, 'policy'), false, 'empty-menu WAIT does not inflate scaled participation');
    const sixComments = create({ request: async () => ({ ok: true, data: snapshot(6) }) });
    eq((await sixComments.getSignal({ profiles: legacyActivity, samples: samples() })).quiet, false,
      'many unproven profiles cannot enable assistance above the fixed fallback threshold');
    const saturated = await fallback.getSignal(context(12, 16 * MINUTE_MS));
    eq(saturated.quiet, false, 'insufficient measured capacity suppresses assistance');
    const manyInactive = profiles(12).concat(profiles(200).map((profile, index) => ({ ...profile, id: 'inactive_' + index, activity: [] })));
    eq((await fallback.getSignal({ profiles: manyInactive, samples: samples() })).policy.activeProfiles, 12,
      'configured but unserviced bots do not inflate the active population');

    const file = path.join(directory, 'mixed.json');
    const fixed = create({ file, populationAware: false });
    const old = fixed.reserve('p_old', { signal: await fixed.getSignal() });
    at += 15 * MINUTE_MS;
    const population = create({ file });
    signal = await population.getSignal(context(30));
    const admission = population.reserve('p_new', { signal });
    eq(admission.version, 2, 'scaled admission freezes version two');
    eq(admission.signal.policy, signal.policy, 'exact selected policy is frozen in durable receipt');
    eq(population.peek().version, 2, 'mixed ledger raises storage fence before compatible writes');
    eq(population.peek().modes.live.map((row) => row.version).sort(), [1, 2], 'mixed storage preserves exact legacy receipts');
    eq(population.ensure(old).version, 1, 'old receipt retains its original version after upgrade');
    population.ensure(admission, 't_population');
    const saved = JSON.stringify(population.peek());
    population.ensure(admission, 't_population');
    eq(JSON.stringify(population.peek()), saved, 'repeated durable binding is idempotent');
    rejects(() => population.ensure(admission, 't_different'), 'one admission cannot bind a second turn');
    population.recordTarget(admission, 99);
    eq(population.excludedThreadIds(), [99], 'same thirty-minute extra-only thread exclusion applies');
    eq(population.excludedThreadIds({ simulation: true }), [], 'live threads do not leak into rehearsal');
    eq(population.canAdmit('p_other', { signal }), false, 'a new bot cannot bypass the frozen global gap');
    at += 8 * MINUTE_MS;
    signal = await population.getSignal(context(30));
    eq(population.canAdmit('p_other', { signal }), true, 'ample measured capacity allows bounded eight-minute admission');
    eq(population.canAdmit('p_new', { signal }), false, 'per-bot once-per-hour hold is unchanged');
    const slower = await population.getSignal(context(30, 4 * MINUTE_MS));
    eq(population.canAdmit('p_other', { signal: slower }), false, 'current lower capacity may lengthen but not bypass the hold');
    const later = population.reserve('p_other', { signal });
    eq(later.excludedThreadIds, [99], 'new receipt freezes the actual extra-only thread cooldown');
    const restarted = create({ file, populationAware: false });
    eq(restarted.peek(), population.peek(), 'restart with population feature off preserves both contract versions');
    eq(restarted.ensure(admission, 't_population').turnId, 't_population', 'feature removal does not reinterpret in-flight population admission');
    eq(restarted.canAdmit('p_later'), false, 'restart does not reset global admission budget');
    const fullyDisabled = create({ file, enabled: false, populationAware: false });
    eq(fullyDisabled.ensure(admission, 't_population').version, 2, 'disabled admission still permits exact frozen replay');
    const encoded = fs.readFileSync(file, 'utf8');
    for (const text of ['SECRET_MUST_NOT_PERSIST', 'PRIVATE_PERSONALITY_MUST_NOT_PERSIST', 'PUBLIC_TEXT_MUST_NOT_PERSIST', 'PUBLIC_AUTHOR_MUST_NOT_PERSIST']) {
      eq(encoded.includes(text), false, 'admission storage contains no provider secrets or text');
    }
    eq(Object.keys(admission.signal.policy).sort(), ['kind', 'version', 'activeProfiles', 'sampleCount', 'sampleAt',
      'p75RequestMs', 'low', 'high', 'gapMs'].sort(), 'frozen policy contains only allowlisted aggregate counts and timings');
    rejects(() => population.ensure({ ...admission, signal: { ...admission.signal,
      policy: { ...admission.signal.policy, gapMs: MINUTE_MS } } }), 'forged interval cannot be replayed');
    rejects(() => population.ensure({ ...admission, signal: { ...admission.signal,
      policy: { ...admission.signal.policy, low: 99 } } }), 'forged thresholds cannot be replayed');
    at = admission.admittedAt + 30 * MINUTE_MS;
    eq(population.excludedThreadIds(), [], 'thread exclusion terminates at thirty minutes');
    at = later.admittedAt + HOUR_MS;
    const afterDowntime = create({ file });
    const current = await afterDowntime.getSignal(context(30));
    const resumed = afterDowntime.reserve('p_new', { signal: current });
    eq(!!resumed, true, 'one opportunity can resume after downtime');
    eq(afterDowntime.reserve('p_immediate', { signal: current }), null, 'restart never repays missed intervals in a catch-up burst');
    at -= 1;
    eq(afterDowntime.canAdmit('p_clock', { signal: current }), false, 'clock reversal conservatively holds admissions');

    at = initialAt;
    const stale = create();
    const fresh = await stale.getSignal(context(30));
    at += POLL_MS;
    eq(stale.reserve('p_stale', { signal: fresh }), null, 'cached public signal cannot admit once freshness expires');
    const oldCapacity = structuredClone(fresh);
    oldCapacity.observedAt = at;
    oldCapacity.windowUntil = at;
    oldCapacity.windowSince = at - HOUR_MS;
    at += policy.CAPACITY_FRESH_MS;
    oldCapacity.observedAt = at;
    oldCapacity.windowUntil = at;
    oldCapacity.windowSince = at - HOUR_MS;
    eq(stale.reserve('p_old_capacity', { signal: oldCapacity }), null, 'stale measured capacity cannot be smuggled through a fresh public signal');
    rejects(() => stale.ensure({ ...coherent, admittedAt: at, signal: oldCapacity }), 'stale capacity cannot be restored as a valid frozen admission');
    const unknown = create({ request: async () => ({ ok: true, data: { ...snapshot(), coverage: { sampleTruncated: true, nsfwIncluded: false } } }) });
    eq((await unknown.getSignal(context(30))).quiet, false, 'incomplete public evidence suppresses scaled assistance');
    const offline = create({ request: async () => { throw new Error('fixture unavailable'); } });
    eq((await offline.getSignal(context(30))).quiet, false, 'unavailable public evidence cannot be rescued by population count');

    at = initialAt;
    const bounded = create();
    const template = bounded.reserve('p_bounds', { signal: await bounded.getSignal(context(30)) });
    for (let index = 0; index < ENTRY_CAP + 2; index++) {
      bounded.ensure({ ...template, id: 'q_' + (index + 1).toString(16).padStart(32, '0'), admittedAt: at + index + 1 });
    }
    eq(bounded.peek().modes.live.length, ENTRY_CAP, 'population admissions retain the existing bounded ledger');
    eq(bounded.peek().modes.rehearsal.length, 0, 'live population traffic never populates rehearsal state');
    const fenced = JSON.parse(fs.readFileSync(file, 'utf8'));
    fenced.version = 1;
    const brokenFile = path.join(directory, 'broken-fence.json');
    fs.writeFileSync(brokenFile, JSON.stringify(fenced));
    rejects(() => create({ file: brokenFile }).peek(), 'version one storage cannot silently reinterpret version two receipts');
    console.log('quiet population controller: ' + checks + ' checks passed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
