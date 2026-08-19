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
const gdelt = require('../lib/gdelt');
const cost = require('../lib/cost');
const store = require('../lib/store'); // migrateProfiles/referenceName are pure - no disk touched

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
    hasPostedNews: (id, key) => { const p = byId.get(id); return !!(p && p.postedNews && p.postedNews.includes(key)); },
    recordPostedNews: (id, key) => {
      const p = byId.get(id); if (!p) return;
      p.postedNews = p.postedNews || [];
      if (!p.postedNews.includes(key)) p.postedNews.push(key);
    },
    clearPostedNews: (id) => { const p = byId.get(id); if (!p) return; p.postedNews = []; p.newsDomainDaily = {}; p.newsDomainDays = []; },
    newsDomainCount: (profile, dayKey, domain) => {
      const daily = (profile && profile.newsDomainDaily) || {};
      const b = daily[dayKey] || {};
      return Number(b[String(domain || '').toLowerCase()]) || 0;
    },
    recordNewsDomain: (id, dayKey, domain) => {
      const p = byId.get(id); if (!p) return;
      if (!p.newsDomainDaily) p.newsDomainDaily = {};
      const dom = String(domain || '').toLowerCase();
      const b = p.newsDomainDaily[dayKey] || (p.newsDomainDaily[dayKey] = {});
      b[dom] = (Number(b[dom]) || 0) + 1;
      return b[dom];
    },
    setProbation: (id, patch) => {
      const p = byId.get(id); if (!p) return null;
      p.probation = { onProbation: null, checkedAt: 0, ...(p.probation || {}), ...(patch || {}) };
      return p.probation;
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
    fedditUsername: over.fedditUsername || over.id,
    token: over.token || 'feddit_stub',
    persona: 'a terse forum poster',
    toneNotes: '',
    readFeddits: over.readFeddits || [],
    postFeddits: over.postFeddits || [],
    mode: over.mode || 'both',
    linkNoContext: over.linkNoContext || 'headline',
    probation: over.probation || { onProbation: null, checkedAt: 0 },
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
    // ---- news config + state ----
    botType: over.botType || 'conversational',
    newsQuery: over.newsQuery || '',
    newsRoutingRules: over.newsRoutingRules || [],
    newsMaxAgeHours: over.newsMaxAgeHours != null ? over.newsMaxAgeHours : 24,
    newsMaxPerDomainPerDay: over.newsMaxPerDomainPerDay != null ? over.newsMaxPerDomainPerDay : 3,
    newsMinGapMinutes: over.newsMinGapMinutes != null ? over.newsMinGapMinutes : 0,
    newsDomainDenylist: over.newsDomainDenylist || [],
    newsPaywallFilter: over.newsPaywallFilter != null ? over.newsPaywallFilter : false,
    newsRequireImage: over.newsRequireImage || false,
    newsTitleStyle: over.newsTitleStyle || 'straight',
    newsTitleCustom: over.newsTitleCustom || '',
    newsLetBotChoose: over.newsLetBotChoose || false,
    postedNews: over.postedNews || [],
    newsDomainDaily: over.newsDomainDaily || {},
    newsDomainDays: over.newsDomainDays || [],
    spendDaily: {},
    spendDays: [],
  };
}

// Format an epoch-ms as a GDELT seendate string ("20260819T091500Z").
function seendateFrom(ms) {
  const s = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  return s.slice(0, 4) + s.slice(5, 7) + s.slice(8, 10) + 'T' + s.slice(11, 13) + s.slice(14, 16) + s.slice(17, 19) + 'Z';
}
function jsonBody(obj) { return Buffer.from(JSON.stringify(obj), 'utf8'); }

// ---- stub feddit ------------------------------------------------------------

function postChild(p) {
  // OG/link-preview keys are ALWAYS present (null on a text post), matching
  // Serialize::post - so classifyPost branches on og_status, never key existence.
  return { kind: 't3', data: {
    id: p.id, name: 't3_' + p.id, feddit: p.feddit, title: p.title, author: p.author,
    kind: p.link ? 'link' : 'text', selftext: p.body || '', url: p.url || '',
    thumbnail_url: p.thumbnail_url != null ? p.thumbnail_url : null,
    og_title: p.og_title != null ? p.og_title : null,
    og_description: p.og_description != null ? p.og_description : null,
    og_site_name: p.og_site_name != null ? p.og_site_name : null,
    og_status: p.og_status != null ? p.og_status : null,
  } };
}
function commentChild(c) {
  return { kind: 't1', data: { id: c.id, name: 't1_' + c.id, post_id: c.postId, parent_id: null, author: c.author, body: c.body, replies: '' } };
}

function makeFeddit(world) {
  world.calls = { submit: [], comment: [], createFeddit: [], botInfo: [] };
  const client = {
    feddit: async (name) => {
      const posts = world.feddits[name] || [];
      return { ok: true, status: 200, data: { kind: 'Listing', data: { after: null, children: posts.map(postChild) } } };
    },
    comments: async (postId) => {
      const cs = world.comments[postId] || [];
      return { ok: true, status: 200, data: { post: null, comments: { kind: 'Listing', data: { after: null, children: cs.map(commentChild) } } } };
    },
    // GET /u/{name}.json - returns the bot object (with its probation flag).
    // Default: off probation. Override via world.onBotInfo(name).
    botInfo: async (name) => {
      world.calls.botInfo.push(name);
      return world.onBotInfo ? world.onBotInfo(name) : { ok: true, status: 200, data: { probation: { on_probation: false } } };
    },
    submit: async (args) => { world.calls.submit.push(args); return world.onSubmit ? world.onSubmit(args) : { ok: true, status: 201, data: { post: { data: { id: 9999 } } } }; },
    comment: async (args) => { world.calls.comment.push(args); return world.onComment ? world.onComment(args) : { ok: true, status: 201, data: { comment: { data: { id: 8888 } } } }; },
    // Spy: the scheduler must NEVER call this (esp. on probation, where it is blocked).
    createFeddit: async (args) => { world.calls.createFeddit.push(args); return { ok: true, status: 201, data: { feddit: {} } }; },
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
  const prompts = []; // every prompt passed to generate(), for prompt-content asserts
  let ollamaBusyFlag = false;
  return {
    prompts,
    setOllamaBusy: (b) => { ollamaBusyFlag = b; },
    ollamaBusy: () => ollamaBusyFlag,
    generate: async (gopts) => {
      prompts.push(gopts.prompt || '');
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

// ============================================================================
// Scenario 9: the shared GDELT queue - 8s spacing across profiles, a plain-text
// 429 body handled without throwing (escalating back-off), and the per-query
// cache. Drives the REAL createGdelt() queue with a fake clock + stub fetch, so
// there is NO live network call here.
// ============================================================================
async function scenarioGdeltQueue() {
  console.log('\n[9] GDELT shared queue: 8s spacing + plain-text 429 back-off + cache');

  // 9a: three DISTINCT queries fired at once must be issued >= 8s apart.
  {
    const clock = makeClock(1_000_000);
    const issuedAt = [];
    const body = jsonBody({ articles: [{ url: 'https://x.com/a', title: 'A', seendate: '20200101T000000Z', domain: 'x.com' }] });
    const gd = gdelt.createGdelt({
      now: clock.now, sleep: async (ms) => clock.advance(ms), minSpacingMs: 8000,
      fetch: async () => { issuedAt.push(clock.now()); return { status: 200, arrayBuffer: async () => body }; },
    });
    const [r1, r2, r3] = await Promise.all([gd.fetchArticles('alpha'), gd.fetchArticles('bravo'), gd.fetchArticles('charlie')]);
    ok(r1.ok && r2.ok && r3.ok, 'all three queued GDELT requests succeeded');
    eq(issuedAt.length, 3, 'exactly three real requests were issued (queue serialised them)');
    const gaps = issuedAt.slice(1).map((t, i) => t - issuedAt[i]);
    ok(gaps.every((g) => g >= 8000), 'no two requests issued within 8s even with several due at once (gaps=' + gaps.join(',') + 'ms)');
  }

  // 9b: a plain-text 429 body is NOT JSON.parsed blindly - handled, and it backs
  // off so a follow-up does not immediately re-request.
  {
    const clock = makeClock(2_000_000);
    let fetchCount = 0;
    const gd = gdelt.createGdelt({
      now: clock.now, sleep: async (ms) => clock.advance(ms), minSpacingMs: 8000, backoffSteps: [15_000, 30_000],
      fetch: async () => { fetchCount++; return { status: 429, arrayBuffer: async () => Buffer.from('Too many requests. Please slow down.', 'utf8') }; },
    });
    let threw = false, res = null;
    try { res = await gd.fetchArticles('boom'); } catch { threw = true; }
    ok(!threw, 'plain-text 429 body did NOT throw (no blind JSON.parse)');
    ok(res && res.ok === false && res.rateLimited === true, '429 surfaced as { ok:false, rateLimited:true }');
    eq(fetchCount, 1, 'one request attempted');
    const res2 = await gd.fetchArticles('boom-different');
    ok(res2 && res2.backoff === true, 'a follow-up while backed off short-circuits (no request)');
    eq(fetchCount, 1, 'no new request issued during the back-off window (no hammering)');
  }

  // 9c: an HTML error page (status 200 but non-JSON) is also treated as rate limiting.
  {
    const clock = makeClock(3_000_000);
    const gd = gdelt.createGdelt({
      now: clock.now, sleep: async (ms) => clock.advance(ms),
      fetch: async () => ({ status: 200, arrayBuffer: async () => Buffer.from('<html><body>error</body></html>', 'utf8') }),
    });
    const res = await gd.fetchArticles('htmlerr');
    ok(res && res.ok === false && res.rateLimited === true, 'HTML (non-JSON) 200 body treated as rate limiting, not parsed');
  }

  // 9d: overlapping/identical queries are served from the ~15min cache.
  {
    const clock = makeClock(4_000_000);
    let fetchCount = 0;
    const body = jsonBody({ articles: [{ url: 'https://y.com/1', title: 'Y', seendate: '20200101T000000Z', domain: 'y.com' }] });
    const gd = gdelt.createGdelt({
      now: clock.now, sleep: async (ms) => clock.advance(ms), cacheTtlMs: 900_000,
      fetch: async () => { fetchCount++; return { status: 200, arrayBuffer: async () => body }; },
    });
    await gd.fetchArticles('same');
    const b = await gd.fetchArticles('same');
    eq(fetchCount, 1, 'two calls for the same query hit the API only once (per-query cache)');
    ok(b.cached === true, 'the second identical query was a cache hit');
  }
}

// ============================================================================
// Scenario 10: news end-to-end (dry-run) - routing rules, freshness cap,
// per-domain daily cap, and PERMANENT canonical-URL dedupe that survives a
// simulated restart. Uses random:()=>0 so the "top of the ranked list" pick is
// deterministic.
// ============================================================================
async function scenarioNews() {
  console.log('\n[10] news: routing + freshness + dedupe-across-restart + per-domain cap (dry-run)');
  const H = 3_600_000;
  const clock = makeClock(1_600_000_000_000);
  const rules = [
    { keywords: ['mega'], subFeddit: 'mega', weight: 9 },
    { keywords: ['rocket', 'launch'], subFeddit: 'space', weight: 5 },
    { keywords: ['sport', 'score', 'final'], subFeddit: 'sports', weight: 3 },
  ];
  const M = { url: 'https://megablog.com/mega', domain: 'megablog.com', title: 'Rocket launch mega event', seendate: seendateFrom(clock.now() - 48 * H) }; // too old
  const A = { url: 'https://space.com/rocket?utm_source=x&id=7#frag', domain: 'space.com', title: 'Rocket launch success', seendate: seendateFrom(clock.now() - 1 * H) };
  const C = { url: 'https://espn.com/final', domain: 'espn.com', title: 'Sports final score tonight', seendate: seendateFrom(clock.now() - 2 * H) };
  const articles = [M, A, C];
  const gd = gdelt.createGdelt({ now: clock.now, sleep: async (ms) => clock.advance(ms), minSpacingMs: 0, fetch: async () => ({ status: 200, arrayBuffer: async () => jsonBody({ articles }) }) });

  // Routing is deterministic - assert it directly via the exported matcher.
  eq(scheduler.matchRule(M, rules).subFeddit, 'mega', 'routing: mega article -> f/mega (weight 9)');
  eq(scheduler.matchRule(A, rules).subFeddit, 'space', 'routing: rocket article -> f/space (weight 5)');
  eq(scheduler.matchRule(C, rules).subFeddit, 'sports', 'routing: sports article -> f/sports (weight 3)');
  // The canonical key strips utm_* and the #fragment (but keeps ?id=7).
  eq(gd.canonicalUrl(A.url), 'https://space.com/rocket?id=7', 'canonical URL strips utm_* + fragment, keeps host/path/id');

  const p = profile({ id: 'news1', botType: 'news', mode: 'post', postsPerHour: 60, provider: 'ollama', newsQuery: 'rocket', newsRoutingRules: rules, newsMaxAgeHours: 24, newsMaxPerDomainPerDay: 5, newsMinGapMinutes: 0 });
  p.sched.nextPostAt = clock.now();
  const store = makeStore([p]);
  const keyA = gd.canonicalUrl(A.url);

  // Run 1: freshest highest-weight FRESH article is A (mega is too old) -> f/space.
  const fed1 = makeFeddit({ feddits: {}, comments: {} });
  const s1 = scheduler.createScheduler({ store, providers: makeProviders(), feddit: fed1, gdelt: gd, now: clock.now, random: () => 0, getDeepseekKey: KEY });
  const r1 = await s1.runTick();
  const a1 = r1.results.find((x) => x && x.action === 'news');
  eq(a1.feddit, 'space', 'run1 posted the fresh w5 rocket article to f/space (stale w9 mega excluded)');
  eq(a1.canonical, keyA, 'run1 dedupe key is the canonical A url');
  eq(fed1.calls.submit.length, 0, 'dry-run: ZERO live submits');
  ok(store.hasPostedNews('news1', keyA), 'dry-run recorded A in the PERMANENT news dedupe set');

  // Run 2: simulate a RESTART (brand-new scheduler, same persisted store). A must
  // NOT be reposted; the next candidate C posts to f/sports.
  clock.advance(60_000); p.sched.nextPostAt = clock.now();
  const fed2 = makeFeddit({ feddits: {}, comments: {} });
  const s2 = scheduler.createScheduler({ store, providers: makeProviders(), feddit: fed2, gdelt: gd, now: clock.now, random: () => 0, getDeepseekKey: KEY });
  const r2 = await s2.runTick();
  const a2 = r2.results.find((x) => x && x.action === 'news');
  eq(a2.feddit, 'sports', 'run2 (post-restart) posted C to f/sports - A was NOT reposted');
  ok(a2.canonical !== keyA, 'run2 chose a different article (canonical dedupe held across the restart)');

  // Run 3: only the stale mega article is left -> nothing postable (freshness).
  clock.advance(60_000); p.sched.nextPostAt = clock.now();
  const s3 = scheduler.createScheduler({ store, providers: makeProviders(), feddit: makeFeddit({ feddits: {}, comments: {} }), gdelt: gd, now: clock.now, random: () => 0, getDeepseekKey: KEY });
  const r3 = await s3.runTick();
  const a3 = r3.results.find((x) => x && x.action === 'news');
  eq(a3.note, 'none', 'run3 posted nothing: only the stale mega article remained (freshness cap held)');
  ok(!store.hasPostedNews('news1', gd.canonicalUrl(M.url)), 'the stale mega article was never posted');

  // Per-domain daily cap: two fresh same-domain articles, cap 1 -> only one posts.
  {
    const clock2 = makeClock(1_600_000_000_000);
    const d1 = { url: 'https://dup.com/1', domain: 'dup.com', title: 'Dup one', seendate: seendateFrom(clock2.now() - 1 * H) };
    const d2 = { url: 'https://dup.com/2', domain: 'dup.com', title: 'Dup two', seendate: seendateFrom(clock2.now() - 1 * H) };
    const gdD = gdelt.createGdelt({ now: clock2.now, sleep: async (ms) => clock2.advance(ms), minSpacingMs: 0, fetch: async () => ({ status: 200, arrayBuffer: async () => jsonBody({ articles: [d1, d2] }) }) });
    const pd = profile({ id: 'newsD', botType: 'news', mode: 'post', postsPerHour: 60, newsQuery: 'dup', newsRoutingRules: [{ keywords: [], subFeddit: 'dump', weight: 1 }], newsMaxAgeHours: 24, newsMaxPerDomainPerDay: 1, newsMinGapMinutes: 0 });
    pd.sched.nextPostAt = clock2.now();
    const storeD = makeStore([pd]);
    const sd1 = scheduler.createScheduler({ store: storeD, providers: makeProviders(), feddit: makeFeddit({ feddits: {}, comments: {} }), gdelt: gdD, now: clock2.now, random: () => 0, getDeepseekKey: KEY });
    const rd1 = await sd1.runTick();
    eq(rd1.results.find((x) => x && x.action === 'news').domain, 'dup.com', 'domain-cap run1 posted a dup.com article');
    clock2.advance(60_000); pd.sched.nextPostAt = clock2.now();
    const sd2 = scheduler.createScheduler({ store: storeD, providers: makeProviders(), feddit: makeFeddit({ feddits: {}, comments: {} }), gdelt: gdD, now: clock2.now, random: () => 0, getDeepseekKey: KEY });
    const rd2 = await sd2.runTick();
    eq(rd2.results.find((x) => x && x.action === 'news').note, 'none', 'domain-cap run2 posted nothing: dup.com daily cap (1) already reached');
  }
}

// ============================================================================
// Scenario 11: the "let the bot choose" shortlist toggle falls back cleanly to
// the code-picked article when the model's index reply is unparseable.
// ============================================================================
async function scenarioShortlistFallback() {
  console.log('\n[11] news shortlist toggle: clean fallback on an unparseable index');
  const H = 3_600_000;
  const clock = makeClock(1_600_000_000_000);
  const art = { url: 'https://news.org/story', domain: 'news.org', title: 'Something happened today', seendate: seendateFrom(clock.now() - 1 * H) };
  const gd = gdelt.createGdelt({ now: clock.now, sleep: async (ms) => clock.advance(ms), minSpacingMs: 0, fetch: async () => ({ status: 200, arrayBuffer: async () => jsonBody({ articles: [art] }) }) });

  // A provider stub whose replies contain NO digit, so the shortlist index can't
  // be parsed (forcing the fallback). Both generations return the same text.
  let gens = 0;
  const providers = {
    ollamaBusy: () => false,
    generate: async (g) => { gens++; return { provider: 'ollama', model: g.model, text: 'honestly they all look good to me', ms: 1, usage: { inputTokens: 10, outputTokens: 6, cachedInputTokens: 0 } }; },
    stats: () => ({ calls: gens, ollama: { calls: gens, maxConcurrent: 1 }, deepseek: { calls: 0, maxConcurrent: 0 }, maxConcurrent: 1 }),
  };
  const p = profile({ id: 'nl', botType: 'news', mode: 'post', postsPerHour: 60, newsQuery: 'q', newsLetBotChoose: true, newsRoutingRules: [{ keywords: [], subFeddit: 'general', weight: 1 }], newsMaxAgeHours: 24, newsMinGapMinutes: 0 });
  p.sched.nextPostAt = clock.now();
  const store = makeStore([p]);
  const sched = scheduler.createScheduler({ store, providers, feddit: makeFeddit({ feddits: {}, comments: {} }), gdelt: gd, now: clock.now, random: () => 0, getDeepseekKey: KEY });

  let threw = false, r = null;
  try { r = await sched.runTick(); } catch { threw = true; }
  ok(!threw, 'unparseable shortlist index did not throw');
  const a = r.results.find((x) => x && x.action === 'news');
  ok(a && a.ok === true && a.title, 'still posted using the code-picked article (clean fallback)');
  eq(gens, 2, 'exactly two generations: one shortlist pick (unparseable) + one title');
  eq(a.feddit, 'general', 'posted to the catch-all route');
}

// ============================================================================
// Scenario 12: best-effort LIVE smoke test. At most ONE real GDELT call and ONE
// short real ollama generation in total. Both are guarded: unreachable => SKIP
// (not a failure), so the suite stays green offline.
// ============================================================================
async function scenarioRealSmoke() {
  console.log('\n[12] best-effort live smoke (at most ONE real GDELT call + ONE real ollama gen)');
  const providersReal = require('../lib/providers');
  const timeout = (ms) => new Promise((res) => setTimeout(() => res({ __timeout: true }), ms));

  try {
    const r = await Promise.race([gdelt.fetchArticles('technology', { maxRecords: 1, timespanHours: 24 }), timeout(9000)]);
    if (r && r.__timeout) console.log('  SKIP  real GDELT call timed out (offline?) - not a failure');
    else if (r && r.ok) { console.log('  PASS  real GDELT returned ' + r.articles.length + ' article(s)'); passed++; }
    else console.log('  SKIP  real GDELT not ok (' + JSON.stringify(r).slice(0, 90) + ') - not a failure');
  } catch (e) { console.log('  SKIP  real GDELT threw: ' + e.message + ' - not a failure'); }

  try {
    const g = await Promise.race([providersReal.ollama.generate({ system: 'You are terse.', prompt: 'Say hi in one word.', numPredict: 5, temperature: 0 }), timeout(9000)]);
    if (g && g.__timeout) console.log('  SKIP  real ollama gen timed out - not a failure');
    else if (g && typeof g.text === 'string') { console.log('  PASS  real ollama gen: ' + JSON.stringify(g.text.slice(0, 40))); passed++; }
    else console.log('  SKIP  real ollama gen returned nothing - not a failure');
  } catch (e) { console.log('  SKIP  real ollama unavailable: ' + e.message + ' - not a failure'); }
}

// ============================================================================
// Scenario 13: store-level profile migration (displayName scrapped -> reference
// name model). Pure - exercises store.migrateProfiles / store.referenceName only.
// ============================================================================
function scenarioProfileMigration() {
  console.log('\n[13] profile migration: displayName scrapped, reference-name model');

  // Old records as they'd sit on disk: BOTH carry the now-obsolete displayName;
  // one is registered (has a username), one is not.
  const migrated = store.migrateProfiles([
    { id: 'a', displayName: 'Cy Inmate', fedditUsername: 'cy_inmate7734', token: 't' },
    { id: 'b', displayName: 'SEA_IS_FLAT', fedditUsername: '' },
  ]);
  const a = migrated[0];
  const b = migrated[1];

  // displayName is gone for good on every record - not hidden, not deprecated.
  ok(!('displayName' in a), 'registered record: displayName removed entirely');
  ok(!('displayName' in b), 'unregistered record: displayName removed entirely');

  // A registered profile's reference name IS its username (the temp name model
  // does not apply once a username exists).
  eq(store.referenceName(a), 'cy_inmate7734', 'registered: reference name is the Feddit username');
  eq(a.fedditUsername, 'cy_inmate7734', 'registered: username preserved (no data loss)');

  // An unregistered profile gets an obviously-temporary reference name that does
  // NOT look like a real Feddit username.
  eq(b.fedditUsername, '', 'unregistered: still has no username');
  eq(b.refName, 'unregistered-1', 'unregistered: assigned a temporary reference name');
  eq(store.referenceName(b), 'unregistered-1', 'unregistered: reference name is the temp name');
  ok(/^unregistered-\d+$/.test(b.refName), 'temp name is obviously temporary, not a real-looking username');

  // Defaults are backfilled onto old records (e.g. botType) - no crash, no missing fields.
  eq(a.botType, 'conversational', 'migration backfills new default fields onto old records');
  ok(Array.isArray(b.postedNews), 'migration backfills array defaults too');

  // Two unregistered records must get DISTINCT temp names (no collision)...
  const two = store.migrateProfiles([
    { id: 'x', fedditUsername: '' },
    { id: 'y', fedditUsername: '' },
  ]);
  ok(two[0].refName !== two[1].refName, 'two unregistered profiles get distinct temp names');
  eq(JSON.stringify([two[0].refName, two[1].refName]), JSON.stringify(['unregistered-1', 'unregistered-2']),
    'temp names are numbered in order');

  // ...and a fresh temp name must never collide with one already on disk.
  const mixed = store.migrateProfiles([
    { id: 'p', fedditUsername: '', refName: 'unregistered-1' }, // already had one
    { id: 'q', fedditUsername: '' },                            // needs a new one
  ]);
  eq(mixed[0].refName, 'unregistered-1', 'existing temp name is preserved, not reissued');
  ok(mixed[1].refName !== 'unregistered-1', 'new temp name does not collide with an existing one');

  // referenceName(): a username always wins over any lingering temp name.
  eq(store.referenceName({ fedditUsername: 'real_user', refName: 'unregistered-9' }), 'real_user',
    'referenceName: username takes precedence over a temp name');

  // Robust against junk input.
  eq(JSON.stringify(store.migrateProfiles([])), '[]', 'migrateProfiles([]) is empty, no crash');
  eq(JSON.stringify(store.migrateProfiles(null)), '[]', 'migrateProfiles(null) is empty, no crash');
}

// ============================================================================
// Scenario 14: PROBATION ceilings - a freshly registered bot is held to 2
// posts/hr and 5 comments/hr (vs the normal 10 / 60), and the scheduler never
// tries to create a sub-feddit (blocked on probation). Proven by contrast: the
// SAME absurd configured rate produces far more output once probation clears.
// ============================================================================
async function scenarioProbationCeilings() {
  console.log('\n[14] probation ceilings: 2 posts/hr + 5 comments/hr (vs 10 / 60)');

  const pool = [];
  for (let i = 1; i <= 400; i++) pool.push({ id: i, feddit: 'busy', title: 'p' + i, author: 'human' + (i % 7) });
  // botInfo that always reports ON probation, so the state holds across the whole
  // simulated hour (the periodic re-check re-confirms it rather than clearing it).
  const onProb = () => ({ ok: true, status: 200, data: { probation: { on_probation: true } } });

  // Simulate one hour of comment ticks and count how many actually fired.
  async function commentHour(onBotInfo, seed) {
    const clock = makeClock(2_000_000);
    const world = { feddits: { busy: pool }, comments: {}, onBotInfo };
    const p = profile({ id: 'pc', fedditUsername: 'pc', mode: 'comment', commentsPerHour: 100000, readFeddits: ['busy'] });
    p.sched.nextCommentAt = clock.now();
    const store = makeStore([p]);
    const feddit = makeFeddit(world);
    const sched = scheduler.createScheduler({ store, providers: makeProviders(), feddit, now: clock.now, random: rng(seed), getDeepseekKey: KEY });
    let count = 0;
    for (let s = 0; s < 3600; s += 10) {
      const r = await sched.runTick();
      if (r.acted) count++;
      clock.advance(10_000);
    }
    return { count, feddit, store };
  }

  // Simulate one hour of post ticks and count how many actually fired.
  async function postHour(onBotInfo, seed) {
    const clock = makeClock(2_000_000);
    const world = { feddits: {}, comments: {}, onBotInfo };
    const p = profile({ id: 'pp', fedditUsername: 'pp', mode: 'post', postsPerHour: 100000, postFeddits: ['busy'] });
    p.sched.nextPostAt = clock.now();
    const store = makeStore([p]);
    const feddit = makeFeddit(world);
    const sched = scheduler.createScheduler({ store, providers: makeProviders(), feddit, now: clock.now, random: rng(seed), getDeepseekKey: KEY });
    let count = 0;
    for (let s = 0; s < 3600; s += 10) {
      const r = await sched.runTick();
      if (r.acted) count++;
      clock.advance(10_000);
    }
    return { count, feddit, store };
  }

  // Comments: on probation the effective ceiling is 5/hr.
  const cProb = await commentHour(onProb, 71);
  ok(cProb.count <= 5, 'on probation, 100000/hr configured but held to ' + cProb.count + ' comments in the hour (<= 5)');
  ok(cProb.count >= 3, 'still worked near the probation ceiling (' + cProb.count + ' >= 3), not starved');
  eq(cProb.store.getProfile('pc').probation.onProbation, true, 'the profile was observed ON probation');
  ok(cProb.feddit.calls.botInfo.length >= 1, 'probation was read from GET /u/{bot}.json');
  eq(cProb.feddit.calls.createFeddit.length, 0, 'never attempted to create a sub-feddit (blocked on probation)');

  // Comments: OFF probation the same config runs up to the normal 60/hr ceiling.
  const cNorm = await commentHour(undefined, 71); // default botInfo -> off probation
  eq(cNorm.store.getProfile('pc').probation.onProbation, false, 'the contrast profile was OFF probation');
  ok(cNorm.count > cProb.count, 'off probation the SAME config fired far more (' + cNorm.count + ' > ' + cProb.count + '): probation was the limiter');
  ok(cNorm.count > 5, 'off probation clearly exceeded the probation ceiling (' + cNorm.count + ' > 5)');

  // Posts: on probation the effective ceiling is 2/hr.
  const pProb = await postHour(onProb, 72);
  ok(pProb.count <= 2, 'on probation, 100000/hr configured but held to ' + pProb.count + ' posts in the hour (<= 2)');
  ok(pProb.count >= 1, 'still posted near the probation ceiling (' + pProb.count + ' >= 1)');

  // Posts: OFF probation the same config runs up to the normal 10/hr ceiling.
  const pNorm = await postHour(undefined, 72);
  ok(pNorm.count > pProb.count, 'off probation the SAME post config fired more (' + pNorm.count + ' > ' + pProb.count + ')');
  ok(pNorm.count > 2, 'off probation clearly exceeded the probation post ceiling (' + pNorm.count + ' > 2)');
}

// ============================================================================
// Scenario 15: a LINK post whose OG fetch is still 'pending' is DEFERRED - it is
// skipped WITHOUT being consumed (not marked replied), and is commented on only
// once the metadata lands ('ok'), with the honesty guard + summary in the prompt.
// ============================================================================
async function scenarioLinkPendingDefer() {
  console.log('\n[15] link post: pending is DEFERRED (not consumed), commented once it flips to ok');
  const clock = makeClock(9_000_000);
  const linkPost = { id: 700, feddit: 'links', title: 'City council votes on new bridge', author: 'human', link: true, url: 'https://news.example/bridge', og_status: 'pending' };
  const world = { feddits: { links: [linkPost] }, comments: {} };
  const p = profile({ id: 'conv', fedditUsername: 'conv', mode: 'comment', commentsPerHour: 30, readFeddits: ['links'] });
  p.sched.nextCommentAt = clock.now();
  const store = makeStore([p]);
  const providers = makeProviders();
  const feddit = makeFeddit(world);
  const sched = scheduler.createScheduler({ store, providers, feddit, now: clock.now, random: rng(41), getDeepseekKey: KEY });

  // Tick 1: the only post is a LINK whose OG fetch is still 'pending' -> DEFER.
  const r1 = await sched.runTick();
  ok(!r1.acted, 'pending link: the tick did not act');
  eq(providers.stats().calls, 0, 'pending link: no generation (deferred, not commented)');
  eq(world.calls.comment.length, 0, 'pending link: no live comment write');
  ok(!store.hasReplied('conv', 't3_700'), 'pending link NOT marked replied (not consumed - it can retry later)');
  eq(store.getThreadReplyCount(700), 0, 'pending link did not consume a thread-reply slot');

  // The OG worker lands ~2 min later: status flips to ok with a real summary.
  linkPost.og_status = 'ok';
  linkPost.og_title = 'Council approves bridge funding';
  linkPost.og_description = 'The vote passed 7-2 after a long debate over cost.';
  linkPost.og_site_name = 'Example News';
  clock.advance(130_000);
  p.sched.nextCommentAt = clock.now(); // due again

  const r2 = await sched.runTick();
  ok(r2.acted, 'ok link: the tick acted');
  eq(providers.stats().calls, 1, 'ok link: generated exactly one reply');
  ok(store.hasReplied('conv', 't3_700'), 'ok link: NOW marked replied (consumed)');
  const prompt = providers.prompts[providers.prompts.length - 1];
  ok(/seen ONLY its headline/i.test(prompt), 'prompt carries the link-honesty guard (headline only, not the article)');
  ok(/and a short summary/i.test(prompt), 'prompt says a summary (not the article) was also seen');
  ok(prompt.includes('The vote passed 7-2'), 'prompt includes the OG summary as context');
  ok(prompt.includes('Council approves bridge funding'), 'prompt uses the fetched OG title as the headline');
}

// ============================================================================
// Scenario 16: terminal OG states. 'no_image' is terminal but may still carry a
// populated og_description (means "no picture", NOT "no metadata") - so it stays
// usable as context. 'blocked' is terminal with no description, so the per-profile
// linkNoContext setting decides: 'skip' passes it over, 'headline' reacts to the
// bare headline (still honesty-guarded, but with no summary claim).
// ============================================================================
async function scenarioLinkTerminalStates() {
  console.log('\n[16] link terminal states: no_image+summary usable; blocked follows the profile setting');

  // 16a: no_image WITH a summary is still commented on.
  {
    const clock = makeClock(10_000_000);
    const post = { id: 800, feddit: 'links', title: 'Headline only', author: 'human', link: true, url: 'https://n.ex/x',
      og_status: 'no_image', og_title: 'Rare comet passes Earth', og_description: 'Visible to the naked eye for three nights.', og_site_name: 'SkyNews' };
    const world = { feddits: { links: [post] }, comments: {} };
    const p = profile({ id: 'ni', fedditUsername: 'ni', mode: 'comment', commentsPerHour: 30, readFeddits: ['links'] });
    p.sched.nextCommentAt = clock.now();
    const store = makeStore([p]);
    const providers = makeProviders();
    const sched = scheduler.createScheduler({ store, providers, feddit: makeFeddit(world), now: clock.now, random: rng(51), getDeepseekKey: KEY });
    await sched.runTick();
    eq(providers.stats().calls, 1, 'no_image WITH a summary is still commented on (terminal != unusable)');
    ok(store.hasReplied('ni', 't3_800'), 'no_image-with-summary post was consumed');
    const prompt = providers.prompts[providers.prompts.length - 1];
    ok(prompt.includes('Visible to the naked eye'), 'the no_image og_description was used as context');
    ok(/and a short summary/i.test(prompt), 'honesty guard notes the summary was seen');
  }

  // 16b: blocked + linkNoContext:'skip' -> passed over, not consumed.
  {
    const clock = makeClock(11_000_000);
    const post = { id: 900, feddit: 'links', title: 'Something behind a wall', author: 'human', link: true, url: 'https://n.ex/y', og_status: 'blocked' };
    const world = { feddits: { links: [post] }, comments: {} };
    const skipP = profile({ id: 'skp', fedditUsername: 'skp', mode: 'comment', commentsPerHour: 30, readFeddits: ['links'], linkNoContext: 'skip' });
    skipP.sched.nextCommentAt = clock.now();
    const store = makeStore([skipP]);
    const providers = makeProviders();
    const sched = scheduler.createScheduler({ store, providers, feddit: makeFeddit(world), now: clock.now, random: rng(52), getDeepseekKey: KEY });
    await sched.runTick();
    eq(providers.stats().calls, 0, "blocked + linkNoContext:'skip' -> not commented");
    ok(!store.hasReplied('skp', 't3_900'), 'blocked+skip: the post was NOT consumed');
  }

  // 16c: blocked + linkNoContext:'headline' -> reacts to the bare headline.
  {
    const clock = makeClock(12_000_000);
    const post = { id: 901, feddit: 'links', title: 'Bare headline here', author: 'human', link: true, url: 'https://n.ex/z', og_status: 'blocked' };
    const world = { feddits: { links: [post] }, comments: {} };
    const headP = profile({ id: 'hdl', fedditUsername: 'hdl', mode: 'comment', commentsPerHour: 30, readFeddits: ['links'], linkNoContext: 'headline' });
    headP.sched.nextCommentAt = clock.now();
    const store = makeStore([headP]);
    const providers = makeProviders();
    const sched = scheduler.createScheduler({ store, providers, feddit: makeFeddit(world), now: clock.now, random: rng(53), getDeepseekKey: KEY });
    await sched.runTick();
    eq(providers.stats().calls, 1, "blocked + linkNoContext:'headline' -> reacts to the headline");
    ok(store.hasReplied('hdl', 't3_901'), 'blocked+headline: the post was consumed');
    const prompt = providers.prompts[providers.prompts.length - 1];
    ok(prompt.includes('Bare headline here'), 'the bare headline was used as context');
    ok(/seen ONLY its headline/i.test(prompt), 'honesty guard present on a headline-only reaction');
    ok(!/and a short summary/i.test(prompt), 'honesty guard does NOT claim a summary when there is none');
  }
}

// ============================================================================
// Scenario 17: probation polling discipline - checked once, NOT hammered inside
// the poll window, re-checked after it, and NEVER checked again once observed off
// (probation only ever transitions ON -> OFF).
// ============================================================================
async function scenarioProbationPolling() {
  console.log('\n[17] probation polling: re-checked but not hammered, never checked again once off');
  const clock = makeClock(13_000_000);
  let probOn = true;
  const world = { feddits: {}, comments: {}, onBotInfo: () => ({ ok: true, status: 200, data: { probation: { on_probation: probOn } } }) };
  const p = profile({ id: 'poll', fedditUsername: 'poll', mode: 'comment', commentsPerHour: 30, readFeddits: ['none'] });
  p.sched.nextCommentAt = clock.now();
  const store = makeStore([p]);
  const feddit = makeFeddit(world);
  const sched = scheduler.createScheduler({ store, providers: makeProviders(), feddit, now: clock.now, random: rng(61), getDeepseekKey: KEY });

  // First tick: checks probation exactly once, observes ON.
  await sched.runTick();
  eq(feddit.calls.botInfo.length, 1, 'probation checked once on the first tick');
  eq(store.getProfile('poll').probation.onProbation, true, 'observed ON probation');

  // Several ticks inside the ~3-min poll window: must NOT re-check (no hammering).
  for (let i = 0; i < 5; i++) { clock.advance(20_000); await sched.runTick(); }
  eq(feddit.calls.botInfo.length, 1, 'NOT re-checked within the poll window (no hammering)');

  // Past the poll window: re-checked (still ON).
  clock.advance(200_000);
  await sched.runTick();
  eq(feddit.calls.botInfo.length, 2, 're-checked after the poll interval elapsed');

  // It clears. Advance past the window again so the next tick re-checks and sees OFF.
  probOn = false;
  clock.advance(200_000);
  await sched.runTick();
  eq(feddit.calls.botInfo.length, 3, 'checked again and observed it clear');
  eq(store.getProfile('poll').probation.onProbation, false, 'now OFF probation');

  // Once OFF it is terminal: never polled again, however much time passes.
  for (let i = 0; i < 5; i++) { clock.advance(600_000); await sched.runTick(); }
  eq(feddit.calls.botInfo.length, 3, 'never polled again once off probation (terminal transition)');
}

// ---- run --------------------------------------------------------------------

(async () => {
  scenarioProfileMigration();
  await scenarioTargetingDedupe();
  await scenarioCadenceCeiling();
  await scenarioThreadCap();
  await scenario429Backoff();
  await scenarioPauseAndSingleFlight();
  await scenarioProviderGate();
  await scenarioSpendCap();
  await scenarioCostMaths();
  await scenarioGdeltQueue();
  await scenarioNews();
  await scenarioShortlistFallback();
  await scenarioProbationCeilings();
  await scenarioLinkPendingDefer();
  await scenarioLinkTerminalStates();
  await scenarioProbationPolling();
  await scenarioRealSmoke();

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
