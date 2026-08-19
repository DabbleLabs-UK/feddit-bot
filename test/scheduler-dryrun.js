'use strict';

// Dry-run harness for lib/scheduler. Proves targeting, dedupe, thread cap,
// cadence/ceiling, 429 back-off AND the per-provider gate / spend guardrail /
// cost maths, with a FAKE clock, a deterministic RNG, an in-memory store, a
// STUB feddit client and STUB providers. No live generation, no live write, no
// disk, no timers. Run: node test/scheduler-dryrun.js
//
// It drives scheduler.runTick() directly (never start()), so nothing long-lived
// is spawned and the process exits on its own.

const scheduler = require('../lib/scheduler');
const cost = require('../lib/cost');

// ---- tiny assert framework --------------------------------------------------

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log('  PASS  ' + msg); }
  else { failures.push(msg); console.log('  FAIL  ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function approx(a, b, msg) { ok(Math.abs(a - b) < 1e-9, msg + '  (got ' + a + ', want ' + b + ')'); }

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
  const settings = {
    paused: false, dryRun: true, threadReplies: {}, threadOrder: [],
    monthlyCapUsd: 5, pricing: cost.defaultPricing(),
  };
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const schedDefaults = () => ({ nextPostAt: null, nextCommentAt: null, backoffUntil: 0, sentPosts: [], sentComments: [] });

  function profileSpend(profile, dayKey, monthKey) {
    const daily = (profile && profile.spendDaily) || {};
    let todayUsd = 0, todayGens = 0, monthUsd = 0, monthGens = 0;
    for (const k of Object.keys(daily)) {
      const b = daily[k] || {};
      if (k === dayKey) { todayUsd += b.usd || 0; todayGens += b.gens || 0; }
      if (k.slice(0, 7) === monthKey) { monthUsd += b.usd || 0; monthGens += b.gens || 0; }
    }
    return { todayUsd, todayGens, monthUsd, monthGens };
  }

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
    recordSpend: (id, { dayKey, usage, costUsd }) => {
      const p = byId.get(id); if (!p) return null;
      if (!p.spendDaily) p.spendDaily = {};
      const u = usage || {};
      let b = p.spendDaily[dayKey];
      if (!b) { b = { usd: 0, gens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }; p.spendDaily[dayKey] = b; }
      b.usd += Number(costUsd) || 0;
      b.gens += 1;
      b.inputTokens += Number(u.inputTokens) || 0;
      b.cachedInputTokens += Number(u.cachedInputTokens) || 0;
      b.outputTokens += Number(u.outputTokens) || 0;
      return b;
    },
    profileSpend,
    runnerSpend: (monthKey, dayKey) => {
      let monthUsd = 0, todayUsd = 0;
      for (const p of byId.values()) {
        const s = profileSpend(p, dayKey || '', monthKey);
        monthUsd += s.monthUsd; todayUsd += s.todayUsd;
      }
      return { monthUsd, todayUsd };
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
    provider: over.provider || 'ollama',
    model: 'stub-model',
    deepseekModel: over.deepseekModel || 'deepseek-v4-flash',
    temperature: 0.8,
    numPredict: 50,
    enabled: over.enabled !== false,
    activity: [],
    sched: over.sched || { nextPostAt: null, nextCommentAt: null, backoffUntil: 0, sentPosts: [], sentComments: [] },
    repliedTo: [],
    spendDaily: {},
    spendDays: [],
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

// ---- stub providers facade with per-provider concurrency assertions ---------
//
// Tracks in-flight generations SEPARATELY per provider so a test can prove the
// ollama single-flight gate never admits >1 while deepseek runs independently.
// stats() exposes ollama metrics at the top level (back-compat with the older
// scenarios) plus a per-provider breakdown.

function makeProviders(opts) {
  const cfg = opts || {};
  const o = { inFlight: 0, max: 0, calls: 0 };
  const d = { inFlight: 0, max: 0, calls: 0 };
  let ollamaBusyFlag = false;
  return {
    setOllamaBusy: (b) => { ollamaBusyFlag = b; },
    ollamaBusy: () => ollamaBusyFlag,
    generate: async (gopts) => {
      const prov = gopts.provider === 'deepseek' ? 'deepseek' : 'ollama';
      const s = prov === 'deepseek' ? d : o;
      s.inFlight++; s.max = Math.max(s.max, s.inFlight); s.calls++;
      await Promise.resolve(); // yield so any real concurrency would be observed
      s.inFlight--;
      const content = 'Generated line one\n\nGenerated body text for call ' + (o.calls + d.calls);
      const usage = prov === 'deepseek'
        ? { inputTokens: 1000, outputTokens: 500, cachedInputTokens: cfg.deepseekCached || 0 }
        : { inputTokens: 20, outputTokens: 30, cachedInputTokens: 0 };
      return { provider: prov, model: gopts.model, text: content, ms: 1, usage };
    },
    stats: () => ({
      calls: o.calls, maxConcurrent: o.max,
      ollama: { calls: o.calls, maxConcurrent: o.max },
      deepseek: { calls: d.calls, maxConcurrent: d.max },
    }),
  };
}

// ---- clock ------------------------------------------------------------------

function makeClock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

const KEY = () => 'stub-deepseek-key';

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
  const providers = makeProviders();
  const sched = scheduler.createScheduler({ store, providers, feddit, now: clock.now, random: rng(1), getDeepseekKey: KEY });

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
  eq(providers.stats().maxConcurrent, 1, 'never more than ONE ollama generation in flight');
}

// ============================================================================
// Scenario 2: cadence jitter + server ceiling (DRY-RUN)
// ============================================================================
async function scenarioCadenceCeiling() {
  console.log('\n[2] cadence jitter + server ceiling (dry-run)');

  const pool = [];
  for (let i = 1; i <= 400; i++) pool.push({ id: i, feddit: 'busy', title: 'p' + i, author: 'human' + (i % 7) });
  const world = { feddits: { busy: pool }, comments: {} };

  // 2a: modest rate -> a handful per hour, with VARYING gaps (jitter).
  {
    const clock = makeClock(2_000_000);
    const p = profile({ id: 'cad', fedditUsername: 'cad', mode: 'comment', commentsPerHour: 6, readFeddits: ['busy'] });
    p.sched.nextCommentAt = clock.now();
    const store = makeStore([p]);
    const sched = scheduler.createScheduler({ store, providers: makeProviders(), feddit: makeFeddit(world), now: clock.now, random: rng(7), getDeepseekKey: KEY });
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
    const sched = scheduler.createScheduler({ store, providers: makeProviders(), feddit: makeFeddit(world), now: clock.now, random: rng(3), getDeepseekKey: KEY });
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
  const sched = scheduler.createScheduler({ store, providers: makeProviders(), feddit: makeFeddit(world), now: clock.now, random: rng(5), getDeepseekKey: KEY });

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
  const providers = makeProviders();
  const sched = scheduler.createScheduler({ store, providers, feddit, now: clock.now, random: rng(9), getDeepseekKey: KEY });

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
  const genDuringBackoff = providers.stats().calls;

  // Advance past the reset and let the endpoint recover.
  clock.advance(61_000); // total 121s > 120s
  world.onComment = () => ({ ok: true, status: 201, data: { comment: { data: { id: 8000 } } } });
  await sched.runTick();
  eq(feddit.calls.comment.length, 2, 'resumed writing after the back-off elapsed');
  ok(store.hasReplied('rl', 't3_500'), 'recorded the target replied after the successful retry');
  ok(providers.stats().calls > genDuringBackoff, 'generation only resumed after back-off, not during it');
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
  const providers = makeProviders();
  const sched = scheduler.createScheduler({ store, providers, feddit: makeFeddit(world), now: clock.now, random: rng(2), getDeepseekKey: KEY });

  // Paused: does nothing.
  store.updateSettings({ paused: true });
  const rp = await sched.runTick();
  eq(rp.skipped, 'paused', 'while globally paused the tick does nothing');
  eq(providers.stats().calls, 0, 'no generation while paused');

  // Resume, then fire two ticks concurrently: the second must be refused.
  store.updateSettings({ paused: false });
  const [r1, r2] = await Promise.all([sched.runTick(), sched.runTick()]);
  const skipped = [r1, r2].filter((r) => r && r.skipped === 'reentrant').length;
  eq(skipped, 1, 'concurrent tick refused by the reentrancy guard (exactly one skipped)');
  eq(providers.stats().maxConcurrent, 1, 'still only ONE ollama generation in flight under concurrent ticks');
}

// ============================================================================
// Scenario 6: per-provider gate - deepseek is NOT blocked by the ollama gate,
// and the ollama gate still admits only one at a time.
// ============================================================================
async function scenarioProviderGate() {
  console.log('\n[6] per-provider gate: ollama gate does not block deepseek');

  // 6a: ollama's single-flight is BUSY (e.g. a UI test-generate / Cy). The
  // ollama profile is skipped, but the deepseek profile still generates.
  {
    const clock = makeClock(7_000_000);
    const world = { feddits: { x: [{ id: 1, feddit: 'x', title: 't1', author: 'human' }] }, comments: {} };
    const oll = profile({ id: 'oll', fedditUsername: 'oll', mode: 'comment', commentsPerHour: 60, readFeddits: ['x'], provider: 'ollama' });
    const ds = profile({ id: 'ds', fedditUsername: 'ds', mode: 'comment', commentsPerHour: 60, readFeddits: ['x'], provider: 'deepseek' });
    oll.sched.nextCommentAt = clock.now();
    ds.sched.nextCommentAt = clock.now();
    const store = makeStore([oll, ds]);
    const providers = makeProviders();
    providers.setOllamaBusy(true); // ollama gate busy
    const sched = scheduler.createScheduler({ store, providers, feddit: makeFeddit(world), now: clock.now, random: rng(11), getDeepseekKey: KEY });

    const r = await sched.runTick();
    ok(r.results.some((x) => x && x.skipped === 'ollama-busy' && x.id === 'oll'), 'ollama profile skipped while its gate is busy');
    eq(providers.stats().ollama.calls, 0, 'ollama did NOT generate while its gate was busy');
    eq(providers.stats().deepseek.calls, 1, 'DeepSeek generated ANYWAY - not blocked by the ollama gate');
  }

  // 6b: both providers due, ollama gate free. Both act in the SAME tick; the
  // ollama gate still admits at most one ollama generation at a time.
  {
    const clock = makeClock(8_000_000);
    const world = { feddits: { x: [{ id: 1, feddit: 'x', title: 't1', author: 'human' }] }, comments: {} };
    const oll1 = profile({ id: 'oll1', fedditUsername: 'oll1', mode: 'comment', commentsPerHour: 60, readFeddits: ['x'], provider: 'ollama' });
    const oll2 = profile({ id: 'oll2', fedditUsername: 'oll2', mode: 'comment', commentsPerHour: 60, readFeddits: ['x'], provider: 'ollama' });
    const ds = profile({ id: 'ds', fedditUsername: 'ds', mode: 'comment', commentsPerHour: 60, readFeddits: ['x'], provider: 'deepseek' });
    for (const p of [oll1, oll2, ds]) p.sched.nextCommentAt = clock.now();
    const store = makeStore([oll1, oll2, ds]);
    const providers = makeProviders();
    const sched = scheduler.createScheduler({ store, providers, feddit: makeFeddit(world), now: clock.now, random: rng(12), getDeepseekKey: KEY });

    const r = await sched.runTick();
    ok(r.acted >= 2, 'both providers acted in one tick (' + r.acted + ' actions)');
    eq(providers.stats().ollama.maxConcurrent, 1, 'ollama gate admitted only ONE generation at a time');
    ok(providers.stats().ollama.calls >= 1, 'at least one ollama generation ran');
    eq(providers.stats().deepseek.calls, 1, 'the deepseek profile generated concurrently');
  }
}

// ============================================================================
// Scenario 7: spend guardrail - over the monthly cap, DeepSeek profiles are
// skipped but ollama profiles keep running.
// ============================================================================
async function scenarioSpendCap() {
  console.log('\n[7] spend cap skips deepseek, not ollama');
  const clock = makeClock(1_600_000_000_000); // a real-ish epoch so day/month keys are sane
  const world = { feddits: { x: [{ id: 1, feddit: 'x', title: 't1', author: 'human' }] }, comments: {} };
  const oll = profile({ id: 'oll', fedditUsername: 'oll', mode: 'comment', commentsPerHour: 60, readFeddits: ['x'], provider: 'ollama' });
  const ds = profile({ id: 'ds', fedditUsername: 'ds', mode: 'comment', commentsPerHour: 60, readFeddits: ['x'], provider: 'deepseek' });
  oll.sched.nextCommentAt = clock.now();
  ds.sched.nextCommentAt = clock.now();
  const store = makeStore([oll, ds]);
  store.updateSettings({ monthlyCapUsd: 5 });
  // Seed month-to-date spend OVER the cap ($6 > $5).
  store.recordSpend('ds', { dayKey: cost.dayKey(clock.now()), usage: {}, costUsd: 6 });
  const providers = makeProviders();
  const sched = scheduler.createScheduler({ store, providers, feddit: makeFeddit(world), now: clock.now, random: rng(21), getDeepseekKey: KEY });

  const r = await sched.runTick();
  ok(r.results.some((x) => x && x.skipped === 'spend-cap' && x.id === 'ds'), 'deepseek profile skipped: over the monthly cap');
  eq(providers.stats().deepseek.calls, 0, 'no DeepSeek generation while over the cap (no money burned)');
  eq(providers.stats().ollama.calls, 1, 'ollama profile STILL generated (cap is money-only, ollama is free)');
  ok(r.spend && r.spend.overCap === true, 'tick reports overCap=true');

  // Raise the cap: deepseek resumes on the next tick (still under cap now).
  store.updateSettings({ monthlyCapUsd: 100 });
  clock.advance(3_600_000);
  await sched.runTick();
  eq(providers.stats().deepseek.calls, 1, 'DeepSeek generated once the cap was raised');
}

// ============================================================================
// Scenario 8: cost maths (pricing table) + end-to-end spend recording +
//             the deepseek concurrency cap in the real providers facade.
// ============================================================================
async function scenarioCostMaths() {
  console.log('\n[8] cost maths + spend recording + deepseek concurrency cap');
  const price = cost.defaultPricing();

  // v4-flash: 1000 input (0 cached) + 500 output = (1000*0.14 + 500*0.28)/1e6
  approx(cost.estimateCost('deepseek-v4-flash', { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 }, price),
    (1000 * 0.14 + 500 * 0.28) / 1e6, 'v4-flash cost = 0.00028');
  // v4-flash with 400 cached input: uncached 600 @ 0.14 + cached 400 @ 0.0028 + 500 @ 0.28
  approx(cost.estimateCost('deepseek-v4-flash', { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 400 }, price),
    (600 * 0.14 + 400 * 0.0028 + 500 * 0.28) / 1e6, 'v4-flash cached cost = 0.00022512');
  // v4-pro: (1000*0.435 + 500*0.87)/1e6
  approx(cost.estimateCost('deepseek-v4-pro', { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 }, price),
    (1000 * 0.435 + 500 * 0.87) / 1e6, 'v4-pro cost = 0.00087');
  // ollama / unknown model: no API cost
  eq(cost.estimateCost('some-ollama-model', { inputTokens: 1000, outputTokens: 500 }, price), 0, 'ollama model costs $0');

  // End-to-end: a deepseek generation records the right cost on the profile.
  {
    const clock = makeClock(1_600_000_000_000);
    const world = { feddits: { x: [{ id: 1, feddit: 'x', title: 't1', author: 'human' }] }, comments: {} };
    const ds = profile({ id: 'ds', fedditUsername: 'ds', mode: 'comment', commentsPerHour: 60, readFeddits: ['x'], provider: 'deepseek', deepseekModel: 'deepseek-v4-flash' });
    ds.sched.nextCommentAt = clock.now();
    const store = makeStore([ds]);
    const providers = makeProviders(); // returns deepseek usage { in:1000, out:500 }
    const sched = scheduler.createScheduler({ store, providers, feddit: makeFeddit(world), now: clock.now, random: rng(31), getDeepseekKey: KEY });
    await sched.runTick();
    const bucket = store.getProfile('ds').spendDaily[cost.dayKey(clock.now())];
    ok(bucket, 'a spend bucket was recorded for the deepseek generation');
    approx(bucket.usd, 0.00028, 'recorded cost matches v4-flash pricing (0.00028)');
    eq(bucket.gens, 1, 'recorded exactly one generation');
    approx(store.runnerSpend(cost.monthKey(clock.now()), cost.dayKey(clock.now())).monthUsd, 0.00028, 'runner month-to-date sums to 0.00028');
  }

  // The real providers facade caps concurrent deepseek generations at 3.
  {
    const providersReal = require('../lib/providers');
    const dsMod = require('../lib/providers/deepseek');
    const savedGen = dsMod.generate;
    let active = 0, maxActive = 0;
    const gates = [];
    dsMod.generate = () => {
      active++; maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => gates.push(() => { active--; resolve({ provider: 'deepseek', model: 'deepseek-v4-flash', text: '', usage: {}, ms: 0 }); }));
    };
    try {
      const runs = Array.from({ length: 6 }, () => providersReal.generate({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'k' }));
      // Let the semaphore admit its first batch.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      eq(active, providersReal.DEEPSEEK_MAX_CONCURRENT, 'exactly DEEPSEEK_MAX_CONCURRENT (' + providersReal.DEEPSEEK_MAX_CONCURRENT + ') deepseek calls in flight; the rest queued');
      // Drain, releasing one at a time so queued calls take freed slots.
      while (gates.length) { gates.shift()(); for (let i = 0; i < 4; i++) await Promise.resolve(); }
      await Promise.all(runs);
      eq(maxActive, providersReal.DEEPSEEK_MAX_CONCURRENT, 'concurrency never exceeded the cap of ' + providersReal.DEEPSEEK_MAX_CONCURRENT);
    } finally {
      dsMod.generate = savedGen; // restore
    }
  }
}

// ---- run --------------------------------------------------------------------

(async () => {
  await scenarioTargetingDedupe();
  await scenarioCadenceCeiling();
  await scenarioThreadCap();
  await scenario429Backoff();
  await scenarioPauseAndSingleFlight();
  await scenarioProviderGate();
  await scenarioSpendCap();
  await scenarioCostMaths();

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
