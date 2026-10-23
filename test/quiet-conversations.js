'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const quiet = require('../lib/quiet-conversations');
const { createQuietConversations, POLL_MS, GLOBAL_GAP_MS, PROFILE_GAP_MS, THREAD_GAP_MS, ENTRY_CAP } = quiet;
const HOUR_MS = 3600000;
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function rejects(fn, code, message) { assert.throws(fn, { code }, message); checks++; }

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-quiet-conversations-'));
  let at = Date.parse('2026-10-22T12:00:00Z');
  const iso = (value) => new Date(value).toISOString();
  const item = (id, type = 'comment', createdAt = at - 60000, postId = 99) => ({
    key: type + ':' + id, targetType: type, targetId: id, postId: type === 'post' ? id : postId,
    createdAt: iso(createdAt), title: 'DO NOT RETAIN PUBLIC TEXT', author: 'DO NOT RETAIN NAMES', votes: [{ reason: 'DO NOT RETAIN REASONS' }],
  });
  const snapshot = (comments = 0) => ({ schemaVersion: 1, source: 'feddit-current-votes', generatedAt: iso(at),
    window: { hours: 1, since: iso(at - HOUR_MS), until: iso(at) },
    coverage: { sampleTruncated: false, nsfwIncluded: false }, items: Array.from({ length: comments }, (_, i) => item(i + 1)),
  });
  let sequence = 0;
  const create = (options = {}) => createQuietConversations({ file: path.join(directory, 'state-' + (++sequence) + '.json'),
    enabled: true, request: async () => ({ ok: true, data: snapshot() }), now: () => at, ...options });
  const bookkeeping = 'QUIET_CONVERSATION_BOOKKEEPING_PENDING';
  try {
    eq(quiet.version(1), 1, 'contract is independently versioned');
    eq(quiet.version(2), 2, 'population-aware contract is independently supported');
    for (const value of [undefined, 0, 3, '1', null]) rejects(() => quiet.version(value), 'UNSUPPORTED_QUIET_CONVERSATION', 'unknown version never guesses semantics');

    let calls = 0;
    const disabledFile = path.join(directory, 'disabled.json');
    const disabled = create({ file: disabledFile, enabled: false, request: () => { calls++; throw new Error('must not call'); } });
    eq((await disabled.getSignal()).status, 'disabled', 'default-off control cannot fetch');
    eq(disabled.canAdmit('p_one'), false, 'disabled admission cannot start');
    eq(disabled.reserve('p_one'), null, 'disabled reserve cannot create bookkeeping');
    disabled.peek(); disabled.sortProfiles([{ id: 'p_one' }]); disabled.excludedThreadIds();
    eq(calls, 0, 'no background collection');
    eq(fs.existsSync(disabledFile), false, 'disabled reads do not create a file');
    const defaultOff = createQuietConversations({ file: disabledFile, request: () => { throw new Error('disabled'); }, now: () => at });
    eq((await defaultOff.getSignal()).status, 'disabled', 'enabled must be explicit');

    const oldRoots = snapshot(2);
    oldRoots.items.push(item(20, 'comment', at - 2 * HOUR_MS), item(21, 'post', at - 2 * HOUR_MS), item(22, 'post'));
    const controller = create({ request: async (url, options) => {
      calls++;
      eq(url, '/evidence.json?window_hours=1&limit=100', 'one bounded public read');
      eq(options, { timeoutMs: 4000, maxResponseBytes: 1048576 }, 'request is time and size bounded');
      return { ok: true, data: oldRoots };
    } });
    const signal = await controller.getSignal();
    eq(signal.comments, 2, 'recent comments on old roots count but old newly voted comments do not');
    eq(signal.roots, 1, 'root creation is diagnostic only');
    eq(signal.quiet, true, 'fewer than six real comments is quiet');
    const admission = controller.reserve('p_one', { signal });
    eq(admission.profileId, 'p_one', 'admission is attributed by stable profile identity');
    eq(controller.canAdmit('p_two'), false, 'global fifteen-minute admission gap');
    eq(controller.canAdmit('p_one'), false, 'WAIT still consumes admission budget');
    eq(controller.excludedThreadIds(), [], 'WAIT does not invent a selected thread');
    eq(controller.ensure(admission, 't_one').turnId, 't_one', 'durable turn binding persists');
    const unchanged = JSON.stringify(controller.peek());
    controller.ensure(admission, 't_one');
    eq(JSON.stringify(controller.peek()), unchanged, 'replay ensure is idempotent');
    rejects(() => controller.ensure(admission, 't_other'), bookkeeping, 'one admission cannot bind another turn');
    rejects(() => controller.ensure({ ...admission, profileId: 'p_other' }), bookkeeping, 'frozen profile cannot be reinterpreted');
    controller.recordTarget(admission, 99);
    const selectedAt = controller.peek().modes.live[0].selectedAt;
    at += GLOBAL_GAP_MS;
    controller.recordTarget(admission, 99);
    eq(controller.peek().modes.live[0].selectedAt, selectedAt, 'replay cannot extend thread cooldown');
    rejects(() => controller.recordTarget(admission, 100), bookkeeping, 'one admission cannot change target');
    eq(controller.canAdmit('p_two'), true, 'next bot may use spare opportunity at fifteen minutes');
    eq(controller.canAdmit('p_one'), false, 'same bot waits one hour');
    eq(controller.excludedThreadIds(), [99], 'recently selected thread excluded only for extra lane');
    at = admission.admittedAt + THREAD_GAP_MS;
    eq(controller.excludedThreadIds(), [], 'thread may naturally return after thirty minutes');
    at = admission.admittedAt + PROFILE_GAP_MS;
    eq(controller.canAdmit('p_one'), true, 'same bot becomes eligible after one hour');
    at = admission.admittedAt - 1;
    eq(controller.canAdmit('p_one'), false, 'clock reversal does not create catch-up admission');
    eq(controller.excludedThreadIds(), [99], 'clock reversal conservatively holds thread exclusion');
    at = admission.admittedAt;
    eq(controller.sortProfiles([{ id: 'p_one' }, { id: 'p_two' }, { id: 'p_three' }]).map((entry) => entry.id),
      ['p_two', 'p_three', 'p_one'], 'unused bots rotate before recent users without changing tie order');

    const file = path.join(directory, 'restart.json');
    const original = create({ file });
    const saved = original.reserve('p_live', { signal: await original.getSignal() });
    original.recordTarget(saved, 101);
    const restarted = create({ file });
    eq(restarted.peek(), original.peek(), 'all cooldown and target evidence survives restart');
    eq(restarted.canAdmit('p_other'), false, 'restart never resets global admission gap');
    eq(restarted.canAdmit('p_other', { simulation: true }), true, 'rehearsal admission is isolated');
    const rehearsal = restarted.reserve('p_rehearsal', { simulation: true, signal: await restarted.getSignal() });
    restarted.recordTarget(rehearsal, 202);
    eq(restarted.excludedThreadIds(), [101], 'live thread ledger ignores rehearsal');
    eq(restarted.excludedThreadIds({ simulation: true }), [202], 'rehearsal ignores live thread ledger');
    const loadedDisabled = create({ file, enabled: false });
    eq(loadedDisabled.ensure(saved).postId, 101, 'frozen admitted turns replay even after assistance disabled');
    loadedDisabled.recordTarget(saved, 101);
    const recovered = create();
    eq(recovered.ensure(saved, 't_recovered').id, saved.id, 'frozen admission can restore lost pre-binding bookkeeping');
    eq(recovered.ensure(saved, 't_recovered').id, saved.id, 'restored frozen admission remains idempotent');
    const excluded = { ...saved, id: 'q_' + 'e'.repeat(32), excludedThreadIds: [303] };
    rejects(() => recovered.recordTarget(excluded, 303), bookkeeping, 'extra lane cannot bypass its own frozen thread exclusions');
    const stored = fs.readFileSync(file, 'utf8');
    for (const forbidden of ['DO NOT RETAIN', 'PRIVATE', 'votes', 'author', 'reason', 'title']) {
      eq(stored.includes(forbidden), false, 'state stores only bounded content-free admission facts');
    }
    if (process.platform !== 'win32') eq(fs.statSync(file).mode & 0o777, 0o600, 'private state file permissions');

    let comments = 5;
    const latch = create({ request: async () => ({ ok: true, data: snapshot(comments) }) });
    eq((await latch.getSignal()).quiet, true, 'quiet latch enters below six');
    comments = 8; at += POLL_MS;
    eq((await latch.getSignal()).quiet, true, 'six-to-eight comments preserves recent quiet latch');
    comments = 9; at += POLL_MS;
    eq((await latch.getSignal()).quiet, false, 'busy site exits at nine');
    comments = 7; at += POLL_MS;
    eq((await latch.getSignal()).quiet, false, 'healthy latch holds through intermediate range');
    comments = 5; at += POLL_MS;
    eq((await latch.getSignal()).quiet, true, 'quiet can return naturally');
    comments = 7; at += 2 * POLL_MS + 1;
    eq((await latch.getSignal()).quiet, false, 'stale latch cannot manufacture quiet');
    let outage = false;
    comments = 5;
    const intermittent = create({ request: async () => {
      if (outage) return { ok: false, status: 503 };
      return { ok: true, data: snapshot(comments) };
    } });
    eq((await intermittent.getSignal()).quiet, true, 'recent valid low activity enters quiet');
    outage = true; at += POLL_MS;
    eq((await intermittent.getSignal()).quiet, false, 'unknown coverage suppresses all assistance immediately');
    outage = false; comments = 7; at += POLL_MS;
    eq((await intermittent.getSignal()).quiet, true, 'fresh valid intermediate count may retain at-most-ten-minute latch after an outage');

    const faults = [
      (data) => { data.coverage.sampleTruncated = true; },
      (data) => { delete data.coverage.sampleTruncated; },
      (data) => { data.coverage.nsfwIncluded = true; },
      (data) => { data.window.hours = 24; },
      (data) => { data.window.since = iso(at - HOUR_MS - 1); },
      (data) => { data.generatedAt = iso(at - 1); },
      (data) => { data.generatedAt = data.window.until = iso(at - 120001); data.window.since = iso(at - HOUR_MS - 120001); },
      (data) => { data.generatedAt = data.window.until = iso(at + 120001); data.window.since = iso(at - HOUR_MS + 120001); },
      (data) => { data.source = 'other'; },
      (data) => { data.schemaVersion = 2; },
      (data) => { data.items = [item(1), item(1)]; },
      (data) => { data.items = [item(1, 'unknown')]; },
      (data) => { data.items = [item(1, 'comment', at + 1)]; },
      (data) => { data.items = [item(1, 'comment', at, 0)]; },
      (data) => { data.items = [item(1, 'post')]; data.items[0].postId = 9; },
      (data) => { data.items = Array.from({ length: 101 }, (_, i) => item(i + 1)); },
      (data) => { data.items = [item(1)]; data.items[0].createdAt = 'not a timestamp'; },
    ];
    for (const mutate of faults) {
      const data = snapshot(); mutate(data);
      const invalid = create({ request: async () => ({ ok: true, data }) });
      const result = await invalid.getSignal();
      eq(result.status, 'unknown', 'malformed stale partial or future signal cannot authorize assistance');
      eq(invalid.reserve('p_one', { signal: result }), null, 'unknown coverage never grants an opportunity');
    }
    const freshIntermediate = create({ request: async () => ({ ok: true, data: snapshot(7) }) });
    eq((await freshIntermediate.getSignal()).quiet, false, 'new process starts healthy in hysteresis gap');
    let failCalls = 0;
    const unavailable = create({ request: async () => { failCalls++; throw new Error('credential=never retain'); } });
    eq((await unavailable.getSignal()).status, 'unknown', 'request failure fails closed');
    await unavailable.getSignal();
    eq(failCalls, 1, 'failed reads also obey five-minute cache without retry');
    at += POLL_MS;
    await unavailable.getSignal();
    eq(failCalls, 2, 'later scheduler read may request a new signal');
    let resolve;
    let sharedCalls = 0;
    const coalesced = create({ request: () => { sharedCalls++; return new Promise((done) => { resolve = done; }); } });
    const first = coalesced.getSignal();
    const second = coalesced.getSignal();
    eq(sharedCalls, 1, 'concurrent readers share one bounded public request');
    resolve({ ok: true, data: snapshot() });
    eq(await first, await second, 'coalesced readers receive same content-free result');
    const mutation = await coalesced.getSignal(); mutation.comments = 100;
    eq((await coalesced.getSignal()).comments, 0, 'external mutation cannot corrupt cached signal');

    const limited = create();
    let admitted = 0;
    for (let i = 0; i < 60; i++) {
      if (limited.reserve('p_' + i, { signal: await limited.getSignal() })) admitted++;
      at += 60000;
    }
    eq(admitted, 4, 'global budget allows at most four starts in a rolling hour');
    const stale = await limited.getSignal(); at += POLL_MS;
    eq(limited.reserve('p_new', { signal: stale }), null, 'expired cached signal cannot authorize admission');

    const bounded = create();
    let last;
    let oldest;
    for (let i = 0; i < ENTRY_CAP + 5; i++) {
      last = bounded.reserve('p_' + i, { signal: await bounded.getSignal() });
      if (!oldest) oldest = last;
      at += GLOBAL_GAP_MS;
    }
    eq(bounded.peek().modes.live.length, ENTRY_CAP, 'live admission state remains bounded');
    eq(bounded.peek().modes.live[0].id, last.id, 'newest admission survives deterministic eviction');
    eq(bounded.peek().modes.rehearsal.length, 0, 'bounding one mode does not invent other mode state');
    rejects(() => bounded.ensure(oldest, 't_outside_ledger'), bookkeeping, 'out-of-bound replay fails closed rather than claiming missing bookkeeping persisted');
    const invalidVersion = create();
    rejects(() => invalidVersion.ensure({ ...saved, version: 3 }), 'UNSUPPORTED_QUIET_CONVERSATION', 'future frozen descriptor is never replayed under a known contract');

    const corruptFile = path.join(directory, 'corrupt.json');
    fs.writeFileSync(corruptFile, '{broken');
    const corrupt = create({ file: corruptFile });
    rejects(() => corrupt.canAdmit('p_one'), bookkeeping, 'corrupt ledger is not silently reset');
    eq(fs.readFileSync(corruptFile, 'utf8'), '{broken', 'corrupt source stays available for recovery');
    const futureFile = path.join(directory, 'future.json');
    fs.writeFileSync(futureFile, JSON.stringify({ version: 3, modes: { live: [], rehearsal: [] } }));
    rejects(() => create({ file: futureFile }).canAdmit('p_one'), 'UNSUPPORTED_QUIET_CONVERSATION', 'future storage format is not downgraded');
    const failedFile = path.join(directory, 'failed.json');
    const failed = create({ file: failedFile });
    const write = fs.writeFileSync;
    const goodSignal = await failed.getSignal();
    fs.writeFileSync = () => { throw new Error('mock disk failure with PRIVATE credential'); };
    try { rejects(() => failed.reserve('p_one', { signal: goodSignal }), bookkeeping, 'failed persistence never grants extra work'); }
    finally { fs.writeFileSync = write; }
    eq(fs.existsSync(failedFile), false, 'failed temporary write did not advance persisted admission');
    rejects(() => failed.canAdmit('p_one'), bookkeeping, 'process remains fail closed after ambiguous bookkeeping failure');
    eq(create({ file: failedFile }).canAdmit('p_one'), true, 'clean restart verifies there was no confirmed admission');

    const renameFile = path.join(directory, 'rename.json');
    const renameFailure = create({ file: renameFile });
    const prior = renameFailure.reserve('p_one', { signal: await renameFailure.getSignal() });
    const beforeRename = fs.readFileSync(renameFile, 'utf8');
    at += GLOBAL_GAP_MS;
    const rename = fs.renameSync;
    const nextSignal = await renameFailure.getSignal();
    fs.renameSync = () => { throw new Error('mock rename failure'); };
    try { rejects(() => renameFailure.reserve('p_two', { signal: nextSignal }), bookkeeping, 'atomic replacement failure blocks opportunity'); }
    finally { fs.renameSync = rename; }
    eq(fs.readFileSync(renameFile, 'utf8'), beforeRename, 'failed replacement preserves complete prior state');
    eq(create({ file: renameFile }).peek().modes.live[0].id, prior.id, 'restart reads confirmed prior admission only');
    eq(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false, 'owned failed-write temporary files are cleaned');
    console.log('quiet conversations: ' + checks + ' checks passed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
