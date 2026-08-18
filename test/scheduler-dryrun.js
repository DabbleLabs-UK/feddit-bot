'use strict';

// Dry-run harness for lib/scheduler. Proves targeting, dedupe, thread cap,
// cadence/ceiling and 429 back-off with a FAKE clock, a deterministic RNG, an
// in-memory store, a STUB feddit client and a STUB ollama. No live generation,
// no live write, no disk, no timers. Run: node test/scheduler-dryrun.js
//
// It drives scheduler.runTick() directly (never start()), so nothing long-lived
// is spawned and the process exits on its own.

const scheduler = require('../lib/scheduler');

// ---- tiny assert framework --------------------------------------------------

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log('  PASS  ' + msg); }
  else { failures.push(msg); console.log('  FAIL  ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

// ---- deterministic RNG (mulberry32) -----------------------------------------

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- in-memory store (mirrors the store interface the scheduler uses) --------

function makeStore(profiles) {
  const settings = { paused: false, dryRun: true, threadReplies: {}, threadOrder: [] };
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const schedDefaults = () => ({ nextPostAt: null, nextCommentAt: null, backoffUntil: 0, sentPosts: [], sentComments: [] });
  return {
    DEFAULT_MODEL: 'stub-model',
    schedDefaults,
    listProfiles: () => [...byId.values()],
    getProfile: (id) => byId.get(id) || null,
    getSettings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch || {}),
    updateSched: (id, patch) => {
      const p = byId.get(id); if (!p) return null;
      p.sched = { ...schedDefaults(), ...(p.sched || {}), ...(patch || {}) };
      return p.sched;
    },
    hasReplied: (id, key) => { const p = byId.get(id); return !!(p && p.repliedTo && p.repliedTo.includes(key)); },
    recordReplied: (id, key) => {
      const p = byId.get(id); if (!p) return;
      p.repliedTo = p.repliedTo || [];
      if (!p.repliedTo.includes(key)) p.repliedTo.push(key);
    },
    getThreadReplyCount: (postId) => settings.threadReplies[String(postId)] || 0,
    bumpThreadReply: (postId) => {
      const k = String(postId);
      settings.threadReplies[k] = (settings.threadReplies[k] || 0) + 1;
      return settings.threadReplies[k];
    },
    logActivity: (id, entry) => {
      const p = byId.get(id); if (!p) return;
      p.activity = p.activity || [];
      p.activity.push(entry);
    },
  };
}

function profile(over) {
  return {
    id: over.id,
    displayName: over.id,
    fedditUsername: over.fedditUsername || over.id,
    token: over.token || 'feddit_stub',
    persona: 'a terse forum poster',
    toneNotes: '',
    readFeddits: over.readFeddits || [],
    postFeddits: over.postFeddits || [],
    mode: over.mode || 'both',
    postsPerHour: over.postsPerHour || 0,
    commentsPerHour: over.commentsPerHour || 0,
    model: 'stub-model',
    temperature: 0.8,
    numPredict: 50,
    enabled: over.enabled !== false,
    activity: [],
    sched: over.sched || { nextPostAt: null, nextCommentAt: null, backoffUntil: 0, sentPosts: [], sentComments: [] },
    repliedTo: [],
  };
}

// ---- stub feddit ------------------------------------------------------------

function postChild(p) {
  return { kind: 't3', data: { id: p.id, name: 't3_' + p.id, feddit: p.feddit, title: p.title, author: p.author, kind: 'text', selftext: p.body || '' } };
}
function commentChild(c) {
  return { kind: 't1', data: { id: c.id, name: 't1_' + c.id, post_id: c.postId, parent_id: null, author: c.author, body: c.body, replies: '' } };
}

function makeFeddit(world) {
  world.calls = { submit: [], comment: [] };
  const client = {
    feddit: async (name) => {
      const posts = world.feddits[name] || [];
      return { ok: true, status: 200, data: { kind: 'Listing', data: { after: null, children: posts.map(postChild) } } };
    },
    comments: async (postId) => {
      const cs = world.comments[postId] || [];
      return { ok: true, status: 200, data: { post: null, comments: { kind: 'Listing', data: { after: null, children: cs.map(commentChild) } } } };
    },
    submit: async (args) => { world.calls.submit.push(args); return world.onSubmit ? world.onSubmit(args) : { ok: true, status: 201, data: { post: { data: { id: 9999 } } } }; },
    comment: async (args) => { world.calls.comment.push(args); return world.onComment ? world.onComment(args) : { ok: true, status: 201, data: { comment: { data: { id: 8888 } } } }; },
  };
  client.calls = world.calls; // expose call log on the client too
  return client;
}

// ---- stub ollama with single-flight assertion -------------------------------

function makeOllama() {
  let inFlight = 0, maxConcurrent = 0, calls = 0;
  return {
    isBusy: () => false,
    generate: async (opts) => {
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight); calls++;
      await Promise.resolve(); // yield so any real concurrency would be observed
      inFlight--;
      // Post prompts expect "title\n\nbody"; give both shapes something usable.
      const content = 'Generated line one\n\nGenerated body text for call ' + calls;
      return { model: opts.model, content, ms: 1, evalCount: 5 };
    },
    stats: () => ({ maxConcurrent, calls }),
  };
}

// ---- clock ------------------------------------------------------------------

function makeClock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

// ============================================================================
// Scenario 1: targeting + dedupe + never-reply-to-own (DRY-RUN)
// ============================================================================
async function scenarioTargetingDedupe() {
  console.log('\n[1] targeting + dedupe + never-own (dry-run)');
  const clock = makeClock(1_000_000);
  const world = {
    feddits: {
      botlife: [
        { id: 1, feddit: 'botlife', title: 'post by other1', author: 'other1' },
        { id: 2, feddit: 'botlife', title: 'post by SELF', author: 'alpha' },   // own -> must be skipped
        { id: 3, feddit: 'botlife', title: 'post by other2', author: 'other2' },
        { id: 4, feddit: 'botlife', title: 'newest by other1', author: 'other1' },
      ],
    },
    comments: {},
  };
  const p = profile({ id: 'alpha', fedditUsername: 'alpha', mode: 'comment', commentsPerHour: 6, readFeddits: ['botlife'] });
  p.sched.nextCommentAt = clock.now(); // due now
  const store = makeStore([p]);
  const feddit = makeFeddit(world);
  const ollama = makeOllama();
  const sched = scheduler.createScheduler({ store, ollama, feddit, now: clock.now, random: rng(1) });

  const targets = [];
  for (let i = 0; i < 6; i++) {
    const r = await sched.runTick();
    if (r.results && r.results[0] && r.results[0].target) targets.push(r.results[0].target);
    clock.advance(3_000_000); // jump well past the next scheduled time so it's due again
  }

  eq(targets.length, 3, 'made exactly 3 replies (3 non-own posts available)');
  ok(!targets.includes('t3_2'), 'never targeted its OWN post (t3_2)');
  ok(new Set(targets).size === targets.length, 'no target was replied to twice (dedupe)');
  eq(JSON.stringify(targets), JSON.stringify(['t3_4', 't3_3', 't3_1']), 'targeted newest-first: t3_4, t3_3, t3_1');
  eq(world.calls.comment.length, 0, 'DRY-RUN made ZERO live comment writes');
  eq(world.calls.submit.length, 0, 'DRY-RUN made ZERO live post writes');
  eq(ollama.stats().maxConcurrent, 1, 'never more than ONE generation in flight');
}

// ============================================================================
// Scenario 2: cadence jitter + server ceiling (DRY-RUN)
// ============================================================================
async function scenarioCadenceCeiling() {
  console.log('\n[2] cadence jitter + server ceiling (dry-run)');

  // Large post pool so it never runs out of targets within an hour.
  const pool = [];
  for (let i = 1; i <= 400; i++) pool.push({ id: i, feddit: 'busy', title: 'p' + i, author: 'human' + (i % 7) });
  const world = { feddits: { busy: pool }, comments: {} };

  // 2a: modest rate -> a handful per hour, with VARYING gaps (jitter).
  {
    const clock = makeClock(2_000_000);
    const p = profile({ id: 'cad', fedditUsername: 'cad', mode: 'comment', commentsPerHour: 6, readFeddits: ['busy'] });
    p.sched.nextCommentAt = clock.now();
    const store = makeStore([p]);
    const sched = scheduler.createScheduler({ store, ollama: makeOllama(), feddit: makeFeddit(world), now: clock.now, random: rng(7) });
    const fireTimes = [];
    for (let s = 0; s < 3600; s += 15) { // simulate one hour in 15s ticks
      const r = await sched.runTick();
      if (r.acted) fireTimes.push(clock.now());
      clock.advance(15_000);
    }
    const gaps = fireTimes.slice(1).map((t, i) => (t - fireTimes[i]) / 1000);
    ok(fireTimes.length >= 3 && fireTimes.length <= 11, '6/hr -> ' + fireTimes.length + ' replies in the hour (3..11 expected with jitter)');
    const distinctGaps = new Set(gaps.map((g) => Math.round(g))).size;
    ok(distinctGaps > 1, 'inter-reply gaps VARY (jitter, not a metronome): gaps=' + gaps.map((g) => Math.round(g)).join(','));
    const minGap = Math.min(...gaps);
    ok(gaps.length === 0 || minGap >= 60 * 0.6 * 10, 'no gap below the jittered floor (~360s): min=' + Math.round(minGap) + 's');
  }

  // 2b: absurd configured rate -> effective capped at 60/hr by the ceiling.
  {
    const clock = makeClock(3_000_000);
    const p = profile({ id: 'greedy', fedditUsername: 'greedy', mode: 'comment', commentsPerHour: 100000, readFeddits: ['busy'] });
    p.sched.nextCommentAt = clock.now();
    const store = makeStore([p]);
    const sched = scheduler.createScheduler({ store, ollama: makeOllama(), feddit: makeFeddit(world), now: clock.now, random: rng(3) });
    let count = 0;
    for (let s = 0; s < 3600; s += 10) {
      const r = await sched.runTick();
      if (r.acted) count++;
      clock.advance(10_000);
    }
    ok(count <= 60, 'configured 100000/hr but ceiling held it to ' + count + ' in the hour (<= 60)');
    ok(count >= 55, 'still worked near the ceiling (' + count + ' >= 55), not starved');
  }
}

// ============================================================================
// Scenario 3: thread cap stops ping-pong between two of our profiles (DRY-RUN)
// ============================================================================
async function scenarioThreadCap() {
  console.log('\n[3] thread cap (anti ping-pong) (dry-run)');
  const clock = makeClock(4_000_000);
  const world = {
    feddits: { ring: [{ id: 100, feddit: 'ring', title: 'the one thread', author: 'human' }] },
    comments: {
      100: [
        { id: 201, postId: 100, author: 'human' },
        { id: 202, postId: 100, author: 'alpha' },
        { id: 203, postId: 100, author: 'beta' },
        { id: 204, postId: 100, author: 'human' },
        { id: 205, postId: 100, author: 'alpha' },
        { id: 206, postId: 100, author: 'beta' },
      ],
    },
  };
  const a = profile({ id: 'alpha', fedditUsername: 'alpha', mode: 'comment', commentsPerHour: 30, readFeddits: ['ring'] });
  const b = profile({ id: 'beta', fedditUsername: 'beta', mode: 'comment', commentsPerHour: 30, readFeddits: ['ring'] });
  a.sched.nextCommentAt = clock.now();
  b.sched.nextCommentAt = clock.now();
  const store = makeStore([a, b]);
  const sched = scheduler.createScheduler({ store, ollama: makeOllama(), feddit: makeFeddit(world), now: clock.now, random: rng(5) });

  for (let i = 0; i < 12; i++) { await sched.runTick(); clock.advance(600_000); }

  const cnt = store.getThreadReplyCount(100);
  eq(cnt, scheduler.THREAD_CAP, 'thread 100 capped at THREAD_CAP (' + scheduler.THREAD_CAP + ') this-runner replies');
  ok(cnt <= scheduler.THREAD_CAP, 'thread reply count never exceeded the cap');
}

// ============================================================================
// Scenario 4: 429 back-off uses the reset time and does not hammer (LIVE stub)
// ============================================================================
async function scenario429Backoff() {
  console.log('\n[4] 429 back-off using reset time (live writes to STUB)');
  const clock = makeClock(5_000_000);
  const world = {
    feddits: { botlife: [{ id: 500, feddit: 'botlife', title: 'target', author: 'human' }] },
    comments: {},
    onComment: () => rateLimited,
  };
  let rateLimited = { ok: false, status: 429, retryAfterSec: 120, error: 'Rate limited by Feddit (429), retry in 120s.' };
  const p = profile({ id: 'rl', fedditUsername: 'rl', mode: 'comment', commentsPerHour: 60, readFeddits: ['botlife'] });
  p.sched.nextCommentAt = clock.now();
  const store = makeStore([p]);
  store.updateSettings({ dryRun: false }); // LIVE so the write is attempted (against the stub)
  const feddit = makeFeddit(world);
  const ollama = makeOllama();
  const sched = scheduler.createScheduler({ store, ollama, feddit, now: clock.now, random: rng(9) });

  // Tick 1: attempts the write, gets 429, backs off 120s.
  await sched.runTick();
  const s1 = store.getProfile('rl').sched;
  eq(feddit.calls.comment.length, 1, 'attempted exactly one live comment before backing off');
  eq(s1.backoffUntil, clock.now() + 120_000, 'backoffUntil = now + 120s (parsed from the 429 reset)');
  ok(!store.hasReplied('rl', 't3_500'), 'did NOT mark the target replied on 429 (so it can retry)');

  // Advance 60s (< back-off): must NOT attempt another write.
  clock.advance(60_000);
  await sched.runTick();
  eq(feddit.calls.comment.length, 1, 'still 1 attempt during back-off window (no hammering)');
  const genDuringBackoff = ollama.stats().calls;

  // Advance past the reset and let the endpoint recover.
  clock.advance(61_000); // total 121s > 120s
  world.onComment = () => ({ ok: true, status: 201, data: { comment: { data: { id: 8000 } } } });
  await sched.runTick();
  eq(feddit.calls.comment.length, 2, 'resumed writing after the back-off elapsed');
  ok(store.hasReplied('rl', 't3_500'), 'recorded the target replied after the successful retry');
  ok(ollama.stats().calls > genDuringBackoff, 'generation only resumed after back-off, not during it');
}

// ============================================================================
// Scenario 5: pause + single-flight guard
// ============================================================================
async function scenarioPauseAndSingleFlight() {
  console.log('\n[5] global pause + reentrancy/single-flight guard');
  const clock = makeClock(6_000_000);
  const world = { feddits: { botlife: [{ id: 1, feddit: 'botlife', title: 't', author: 'human' }] }, comments: {} };
  const p = profile({ id: 'sf', fedditUsername: 'sf', mode: 'comment', commentsPerHour: 60, readFeddits: ['botlife'] });
  p.sched.nextCommentAt = clock.now();
  const store = makeStore([p]);
  const ollama = makeOllama();
  const sched = scheduler.createScheduler({ store, ollama, feddit: makeFeddit(world), now: clock.now, random: rng(2) });

  // Paused: does nothing.
  store.updateSettings({ paused: true });
  const rp = await sched.runTick();
  eq(rp.skipped, 'paused', 'while globally paused the tick does nothing');
  eq(ollama.stats().calls, 0, 'no generation while paused');

  // Resume, then fire two ticks concurrently: the second must be refused.
  store.updateSettings({ paused: false });
  const [r1, r2] = await Promise.all([sched.runTick(), sched.runTick()]);
  const skipped = [r1, r2].filter((r) => r && r.skipped === 'reentrant').length;
  eq(skipped, 1, 'concurrent tick refused by the reentrancy guard (exactly one skipped)');
  eq(ollama.stats().maxConcurrent, 1, 'still only ONE generation in flight under concurrent ticks');
}

// ---- run --------------------------------------------------------------------

(async () => {
  await scenarioTargetingDedupe();
  await scenarioCadenceCeiling();
  await scenarioThreadCap();
  await scenario429Backoff();
  await scenarioPauseAndSingleFlight();

  console.log('\n----------------------------------------');
  console.log(passed + ' checks passed, ' + failures.length + ' failed.');
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('ALL GREEN.');
  process.exit(0);
})().catch((e) => { console.error('harness crashed:', e); process.exit(2); });
